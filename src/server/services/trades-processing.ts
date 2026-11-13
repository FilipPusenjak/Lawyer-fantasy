import type { DbOrTx } from "@/db";

/**
 * STUB — to be implemented by the trades feature.
 * Execute accepted trades whose review window (reviewEndsAt) has passed.
 */
export async function processDueTrades(db: DbOrTx, leagueId: string, now: Date): Promise<void> {
  void db;
  void leagueId;
  void now;
}
