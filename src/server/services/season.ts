/**
 * Season setup after the draft: schedule, waiver order, waiver holds for
 * undrafted lawyers, and starting lineups.
 */
import { asc, eq } from "drizzle-orm";
import type { DbOrTx } from "@/db";
import { lawyers, leagues, matchups, rosterSpots, teams, waiverHolds } from "@/db/schema";
import { autoFillLineup } from "@/lib/lineup";
import { regularSeasonSchedule } from "@/lib/schedule";
import { parseLeagueSettings, starterSlots } from "@/lib/settings";
import { editableWeek } from "@/lib/time";
import { leagueClock, saveLineup } from "./lineups";
import { scheduleNextWaiverRun } from "./league";
import { getTeamRoster } from "./roster";

/**
 * Called once when the draft completes (inside the draft's transaction).
 * Idempotent-ish: refuses to run if matchups already exist.
 */
export async function startSeason(db: DbOrTx, leagueId: string, now: Date = new Date()): Promise<void> {
  const [league] = await db.select().from(leagues).where(eq(leagues.id, leagueId));
  if (!league) throw new Error("League not found");
  const existing = await db.select({ id: matchups.id }).from(matchups).where(eq(matchups.leagueId, leagueId)).limit(1);
  if (existing.length > 0) return;
  const settings = parseLeagueSettings(league.settings);

  const leagueTeams = await db.select().from(teams).where(eq(teams.leagueId, leagueId)).orderBy(asc(teams.draftPosition));
  const teamIds = leagueTeams.map((t) => t.id);

  // Regular-season schedule
  const sched = regularSeasonSchedule(teamIds, settings.schedule);
  const rows = sched.flatMap((p) =>
    p.pairings.map((pair) => ({
      leagueId,
      period: p.period,
      weekStart: p.weekStart,
      weekEnd: p.weekEnd,
      isPlayoff: false,
      teamAId: pair.teamA,
      teamBId: pair.teamB,
      isMedian: pair.teamB === null,
    })),
  );
  if (rows.length) await db.insert(matchups).values(rows);

  // Waiver priority: reverse draft order
  const reversed = [...leagueTeams].reverse();
  for (let i = 0; i < reversed.length; i++) {
    await db.update(teams).set({ waiverPriority: i + 1 }).where(eq(teams.id, reversed[i].id));
  }

  // Undrafted lawyers start on waivers until the first waiver run
  const pool = await db.select({ id: lawyers.id }).from(lawyers).where(eq(lawyers.poolId, league.poolId));
  const rostered = new Set(
    (await db.select({ lawyerId: rosterSpots.lawyerId }).from(rosterSpots).where(eq(rosterSpots.leagueId, leagueId))).map(
      (r) => r.lawyerId,
    ),
  );
  const holds = pool.filter((l) => !rostered.has(l.id)).map((l) => ({ leagueId, lawyerId: l.id }));
  if (holds.length) await db.insert(waiverHolds).values(holds).onConflictDoNothing();

  await scheduleNextWaiverRun(db, leagueId, settings, now);

  // Starting lineups for the first editable week
  const week = editableWeek(now, leagueClock({ seasonStart: league.seasonStart, settings }));
  const n = starterSlots(settings.roster).length;
  for (const t of leagueTeams) {
    const roster = await getTeamRoster(db, t.id);
    const lineup = autoFillLineup(new Array(n).fill(null), settings.roster, roster);
    await saveLineup(db, t.id, week, lineup);
  }

  await db.update(leagues).set({ status: "in_season" }).where(eq(leagues.id, leagueId));
}
