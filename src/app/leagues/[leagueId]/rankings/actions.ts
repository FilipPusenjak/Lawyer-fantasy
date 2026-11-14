"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { isUuid, plural } from "@/lib/format";
import { ok, runAction, UserError, type ActionResult } from "@/server/action-result";
import { actionLeagueContext, canManagePool } from "@/server/league-context";
import { applyProjectionRanks } from "@/server/services/projections";

const schema = z.object({ leagueId: z.string().refine(isUuid) });

/**
 * Set every pool lawyer's draft rank (stored as preseason_rank) to their projection rank.
 * Commissioners of this league who can manage its pool only.
 */
export async function applyProjectionRanksAction(_prev: unknown, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const parsed = schema.safeParse({ leagueId: formData.get("leagueId") });
    if (!parsed.success) throw new UserError("Something was off with that request. Refresh and try again.");
    const { leagueId } = parsed.data;
    const ctx = await actionLeagueContext(leagueId, { commissioner: true });
    if (!(await canManagePool(ctx.user, ctx.league.poolId))) throw new UserError("You can't manage this player pool.");
    const res = await applyProjectionRanks(db, leagueId, ctx.user.id);
    // The pool can be shared, and ranks show in the draft room and lawyer lists of every league using it.
    revalidatePath("/leagues/[leagueId]", "layout");
    if (res.ranked === 0) return ok("There are no lawyers in this pool to rank yet.");
    const shared = res.poolLeagueCount > 1 ? ` This pool is shared by ${res.poolLeagueCount} leagues, so they all use these ranks.` : "";
    return ok(`Draft rankings now follow projections for ${plural(res.ranked, "lawyer")}.${shared}`);
  });
}
