import { createHash, timingSafeEqual } from "node:crypto";
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { leagues } from "@/db/schema";
import { runLeagueMaintenance } from "@/server/services/maintenance";

/**
 * Daily Vercel Cron job (see vercel.json). Vercel sends
 * "Authorization: Bearer <CRON_SECRET>". Runs lazy maintenance (waivers,
 * trade reviews, …) for every active league so they stay current even when
 * nobody opens the app.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

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

  const failed = results.filter((r) => !r.ok).length;
  return Response.json(
    {
      ok: failed === 0,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      leagues: results.length,
      succeeded: results.length - failed,
      failed,
      results,
    },
    { status: failed === 0 ? 200 : 500 },
  );
}
