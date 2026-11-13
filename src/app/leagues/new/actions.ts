"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { ok, runAction, UserError, type ActionResult } from "@/server/action-result";
import { getCurrentUser } from "@/server/auth/session";
import { firstIssue } from "@/app/account/rules";
import { createLeagueFromForm } from "./create-league";
import { createLeagueSchema } from "./league-rules";

export async function createLeagueAction(_prev: unknown, formData: FormData): Promise<ActionResult> {
  let leagueId = "";
  const result = await runAction(async () => {
    const user = await getCurrentUser();
    if (!user) throw new UserError("Please log in again.");
    if (!user.isAdmin) throw new UserError("Only the club admin can create leagues.");

    const parsed = createLeagueSchema.safeParse({
      name: formData.get("name"),
      teamName: formData.get("teamName"),
      maxTeams: formData.get("maxTeams"),
      seasonStart: formData.get("seasonStart"),
      pool: formData.get("pool"),
      newPoolName: formData.get("newPoolName"),
    });
    if (!parsed.success) throw new UserError(firstIssue(parsed.error));

    const league = await createLeagueFromForm(db, parsed.data, user.id);
    leagueId = league.id;
    revalidatePath("/");
    return ok();
  });
  if (!result.ok) return result;
  redirect(`/leagues/${leagueId}`);
}
