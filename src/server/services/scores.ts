/**
 * League scoreboard: lawyer and team points per week.
 *
 * Finalized weeks read from snapshots (week_scores / team_week_scores) so late
 * approvals don't silently change settled results. Open weeks are computed live
 * from approved events and each team's lineup for that week. A reopened week
 * (finalized once, then reopened) is computed with the scoring settings it was
 * first finalized with (`week_scoring`), not today's; pool links (appearances,
 * firm links) are always the current ones.
 */
import { and, eq, inArray } from "drizzle-orm";
import { cache } from "react";
import { db as defaultDb, type DbOrTx } from "@/db";
import {
  caseAppearances,
  cases,
  lawyers,
  leagues,
  scoringEvents,
  teams,
  teamWeekScores,
  weekFinalizations,
  weekScores,
  weekScoring,
} from "@/db/schema";
import { computeLawyerPoints, round2, type LawyerPoints, type ScoringEventInput } from "@/lib/scoring";
import { parseLeagueSettings, scoringSchema, totalSeasonWeeks, type LeagueSettings, type ScoringSettings } from "@/lib/settings";
import { weekOfDate } from "@/lib/time";
import { effectiveStarters, loadLeagueLineups, type LineupRow } from "./lineups";

export type PoolLawyer = {
  id: string;
  name: string;
  kind: "lawyer" | "firm";
  position: "trial" | "appellate" | "prosecutor" | "defense" | "firm";
  firmId: string | null;
  organization: string | null;
  preseasonRank: number | null;
};

export type Scoreboard = {
  leagueId: string;
  settings: LeagueSettings;
  seasonStart: string;
  totalWeeks: number;
  finalizedWeeks: Set<number>;
  /** Live computation (all weeks) — includes per-event lines for lawyer pages. */
  live: Map<string, LawyerPoints>;
  lawyers: Map<string, PoolLawyer>;
  lawyerWeek(lawyerId: string, week: number): number;
  lawyerTotal(lawyerId: string): number;
  starters(teamId: string, week: number): (string | null)[];
  teamWeek(teamId: string, week: number): number;
  /** Sum of teamWeek over an inclusive week range. */
  teamRange(teamId: string, weekStart: number, weekEnd: number): number;
};

export async function loadPoolLawyers(db: DbOrTx, poolId: string): Promise<PoolLawyer[]> {
  return db
    .select({
      id: lawyers.id,
      name: lawyers.name,
      kind: lawyers.kind,
      position: lawyers.position,
      firmId: lawyers.firmId,
      organization: lawyers.organization,
      preseasonRank: lawyers.preseasonRank,
    })
    .from(lawyers)
    .where(eq(lawyers.poolId, poolId));
}

export async function loadApprovedEvents(db: DbOrTx, poolId: string): Promise<ScoringEventInput[]> {
  const rows = await db
    .select({
      id: scoringEvents.id,
      type: scoringEvents.type,
      customPoints: scoringEvents.customPoints,
      occurredOn: scoringEvents.occurredOn,
      caseId: scoringEvents.caseId,
      side: scoringEvents.side,
      lawyerId: scoringEvents.lawyerId,
    })
    .from(scoringEvents)
    .where(and(eq(scoringEvents.poolId, poolId), eq(scoringEvents.status, "approved")));
  return rows;
}

export async function loadPoolAppearances(db: DbOrTx, poolId: string) {
  return db
    .select({ caseId: caseAppearances.caseId, lawyerId: caseAppearances.lawyerId, side: caseAppearances.side })
    .from(caseAppearances)
    .innerJoin(cases, eq(cases.id, caseAppearances.caseId))
    .where(eq(cases.poolId, poolId));
}

