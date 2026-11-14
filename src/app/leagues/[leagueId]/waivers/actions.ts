"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { isUuid } from "@/lib/format";
import { ok, runAction, UserError, type ActionResult } from "@/server/action-result";
import { actionLeagueContext } from "@/server/league-context";
import { cancelWaiverClaim, moveWaiverClaim } from "@/server/services/transactions-moves";

const id = z.string().refine(isUuid);

const claimOpSchema = z.object({
  leagueId: id,
  claimId: id,
  op: z.enum(["up", "down", "cancel"]),
});

/** Reorder or cancel one of my pending waiver claims. */
export async function claimOpAction(_prev: unknown, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const parsed = claimOpSchema.safeParse({
      leagueId: formData.get("leagueId"),
      claimId: formData.get("claimId"),
      op: formData.get("op"),
    });
    if (!parsed.success) throw new UserError("Something was off with that request. Refresh and try again.");
    const { leagueId, claimId, op } = parsed.data;
    const ctx = await actionLeagueContext(leagueId);
    if (!ctx.team) throw new UserError("You don't have a team in this league.");
    if (op === "cancel") {
      await cancelWaiverClaim(db, { leagueId, teamId: ctx.team.id, claimId });
    } else {
      await moveWaiverClaim(db, { leagueId, teamId: ctx.team.id, claimId, direction: op });
    }
    revalidatePath(`/leagues/${leagueId}`, "layout");
    return ok(op === "cancel" ? "Claim cancelled." : undefined);
  });
}
