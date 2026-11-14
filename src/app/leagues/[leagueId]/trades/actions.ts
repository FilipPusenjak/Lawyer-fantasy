"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/db";
import { isUuid } from "@/lib/format";
import { formatDateTime } from "@/lib/time";
import { fail, ok, runAction, UserError, type ActionResult } from "@/server/action-result";
import { actionLeagueContext, type LeagueContext } from "@/server/league-context";
import {
  acceptTrade,
  approveTradeNow,
  cancelTrade,
  proposeTrade,
  rejectTrade,
  TRADE_MESSAGE_MAX,
  vetoTrade,
  type TradeOutcome,
} from "@/server/services/trades";

const id = z.string().refine(isUuid, "Invalid id.");
const text = z.preprocess((v) => (v == null ? "" : v), z.string());

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new UserError("Something was off with that request. Refresh and try again.");
  return r.data;
}

function myTeamId(ctx: LeagueContext): string {
  if (!ctx.team) throw new UserError("You don't have a team in this league.");
  return ctx.team.id;
}

/** Trades touch rosters, lineups, activity and home-page alerts, so refresh the whole league. */
function revalidateLeague(leagueId: string): void {
  revalidatePath(`/leagues/${leagueId}`, "layout");
}

function outcomeResult(outcome: TradeOutcome, timeZone: string, accepted: string): ActionResult {
  if (outcome.status === "completed") return ok("Trade complete! The lawyers have switched teams.");
  if (outcome.status === "failed") return fail(`This trade can't go through: ${outcome.failReason ?? "rosters changed."}`);
  if (outcome.status === "accepted" && outcome.reviewEndsAt) {
    return ok(`${accepted} It goes through ${formatDateTime(outcome.reviewEndsAt, timeZone)} unless the commissioner vetoes it.`);
  }
  return ok(accepted);
}

const tradeRefSchema = z.object({ leagueId: id, tradeId: id });

// ---------------------------------------------------------------------------
// Propose (from /trades/new)
// ---------------------------------------------------------------------------

const proposeSchema = z.object({
  leagueId: id,
  recipientTeamId: id,
  give: z.array(id).max(50),
  get: z.array(id).max(50),
  message: text.pipe(z.string().max(TRADE_MESSAGE_MAX + 200)),
});

export async function proposeTradeAction(_prev: unknown, formData: FormData): Promise<ActionResult> {
  let target = "";
  const result = await runAction(async () => {
    const input = parse(proposeSchema, {
      leagueId: formData.get("leagueId"),
      recipientTeamId: formData.get("recipientTeamId"),
      give: formData.getAll("give"),
      get: formData.getAll("get"),
      message: formData.get("message"),
    });
    const ctx = await actionLeagueContext(input.leagueId);
    const { tradeId } = await proposeTrade(db, {
      leagueId: input.leagueId,
      proposerTeamId: myTeamId(ctx),
      recipientTeamId: input.recipientTeamId,
      giveLawyerIds: input.give,
      getLawyerIds: input.get,
      message: input.message,
    });
    revalidateLeague(input.leagueId);
    target = `/leagues/${input.leagueId}/trades?sent=${tradeId}`;
    return ok();
  });
  if (!result.ok) return result;
  redirect(target);
}

// ---------------------------------------------------------------------------
// Recipient: accept / decline
// ---------------------------------------------------------------------------

export async function respondToTradeAction(_prev: unknown, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const { leagueId, tradeId } = parse(tradeRefSchema, { leagueId: formData.get("leagueId"), tradeId: formData.get("tradeId") });
    const intent = parse(z.enum(["accept", "reject"]), formData.get("intent"));
    const ctx = await actionLeagueContext(leagueId);
    const ref = { leagueId, tradeId, teamId: myTeamId(ctx), userId: ctx.user.id };
    if (intent === "reject") {
      await rejectTrade(db, ref);
      revalidateLeague(leagueId);
      return ok("Offer declined.");
    }
    const outcome = await acceptTrade(db, ref);
    revalidateLeague(leagueId);
    return outcomeResult(outcome, ctx.settings.schedule.timezone, "Trade accepted!");
  });
}

// ---------------------------------------------------------------------------
// Proposer: cancel
// ---------------------------------------------------------------------------

export async function cancelTradeAction(_prev: unknown, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const { leagueId, tradeId } = parse(tradeRefSchema, { leagueId: formData.get("leagueId"), tradeId: formData.get("tradeId") });
    const ctx = await actionLeagueContext(leagueId);
    await cancelTrade(db, { leagueId, tradeId, teamId: myTeamId(ctx), userId: ctx.user.id });
    revalidateLeague(leagueId);
    return ok("Trade cancelled.");
  });
}

// ---------------------------------------------------------------------------
// Commissioner: veto / approve now
// ---------------------------------------------------------------------------

export async function reviewTradeAction(_prev: unknown, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const { leagueId, tradeId } = parse(tradeRefSchema, { leagueId: formData.get("leagueId"), tradeId: formData.get("tradeId") });
    const intent = parse(z.enum(["veto", "approve"]), formData.get("intent"));
    const reasonRaw = parse(text, formData.get("reason"));
    if (reasonRaw.trim().length > TRADE_MESSAGE_MAX) throw new UserError(`Keep the reason to ${TRADE_MESSAGE_MAX} characters or less.`);
    const ctx = await actionLeagueContext(leagueId, { commissioner: true });
    if (intent === "veto") {
      await vetoTrade(db, { leagueId, tradeId, userId: ctx.user.id, actingTeamId: ctx.team?.id ?? null, reason: reasonRaw });
      revalidateLeague(leagueId);
      return ok("Trade vetoed.");
    }
    const outcome = await approveTradeNow(db, { leagueId, tradeId, userId: ctx.user.id, actingTeamId: ctx.team?.id ?? null });
    revalidateLeague(leagueId);
    return outcomeResult(outcome, ctx.settings.schedule.timezone, "Trade approved.");
  });
}