export async function buildScoreboard(db: DbOrTx, leagueId: string): Promise<Scoreboard> {
  const [league] = await db.select().from(leagues).where(eq(leagues.id, leagueId));
  if (!league) throw new Error("League not found");
  const settings = parseLeagueSettings(league.settings);
  const totalWeeks = totalSeasonWeeks(settings.schedule);

  const [poolLawyers, events, appearances, finals, wScores, tScores, lineupMap, storedScoring] = await Promise.all([
    loadPoolLawyers(db, league.poolId),
    loadApprovedEvents(db, league.poolId),
    loadPoolAppearances(db, league.poolId),
    db.select({ week: weekFinalizations.week }).from(weekFinalizations).where(eq(weekFinalizations.leagueId, leagueId)),
    db.select().from(weekScores).where(eq(weekScores.leagueId, leagueId)),
    db.select().from(teamWeekScores).where(eq(teamWeekScores.leagueId, leagueId)),
    loadLeagueLineups(db, leagueId),
    db.select({ week: weekScoring.week, scoring: weekScoring.scoring }).from(weekScoring).where(eq(weekScoring.leagueId, leagueId)),
  ]);

  const weekOf = (d: string) => weekOfDate(d, league.seasonStart);
  const live = computeLawyerPoints({ events, appearances, lawyers: poolLawyers, scoring: settings.scoring, weekOf, totalWeeks });

  const finalizedWeeks = new Set(finals.map((f) => f.week));

  // Reopened weeks keep the scoring they were first finalized with.
  for (const g of weekScoringOverrides(storedScoring, finalizedWeeks, settings.scoring)) {
    const pts = computeLawyerPoints({
      events: events.filter((e) => g.weeks.has(weekOf(e.occurredOn))),
      appearances,
      lawyers: poolLawyers,
      scoring: g.scoring,
      weekOf,
      totalWeeks,
    });
    replaceWeeks(live, g.weeks, pts);
  }

  const snap = new Map<string, number>();
  for (const s of wScores) snap.set(`${s.lawyerId}|${s.week}`, s.points);
  const teamSnap = new Map<string, number>();
  for (const s of tScores) teamSnap.set(`${s.teamId}|${s.week}`, s.points);

  const lawyerWeek = (lawyerId: string, week: number): number => {
    if (finalizedWeeks.has(week)) return snap.get(`${lawyerId}|${week}`) ?? 0;
    return live.get(lawyerId)?.byWeek.get(week) ?? 0;
  };
  const lawyerTotal = (lawyerId: string): number => {
    let t = 0;
    for (let w = 1; w <= totalWeeks; w++) t += lawyerWeek(lawyerId, w);
    return round2(t);
  };
  const starters = (teamId: string, week: number) => effectiveStarters(lineupMap.get(teamId) as LineupRow[] | undefined, week, settings);
  const teamWeek = (teamId: string, week: number): number => {
    if (finalizedWeeks.has(week)) return teamSnap.get(`${teamId}|${week}`) ?? 0;
    let t = 0;
    for (const id of starters(teamId, week)) if (id) t += lawyerWeek(id, week);
    return round2(t);
  };
  const teamRange = (teamId: string, a: number, b: number) => {
    let t = 0;
    for (let w = a; w <= b; w++) t += teamWeek(teamId, w);
    return round2(t);
  };

  return {
    leagueId,
    settings,
    seasonStart: league.seasonStart,
    totalWeeks,
    finalizedWeeks,
    live,
    lawyers: new Map(poolLawyers.map((l) => [l.id, l])),
    lawyerWeek,
    lawyerTotal,
    starters,
    teamWeek,
    teamRange,
  };
}

/**
 * Weeks to score with stored settings instead of `current`, grouped by
 * settings: only weeks without a snapshot whose stored scoring differs from the
 * current one. Rows that don't parse are ignored (the week uses current settings).
 */
export function weekScoringOverrides(
  rows: { week: number; scoring: unknown }[],
  finalizedWeeks: ReadonlySet<number>,
  current: ScoringSettings,
): { scoring: ScoringSettings; weeks: Set<number> }[] {
  const currentKey = JSON.stringify(scoringSchema.parse(current));
  const groups = new Map<string, { scoring: ScoringSettings; weeks: Set<number> }>();
  for (const r of rows) {
    if (finalizedWeeks.has(r.week)) continue;
    const parsed = scoringSchema.safeParse(r.scoring);
    if (!parsed.success) continue;
    const key = JSON.stringify(parsed.data);
    if (key === currentKey) continue;
    const g = groups.get(key);
    if (g) g.weeks.add(r.week);
    else groups.set(key, { scoring: parsed.data, weeks: new Set([r.week]) });
  }
  return [...groups.values()];
}

/**
 * Replace `weeks` in `base` (points by week, event lines and totals) with the
 * values from `other`, in place. Lines stay in week order.
 */
