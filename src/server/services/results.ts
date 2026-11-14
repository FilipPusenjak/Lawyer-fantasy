/**
 * Results: finalizing weeks, settling matchups and running the playoffs.
 *
 * - Finalizing week N snapshots every lawyer's and team's points for N
 *   (`snapshotWeek`), so approvals that come in later don't change settled
 *   results. Weeks are finalized in order, and only after they end in league
 *   time.
 * - A matchup is settled (final) once all of its weeks are finalized: its score
 *   is the sum of the teams' weekly snapshots (median games: the median of every
 *   team's total for the same weeks).
 * - When the whole regular season is settled, the top teams by standings are
 *   seeded into a bracket (top seeds get byes when the field isn't a power of
 *   two). Each time a playoff round is settled, the next round is created, until
 *   one team is left and the season is complete.
 *
 * Reopening (documented choice): only the most recently finalized week can be
 * reopened. Its snapshots are deleted and the matchups containing it go back to
 * "not final". If finalizing that week had generated a playoff round (round 1
 * from the last regular-season week, or round N+1 from the last week of round
 * N), that generated round is deleted too and the league status steps back.
 * The deleted round can never have finalized weeks of its own (all of its
 * weeks come after the reopened week), so nothing is lost: it's rebuilt, with
 * fresh seeding, when the week is finalized again. We chose this over refusing
 * so a commissioner can always fix a late approval in the last week of a round.
 * As a safety net, the reopen is refused if any of those rounds somehow has a
 * finalized week.
 *
 * No `server-only` and no cookies here, so the seed script can call these.
 */
import { and, asc, count, eq, gt, gte, inArray, lte } from "drizzle-orm";
import type { DbOrTx } from "@/db";
import {
  leagues,
  matchups,
  scoringEvents,
  teams,
  teamWeekScores,
  weekFinalizations,
  type League,
  type Matchup,
} from "@/db/schema";
import { pickHomePeriod } from "@/app/leagues/new/league-rules";
import { decideWinner, firstRoundBracket, median, nextRoundPairs, playoffRoundWeeks } from "@/lib/schedule";
import { round2 } from "@/lib/scoring";
import {
  parseLeagueSettings,
  regularSeasonWeeks,
  totalSeasonWeeks,
  type ScheduleSettings,
} from "@/lib/settings";
import { addDays, formatShortDate, todayIn, weekEndDate, weekOfDate, weekStartDate } from "@/lib/time";
import { UserError } from "@/server/action-result";
import { clearWeekSnapshot, snapshotWeek } from "./scores";
import { getStandings } from "./standings";

export type LeagueStatus = League["status"];

// ---------------------------------------------------------------------------
// Pure helpers: weeks and periods
// ---------------------------------------------------------------------------

export type WeekState = "upcoming" | "in_progress" | "ended" | "finalized";

export const WEEK_STATE_LABELS: Record<WeekState, string> = {
  upcoming: "Upcoming",
  in_progress: "In progress",
  ended: "Ended · not final",
  finalized: "Final",
};

/** State of a week given today's date in the league time zone ("YYYY-MM-DD"). */
export function weekState(week: number, seasonStart: string, today: string, finalized: ReadonlySet<number>): WeekState {
  if (finalized.has(week)) return "finalized";
  if (weekEndDate(week, seasonStart) < today) return "ended";
  if (weekStartDate(week, seasonStart) <= today) return "in_progress";
  return "upcoming";
}

export type PeriodInfo = {
  period: number;
  weekStart: number;
  weekEnd: number;
  isPlayoff: boolean;
  /** 1-based playoff round (null in the regular season). */
  playoffRound: number | null;
};

/** The matchup period a season week belongs to, from the schedule settings. Null outside the season. */
export function periodOfWeek(week: number, schedule: ScheduleSettings): PeriodInfo | null {
  if (!Number.isInteger(week) || week < 1 || week > totalSeasonWeeks(schedule)) return null;
  const regular = regularSeasonWeeks(schedule);
  if (week <= regular) {
    const period = Math.ceil(week / schedule.matchupWeeks);
    return {
      period,
      weekStart: (period - 1) * schedule.matchupWeeks + 1,
      weekEnd: period * schedule.matchupWeeks,
      isPlayoff: false,
      playoffRound: null,
    };
  }
  const round = Math.ceil((week - regular) / schedule.playoffRoundWeeks);
  const r = playoffRoundWeeks(round, schedule);
  return { period: r.period, weekStart: r.weekStart, weekEnd: r.weekEnd, isPlayoff: true, playoffRound: round };
}

