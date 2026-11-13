import type { DbOrTx } from "@/db";

/**
 * STUB — to be implemented by the waivers feature.
 * If the league's nextWaiverRunAt <= now: process pending claims with
 * processWaivers() (src/lib/waivers.ts), clear waiver holds, update
 * waiver priorities, and schedule the next run.
 */
export async function processDueWaivers(db: DbOrTx, leagueId: string, now: Date): Promise<void> {
  void db;
  void leagueId;
  void now;
}
