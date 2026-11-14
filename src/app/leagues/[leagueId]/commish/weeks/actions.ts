"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { isUuid, plural } from "@/lib/format";
import { ok, runAction, UserError, type ActionResult } from "@/server/action-result";
import { actionLeagueContext } from "@/server/league-context";
import { finalizeWeek, reopenWeek, type FinalizeResult, type ReopenResult } from "@/server/services/results";

const weekInput = z.object({
  leagueId: z.string().refine(isUuid),
  week: z.coerce.number().int().min(1).max(500),
});

function parseWeekInput(formData: FormData): z.infer<typeof weekInput> {
  const r = weekInput.safeParse({ leagueId: formData.get("leagueId"), week: formData.get("week") });
  if (!r.success) throw new UserError("Something was off with that request. Refresh and try again.");
  return r.data;
}

function finalizedMessage(r: FinalizeResult): string {
  const parts = [`Week ${r.week} is final.`];
  if (r.settled > 0) parts.push(`${plural(r.settled, "matchup")} settled.`);
  if (r.playoffsStarted) parts.push("The regular season is done and the playoff bracket is set!");
  else if (r.roundCreated) parts.push(`Playoff round ${r.roundCreated} is set.`);
  if (r.seasonComplete) parts.push("That wraps up the season!");
  return parts.join(" ");
}

function reopenedMessage(r: ReopenResult): string {
  const parts = [`Week ${r.week} is open again, so its scores are live.`];
  if (r.removedRounds.length > 0) {
    parts.push(
      `Removed playoff round ${r.removedRounds.join(", ")}. It's rebuilt when you finalize week ${r.week} again.`,
    );
  }
  return parts.join(" ");
}

/** Finalize a week (commissioners only). */
export async function finalizeWeekAction(_prev: unknown, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const { leagueId, week } = parseWeekInput(formData);
    const ctx = await actionLeagueContext(leagueId, { commissioner: true });
    const result = await finalizeWeek(db, ctx.league.id, week, ctx.user.id);
    revalidatePath(`/leagues/${ctx.league.id}`, "layout");
    return ok(finalizedMessage(result));
  });
}

/** Reopen the latest finalized week (commissioners only). */
export async function reopenWeekAction(_prev: unknown, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const { leagueId, week } = parseWeekInput(formData);
    const ctx = await actionLeagueContext(leagueId, { commissioner: true });
    const result = await reopenWeek(db, ctx.league.id, week);
    revalidatePath(`/leagues/${ctx.league.id}`, "layout");
    return ok(reopenedMessage(result));
  });
}