/** Short period label: "Week 3", "Week 3–4" or "Playoffs R1". */
export function periodLabel(p: Pick<PeriodInfo, "weekStart" | "weekEnd" | "isPlayoff" | "playoffRound">): string {
  if (p.isPlayoff) return `Playoffs R${p.playoffRound ?? 1}`;
  return p.weekStart === p.weekEnd ? `Week ${p.weekStart}` : `Week ${p.weekStart}–${p.weekEnd}`;
}

/** "Week 5" or "Weeks 5–6". */
export function weekRangeLabel(weekStart: number, weekEnd: number): string {
  return weekStart === weekEnd ? `Week ${weekStart}` : `Weeks ${weekStart}–${weekEnd}`;
}

/** Number of rounds in a bracket, from its first round's match count (byes included). */
export function bracketRoundCount(firstRoundMatches: number): number {
  return firstRoundMatches <= 0 ? 0 : Math.round(Math.log2(firstRoundMatches * 2));
}

/** Friendly playoff round name ("Championship", "Semifinals", …). */
export function playoffRoundName(round: number, totalRounds: number): string {
  if (round === totalRounds) return "Championship";
  if (round === totalRounds - 1) return "Semifinals";
  if (round === totalRounds - 2) return "Quarterfinals";
  return `Round ${round}`;
}

/** Round name for use mid-sentence: "round 1", "the semifinals", "the championship". */
export function playoffRoundRef(round: number, totalRounds: number): string {
  const name = playoffRoundName(round, totalRounds);
  return name.startsWith("Round") ? name.toLowerCase() : `the ${name.toLowerCase()}`;
}

/** Distinct matchup periods that exist for a league, in order. */
export function listPeriods(all: Pick<Matchup, "period" | "weekStart" | "weekEnd" | "isPlayoff" | "playoffRound">[]): (PeriodInfo & {
  label: string;
})[] {
  const byPeriod = new Map<number, PeriodInfo & { label: string }>();
  for (const m of all) {
    if (byPeriod.has(m.period)) continue;
    const p: PeriodInfo = {
      period: m.period,
      weekStart: m.weekStart,
      weekEnd: m.weekEnd,
      isPlayoff: m.isPlayoff,
      playoffRound: m.playoffRound,
    };
    byPeriod.set(m.period, { ...p, label: periodLabel(p) });
  }
  return [...byPeriod.values()].sort((a, b) => a.period - b.period);
}

/**
 * The period to show by default for a week: the one containing it; before the
 * season the first; after the last period (or in the gap before the next
 * playoff round exists) the latest one that already ended. Null with no schedule.
 */
export function currentPeriod(all: Pick<Matchup, "period" | "weekStart" | "weekEnd">[], week: number): number | null {
  return pickHomePeriod(all, week);
}

// ---------------------------------------------------------------------------
// Pure helpers: finalize / reopen rules
// ---------------------------------------------------------------------------

export type RuleCheck = { ok: true } | { ok: false; reason: string };

/**
 * Whether a week can be finalized now: the season is running, the week is part
 * of it, it ended before today (league time), it isn't final yet, and every
 * earlier week is already final.
 */
