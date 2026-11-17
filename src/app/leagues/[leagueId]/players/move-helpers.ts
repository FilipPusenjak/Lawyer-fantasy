/**
 * Pure helpers for the add / claim / drop controls on the players, lawyer and
 * waivers pages. No DB access (unit tested).
 */
import type { LeagueSettings, Position } from "@/lib/settings";
import { waiverClearTime } from "@/lib/waivers";
import type { DropOption } from "./move-controls";
import { formatShortDay } from "./player-filters";

/** My roster as drop-picker options, marking who starts in the editable week's lineup. */
export function toDropOptions(roster: { id: string; name: string; position: Position }[], starters: (string | null)[]): DropOption[] {
  const starting = new Set(starters.filter((s): s is string => s !== null));
  return roster.map((r) => ({ id: r.id, name: r.name, position: r.position, isStarter: starting.has(r.id) }));
}

/**
 * When a lawyer on waivers clears them: the first run at least
 * WAIVER_MIN_HOLD_HOURS after they went on waivers. Without a hold time, the
 * next run. Null when no run is scheduled.
 */
export function waiversClearAt(heldSince: Date | undefined, nextRunAt: Date | null, settings: LeagueSettings): Date | null {
  if (!nextRunAt) return null;
  if (!heldSince) return nextRunAt;
  return waiverClearTime(heldSince, nextRunAt, {
    processDay: settings.waivers.processDay,
    processTime: settings.waivers.processTime,
    timeZone: settings.schedule.timezone,
  });
}

/** `waiversClearAt` as a short day for the "Waivers · Wed, Nov 18" badge. */
export function waiversUntilDay(heldSince: Date | undefined, nextRunAt: Date | null, settings: LeagueSettings): string | null {
  const at = waiversClearAt(heldSince, nextRunAt, settings);
  return at ? formatShortDay(at, settings.schedule.timezone) : null;
}
