/**
 * Lazy league maintenance: process anything that has come due. Called from the
 * league layout on every page view and from the daily cron for every league.
 * Each step must be cheap when there is nothing to do, and safe to run
 * concurrently (use row locks / conditional updates).
 */
import { db as defaultDb, type DbOrTx } from "@/db";
import { processDueTrades } from "./trades-processing";
import { processDueWaivers } from "./waivers-processing";

export async function runLeagueMaintenance(leagueId: string, now: Date = new Date(), db: DbOrTx = defaultDb): Promise<void> {
  await processDueWaivers(db, leagueId, now);
  await processDueTrades(db, leagueId, now);
}