export function canFinalizeWeek(args: {
  week: number;
  status: LeagueStatus;
  schedule: ScheduleSettings;
  seasonStart: string;
  /** Today's date in the league time zone, "YYYY-MM-DD". */
  today: string;
  finalizedWeeks: Iterable<number>;
}): RuleCheck {
  const { week, status, schedule, seasonStart, today } = args;
  const finalized = new Set(args.finalizedWeeks);
  if (status === "setup" || status === "drafting") return { ok: false, reason: "The season hasn't started yet." };
  if (status === "complete") return { ok: false, reason: "The season is over, so there's nothing left to finalize." };
  if (!Number.isInteger(week) || week < 1 || week > totalSeasonWeeks(schedule)) {
    return { ok: false, reason: `Week ${week} isn't part of this season.` };
  }
  if (finalized.has(week)) return { ok: false, reason: `Week ${week} is already final.` };
  const end = weekEndDate(week, seasonStart);
  if (!(end < today)) {
    return { ok: false, reason: `Week ${week} isn't over yet. You can finalize it starting ${formatShortDate(addDays(end, 1))}.` };
  }
  for (let w = 1; w < week; w++) {
    if (!finalized.has(w)) return { ok: false, reason: `Finalize week ${w} first. Weeks are finalized in order.` };
  }
  return { ok: true };
}

/** Only the most recently finalized week can be reopened. */
export function canReopenWeek(week: number, finalizedWeeks: Iterable<number>): RuleCheck {
  const finalized = [...finalizedWeeks];
  if (!finalized.includes(week)) return { ok: false, reason: `Week ${week} isn't final.` };
  const latest = Math.max(...finalized);
  if (week !== latest) return { ok: false, reason: `Only the latest final week (week ${latest}) can be reopened.` };
  return { ok: true };
}

export type WeekStatusRow = {
  week: number;
  startDate: string;
  endDate: string;
  state: WeekState;
  period: PeriodInfo;
  periodLabel: string;
  canFinalize: boolean;
  canReopen: boolean;
};

