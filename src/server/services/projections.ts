/**
 * Scouting service: projections and rankings for every lawyer and firm in a
 * league's pool, plus each one's status in the league (rostered / waivers /
 * free agent). The model itself is pure (src/lib/projections.ts); this file
 * only loads data (one round of queries after the league row) and computes in
 * memory.
 *
 * No `server-only` / cookies so scripts can use it. Accepts `db: DbOrTx`.
 */
import { and, count, eq, inArray, sql } from "drizzle-orm";
import { cache } from "react";
import { db as defaultDb, type DbOrTx } from "@/db";
import { cases, lawyers, leagueMembers, leagues, rosterSpots, teams, users, waiverHolds, type League } from "@/db/schema";
import {
  historyEndDate,
  projectionWeeks,
  projectPool,
  rankProjections,
  type ProjectionWeeks,
  type RankedProjection,
} from "@/lib/projections";
import { parseCaseOutlook } from "@/lib/outlook";
import { parseLeagueSettings, totalSeasonWeeks, type LeagueSettings } from "@/lib/settings";
import { UserError } from "@/server/action-result";
import { isAdminUser } from "@/server/auth/admin";
import { loadApprovedEvents, loadPoolAppearances, loadPoolLawyers } from "./scores";

export type ProjectionLeagueStatus =
  | { kind: "rostered"; teamId: string; teamName: string }
  | { kind: "waivers" }
  | { kind: "free_agent" };

export type LeagueProjectionRow = RankedProjection & {
  kind: "lawyer" | "firm";
  firmId: string | null;
  /** Name of the lawyer's firm (a firm entity in the pool), if any. */
  firmName: string | null;
  organization: string | null;
  preseasonRank: number | null;
  status: ProjectionLeagueStatus;
};

export type LeagueProjections = {
  leagueId: string;
  poolId: string;
  leagueStatus: League["status"];
  settings: LeagueSettings;
  seasonStart: string;
  totalWeeks: number;
  /** Target week, history window end, weeks remaining and season phase. */
  weeks: ProjectionWeeks;
  lookbackWeeks: number;
  /** Last day (a Sunday, YYYY-MM-DD) of the history window. */
  historyEnd: string;
  /** False when the pool has no approved events yet (projections use the documented defaults). */
  poolHasHistory: boolean;
  /** Every pool lawyer and firm, best overall rank first. */
  rows: LeagueProjectionRow[];
  byLawyerId: Map<string, LeagueProjectionRow>;
};

/** Projections + ranks for every lawyer in the league's pool. */
export async function getLeagueProjections(db: DbOrTx, leagueId: string, now: Date = new Date()): Promise<LeagueProjections> {
  const [league] = await db
    .select({
      id: leagues.id,
      poolId: leagues.poolId,
      status: leagues.status,
      settings: leagues.settings,
      seasonStart: leagues.seasonStart,
    })
    .from(leagues)
    .where(eq(leagues.id, leagueId));
  if (!league) throw new UserError("League not found.");
  const settings = parseLeagueSettings(league.settings);
  const totalWeeks = totalSeasonWeeks(settings.schedule);
  const weeks = projectionWeeks(
    now,
    { seasonStart: league.seasonStart, lockTime: settings.schedule.lockTime, timeZone: settings.schedule.timezone },
    totalWeeks,
    league.status === "complete",
  );

  const [poolLawyers, caseRows, appearances, events, spots, holds] = await Promise.all([
    loadPoolLawyers(db, league.poolId),
    db
      .select({ id: cases.id, caseType: cases.caseType, status: cases.status, filedOn: cases.filedOn, outlook: cases.outlook })
      .from(cases)
      .where(eq(cases.poolId, league.poolId)),
    loadPoolAppearances(db, league.poolId),
    loadApprovedEvents(db, league.poolId),
    db
      .select({ lawyerId: rosterSpots.lawyerId, teamId: rosterSpots.teamId, teamName: teams.name })
      .from(rosterSpots)
      .innerJoin(teams, eq(teams.id, rosterSpots.teamId))
      .where(eq(rosterSpots.leagueId, leagueId)),
    db.select({ lawyerId: waiverHolds.lawyerId }).from(waiverHolds).where(eq(waiverHolds.leagueId, leagueId)),
  ]);

  const result = projectPool({
    lawyers: poolLawyers,
    cases: caseRows.map((c) => ({ ...c, outlook: parseCaseOutlook(c.outlook) })),
    appearances,
    events,
    scoring: settings.scoring,
    seasonStart: league.seasonStart,
    historyThroughWeek: weeks.historyThroughWeek,
    remainingWeeks: weeks.remainingWeeks,
    targetWeek: weeks.targetWeek,
  });
  const ranked = rankProjections(result.projections, poolLawyers);

  const status = new Map<string, ProjectionLeagueStatus>();
  for (const h of holds) status.set(h.lawyerId, { kind: "waivers" });
  // A rostered lawyer never keeps a hold, but rostered wins just in case.
  for (const s of spots) status.set(s.lawyerId, { kind: "rostered", teamId: s.teamId, teamName: s.teamName });
  const freeAgent: ProjectionLeagueStatus = { kind: "free_agent" };

  const byId = new Map(poolLawyers.map((l) => [l.id, l]));
  const rows: LeagueProjectionRow[] = ranked.map((r) => {
    const l = byId.get(r.lawyerId)!;
    const firm = l.firmId ? byId.get(l.firmId) : undefined;
    return {
      ...r,
      kind: l.kind,
      firmId: l.firmId,
      firmName: firm?.kind === "firm" ? firm.name : null,
      organization: l.organization,
      preseasonRank: l.preseasonRank,
      status: status.get(l.id) ?? freeAgent,
    };
  });

  return {
    leagueId,
    poolId: league.poolId,
    leagueStatus: league.status,
    settings,
    seasonStart: league.seasonStart,
    totalWeeks,
    weeks,
    lookbackWeeks: result.lookbackWeeks,
    historyEnd: historyEndDate(weeks.historyThroughWeek, league.seasonStart),
    poolHasHistory: result.poolHasHistory,
    rows,
    byLawyerId: new Map(rows.map((r) => [r.lawyerId, r])),
  };
}

