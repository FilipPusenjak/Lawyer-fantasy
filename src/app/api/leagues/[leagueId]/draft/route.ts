/**
 * Draft room polling endpoint.
 *
 * GET /api/leagues/:leagueId/draft[?since=<version>][&pool=1]
 * - Runs the lazy pick clock first (auto-picks for expired deadlines).
 * - `since`: if the draft's version still equals it, returns a tiny
 *   `{ unchanged: true }` payload instead of the full state.
 * - `pool=1`: include the league's lawyer pool (the room loads it once).
 * Signed out → 401, not a member → 404 (JSON, never a redirect).
 */
import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { leagueMembers, teams } from "@/db/schema";
import { isUuid } from "@/lib/format";
import { getCurrentUser } from "@/server/auth/session";
import { advanceClock, getDraftState, peekDraft } from "@/server/services/draft";
import { shapeDraftState, type DraftPollJson } from "@/components/draft/model";

const NO_STORE = { "Cache-Control": "no-store" };

function error(status: number, message: string): Response {
  return Response.json({ error: message }, { status, headers: NO_STORE });
}

export async function GET(request: NextRequest, ctx: RouteContext<"/api/leagues/[leagueId]/draft">): Promise<Response> {
  const { leagueId } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return error(401, "Please sign in again.");
  if (!isUuid(leagueId)) return error(404, "League not found.");

  const [member] = await db
    .select({ role: leagueMembers.role })
    .from(leagueMembers)
    .where(and(eq(leagueMembers.leagueId, leagueId), eq(leagueMembers.userId, user.id)));
  if (!member) return error(404, "League not found.");

  const now = new Date();
  await advanceClock(db, leagueId, now);

  const params = request.nextUrl.searchParams;
  const since = Number(params.get("since"));
  const includePool = params.get("pool") === "1";
  if (params.has("since") && Number.isInteger(since) && !includePool) {
    const peek = await peekDraft(db, leagueId);
    if (peek && peek.version === since) {
      const body: DraftPollJson = { unchanged: true, version: peek.version, serverNow: new Date().toISOString() };
      return Response.json(body, { headers: NO_STORE });
    }
  }

  const [team] = await db
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.leagueId, leagueId), eq(teams.ownerId, user.id)));
  const state = await getDraftState(db, leagueId, { teamId: team?.id ?? null, includeLawyers: includePool });
  const body: DraftPollJson = shapeDraftState(state, {
    myTeamId: team?.id ?? null,
    isCommissioner: member.role === "commissioner",
    now: new Date(),
    includePool,
  });
  return Response.json(body, { headers: NO_STORE });
}
