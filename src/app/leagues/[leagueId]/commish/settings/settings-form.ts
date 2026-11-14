/**
 * Pure parsing/validation for the commissioner settings forms (one parser per
 * section). Each returns a value that passes the zod schemas in
 * src/lib/settings.ts. Client-safe (no DB / server imports).
 */
import type { z } from "zod";
import {
  draftSettingsSchema,
  EVENT_TYPES,
  playoffRounds,
  presetScoring,
  regularSeasonWeeks,
  rosterSchema,
  scheduleSchema,
  SCORING_PRESETS,
  scoringSchema,
  totalSeasonWeeks,
  tradeSettingsSchema,
  waiverSettingsSchema,
  type DraftSettings,
  type RosterSettings,
  type ScheduleSettings,
  type ScoringPreset,
  type ScoringSettings,
  type TradeSettings,
  type ValuedEventType,
  type WaiverSettings,
} from "@/lib/settings";
import { dateToDayNumber, dayNumberToDate, dayOfWeek, localDate, weekEndDate, zonedTimeToUtc } from "@/lib/time";
import type { SettingsLocks } from "@/server/services/settings-admin";

export type FormLike = { get(name: string): FormDataEntryValue | null };
export type ParseResult<T> = { ok: true; data: T } | { ok: false; error: string };

class FormProblem extends Error {}

function attempt<T>(fn: () => T): ParseResult<T> {
  try {
    return { ok: true, data: fn() };
  } catch (e) {
    if (e instanceof FormProblem) return { ok: false, error: e.message };
    throw e;
  }
}

function text(form: FormLike, name: string): string {
  const v = form.get(name);
  return typeof v === "string" ? v.trim() : "";
}

function whole(form: FormLike, name: string, label: string, min: number, max: number): number {
  const raw = text(form, name);
  if (!/^-?\d+$/.test(raw)) throw new FormProblem(`${label}: enter a whole number.`);
  const n = Number(raw);
  if (n < min || n > max) throw new FormProblem(`${label} must be between ${min} and ${max}.`);
  return n;
}

function decimal(form: FormLike, name: string, label: string, min: number, max: number): number {
  const raw = text(form, name).replace(/^\+/, "");
  if (!/^-?(\d+(\.\d*)?|\.\d+)$/.test(raw)) throw new FormProblem(`${label}: enter a number.`);
  const n = Math.round(Number(raw) * 100) / 100;
  if (n < min || n > max) throw new FormProblem(`${label} must be between ${min} and ${max}.`);
  return n;
}

