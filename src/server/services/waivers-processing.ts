/**
 * Weekly waiver processing. Runs lazily from league maintenance (every league
 * page view and the daily cron), so it must be cheap when nothing is due and
 * safe to run concurrently.
 *
 * A run is "claimed" by moving leagues.next_waiver_run_at forward with a
 * conditional UPDATE inside the processing transaction; a concurrent run
 * blocks on that row lock and then finds nothing due.
 */
import { and, eq, inArray, lte } from "drizzle-orm";
import type { DbOrTx } from "@/db";
import { lawyers, leagues, rosterSpots, teams, transactions, waiverClaims, waiverHolds } from "@/db/schema";
import { parseLeagueSettings } from "@/lib/settings";
import { nextWeeklyTime } from "@/lib/time";
import { holdReleasable, processWaivers, type ClaimInput } from "@/lib/waivers";
import { scheduleNextWaiverRun } from "./league";
import { addLawyerToTeam, maxRosterSize, removeLawyerFromTeam } from "./roster";

// ---------------------------------------------------------------------------
// Pure helpers (unit tested)
// ---------------------------------------------------------------------------

/**
 * Team ids in waiver order: by waiverPriority (1 first); teams without a
 * priority go last, oldest team first; ties break by id for determinism.
 */
export function waiverOrder(rows: { id: string; waiverPriority: number | null; createdAt: Date }[]): string[] {
  return [...rows]
    .sort(
      (a, b) =>
        (a.waiverPriority ?? Number.MAX_SAFE_INTEGER) - (b.waiverPriority ?? Number.MAX_SAFE_INTEGER) ||
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.id.localeCompare(b.id),
    )
    .map((r) => r.id);
}

/** Is a waiver run due? (Only in season / playoffs, and only once the scheduled time has passed.) */
export function waiverRunDue(league: { status: string; nextWaiverRunAt: Date | null }, now: Date): boolean {
  if (league.status !== "in_season" && league.status !== "playoffs") return false;
  return league.nextWaiverRunAt !== null && league.nextWaiverRunAt.getTime() <= now.getTime();
}

// ---------------------------------------------------------------------------
// Processing
// ---------------------------------------------------------------------------

export type WaiverRunSummary = {
  ranAt: Date;
  nextRunAt: Date;
  awarded: { claimId: string; teamId: string; addLawyerId: string; dropLawyerId: string | null }[];
  lost: string[];
  finalPriority: string[];
};

/**
 * Process waivers if a run is due. Returns a summary when a run happened,
 * null otherwise. Throws on unexpected errors (the transaction rolls back and
 * the run is retried on the next call).
 */
