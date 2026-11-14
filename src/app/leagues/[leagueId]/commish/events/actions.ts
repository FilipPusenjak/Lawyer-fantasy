"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { isUuid, plural } from "@/lib/format";
import { addDays, todayIn } from "@/lib/time";
import { ok, runAction, UserError, type ActionResult } from "@/server/action-result";
import { actionLeagueContext, canManagePool, type LeagueContext } from "@/server/league-context";
import { approveEvents, createEvent, rejectEvent, revertEvent, updateEvent } from "@/server/services/events";
import { parseEventForm, parseReviewOp, type EventFormData, type ParseResult } from "./event-rules";

/** Commissioner of this league who may manage its pool. */
async function poolAccess(leagueId: string): Promise<LeagueContext> {
  if (!isUuid(leagueId)) throw new UserError("League not found.");
  const ctx = await actionLeagueContext(leagueId, { commissioner: true });
  if (!(await canManagePool(ctx.user, ctx.league.poolId))) throw new UserError("You can't manage this player pool.");
  return ctx;
}

function unwrap<T>(r: ParseResult<T>): T {
  if (!r.ok) throw new UserError(r.error);
  return r.data;
}

function requireId(id: string): string {
  if (!isUuid(id)) throw new UserError("Something was off with that request. Refresh and try again.");
  return id;
}

/** Events count for every league using the pool, so refresh all league pages. */
function refreshScores(): void {
  revalidatePath("/leagues/[leagueId]", "layout");
}

/** Events are facts that already happened (one day of slack for time zones). */
function assertNotFuture(ctx: LeagueContext, data: EventFormData): void {
  if (data.input.occurredOn > addDays(todayIn(ctx.settings.schedule.timezone), 1)) {
    throw new UserError("The date can't be in the future. Only record things that already happened.");
  }
}

export async function createEventAction(leagueId: string, _prev: unknown, formData: FormData): Promise<ActionResult> {
  const out = { approved: false, created: 0 };
  const result = await runAction(async () => {
    const ctx = await poolAccess(leagueId);
    const data = unwrap(parseEventForm(formData, { requireSource: true }));
    assertNotFuture(ctx, data);
    const rows = await createEvent(db, {
      poolId: ctx.league.poolId,
      input: data.input,
      createdBy: ctx.user.id,
      origin: "manual",
      approve: data.approveNow,
      alsoRecordLoss: data.alsoRecordLoss,
    });
    out.approved = data.approveNow;
    out.created = rows.length;
    refreshScores();
    return ok();
  });
  if (!result.ok) return result;
  const base = `/leagues/${leagueId}/commish/events`;
  redirect(out.approved ? `${base}/history?added=${out.created}` : `${base}?added=${out.created}`);
}

export async function updateEventAction(leagueId: string, eventId: string, _prev: unknown, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await poolAccess(leagueId);
    // The service decides whether a source link is required (manual events).
    const data = unwrap(parseEventForm(formData, { requireSource: false }));
    assertNotFuture(ctx, data);
    await updateEvent(db, ctx.league.poolId, requireId(eventId), data.input);
    refreshScores();
    return ok("Event saved.");
  });
}

/** Review queue form: approve one, reject one, or approve the ticked ones. */
export async function reviewEventsAction(leagueId: string, _prev: unknown, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await poolAccess(leagueId);
    const op = unwrap(parseReviewOp(formData));
    if (op.op === "reject") {
      await rejectEvent(db, ctx.league.poolId, op.id, ctx.user.id);
      refreshScores();
      return ok("Event rejected.");
    }
    const n = await approveEvents(db, ctx.league.poolId, op.ids, ctx.user.id);
    if (n === 0) throw new UserError("Those events were already reviewed. Refresh to see the latest.");
    refreshScores();
    return ok(n === op.ids.length ? `Approved ${plural(n, "event")}.` : `Approved ${plural(n, "event")}. The rest were already reviewed.`);
  });
}

/** Single-event status changes from the edit page / history: approve, reject or move back to pending. */
export async function setEventStatusAction(leagueId: string, eventId: string, _prev: unknown, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await poolAccess(leagueId);
    const id = requireId(eventId);
    const op = formData.get("op");
    if (op === "approve") {
      const n = await approveEvents(db, ctx.league.poolId, [id], ctx.user.id);
      if (n === 0) throw new UserError("That event isn't pending anymore. Refresh to see its status.");
      refreshScores();
      return ok("Approved. Points count now.");
    }
    if (op === "reject") {
      await rejectEvent(db, ctx.league.poolId, id, ctx.user.id);
      refreshScores();
      return ok("Rejected.");
    }
    if (op === "pending") {
      await revertEvent(db, ctx.league.poolId, id);
      refreshScores();
      return ok("Moved back to the review queue. It doesn't count until it's approved again.");
    }
    throw new UserError("Something was off with that request. Refresh and try again.");
  });
}
