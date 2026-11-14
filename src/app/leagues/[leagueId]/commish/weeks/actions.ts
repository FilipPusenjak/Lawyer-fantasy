"use server";

import { revalidatePath } from "next/cache";
import { count, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { teams } from "@/db/schema";
import { isUuid, plural } from "@/lib/format";
import type { ScheduleSettings } from "@/lib/settings";
import { ok, runAction, UserError, type ActionResult } from "@/server/action-result";
import { actionLeagueContext } from "@/server/league-context";
import {
  finalizeWeek,
  playoffRoundList,
  playoffRoundRef,
  playoffRoundTotal,
  reopenWeek,
  type FinalizeResult,
  type ReopenResult,
} from "@/server/services/results";
import { getLeagueMatchups } from "@/server/services/standings";

const weekInput = z.object({
  leagueId: z.string().refine(isUuid),
  week: z.coerce.number().int().min(1).max(500),
});

function parseWeekInput(formData: FormData): z.infer<typeof weekInput> {
  const r = weekInput.safeParse({ leagueId: formData.get("leagueId"), week: formData.get("week") });
  if (!r.success) throw new UserError("Something was off with that request. Refresh and try again.");
  return r.data;
}

/** Rounds in the league's real bracket, for naming playoff rounds like every other page does. */
async function bracketRounds(leagueId: string, schedule: ScheduleSettings): Promise<number> {
  const [all, [{ n: teamCount }]] = await Promise.all([
    getLeagueMatchups(db, leagueId),
    db.select({ n: count() }).from(teams).where(eq(teams.leagueId, leagueId)),
  ]);
  return playoffRoundTotal(schedule, teamCount, all);
}

function finalizedMessage(r: FinalizeResult, totalRounds: number): string {
  const parts = [`Week ${r.week} is final.`];
  if (r.settled > 0) parts.push(`${plural(r.settled, "matchup")} settled.`);
  if (r.playoffsStarted) parts.push("The regular season is done and the playoff bracket is set!");
  else if (r.roundCreated) {
    parts.push(
      r.roundCreated === totalRounds
        ? "The championship matchup is set."
        : `Matchups for ${playoffRoundRef(r.roundCreated, totalRounds)} are set.`,
    );
  }
  if (r.seasonComplete) parts.push("That wraps up the season!");
  return parts.join(" ");
}

function reopenedMessage(r: ReopenResult, totalRounds: number): string {
  const parts = [`Week ${r.week} is open again, so its scores can change until you finalize it again.`];
  if (r.removedRounds.length > 0) {
    parts.push(
      `Removed the ${playoffRoundList(r.removedRounds, totalRounds)} matchups. They're rebuilt when you finalize week ${r.week} again.`,
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
    const totalRounds = result.roundCreated && !result.playoffsStarted ? await bracketRounds(ctx.league.id, ctx.settings.schedule) : 0;
    revalidatePath(`/leagues/${ctx.league.id}`, "layout");
    return ok(finalizedMessage(result, totalRounds));
  });
}

/** Reopen the latest finalized week (commissioners only). */
export async function reopenWeekAction(_prev: unknown, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const { leagueId, week } = parseWeekInput(formData);
    const ctx = await actionLeagueContext(leagueId, { commissioner: true });
    const result = await reopenWeek(db, ctx.league.id, week);
    const totalRounds = result.removedRounds.length > 0 ? await bracketRounds(ctx.league.id, ctx.settings.schedule) : 0;
    revalidatePath(`/leagues/${ctx.league.id}`, "layout");
    return ok(reopenedMessage(result, totalRounds));
  });
}
