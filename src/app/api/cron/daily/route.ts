import { createHash, timingSafeEqual } from "node:crypto";
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { leagues } from "@/db/schema";
import { runCourtSync, type SyncResult } from "@/server/services/court-sync";
import { runLeagueMaintenance } from "@/server/services/maintenance";

/**
 * Daily Vercel Cron job (see vercel.json). Vercel sends
 * "Authorization: Bearer <CRON_SECRET>". Runs lazy maintenance (waivers,
 * trade reviews, …) for every active league so they stay current even when
 * nobody opens the app, then pulls court data (Supreme Court feed +
 * CourtListener) into pending suggestions for the commissioners.
 */
export const dynamic = "force-dynamic";
/** Vercel Hobby's limit. Court sync paces CourtListener requests (5/min) and stops at COURT_SYNC_BUDGET_MS. */
export const maxDuration = 300;

/** Court sync must finish this long after the route starts (leaves ~30 s of the 300 s for the response). */
const COURT_SYNC_BUDGET_MS = 270_000;
/** CourtListener requests per daily run (free tier: 125/day shared with the commissioner screens). */
const COURT_SYNC_MAX_CALLS = 20;

const ACTIVE_STATUSES = ["drafting", "in_season", "playoffs"] as const;

function digest(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

function isAuthorized(header: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || !header) return false;
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}

export async function GET(request: Request) {
  if (!isAuthorized(request.headers.get("authorization"))) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = new Date();
  const active = await db
    .select({ id: leagues.id, status: leagues.status })
    .from(leagues)
    .where(inArray(leagues.status, [...ACTIVE_STATUSES]));

  const results: { leagueId: string; status: string; ok: boolean; ms: number; error?: string }[] = [];
  for (const league of active) {
    const t0 = Date.now();
    try {
      await runLeagueMaintenance(league.id, new Date(), undefined, { strict: true });
      results.push({ leagueId: league.id, status: league.status, ok: true, ms: Date.now() - t0 });
    } catch (e) {
      // One broken league shouldn't stop the others.
      console.error(`[cron/daily] maintenance failed for league ${league.id}`, e);
      results.push({
        leagueId: league.id,
        status: league.status,
        ok: false,
        ms: Date.now() - t0,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Court data. Per-case problems are recorded on the case (cases.syncError) and
  // listed here; they don't fail the run. Only a crash of the whole sync does.
  let court: { ok: boolean; cases: number; suggestions: number; skipped: number; errors: number; ms: number; results: SyncResult[]; error?: string };
  const t0 = Date.now();
  try {
    const sync = await runCourtSync(db, new Date(), {
      maxCourtListenerCalls: COURT_SYNC_MAX_CALLS,
      deadlineMs: startedAt.getTime() + COURT_SYNC_BUDGET_MS,
    });
    court = {
      ok: true,
      cases: sync.results.length,
      suggestions: sync.results.reduce((n, r) => n + r.suggestions, 0),
      skipped: sync.skipped,
      errors: sync.results.filter((r) => r.error).length,
      ms: Date.now() - t0,
      results: sync.results,
    };
  } catch (e) {
    console.error("[cron/daily] court sync failed", e);
    court = {
      ok: false,
      cases: 0,
      suggestions: 0,
      skipped: 0,
      errors: 0,
      ms: Date.now() - t0,
      results: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }

  const failed = results.filter((r) => !r.ok).length;
  const ok = failed === 0 && court.ok;
  return Response.json(
    {
      ok,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      leagues: results.length,
      succeeded: results.length - failed,
      failed,
      results,
      court,
    },
    { status: ok ? 200 : 500 },
  );
}