export function replaceWeeks(base: Map<string, LawyerPoints>, weeks: ReadonlySet<number>, other: ReadonlyMap<string, LawyerPoints>): void {
  const touched = new Set<string>();
  for (const [id, lp] of base) {
    if (![...lp.byWeek.keys()].some((w) => weeks.has(w))) continue;
    for (const w of weeks) lp.byWeek.delete(w);
    lp.lines = lp.lines.filter((l) => !weeks.has(l.week));
    touched.add(id);
  }
  for (const [id, o] of other) {
    let lp = base.get(id);
    if (!lp) base.set(id, (lp = { byWeek: new Map(), lines: [], total: 0 }));
    for (const [w, v] of o.byWeek) if (weeks.has(w)) lp.byWeek.set(w, v);
    lp.lines.push(...o.lines.filter((l) => weeks.has(l.week)));
    touched.add(id);
  }
  for (const id of touched) {
    const lp = base.get(id)!;
    lp.lines.sort((a, b) => a.week - b.week); // stable: keeps event order within a week
    let t = 0;
    for (const v of lp.byWeek.values()) t += v;
    lp.total = round2(t);
  }
}

/** Whether `week` has stored scoring (it was finalized after `week_scoring` existed). */
export async function hasWeekScoring(db: DbOrTx, leagueId: string, week: number): Promise<boolean> {
  const rows = await db
    .select({ week: weekScoring.week })
    .from(weekScoring)
    .where(and(eq(weekScoring.leagueId, leagueId), eq(weekScoring.week, week)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Reopened weeks that score with their stored settings instead of `current`,
 * the same ones buildScoreboard uses. For point previews (event pages, firm
 * multiplier labels): `map.get(week) ?? current`.
 */
export async function reopenedWeekScoring(db: DbOrTx, leagueId: string, current: ScoringSettings): Promise<Map<number, ScoringSettings>> {
  const [rows, finals] = await Promise.all([
    db.select({ week: weekScoring.week, scoring: weekScoring.scoring }).from(weekScoring).where(eq(weekScoring.leagueId, leagueId)),
    db.select({ week: weekFinalizations.week }).from(weekFinalizations).where(eq(weekFinalizations.leagueId, leagueId)),
  ]);
  const out = new Map<number, ScoringSettings>();
  for (const g of weekScoringOverrides(rows, new Set(finals.map((f) => f.week)), current)) {
    for (const w of g.weeks) out.set(w, g.scoring);
  }
  return out;
}

/** Request-memoized scoreboard for Server Components. */
export const getScoreboard = cache((leagueId: string) => buildScoreboard(defaultDb, leagueId));

/** Snapshot one week's lawyer and team scores (used by "Finalize week"). */
export async function snapshotWeek(db: DbOrTx, leagueId: string, week: number): Promise<void> {
  // Compute live values ignoring any existing snapshot for this week.
  await db.delete(weekScores).where(and(eq(weekScores.leagueId, leagueId), eq(weekScores.week, week)));
  await db.delete(teamWeekScores).where(and(eq(teamWeekScores.leagueId, leagueId), eq(teamWeekScores.week, week)));
  await db.delete(weekFinalizations).where(and(eq(weekFinalizations.leagueId, leagueId), eq(weekFinalizations.week, week)));
  const sb = await buildScoreboard(db, leagueId);
  const lawyerRows: { leagueId: string; week: number; lawyerId: string; points: number }[] = [];
  for (const [lawyerId, lp] of sb.live) {
    const pts = lp.byWeek.get(week);
    if (pts) lawyerRows.push({ leagueId, week, lawyerId, points: pts });
  }
  if (lawyerRows.length) await db.insert(weekScores).values(lawyerRows);
  const leagueTeams = await db.select({ id: teams.id }).from(teams).where(eq(teams.leagueId, leagueId));
  if (leagueTeams.length) {
    await db.insert(teamWeekScores).values(leagueTeams.map((t) => ({ leagueId, week, teamId: t.id, points: sb.teamWeek(t.id, week) })));
  }
}

export async function clearWeekSnapshot(db: DbOrTx, leagueId: string, weeks: number[]): Promise<void> {
  if (weeks.length === 0) return;
  await db.delete(weekScores).where(and(eq(weekScores.leagueId, leagueId), inArray(weekScores.week, weeks)));
  await db.delete(teamWeekScores).where(and(eq(teamWeekScores.leagueId, leagueId), inArray(teamWeekScores.week, weeks)));
}
