/**
 * Lazy league maintenance: process anything that has come due. Called from the
 * league layout on every page view and from the daily cron for every league.
 * Each step must be cheap when there is nothing to do, and safe to run
 * concurrently (use row locks / conditional updates).
 */
import { eq } from "drizzle-orm";
import { db as defaultDb, type DbOrTx } from "@/db";
import { leagues } from "@/db/schema";
import { advanceClock } from "./draft";
import { processDueTrades } from "./trades-processing";
import { processDueWaivers } from "./waivers-processing";

export async function runLeagueMaintenance(leagueId: string, now: Date = new Date(), db: DbOrTx = defaultDb): Promise<void> {
  const [league] = await db.select({ status: leagues.status }).from(leagues).where(eq(leagues.id, leagueId));
  if (!league) return;
  if (league.status === "drafting") {
    // Auto-pick for anyone whose clock ran out, even if nobody has the draft room open.
    await advanceClock(db, leagueId, now);
    return;
  }
  if (league.status === "in_season" || league.status === "playoffs") {
    await processDueWaivers(db, leagueId, now);
    await processDueTrades(db, leagueId, now);
  }
}