/** Every season week with its state and which actions apply (for the commissioner weeks page). */
export function weekStatusList(args: {
  schedule: ScheduleSettings;
  seasonStart: string;
  today: string;
  finalizedWeeks: Iterable<number>;
  status: LeagueStatus;
}): WeekStatusRow[] {
  const { schedule, seasonStart, today, status } = args;
  const finalized = new Set(args.finalizedWeeks);
  const latestFinal = finalized.size ? Math.max(...finalized) : null;
  const total = totalSeasonWeeks(schedule);
  const rows: WeekStatusRow[] = [];
  for (let week = 1; week <= total; week++) {
    const period = periodOfWeek(week, schedule)!;
    rows.push({
      week,
      startDate: weekStartDate(week, seasonStart),
      endDate: weekEndDate(week, seasonStart),
      state: weekState(week, seasonStart, today, finalized),
      period,
      periodLabel: periodLabel(period),
      canFinalize: canFinalizeWeek({ week, status, schedule, seasonStart, today, finalizedWeeks: finalized }).ok,
      canReopen: week === latestFinal,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Pure helpers: settling matchups
// ---------------------------------------------------------------------------

type SettleMatchup = Pick<
  Matchup,
  "teamAId" | "teamBId" | "isMedian" | "isBye" | "isPlayoff" | "seedA" | "seedB" | "weekStart" | "weekEnd"
>;

/** True when every week of the matchup's range is finalized. */
export function isRangeFinalized(m: Pick<Matchup, "weekStart" | "weekEnd">, finalized: ReadonlySet<number>): boolean {
  for (let w = m.weekStart; w <= m.weekEnd; w++) if (!finalized.has(w)) return false;
  return true;
}

/** Each team's total over an inclusive week range (every team id starts at 0). */
export function rangeTotals(
  rows: { teamId: string; week: number; points: number }[],
  weekStart: number,
  weekEnd: number,
  teamIds: string[],
): Map<string, number> {
  const totals = new Map<string, number>(teamIds.map((id) => [id, 0]));
  for (const r of rows) {
    if (r.week < weekStart || r.week > weekEnd || !totals.has(r.teamId)) continue;
    totals.set(r.teamId, totals.get(r.teamId)! + r.points);
  }
  for (const [id, v] of totals) totals.set(id, round2(v));
  return totals;
}

/**
 * Final score and winner of a matchup from every team's range totals.
 * Median games (no team B) compare against the median of ALL teams' totals.
 * Regular-season ties have no winner; playoff ties go to the higher seed.
 */
export function settleMatchup(
  m: SettleMatchup,
  totals: ReadonlyMap<string, number>,
): { scoreA: number; scoreB: number; winnerTeamId: string | null } {
  const scoreA = round2(totals.get(m.teamAId) ?? 0);
  const scoreB = round2(m.teamBId ? (totals.get(m.teamBId) ?? 0) : median([...totals.values()]));
  const winnerTeamId = decideWinner({
    teamA: m.teamAId,
    teamB: m.teamBId,
    scoreA,
    scoreB,
    isPlayoff: m.isPlayoff,
    seedA: m.seedA,
    seedB: m.seedB,
  });
  return { scoreA, scoreB, winnerTeamId };
}

// ---------------------------------------------------------------------------
// Pure helpers: playoff bracket shaping
// ---------------------------------------------------------------------------

export type PlayoffRow = {
  period: number;
  weekStart: number;
  weekEnd: number;
  isPlayoff: true;
  playoffRound: number;
  bracketSlot: number;
  teamAId: string;
  teamBId: string | null;
  isMedian: false;
  isBye: boolean;
  seedA: number;
  seedB: number | null;
  scoreA: null;
  scoreB: null;
  winnerTeamId: string | null;
  final: boolean;
};

/**
 * Round-1 rows for teams already in seed order (index 0 = seed 1). Byes are
 * stored as settled matchups with no team B, won by team A, with no scores.
 */
export function firstRoundRows(seededTeamIds: string[], schedule: ScheduleSettings): PlayoffRow[] {
  const weeks = playoffRoundWeeks(1, schedule);
  return firstRoundBracket(seededTeamIds.length).map((b) => {
    const teamAId = seededTeamIds[b.seedA - 1];
    const teamBId = b.seedB === null ? null : seededTeamIds[b.seedB - 1];
    const isBye = teamBId === null;
    return {
      period: weeks.period,
      weekStart: weeks.weekStart,
      weekEnd: weeks.weekEnd,
      isPlayoff: true,
      playoffRound: 1,
      bracketSlot: b.bracketSlot,
      teamAId,
      teamBId,
      isMedian: false,
      isBye,
      seedA: b.seedA,
      seedB: isBye ? null : b.seedB,
      scoreA: null,
      scoreB: null,
      winnerTeamId: isBye ? teamAId : null,
      final: isBye,
    };
  });
}

type RoundMatchup = Pick<Matchup, "bracketSlot" | "teamAId" | "teamBId" | "seedA" | "seedB" | "winnerTeamId" | "final">;

/**
 * Rows for the round after `round`, pairing winners of adjacent bracket slots
 * (seeds carried along, better seed as team A). Null when only one team is
 * left, i.e. `round` was the championship.
 */
export function nextRoundRows(roundMatchups: RoundMatchup[], round: number, schedule: ScheduleSettings): PlayoffRow[] | null {
  const results = roundMatchups.map((m) => {
    if (!m.final || !m.winnerTeamId) throw new Error("Playoff round isn't settled yet");
    const seed = m.winnerTeamId === m.teamAId ? m.seedA : m.seedB;
    return { bracketSlot: m.bracketSlot ?? 0, winnerTeamId: m.winnerTeamId, winnerSeed: seed ?? 99 };
  });
  if (results.length <= 1) return null;
  const weeks = playoffRoundWeeks(round + 1, schedule);
  return nextRoundPairs(results).map((p) => ({
    period: weeks.period,
    weekStart: weeks.weekStart,
    weekEnd: weeks.weekEnd,
    isPlayoff: true,
    playoffRound: round + 1,
    bracketSlot: p.bracketSlot,
    teamAId: p.a.winnerTeamId,
    teamBId: p.b.winnerTeamId,
    isMedian: false,
    isBye: false,
    seedA: p.a.winnerSeed,
    seedB: p.b.winnerSeed,
    scoreA: null,
    scoreB: null,
    winnerTeamId: null,
    final: false,
  }));
}

export type AdvancePlan =
  | { kind: "none" }
  /** Regular season settled: seed this many teams into round 1. */
  | { kind: "seed_playoffs"; playoffTeams: number }
  /** Create the next playoff round. */
  | { kind: "next_round"; round: number; rows: PlayoffRow[] }
  /** Season over (no playoffs, or the championship is settled). */
  | { kind: "complete" };

type PlanMatchup = RoundMatchup & Pick<Matchup, "isPlayoff" | "playoffRound">;

/** What should happen to the season after matchups were settled. */
export function planSeasonAdvance(args: {
  status: LeagueStatus;
  matchups: PlanMatchup[];
  playoffTeams: number;
  teamCount: number;
  schedule: ScheduleSettings;
}): AdvancePlan {
  const { status, schedule } = args;
  const regular = args.matchups.filter((m) => !m.isPlayoff);
  const playoff = args.matchups.filter((m) => m.isPlayoff);
  if (playoff.length === 0) {
    if (status !== "in_season") return { kind: "none" };
    if (regular.length === 0 || regular.some((m) => !m.final)) return { kind: "none" };
    const n = Math.min(args.playoffTeams, args.teamCount);
    return n >= 2 ? { kind: "seed_playoffs", playoffTeams: n } : { kind: "complete" };
  }
  if (status !== "playoffs") return { kind: "none" };
  const latest = Math.max(...playoff.map((m) => m.playoffRound ?? 1));
  const round = playoff.filter((m) => (m.playoffRound ?? 1) === latest);
  if (round.some((m) => !m.final)) return { kind: "none" };
  const rows = nextRoundRows(round, latest, schedule);
  return rows ? { kind: "next_round", round: latest + 1, rows } : { kind: "complete" };
}

// ---------------------------------------------------------------------------
// DB: finalize / reopen
// ---------------------------------------------------------------------------

async function lockLeague(tx: DbOrTx, leagueId: string): Promise<League> {
  const [league] = await tx.select().from(leagues).where(eq(leagues.id, leagueId)).for("update");
  if (!league) throw new UserError("League not found.");
  return league;
}

/** Weeks already finalized for a league. */
export async function getFinalizedWeeks(db: DbOrTx, leagueId: string): Promise<Set<number>> {
  const rows = await db.select({ week: weekFinalizations.week }).from(weekFinalizations).where(eq(weekFinalizations.leagueId, leagueId));
  return new Set(rows.map((r) => r.week));
}

/** Settle every unsettled (non-bye) matchup whose weeks are all finalized. Returns how many. */
async function settleReadyMatchups(tx: DbOrTx, leagueId: string, finalized: ReadonlySet<number>): Promise<number> {
  const open = await tx.select().from(matchups).where(and(eq(matchups.leagueId, leagueId), eq(matchups.final, false)));
  const ready = open.filter((m) => !m.isBye && isRangeFinalized(m, finalized));
  if (ready.length === 0) return 0;
  const weeks = new Set<number>();
  for (const m of ready) for (let w = m.weekStart; w <= m.weekEnd; w++) weeks.add(w);
  const [teamRows, scoreRows] = await Promise.all([
    tx.select({ id: teams.id }).from(teams).where(eq(teams.leagueId, leagueId)),
    tx
      .select({ teamId: teamWeekScores.teamId, week: teamWeekScores.week, points: teamWeekScores.points })
      .from(teamWeekScores)
      .where(and(eq(teamWeekScores.leagueId, leagueId), inArray(teamWeekScores.week, [...weeks]))),
  ]);
  const teamIds = teamRows.map((t) => t.id);
  for (const m of ready) {
    const r = settleMatchup(m, rangeTotals(scoreRows, m.weekStart, m.weekEnd, teamIds));
    await tx
      .update(matchups)
      .set({ scoreA: r.scoreA, scoreB: r.scoreB, winnerTeamId: r.winnerTeamId, final: true })
      .where(eq(matchups.id, m.id));
  }
  return ready.length;
}

type AdvanceOutcome = { playoffsStarted: boolean; roundCreated: number | null; seasonComplete: boolean; status: LeagueStatus };

/** Start the playoffs, create the next round or complete the season, as needed. */
async function advanceSeason(tx: DbOrTx, league: League, schedule: ScheduleSettings): Promise<AdvanceOutcome> {
  const leagueId = league.id;
  const [all, [{ n: teamCount }]] = await Promise.all([
    tx.select().from(matchups).where(eq(matchups.leagueId, leagueId)),
    tx.select({ n: count() }).from(teams).where(eq(teams.leagueId, leagueId)),
  ]);
  const plan = planSeasonAdvance({ status: league.status, matchups: all, playoffTeams: schedule.playoffTeams, teamCount, schedule });
  const setStatus = (status: LeagueStatus) => tx.update(leagues).set({ status }).where(eq(leagues.id, leagueId));
  switch (plan.kind) {
    case "none":
      return { playoffsStarted: false, roundCreated: null, seasonComplete: false, status: league.status };
    case "complete":
      await setStatus("complete");
      return { playoffsStarted: false, roundCreated: null, seasonComplete: true, status: "complete" };
    case "seed_playoffs": {
      const standings = await getStandings(tx, leagueId);
      const seeds = standings.slice(0, plan.playoffTeams).map((s) => s.teamId);
      const rows = firstRoundRows(seeds, schedule);
      await tx.insert(matchups).values(rows.map((r) => ({ ...r, leagueId })));
      await setStatus("playoffs");
      return { playoffsStarted: true, roundCreated: 1, seasonComplete: false, status: "playoffs" };
    }
    case "next_round":
      await tx.insert(matchups).values(plan.rows.map((r) => ({ ...r, leagueId })));
      return { playoffsStarted: false, roundCreated: plan.round, seasonComplete: false, status: league.status };
  }
}

export type FinalizeResult = AdvanceOutcome & {
  week: number;
  /** Matchups that became final. */
  settled: number;
};

/**
 * Finalize one week: snapshot its scores, settle matchups whose weeks are now
 * all final, then start the playoffs / create the next round / complete the
 * season as needed. Throws UserError when the week can't be finalized yet.
 */
export async function finalizeWeek(
  db: DbOrTx,
  leagueId: string,
  week: number,
  userId: string | null,
  now: Date = new Date(),
): Promise<FinalizeResult> {
  return db.transaction(async (tx) => {
    const league = await lockLeague(tx, leagueId);
    const settings = parseLeagueSettings(league.settings);
    const finalized = await getFinalizedWeeks(tx, leagueId);
    const check = canFinalizeWeek({
      week,
      status: league.status,
      schedule: settings.schedule,
      seasonStart: league.seasonStart,
      today: todayIn(settings.schedule.timezone, now),
      finalizedWeeks: finalized,
    });
    if (!check.ok) throw new UserError(check.reason);

    await snapshotWeek(tx, leagueId, week);
    await tx.insert(weekFinalizations).values({ leagueId, week, finalizedBy: userId });
    finalized.add(week);

    const settled = await settleReadyMatchups(tx, leagueId, finalized);
    const outcome = await advanceSeason(tx, league, settings.schedule);
    return { week, settled, ...outcome };
  });
}

/**
 * Finalize every week that has ended and isn't final yet, in order (handy for
 * the seed script). Stops at the first week that can't be finalized.
 */
export async function finalizeEndedWeeks(
  db: DbOrTx,
  leagueId: string,
  userId: string | null,
  now: Date = new Date(),
): Promise<FinalizeResult[]> {
  const out: FinalizeResult[] = [];
  for (let guard = 0; guard < 200; guard++) {
    const [league] = await db.select().from(leagues).where(eq(leagues.id, leagueId));
    if (!league) break;
    const settings = parseLeagueSettings(league.settings);
    const finalized = await getFinalizedWeeks(db, leagueId);
    let next = 1;
    while (finalized.has(next)) next++;
    const check = canFinalizeWeek({
      week: next,
      status: league.status,
      schedule: settings.schedule,
      seasonStart: league.seasonStart,
      today: todayIn(settings.schedule.timezone, now),
      finalizedWeeks: finalized,
    });
    if (!check.ok) break;
    out.push(await finalizeWeek(db, leagueId, next, userId, now));
  }
  return out;
}

export type ReopenResult = {
  week: number;
  /** Matchups that went back to "not final". */
  reopened: number;
  /** Playoff rounds deleted because they were generated from this week. */
  removedRounds: number[];
  status: LeagueStatus;
};

/**
 * Reopen the most recently finalized week (see the file comment for how
 * generated playoff rounds are handled).
 */
export async function reopenWeek(db: DbOrTx, leagueId: string, week: number): Promise<ReopenResult> {
  return db.transaction(async (tx) => {
    const league = await lockLeague(tx, leagueId);
    const finalized = await getFinalizedWeeks(tx, leagueId);
    const check = canReopenWeek(week, finalized);
    if (!check.ok) throw new UserError(check.reason);

    // Playoff rounds that start after this week were generated by finalizing it.
    const generated = await tx
      .select()
      .from(matchups)
      .where(and(eq(matchups.leagueId, leagueId), eq(matchups.isPlayoff, true), gt(matchups.weekStart, week)));
    if (generated.some((m) => [...finalized].some((w) => m.weekStart <= w && w <= m.weekEnd))) {
      throw new UserError("A later playoff round already has final weeks. Reopen those weeks first.");
    }
    const removedRounds = [...new Set(generated.map((m) => m.playoffRound ?? 1))].sort((a, b) => a - b);
    if (generated.length) await tx.delete(matchups).where(inArray(matchups.id, generated.map((m) => m.id)));

    await tx.delete(weekFinalizations).where(and(eq(weekFinalizations.leagueId, leagueId), eq(weekFinalizations.week, week)));
    await clearWeekSnapshot(tx, leagueId, [week]);

    // Byes have no scores to redo, so they stay settled.
    const reopened = await tx
      .update(matchups)
      .set({ final: false, scoreA: null, scoreB: null, winnerTeamId: null })
      .where(
        and(
          eq(matchups.leagueId, leagueId),
          lte(matchups.weekStart, week),
          gte(matchups.weekEnd, week),
          eq(matchups.isBye, false),
        ),
      )
      .returning({ id: matchups.id });

    let status = league.status;
    if (status === "in_season" || status === "playoffs" || status === "complete") {
      const [{ n }] = await tx
        .select({ n: count() })
        .from(matchups)
        .where(and(eq(matchups.leagueId, leagueId), eq(matchups.isPlayoff, true)));
      status = n > 0 ? "playoffs" : "in_season";
      if (status !== league.status) await tx.update(leagues).set({ status }).where(eq(leagues.id, leagueId));
    }
    return { week, reopened: reopened.length, removedRounds, status };
  });
}

// ---------------------------------------------------------------------------
// DB: lookups for pages
// ---------------------------------------------------------------------------

/** Pending (unreviewed) scoring events in the league's pool, counted by season week. */
export async function pendingEventCountsByWeek(
  db: DbOrTx,
  args: { poolId: string; seasonStart: string; totalWeeks: number },
): Promise<Map<number, number>> {
  const { poolId, seasonStart, totalWeeks } = args;
  const out = new Map<number, number>();
  if (totalWeeks < 1) return out;
  const rows = await db
    .select({ occurredOn: scoringEvents.occurredOn, n: count() })
    .from(scoringEvents)
    .where(
      and(
        eq(scoringEvents.poolId, poolId),
        eq(scoringEvents.status, "pending"),
        gte(scoringEvents.occurredOn, weekStartDate(1, seasonStart)),
        lte(scoringEvents.occurredOn, weekEndDate(totalWeeks, seasonStart)),
      ),
    )
    .groupBy(scoringEvents.occurredOn)
    .orderBy(asc(scoringEvents.occurredOn));
  for (const r of rows) {
    const w = weekOfDate(r.occurredOn, seasonStart);
    out.set(w, (out.get(w) ?? 0) + r.n);
  }
  return out;
}

/** Week rows for the commissioner page, computed for "now" in league time. */
export async function getWeekStatuses(db: DbOrTx, leagueId: string, now: Date = new Date()): Promise<WeekStatusRow[]> {
  const [league] = await db.select().from(leagues).where(eq(leagues.id, leagueId));
  if (!league) throw new Error("League not found");
  const settings = parseLeagueSettings(league.settings);
  const finalized = await getFinalizedWeeks(db, leagueId);
  return weekStatusList({
    schedule: settings.schedule,
    seasonStart: league.seasonStart,
    today: todayIn(settings.schedule.timezone, now),
    finalizedWeeks: finalized,
    status: league.status,
  });
}
