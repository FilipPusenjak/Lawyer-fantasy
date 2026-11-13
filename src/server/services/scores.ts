/**
 * League scoreboard: lawyer and team points per week.
 *
 * Finalized weeks read from snapshots (week_scores / team_week_scores) so late
 * approvals don't silently change settled results. Open weeks are computed live
 * from approved events and each team's lineup for that week.
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
} from "@/db/schema";
import { computeLawyerPoints, round2, type LawyerPoints, type ScoringEventInput } from "@/lib/scoring";
import { parseLeagueSettings, totalSeasonWeeks, type LeagueSettings } from "@/lib/settings";
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

  const [poolLawyers, events, appearances, finals, wScores, tScores, lineupMap] = await Promise.all([
    loadPoolLawyers(db, league.poolId),
    loadApprovedEvents(db, league.poolId),
    loadPoolAppearances(db, league.poolId),
    db.select({ week: weekFinalizations.week }).from(weekFinalizations).where(eq(weekFinalizations.leagueId, leagueId)),
    db.select().from(weekScores).where(eq(weekScores.leagueId, leagueId)),
    db.select().from(teamWeekScores).where(eq(teamWeekScores.leagueId, leagueId)),
    loadLeagueLineups(db, leagueId),
  ]);

  const live = computeLawyerPoints({
    events,
    appearances,
    lawyers: poolLawyers,
    scoring: settings.scoring,
    weekOf: (d) => weekOfDate(d, league.seasonStart),
    totalWeeks,
  });

  const finalizedWeeks = new Set(finals.map((f) => f.week));
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