export async function runDueWaivers(db: DbOrTx, leagueId: string, now: Date): Promise<WaiverRunSummary | null> {
  // Cheap check first: one small query when nothing is due.
  const [league] = await db
    .select({ status: leagues.status, nextWaiverRunAt: leagues.nextWaiverRunAt, settings: leagues.settings })
    .from(leagues)
    .where(eq(leagues.id, leagueId));
  if (!league) return null;
  if (league.status !== "in_season" && league.status !== "playoffs") return null;
  if (league.nextWaiverRunAt === null) {
    // Should have been set when the season started; schedule it now.
    await scheduleNextWaiverRun(db, leagueId, parseLeagueSettings(league.settings), now);
    return null;
  }
  if (!waiverRunDue(league, now)) return null;

  return db.transaction(async (tx) => {
    const settings = parseLeagueSettings(league.settings);
    const nextRunAt = nextWeeklyTime(now, settings.waivers.processDay, settings.waivers.processTime, settings.schedule.timezone);
    // The scheduled time of the run being processed (runs are lazy, so this can
    // be hours before `now`). Hold ages are judged against it, so a lawyer clears
    // on the date the screens showed (waiverClearTime), not earlier. Locking the
    // row here takes the same lock the claiming UPDATE below would.
    const [scheduled] = await tx
      .select({ nextWaiverRunAt: leagues.nextWaiverRunAt })
      .from(leagues)
      .where(eq(leagues.id, leagueId))
      .for("update");
    const scheduledRunAt = scheduled?.nextWaiverRunAt ?? null;
    if (!scheduledRunAt || scheduledRunAt.getTime() > now.getTime()) return null;
    // Claim the run atomically. A concurrent run blocks here, then matches no row.
    const [claimed] = await tx
      .update(leagues)
      .set({ nextWaiverRunAt: nextRunAt, lastWaiverRunAt: now })
      .where(
        and(eq(leagues.id, leagueId), lte(leagues.nextWaiverRunAt, now), inArray(leagues.status, ["in_season", "playoffs"])),
      )
      .returning({ id: leagues.id, seasonStart: leagues.seasonStart, settings: leagues.settings });
    if (!claimed) return null;
    const freshSettings = parseLeagueSettings(claimed.settings);
    const leagueInfo = { id: claimed.id, seasonStart: claimed.seasonStart, settings: freshSettings };

    const [teamRows, pending, spots, holds] = await Promise.all([
      tx
        .select({ id: teams.id, waiverPriority: teams.waiverPriority, createdAt: teams.createdAt })
        .from(teams)
        .where(eq(teams.leagueId, leagueId)),
      tx
        .select()
        .from(waiverClaims)
        .where(and(eq(waiverClaims.leagueId, leagueId), eq(waiverClaims.status, "pending"))),
      tx.select({ teamId: rosterSpots.teamId, lawyerId: rosterSpots.lawyerId }).from(rosterSpots).where(eq(rosterSpots.leagueId, leagueId)),
      tx.select({ lawyerId: waiverHolds.lawyerId, createdAt: waiverHolds.createdAt }).from(waiverHolds).where(eq(waiverHolds.leagueId, leagueId)),
    ]);

    // The waiver period is over for lawyers who had been on waivers long
    // enough by the scheduled run time: anyone of them left unclaimed becomes a
    // free agent. Lawyers dropped too recently stay on waivers until the next
    // run, and claims on them stay pending for it. (Moves run a due run first,
    // so no hold is created between the scheduled time and now.)
    const tooNew = new Set(holds.filter((h) => !holdReleasable(h.createdAt, scheduledRunAt)).map((h) => h.lawyerId));
    const released = holds.filter((h) => !tooNew.has(h.lawyerId)).map((h) => h.lawyerId);
    if (released.length) {
      await tx.delete(waiverHolds).where(and(eq(waiverHolds.leagueId, leagueId), inArray(waiverHolds.lawyerId, released)));
    }

    const rosters = new Map<string, Set<string>>();
    for (const t of teamRows) rosters.set(t.id, new Set());
    for (const s of spots) rosters.get(s.teamId)?.add(s.lawyerId);
    const teamIds = new Set(teamRows.map((t) => t.id));
    const claims: ClaimInput[] = pending
      .filter((c) => teamIds.has(c.teamId) && !tooNew.has(c.addLawyerId))
      .map((c) => ({
        id: c.id,
        teamId: c.teamId,
        addLawyerId: c.addLawyerId,
        dropLawyerId: c.dropLawyerId,
        claimOrder: c.claimOrder,
        createdAt: c.createdAt.getTime(),
      }));

    const result = processWaivers({
      priority: waiverOrder(teamRows),
      claims,
      rosters,
      maxRoster: maxRosterSize(freshSettings),
    });

    // Names for the activity log.
    const involved = [...new Set(result.awarded.flatMap((a) => (a.dropLawyerId ? [a.addLawyerId, a.dropLawyerId] : [a.addLawyerId])))];
    const names = new Map(
      involved.length
        ? (await tx.select({ id: lawyers.id, name: lawyers.name }).from(lawyers).where(inArray(lawyers.id, involved))).map((l) => [
            l.id,
            l.name,
          ])
        : [],
    );

    const logs: (typeof transactions.$inferInsert)[] = [];
    let tick = 0;
    const at = () => new Date(now.getTime() + tick++);
    for (const a of result.awarded) {
      if (a.dropLawyerId) {
        await removeLawyerFromTeam(tx, { league: leagueInfo, teamId: a.teamId, lawyerId: a.dropLawyerId, toWaivers: true, now });
        logs.push({
          leagueId,
          teamId: a.teamId,
          type: "drop",
          lawyerId: a.dropLawyerId,
          description: `Dropped ${names.get(a.dropLawyerId) ?? "a lawyer"} (to waivers)`,
          createdAt: at(),
        });
      }
      await addLawyerToTeam(tx, { leagueId, settings: freshSettings, teamId: a.teamId, lawyerId: a.addLawyerId, via: "waiver" });
      logs.push({
        leagueId,
        teamId: a.teamId,
        type: "waiver_add",
        lawyerId: a.addLawyerId,
        description: `Claimed ${names.get(a.addLawyerId) ?? "a lawyer"} off waivers`,
        createdAt: at(),
      });
    }

    const wonIds = result.awarded.map((a) => a.claimId);
    if (wonIds.length) {
      await tx.update(waiverClaims).set({ status: "won", processedAt: now }).where(inArray(waiverClaims.id, wonIds));
    }
    if (result.lost.length) {
      await tx.update(waiverClaims).set({ status: "lost", processedAt: now }).where(inArray(waiverClaims.id, result.lost));
    }
    for (let i = 0; i < result.finalPriority.length; i++) {
      await tx.update(teams).set({ waiverPriority: i + 1 }).where(eq(teams.id, result.finalPriority[i]));
    }
    if (logs.length) await tx.insert(transactions).values(logs);

    return { ranAt: now, nextRunAt, awarded: result.awarded, lost: result.lost, finalPriority: result.finalPriority };
  });
}

/**
 * Called by league maintenance. Never throws: a failed run is logged and
 * retried on the next page view, so a bad claim can't take the league down.
 */
export async function processDueWaivers(db: DbOrTx, leagueId: string, now: Date): Promise<WaiverRunSummary | null> {
  try {
    return await runDueWaivers(db, leagueId, now);
  } catch (e) {
    console.error(`Waiver processing failed for league ${leagueId}`, e);
    return null;
  }
}
