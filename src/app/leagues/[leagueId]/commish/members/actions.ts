"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { isUuid } from "@/lib/format";
import { ok, runAction, UserError, type ActionResult } from "@/server/action-result";
import { actionLeagueContext } from "@/server/league-context";
import { reassignTeam, regenerateInviteCode, removeMember, renameTeam, setMemberRole, setTemporaryPassword } from "@/server/services/settings-admin";
import { firstIssue, passwordSchema } from "@/app/account/rules";
import { parseTakeoverUsername } from "./rules";

async function commish(leagueId: string) {
  if (!isUuid(leagueId)) throw new UserError("League not found.");
  return actionLeagueContext(leagueId, { commissioner: true });
}

function idField(formData: FormData, name: string): string {
  const v = formData.get(name);
  if (typeof v !== "string" || !isUuid(v)) throw new UserError("Something was off with that request. Refresh and try again.");
  return v;
}

function refresh(leagueId: string): void {
  revalidatePath(`/leagues/${leagueId}`, "layout");
}

export async function setRoleAction(leagueId: string, _prev: unknown, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await commish(leagueId);
    const userId = idField(formData, "userId");
    const role = formData.get("role");
    if (role !== "commissioner" && role !== "member") throw new UserError("Pick a role.");
    if (userId === ctx.user.id && role === "member") {
      throw new UserError("You can't remove your own commissioner role. Ask another commissioner to do it.");
    }
    const { displayName } = await setMemberRole(db, leagueId, userId, role);
    refresh(leagueId);
    return ok(role === "commissioner" ? `${displayName} is now a co-commissioner.` : `${displayName} is now a regular member.`);
  });
}

export async function renameTeamAction(leagueId: string, _prev: unknown, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    await commish(leagueId);
    const teamId = idField(formData, "teamId");
    const raw = formData.get("name");
    const { name } = await renameTeam(db, leagueId, teamId, typeof raw === "string" ? raw : "");
    refresh(leagueId);
    return ok(`Team renamed to ${name}.`);
  });
}

export async function removeMemberAction(leagueId: string, _prev: unknown, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await commish(leagueId);
    const userId = idField(formData, "userId");
    if (userId === ctx.user.id) throw new UserError("You can't remove yourself.");
    const { displayName } = await removeMember(db, leagueId, userId);
    refresh(leagueId);
    return ok(`${displayName} and their team were removed.`);
  });
}

export async function reassignTeamAction(leagueId: string, _prev: unknown, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    await commish(leagueId);
    const teamId = idField(formData, "teamId");
    const previousOwnerId = idField(formData, "previousOwnerId");
    const username = parseTakeoverUsername(formData.get("username"));
    if (!username) throw new UserError("Type the new student's username.");
    const { teamName, newDisplayName, oldDisplayName } = await reassignTeam(db, leagueId, teamId, previousOwnerId, username);
    refresh(leagueId);
    return ok(`${newDisplayName} now runs ${teamName}. ${oldDisplayName} is no longer in the league.`);
  });
}

export async function regenerateCodeAction(leagueId: string): Promise<ActionResult> {
  return runAction(async () => {
    await commish(leagueId);
    const code = await regenerateInviteCode(db, leagueId);
    refresh(leagueId);
    return ok(`New invite code: ${code}. The old code no longer works.`);
  });
}

export async function setTempPasswordAction(leagueId: string, _prev: unknown, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await commish(leagueId);
    if (!ctx.user.isAdmin) throw new UserError("Only the club admin can set passwords.");
    const userId = idField(formData, "userId");
    if (userId === ctx.user.id) throw new UserError("Change your own password on your account page.");
    const parsed = passwordSchema.safeParse(formData.get("password"));
    if (!parsed.success) throw new UserError(firstIssue(parsed.error));
    const { username } = await setTemporaryPassword(db, leagueId, userId, parsed.data);
    return ok(`Password set for @${username}. Tell them in person, and ask them to change it on their account page.`);
  });
}
