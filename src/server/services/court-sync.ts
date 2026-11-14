/**
 * Court data sync (Phase 2). CONTRACT FILE: signatures are fixed; the
 * implementation is filled in by the court-data core work.
 *
 * Sources:
 * - U.S. Supreme Court cases (case_type supreme_court, docket like "25-159"):
 *   https://www.supremecourt.gov/RSS/Cases/JSON/<docket>.json (no token, no quota).
 * - Other federal cases with cases.courtlistenerDocketId: CourtListener v4
 *   docket entries (token required; shared free quota).
 *
 * New court activity becomes PENDING scoring events (origin "courtlistener"
 * for both sources, externalRef unique per pool, e.g. "cl-entry:123" or
 * "scotus:25-159:7") with a suggested type and, when it can be inferred, a
 * side or a specific lawyer. Nothing counts until the commissioner approves.
 */
import type { DbOrTx } from "@/db";

export type SyncSource = "scotus" | "courtlistener";

export type SyncResult = {
  caseId: string;
  caption: string;
  source: SyncSource;
  /** New docket entries / proceedings seen this run. */
  newEntries: number;
  /** Pending scoring events created this run. */
  suggestions: number;
  error?: string;
};

/** "25-159" when the case is a Supreme Court case with a docket number in that form, else null. */
export function scotusDocketFromCase(c: { caseType: string; docketNumber: string | null }): string | null {
  void c;
  return null;
}

/** Which source a case syncs from, or null if it can't sync (not linked / not SCOTUS). */
export function syncSourceForCase(c: { caseType: string; docketNumber: string | null; courtlistenerDocketId: number | null }): SyncSource | null {
  void c;
  return null;
}

/** Pull new activity for one case and create pending suggestions. */
export async function syncCase(db: DbOrTx, caseId: string, now: Date = new Date()): Promise<SyncResult> {
  void db;
  void caseId;
  void now;
  throw new Error("Not implemented");
}

/**
 * Daily run (cron): sync every active case in every pool used by a league that
 * is drafting/in season/in playoffs. Supreme Court cases all sync; CourtListener
 * cases are synced least-recently-synced first, stopping at `maxCourtListenerCalls`
 * API requests or `deadlineMs` (epoch ms), so a run fits the free quota and
 * Vercel's function time limit.
 */
export async function runCourtSync(
  db: DbOrTx,
  now: Date = new Date(),
  opts: { maxCourtListenerCalls?: number; deadlineMs?: number } = {},
): Promise<{ results: SyncResult[]; skipped: number }> {
  void db;
  void now;
  void opts;
  throw new Error("Not implemented");
}

/** Link (or unlink with null) a pool case to a CourtListener docket. Verifies the case is in the pool. */
export async function linkCaseToDocket(db: DbOrTx, poolId: string, caseId: string, docketId: number | null): Promise<void> {
  void db;
  void poolId;
  void caseId;
  void docketId;
  throw new Error("Not implemented");
}

/**
 * Try to link unlinked federal (non-SCOTUS) pool cases to CourtListener dockets
 * by docket number (+ court when known). Uses at most `max` API requests.
 */
export async function autoLinkPoolCases(
  db: DbOrTx,
  poolId: string,
  opts: { max?: number } = {},
): Promise<{ linked: { caseId: string; docketId: number }[]; notFound: string[]; remaining: number }> {
  void db;
  void poolId;
  void opts;
  throw new Error("Not implemented");
}
