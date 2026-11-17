"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { isUuid } from "@/lib/format";
import { ok, runAction, UserError, type ActionResult } from "@/server/action-result";
import { actionLeagueContext, type LeagueContext } from "@/server/league-context";
import {
  addToQueue,
  cancelDraftStart,
  commissionerPick,
  makePick,
  moveInQueue,
  moveTeamInDraftOrder,
  pauseDraft,
  randomizeDraftOrder,
  removeFromQueue,
  resumeDraft,
  startDraft,
  undoLastPick,
} from "@/server/services/draft";

const id = z.string().refine(isUuid, "Invalid id.");
const overall = z.number().int().min(0).max(10_000);

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new UserError("Something was off with that request. Refresh and try again.");
  return r.data;
}

function myTeamId(ctx: LeagueContext): string {
  if (!ctx.team) throw new UserError("You don't have a team in this league.");
  return ctx.team.id;
}

/** Draft changes touch rosters, activity and league status, so refresh the whole league. */
function revalidateLeague(leagueId: string): void {
  revalidatePath(`/leagues/${leagueId}`, "layout");
}

function revalidateDraftRoom(leagueId: string): void {
  revalidatePath(`/leagues/${leagueId}/draft`);
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

/** Draft a lawyer for my team (must be my turn). `expectedOverall` is the pick I saw on the clock. */
export async function makePickAction(leagueIdRaw: string, lawyerIdRaw: string, expectedOverallRaw: number): Promise<ActionResult> {
  return runAction(async () => {
    const leagueId = parse(id, leagueIdRaw);
    const lawyerId = parse(id, lawyerIdRaw);
    const expected = parse(overall, expectedOverallRaw);
    const ctx = await actionLeagueContext(leagueId);
    const res = await makePick(db, leagueId, myTeamId(ctx), lawyerId, ctx.user.id, false, new Date(), expected);
    revalidateLeague(leagueId);
    return ok(res.completed ? `You drafted ${res.lawyerName}. That's the last pick, so the draft is done!` : `You drafted ${res.lawyerName}.`);
  });
}

export async function queueAddAction(leagueIdRaw: string, lawyerIdRaw: string): Promise<ActionResult> {
  return runAction(async () => {
    const leagueId = parse(id, leagueIdRaw);
    const lawyerId = parse(id, lawyerIdRaw);
    const ctx = await actionLeagueContext(leagueId);
    await addToQueue(db, leagueId, myTeamId(ctx), lawyerId);
    revalidateDraftRoom(leagueId);
    return ok();
  });
}

export async function queueRemoveAction(leagueIdRaw: string, lawyerIdRaw: string): Promise<ActionResult> {
  return runAction(async () => {
    const leagueId = parse(id, leagueIdRaw);
    const lawyerId = parse(id, lawyerIdRaw);
    const ctx = await actionLeagueContext(leagueId);
    await removeFromQueue(db, leagueId, myTeamId(ctx), lawyerId);
    revalidateDraftRoom(leagueId);
    return ok();
  });
}

export async function queueMoveAction(leagueIdRaw: string, lawyerIdRaw: string, directionRaw: string): Promise<ActionResult> {
  return runAction(async () => {
    const leagueId = parse(id, leagueIdRaw);
    const lawyerId = parse(id, lawyerIdRaw);
    const direction = parse(z.enum(["up", "down", "top"]), directionRaw);
    const ctx = await actionLeagueContext(leagueId);
    await moveInQueue(db, leagueId, myTeamId(ctx), lawyerId, direction);
    revalidateDraftRoom(leagueId);
    return ok();
  });
}

// ---------------------------------------------------------------------------
// Commissioner
// ---------------------------------------------------------------------------

export async function startDraftAction(leagueIdRaw: string): Promise<ActionResult> {
  return runAction(async () => {
    const leagueId = parse(id, leagueIdRaw);
    await actionLeagueContext(leagueId, { commissioner: true });
    await startDraft(db, leagueId);
    revalidateLeague(leagueId);
    return ok("The draft is live. Good luck!");
  });
}

/** Undo "Start draft" while no pick has been made (back to setup). */
export async function cancelDraftStartAction(leagueIdRaw: string): Promise<ActionResult> {
  return runAction(async () => {
    const leagueId = parse(id, leagueIdRaw);
    await actionLeagueContext(leagueId, { commissioner: true });
    const { checkPlayoffTeams } = await cancelDraftStart(db, leagueId);
    revalidateLeague(leagueId);
    return ok(
      checkPlayoffTeams
        ? "The draft is back in setup. If you add teams, check Playoff teams in league settings."
        : "The draft is back in setup. Start it again when you're ready.",
    );
  });
}

export async function moveTeamAction(leagueIdRaw: string, teamIdRaw: string, directionRaw: string): Promise<ActionResult> {
  return runAction(async () => {
    const leagueId = parse(id, leagueIdRaw);
    const teamId = parse(id, teamIdRaw);
    const direction = parse(z.enum(["up", "down"]), directionRaw);
    await actionLeagueContext(leagueId, { commissioner: true });
    await moveTeamInDraftOrder(db, leagueId, teamId, direction === "up" ? -1 : 1);
    revalidateDraftRoom(leagueId);
    return ok();
  });
}

export async function randomizeOrderAction(leagueIdRaw: string): Promise<ActionResult> {
  return runAction(async () => {
    const leagueId = parse(id, leagueIdRaw);
    await actionLeagueContext(leagueId, { commissioner: true });
    await randomizeDraftOrder(db, leagueId);
    revalidateDraftRoom(leagueId);
    return ok("Draft order shuffled.");
  });
}

export async function pauseDraftAction(leagueIdRaw: string): Promise<ActionResult> {
  return runAction(async () => {
    const leagueId = parse(id, leagueIdRaw);
    await actionLeagueContext(leagueId, { commissioner: true });
    await pauseDraft(db, leagueId);
    revalidateLeague(leagueId);
    return ok("Draft paused.");
  });
}

export async function resumeDraftAction(leagueIdRaw: string): Promise<ActionResult> {
  return runAction(async () => {
    const leagueId = parse(id, leagueIdRaw);
    await actionLeagueContext(leagueId, { commissioner: true });
    await resumeDraft(db, leagueId);
    revalidateLeague(leagueId);
    return ok("Draft resumed.");
  });
}

/** Undo the last pick. `expectedOverall` is the pick the commissioner saw as the latest. */
export async function undoLastPickAction(leagueIdRaw: string, expectedOverallRaw: number): Promise<ActionResult> {
  return runAction(async () => {
    const leagueId = parse(id, leagueIdRaw);
    const expected = parse(overall, expectedOverallRaw);
    await actionLeagueContext(leagueId, { commissioner: true });
    const res = await undoLastPick(db, leagueId, expected);
    revalidateLeague(leagueId);
    return ok(`Undid ${res.teamName}'s pick of ${res.lawyerName}. They're back on the clock.`);
  });
}

/** Pick for the team on the clock. `expectedOverall` is the pick the commissioner saw on the clock. */
export async function commissionerPickAction(leagueIdRaw: string, lawyerIdRaw: string, expectedOverallRaw: number): Promise<ActionResult> {
  return runAction(async () => {
    const leagueId = parse(id, leagueIdRaw);
    const lawyerId = parse(id, lawyerIdRaw);
    const expected = parse(overall, expectedOverallRaw);
    const ctx = await actionLeagueContext(leagueId, { commissioner: true });
    const res = await commissionerPick(db, leagueId, lawyerId, ctx.user.id, expected);
    revalidateLeague(leagueId);
    return ok(`Drafted ${res.lawyerName} for ${res.teamName}.`);
  });
}
