"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { isUuid } from "@/lib/format";
import { SLOT_LABELS, type SlotType } from "@/lib/settings";
import { formatDateTime } from "@/lib/time";
import { ok, runAction, UserError, type ActionResult } from "@/server/action-result";
import { actionLeagueContext } from "@/server/league-context";
import { addFreeAgent, createWaiverClaim, dropLawyer } from "@/server/services/transactions-moves";
import type { ResultLink } from "./result-toast";

const id = z.string().refine(isUuid);

/** The note added when a drop leaves a starting slot empty. */
function emptySlotNote(slot: SlotType | null): string {
  return slot ? ` Your ${SLOT_LABELS[slot]} slot is now empty.` : "";
}

const moveSchema = z.object({
  leagueId: id,
  op: z.enum(["add", "claim", "drop"]),
  lawyerId: id,
  dropLawyerId: z.union([id, z.literal("")]).transform((v) => (v === "" ? null : v)),
});

/**
 * One action for every roster move from the pool list, lawyer page and my
 * team page: add a free agent, claim a lawyer off waivers, or drop a lawyer.
 * The acting team is always the signed-in member's own team.
 */
export async function rosterMoveAction(_prev: unknown, formData: FormData): Promise<ActionResult<{ link?: ResultLink }>> {
  return runAction(async () => {
    const parsed = moveSchema.safeParse({
      leagueId: formData.get("leagueId"),
      op: formData.get("op"),
      lawyerId: formData.get("lawyerId"),
      dropLawyerId: formData.get("dropLawyerId") ?? "",
    });
    if (!parsed.success) throw new UserError("Something was off with that request. Refresh and try again.");
    const { leagueId, op, lawyerId, dropLawyerId } = parsed.data;
    const ctx = await actionLeagueContext(leagueId);
    if (!ctx.team) throw new UserError("You don't have a team in this league.");
    const teamId = ctx.team.id;
    const tz = ctx.settings.schedule.timezone;

    let message: string;
    let emptiedSlot: SlotType | null = null;
    if (op === "add") {
      const res = await addFreeAgent(db, { leagueId, teamId, lawyerId, dropLawyerId });
      message = `Added ${res.lawyerName}.`;
      if (res.dropped) {
        message += res.dropped.toWaivers
          ? ` ${res.dropped.lawyerName} went to waivers.`
          : ` ${res.dropped.lawyerName} is a free agent again.`;
        emptiedSlot = res.dropped.emptiedSlot;
      }
    } else if (op === "claim") {
      const res = await createWaiverClaim(db, { leagueId, teamId, lawyerId, dropLawyerId });
      message = `Claim #${res.claimOrder} on ${res.lawyerName} is in.`;
      if (res.runsAt) message += ` Waivers run ${formatDateTime(res.runsAt, tz)}.`;
    } else {
      const res = await dropLawyer(db, { leagueId, teamId, lawyerId });
      message = res.toWaivers
        ? `Dropped ${res.lawyerName}. They're on waivers${res.waiversUntil ? ` until ${formatDateTime(res.waiversUntil, tz)}` : ""}.`
        : `Dropped ${res.lawyerName}. They're a free agent again.`;
      emptiedSlot = res.emptiedSlot;
    }
    message += emptySlotNote(emptiedSlot);
    // Rosters show up on most league pages (team, pool, lawyer pages, activity).
    revalidatePath(`/leagues/${leagueId}`, "layout");
    return ok(message, emptiedSlot ? { link: { href: `/leagues/${leagueId}/team`, label: "Set your lineup ›" } } : {});
  });
}
