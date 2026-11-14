import { and, asc, eq, lte } from "drizzle-orm";
import type { DbOrTx } from "@/db";
import { trades } from "@/db/schema";
import { executeTrade } from "./trades";

/**
 * Execute accepted trades whose commissioner review window (reviewEndsAt) has
 * passed. One cheap indexed query when nothing is due. Each trade runs in its
 * own transaction; executeTrade locks the trade and no-ops unless it is still
 * `accepted`, so concurrent page views / cron runs can't execute it twice.
 */
export async function processDueTrades(db: DbOrTx, leagueId: string, now: Date): Promise<void> {
  const due = await db
    .select({ id: trades.id })
    .from(trades)
    .where(and(eq(trades.leagueId, leagueId), eq(trades.status, "accepted"), lte(trades.reviewEndsAt, now)))
    .orderBy(asc(trades.reviewEndsAt), asc(trades.createdAt));
  for (const t of due) {
    try {
      await executeTrade(db, t.id, now);
    } catch (e) {
      // Never break a page view over one trade; the next maintenance run retries it.
      console.error(`processDueTrades: trade ${t.id} failed to process`, e);
    }
  }
}
