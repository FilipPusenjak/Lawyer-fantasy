"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { isUuid } from "@/lib/format";
import { ok, runAction, UserError, type ActionResult } from "@/server/action-result";
import { actionLeagueContext } from "@/server/league-context";
import { setTeamLineup } from "@/server/services/transactions-moves";

const id = z.string().refine(isUuid);

const lineupSchema = z.object({
  leagueId: id,
  week: z.coerce.number().int().min(1).max(200),
  starters: z.array(id.nullable()).max(40),
});

function parseJson(raw: FormDataEntryValue | null): unknown {
  if (typeof raw !== "string" || raw.length > 4000) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Save my team's starters for the current editable week. */
export async function saveLineupAction(_prev: unknown, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const parsed = lineupSchema.safeParse({
      leagueId: formData.get("leagueId"),
      week: formData.get("week"),
      starters: parseJson(formData.get("starters")),
    });
    if (!parsed.success) throw new UserError("Something was off with that lineup. Refresh and try again.");
    const { leagueId, week, starters } = parsed.data;
    const ctx = await actionLeagueContext(leagueId);
    if (!ctx.team) throw new UserError("You don't have a team in this league.");
    await setTeamLineup(db, { leagueId, teamId: ctx.team.id, week, starters });
    revalidatePath(`/leagues/${leagueId}`, "layout");
    return ok(`Week ${week} lineup saved.`);
  });
}