/** Request-memoized projections for Server Components (several components can share one computation). */
export const getLeagueProjectionsCached = cache((leagueId: string) => getLeagueProjections(defaultDb, leagueId));

/** How many leagues use a pool (a pool can be shared, so pool edits reach all of them). */
export async function countPoolLeagues(db: DbOrTx, poolId: string): Promise<number> {
  const [r] = await db.select({ n: count() }).from(leagues).where(eq(leagues.poolId, poolId));
  return r?.n ?? 0;
}

/**
 * Same rule as canManagePool (src/server/league-context.ts), checked again
 * with the given db handle: site admins and commissioners of any league that
 * uses the pool.
 */
async function userCanManagePool(db: DbOrTx, userId: string, poolId: string): Promise<boolean> {
  const [u] = await db.select({ username: users.username, isAdmin: users.isAdmin }).from(users).where(eq(users.id, userId));
  if (!u) return false;
  if (isAdminUser(u)) return true;
  const rows = await db
    .select({ role: leagueMembers.role })
    .from(leagueMembers)
    .innerJoin(leagues, eq(leagues.id, leagueMembers.leagueId))
    .where(and(eq(leagueMembers.userId, userId), eq(leagues.poolId, poolId), eq(leagueMembers.role, "commissioner")))
    .limit(1);
  return rows.length > 0;
}

/**
 * Set `lawyers.preseason_rank` for every lawyer in the league's pool to their
 * season projection rank (1 = most projected points over the rest of the
 * season). Auto-pick in the draft uses these ranks. The pool may be shared by other leagues, which see the same
 * ranks. The Server Action must also check canManagePool; this re-checks.
 */
export async function applyProjectionRanks(
  db: DbOrTx,
  leagueId: string,
  userId: string,
  now: Date = new Date(),
): Promise<{ ranked: number; poolId: string; poolLeagueCount: number; targetWeek: number }> {
  const [league] = await db.select({ poolId: leagues.poolId }).from(leagues).where(eq(leagues.id, leagueId));
  if (!league) throw new UserError("League not found.");
  if (!(await userCanManagePool(db, userId, league.poolId))) throw new UserError("You can't manage this player pool.");

  const proj = await getLeagueProjections(db, leagueId, now);
  const poolLeagueCount = await countPoolLeagues(db, league.poolId);
  if (proj.rows.length === 0) return { ranked: 0, poolId: league.poolId, poolLeagueCount, targetWeek: proj.weeks.targetWeek };

  // One UPDATE: CASE id WHEN … THEN rank … END. Lawyers added since we loaded keep their rank.
  const whens = sql.join(
    proj.rows.map((r) => sql`when ${r.lawyerId}::uuid then ${r.overallRank}::integer`),
    sql` `,
  );
  const updated = await db
    .update(lawyers)
    .set({ preseasonRank: sql`case ${lawyers.id} ${whens} end` })
    .where(and(eq(lawyers.poolId, league.poolId), inArray(lawyers.id, proj.rows.map((r) => r.lawyerId))))
    .returning({ id: lawyers.id });

  return { ranked: updated.length, poolId: league.poolId, poolLeagueCount, targetWeek: proj.weeks.targetWeek };
}
