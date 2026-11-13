"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { ok, runAction, UserError, type ActionResult } from "@/server/action-result";
import { getCurrentUser } from "@/server/auth/session";
import { firstIssue } from "@/app/account/rules";
import { joinLeagueByCode } from "./join-league";
import { joinSchema } from "./join-rules";

/** Join a league by invite code (used on the home page and /join). */
export async function joinLeagueAction(_prev: unknown, formData: FormData): Promise<ActionResult> {
  let leagueId = "";
  const result = await runAction(async () => {
    const user = await getCurrentUser();
    if (!user) throw new UserError("Please log in first.");
    const parsed = joinSchema.safeParse({ code: formData.get("code"), teamName: formData.get("teamName") });
    if (!parsed.success) throw new UserError(firstIssue(parsed.error));
    leagueId = await joinLeagueByCode(db, { code: parsed.data.code, userId: user.id, teamName: parsed.data.teamName });
    revalidatePath("/");
    return ok();
  });
  if (!result.ok) return result;
  redirect(`/leagues/${leagueId}`);
}
