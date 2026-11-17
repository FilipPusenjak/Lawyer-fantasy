"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { isUuid } from "@/lib/format";
import { totalSeasonWeeks } from "@/lib/settings";
import { formatDate, formatDateTime } from "@/lib/time";
import { ok, runAction, UserError, type ActionResult } from "@/server/action-result";
import { actionLeagueContext } from "@/server/league-context";
import {
  loadAdminLeague,
  MAX_SEASON_WEEKS,
  playoffTeamLimit,
  saveDraftSettings,
  saveRosterSettings,
  saveScheduleSettings,
  saveScoringSettings,
  saveTradeSettings,
  saveWaiverSettings,
} from "@/server/services/settings-admin";
import {
  parseDraftForm,
  parseRosterForm,
  parseScheduleForm,
  parseScoringForm,
  parseTradesForm,
  parseWaiversForm,
  type ParseResult,
} from "./settings-form";

async function commish(leagueId: string) {
  if (!isUuid(leagueId)) throw new UserError("League not found.");
  return actionLeagueContext(leagueId, { commissioner: true });
}

function unwrap<T>(r: ParseResult<T>): T {
  if (!r.ok) throw new UserError(r.error);
  return r.data;
}

function saved(leagueId: string, message: string): ActionResult {
  revalidatePath(`/leagues/${leagueId}`, "layout");
  return ok(message);
}

export async function saveRosterAction(leagueId: string, _prev: unknown, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    await commish(leagueId);
    const admin = await loadAdminLeague(db, leagueId);
    if (admin.locks.roster) throw new UserError("Roster spots are locked once the draft starts.");
    const input = unwrap(parseRosterForm(formData, { teamCount: admin.teamCount }));
    await saveRosterSettings(db, leagueId, input);
    return saved(leagueId, "Roster settings saved.");
  });
}

export async function saveScoringAction(leagueId: string, _prev: unknown, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await commish(leagueId);
    const scoring = unwrap(parseScoringForm(formData, { currentPreset: ctx.settings.scoring.preset }));
    await saveScoringSettings(db, leagueId, scoring);
    return saved(leagueId, "Scoring saved. Weeks that haven't been finalized yet use these values.");
  });
}

export async function saveScheduleAction(leagueId: string, _prev: unknown, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    await commish(leagueId);
    const admin = await loadAdminLeague(db, leagueId);
    const { snapped, ...input } = unwrap(
      parseScheduleForm(formData, {
        locks: admin.locks,
        current: admin.settings.schedule,
        seasonStart: admin.league.seasonStart,
        playoffLimit: playoffTeamLimit(admin.locks, admin.settings.maxTeams, admin.teamCount),
        maxSeasonWeeks: MAX_SEASON_WEEKS,
      }),
    );
    await saveScheduleSettings(db, leagueId, input);
    return saved(
      leagueId,
      snapped
        ? `Schedule saved. Weeks run Monday to Sunday, so the season starts Monday, ${formatDate(input.seasonStart)}.`
        : "Schedule saved.",
    );
  });
}

export async function saveDraftAction(leagueId: string, _prev: unknown, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await commish(leagueId);
    const draft = unwrap(parseDraftForm(formData, { timeZone: ctx.settings.schedule.timezone }));
    await saveDraftSettings(db, leagueId, draft);
    return saved(leagueId, "Draft settings saved.");
  });
}

export async function saveWaiversAction(leagueId: string, _prev: unknown, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    await commish(leagueId);
    const waivers = unwrap(parseWaiversForm(formData));
    const { settings, nextRunAt } = await saveWaiverSettings(db, leagueId, waivers);
    return saved(
      leagueId,
      nextRunAt ? `Waiver settings saved. Next run: ${formatDateTime(nextRunAt, settings.schedule.timezone)}.` : "Waiver settings saved.",
    );
  });
}

export async function saveTradesAction(leagueId: string, _prev: unknown, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await commish(leagueId);
    const trades = unwrap(parseTradesForm(formData, { totalWeeks: totalSeasonWeeks(ctx.settings.schedule) }));
    await saveTradeSettings(db, leagueId, trades);
    return saved(leagueId, "Trade settings saved.");
  });
}