function finalCheck<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new FormProblem("Those settings don't look right. Check the numbers and try again.");
  return r.data;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function timeOfDay(form: FormLike, name: string, label: string): string {
  const raw = text(form, name).slice(0, 5);
  if (!TIME_RE.test(raw)) throw new FormProblem(`${label}: pick a time.`);
  return raw;
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

export const ROSTER_FIELDS: { key: keyof RosterSettings; label: string; max: number }[] = [
  { key: "trial", label: "Trial Lawyer (TRL)", max: 3 },
  { key: "appellate", label: "Appellate Lawyer (APP)", max: 3 },
  { key: "prosecutor", label: "Prosecutor (PRO)", max: 3 },
  { key: "defense", label: "Defense Attorney (DEF)", max: 3 },
  { key: "flex", label: "FLEX (any lawyer)", max: 4 },
  { key: "firm", label: "Law Firm (FIRM)", max: 2 },
  { key: "bench", label: "Bench", max: 10 },
];

export function parseRosterForm(form: FormLike, opts: { teamCount: number }): ParseResult<{ roster: RosterSettings; maxTeams: number }> {
  return attempt(() => {
    const roster = {} as RosterSettings;
    for (const f of ROSTER_FIELDS) roster[f.key] = whole(form, `roster_${f.key}`, f.label, 0, f.max);
    const starters = ROSTER_FIELDS.filter((f) => f.key !== "bench").reduce((n, f) => n + roster[f.key], 0);
    if (starters < 1) throw new FormProblem("Teams need at least one starting spot.");
    const maxTeams = whole(form, "maxTeams", "Max teams", 2, 12);
    if (maxTeams < opts.teamCount) {
      throw new FormProblem(`${opts.teamCount} teams have already joined, so max teams can't be lower than ${opts.teamCount}.`);
    }
    return { roster: finalCheck(rosterSchema, roster), maxTeams };
  });
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export const VALUED_EVENT_TYPES = EVENT_TYPES.filter((t): t is ValuedEventType => t !== "custom");

function sameScoring(a: ScoringSettings, b: ScoringSettings): boolean {
  return (
    a.firmMultiplier === b.firmMultiplier &&
    a.filingWeeklyCap === b.filingWeeklyCap &&
    VALUED_EVENT_TYPES.every((t) => a.values[t] === b.values[t])
  );
}

/**
 * Decide the saved scoring from the submitted preset + values:
 * - "custom" keeps the typed values;
 * - a newly chosen preset applies that preset's values;
 * - the same preset with edited values becomes "custom" (so it also works
 *   without JavaScript, where the inputs don't refill on preset change).
 */
export function resolveScoring(submittedPreset: ScoringPreset, typed: Omit<ScoringSettings, "preset">, currentPreset: ScoringPreset): ScoringSettings {
  const asCustom: ScoringSettings = { ...typed, preset: "custom" };
  if (submittedPreset === "custom") return asCustom;
  const preset = presetScoring(submittedPreset);
  if (submittedPreset !== currentPreset) return preset;
  return sameScoring(preset, asCustom) ? preset : asCustom;
}

export function parseScoringForm(form: FormLike, opts: { currentPreset: ScoringPreset }): ParseResult<ScoringSettings> {
  return attempt(() => {
    const presetRaw = text(form, "preset");
    if (!(SCORING_PRESETS as readonly string[]).includes(presetRaw) && presetRaw !== "custom") {
      throw new FormProblem("Pick a scoring preset.");
    }
    const values = {} as Record<ValuedEventType, number>;
    for (const t of VALUED_EVENT_TYPES) values[t] = decimal(form, `value_${t}`, "Each point value", -100, 100);
    const firmMultiplier = decimal(form, "firmMultiplier", "Firm multiplier", 0, 5);
    const filingWeeklyCap = decimal(form, "filingWeeklyCap", "Weekly filing cap", 0, 100);
    const resolved = resolveScoring(presetRaw as ScoringPreset, { values, firmMultiplier, filingWeeklyCap }, opts.currentPreset);
    return finalCheck(scoringSchema, resolved);
  });
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

export const US_TIMEZONES: { id: string; label: string }[] = [
  { id: "America/New_York", label: "Eastern (New York)" },
  { id: "America/Detroit", label: "Eastern (Detroit)" },
  { id: "America/Chicago", label: "Central (Chicago)" },
  { id: "America/Denver", label: "Mountain (Denver)" },
  { id: "America/Phoenix", label: "Arizona (Phoenix, no DST)" },
  { id: "America/Los_Angeles", label: "Pacific (Los Angeles)" },
  { id: "America/Anchorage", label: "Alaska (Anchorage)" },
  { id: "Pacific/Honolulu", label: "Hawaii (Honolulu)" },
  { id: "America/Puerto_Rico", label: "Atlantic (Puerto Rico)" },
];

/** Time zone choices, including the league's current zone if it isn't a common one. */
export function timezoneOptions(current: string): { id: string; label: string }[] {
  return US_TIMEZONES.some((z) => z.id === current) ? US_TIMEZONES : [{ id: current, label: current }, ...US_TIMEZONES];
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && dayNumberToDate(dateToDayNumber(s)) === s;
}

/**
 * Locked fields keep their current values (disabled inputs aren't submitted).
 * Playoff teams: 0 (no playoffs) or 2..playoffLimit.
 */
export function parseScheduleForm(
  form: FormLike,
  opts: { locks: SettingsLocks; current: ScheduleSettings; seasonStart: string; playoffLimit: number; maxSeasonWeeks: number },
): ParseResult<{ seasonStart: string; schedule: ScheduleSettings }> {
  return attempt(() => {
    const { locks, current } = opts;
    let seasonStart = opts.seasonStart;
    if (!locks.seasonStart) {
      seasonStart = text(form, "seasonStart");
      if (!isIsoDate(seasonStart)) throw new FormProblem("Pick the season start date.");
      if (dayOfWeek(seasonStart) !== 1) throw new FormProblem("The season has to start on a Monday.");
    }
    const lockTime = timeOfDay(form, "lockTime", "Lineup lock time");
    let shape = {
      timezone: current.timezone,
      matchupWeeks: current.matchupWeeks,
      regularSeasonMatchups: current.regularSeasonMatchups,
      playoffRoundWeeks: current.playoffRoundWeeks,
    };
    if (!locks.scheduleShape) {
      const timezone = text(form, "timezone");
      if (!timezone || !isValidTimeZone(timezone)) throw new FormProblem("Pick a time zone.");
      shape = {
        timezone,
        matchupWeeks: whole(form, "matchupWeeks", "Weeks per matchup", 1, 4),
        regularSeasonMatchups: whole(form, "regularSeasonMatchups", "Regular-season matchups", 1, 30),
        playoffRoundWeeks: whole(form, "playoffRoundWeeks", "Weeks per playoff round", 1, 4),
      };
    }
    let playoffTeams = current.playoffTeams;
    if (!locks.playoffTeams) {
      playoffTeams = whole(form, "playoffTeams", "Playoff teams", 0, 12);
      if (playoffTeams === 1 || playoffTeams > opts.playoffLimit) {
        throw new FormProblem(`Playoff teams must be 0 (no playoffs) or between 2 and ${opts.playoffLimit}.`);
      }
    }
    const schedule = finalCheck(scheduleSchema, { ...shape, lockTime, playoffTeams });
    if (totalSeasonWeeks(schedule) > opts.maxSeasonWeeks) {
      throw new FormProblem(`That season would be ${totalSeasonWeeks(schedule)} weeks. Keep it to ${opts.maxSeasonWeeks} or fewer.`);
    }
    return { seasonStart, schedule };
  });
}

export type SeasonSummary = {
  regularWeeks: number;
  playoffRounds: number;
  playoffWeeks: number;
  totalWeeks: number;
  /** Last day (Sunday) of the season, YYYY-MM-DD. */
  endDate: string;
};

export function seasonSummary(schedule: ScheduleSettings, seasonStart: string): SeasonSummary {
  const regularWeeks = regularSeasonWeeks(schedule);
  const rounds = playoffRounds(schedule.playoffTeams);
  const totalWeeks = totalSeasonWeeks(schedule);
  return {
    regularWeeks,
    playoffRounds: rounds,
    playoffWeeks: rounds * schedule.playoffRoundWeeks,
    totalWeeks,
    endDate: weekEndDate(totalWeeks, seasonStart),
  };
}

// ---------------------------------------------------------------------------
// Draft
// ---------------------------------------------------------------------------

export const SECONDS_PER_PICK_CHOICES = [30, 60, 90, 120] as const;

const LOCAL_INPUT_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/;

/** datetime-local value ("YYYY-MM-DDTHH:MM") for an ISO instant, in a time zone. "" if invalid. */
export function isoToLocalInput(iso: string | null, timeZone: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${localDate(d, timeZone)}T${get("hour")}:${get("minute")}`;
}

/** ISO instant for a datetime-local value in a time zone; null for blank; undefined if malformed. */
export function localInputToIso(value: string, timeZone: string): string | null | undefined {
  const v = value.trim();
  if (!v) return null;
  const m = LOCAL_INPUT_RE.exec(v);
  if (!m || !isIsoDate(m[1]) || !TIME_RE.test(m[2])) return undefined;
  return zonedTimeToUtc(m[1], m[2], timeZone).toISOString();
}

export function parseDraftForm(form: FormLike, opts: { timeZone: string }): ParseResult<DraftSettings> {
  return attempt(() => {
    const choice = text(form, "secondsChoice");
    let secondsPerPick: number;
    if (choice === "custom" || choice === "") secondsPerPick = whole(form, "customSeconds", "Seconds per pick", 15, 600);
    else if ((SECONDS_PER_PICK_CHOICES as readonly number[]).includes(Number(choice))) secondsPerPick = Number(choice);
    else throw new FormProblem("Pick how long each pick lasts.");
    const scheduledAt = localInputToIso(text(form, "scheduledAt"), opts.timeZone);
    if (scheduledAt === undefined) throw new FormProblem("Pick a valid draft date and time (or leave it blank).");
    return finalCheck(draftSettingsSchema, { secondsPerPick, scheduledAt });
  });
}

// ---------------------------------------------------------------------------
// Waivers & trades
// ---------------------------------------------------------------------------

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export function parseWaiversForm(form: FormLike): ParseResult<WaiverSettings> {
  return attempt(() => {
    const processDay = whole(form, "processDay", "Waiver day", 0, 6);
    const processTime = timeOfDay(form, "processTime", "Waiver time");
    return finalCheck(waiverSettingsSchema, { processDay, processTime });
  });
}

export function parseTradesForm(form: FormLike, opts: { totalWeeks: number }): ParseResult<TradeSettings> {
  return attempt(() => {
    const reviewHours = whole(form, "reviewHours", "Review window", 0, 168);
    const deadlineRaw = text(form, "deadlineWeek");
    const deadlineWeek = deadlineRaw === "" ? null : whole(form, "deadlineWeek", "Trade deadline week", 1, opts.totalWeeks);
    return finalCheck(tradeSettingsSchema, { reviewHours, deadlineWeek });
  });
}
