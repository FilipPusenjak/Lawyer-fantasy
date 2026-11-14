/**
 * Lazy league maintenance: process anything that has come due. Called on every
 * league page view (inside getLeagueContext) and from the daily cron for every
 * league. Each step must be cheap when there is nothing to do, and safe to run
 * concurrently (use row locks / conditional updates).
 *
 * Page views use the forgiving mode: a failing waiver run or trade is logged
 * and retried later, so one bad record can't take the league's pages down. The
 * cron passes `strict: true` so failures surface in its response and logs.
 */
import { eq } from "drizzle-orm";
import { db as defaultDb, type DbOrTx } from "@/db";
import { leagues } from "@/db/schema";
import { advanceClock } from "./draft";
import { processDueTrades } from "./trades-processing";
import { processDueWaivers, runDueWaivers } from "./waivers-processing";

export async function runLeagueMaintenance(
  leagueId: string,
  now: Date = new Date(),
  db: DbOrTx = defaultDb,
  opts: { strict?: boolean } = {},
): Promise<void> {
  const [league] = await db.select({ status: leagues.status }).from(leagues).where(eq(leagues.id, leagueId));
  if (!league) return;
  if (league.status === "drafting") {
    // Auto-pick for anyone whose clock ran out, even if nobody has the draft room open.
    await advanceClock(db, leagueId, now);
    return;
  }
  if (league.status === "in_season" || league.status === "playoffs") {
    if (opts.strict) await runDueWaivers(db, leagueId, now);
    else await processDueWaivers(db, leagueId, now);
    await processDueTrades(db, leagueId, now, { strict: opts.strict });
  }
}
