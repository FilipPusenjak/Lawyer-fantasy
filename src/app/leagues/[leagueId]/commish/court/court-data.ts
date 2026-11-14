/**
 * Read-only DB loaders for the court-data screens (no CourtListener calls).
 */
import { asc, eq } from "drizzle-orm";
import type { DbOrTx } from "@/db";
import { cases } from "@/db/schema";
import { syncSourceForCase } from "@/server/services/court-sync";
import { courtStats, type CourtCaseRow, type CourtStats } from "./court-rules";

/** Every case in the pool with its court-sync columns, by caption. */
export async function loadCourtCases(db: DbOrTx, poolId: string): Promise<CourtCaseRow[]> {
  return db
    .select({
      id: cases.id,
      caption: cases.caption,
      caseType: cases.caseType,
      status: cases.status,
      court: cases.court,
      docketNumber: cases.docketNumber,
      courtlistenerDocketId: cases.courtlistenerDocketId,
      syncedAt: cases.syncedAt,
      syncError: cases.syncError,
    })
    .from(cases)
    .where(eq(cases.poolId, poolId))
    .orderBy(asc(cases.caption));
}

/** Counts for the hub, pool and Court data cards. */
export async function poolCourtStats(db: DbOrTx, poolId: string): Promise<CourtStats> {
  return courtStats(await loadCourtCases(db, poolId), syncSourceForCase);
}
