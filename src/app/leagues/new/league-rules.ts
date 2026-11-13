/**
 * Pure rules for creating leagues and showing league status. No DB access.
 */
import { z } from "zod";
import { addDays, dateToDayNumber, dayNumberToDate, mondayOnOrAfter, mondayOnOrBefore, todayIn } from "@/lib/time";

const text = z.preprocess((v) => (v == null ? "" : v), z.string());
const clean = (s: string) => s.trim().replace(/\s+/g, " ");

export const LEAGUE_NAME_MAX = 60;
export const POOL_NAME_MAX = 60;

export const LEAGUE_STATUS_LABELS = {
  setup: "Pre-draft",
  drafting: "Drafting now",
  in_season: "In season",
  playoffs: "Playoffs",
  complete: "Season over",
} as const;
export type LeagueStatus = keyof typeof LEAGUE_STATUS_LABELS;

export function leagueStatusTone(status: LeagueStatus): "neutral" | "brand" | "accent" | "warn" {
  switch (status) {
    case "drafting":
      return "warn";
    case "in_season":
      return "brand";
    case "playoffs":
      return "accent";
    default:
      return "neutral";
  }
}

/** Is "YYYY-MM-DD" a real calendar date? */
export function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return dayNumberToDate(dateToDayNumber(s)) === s;
}

export const createLeagueSchema = z
  .object({
    name: text.transform(clean).pipe(
      z.string().min(2, "League names need at least 2 characters.").max(LEAGUE_NAME_MAX, `League names can be at most ${LEAGUE_NAME_MAX} characters.`),
    ),
    teamName: text.transform(clean).pipe(
      z.string().min(2, "Team names need at least 2 characters.").max(40, "Team names can be at most 40 characters."),
    ),
    maxTeams: text.pipe(
      z.coerce.number({ error: "Pick how many teams can join." }).int("Pick a whole number of teams.").min(2, "Leagues need at least 2 teams.").max(12, "Leagues can have at most 12 teams."),
    ),
    seasonStart: text.transform((s) => s.trim()).pipe(z.string().refine(isValidIsoDate, "Pick a season start date.")),
    pool: text.pipe(
      z.union([z.literal("new"), z.uuid("Pick a player pool.")], { error: "Pick a player pool." }),
    ),
    newPoolName: text.transform(clean),
  })
  .superRefine((d, ctx) => {
    if (d.pool !== "new") return;
    if (d.newPoolName.length < 2) ctx.addIssue({ code: "custom", path: ["newPoolName"], message: "Give the new player pool a name." });
    else if (d.newPoolName.length > POOL_NAME_MAX)
      ctx.addIssue({ code: "custom", path: ["newPoolName"], message: `Pool names can be at most ${POOL_NAME_MAX} characters.` });
  });
export type CreateLeagueInput = z.infer<typeof createLeagueSchema>;

/** Default season start: the next Monday strictly after today in the league time zone. */
export function defaultSeasonStart(now: Date, timeZone: string): string {
  return mondayOnOrAfter(addDays(todayIn(timeZone, now), 1));
}

/**
 * Snap a chosen date to the Monday on or after it and make sure it's not in a
 * past week or absurdly far away.
 */
export function resolveSeasonStart(
  input: string,
  now: Date,
  timeZone: string,
): { ok: true; date: string; snapped: boolean } | { ok: false; error: string } {
  if (!isValidIsoDate(input)) return { ok: false, error: "Pick a season start date." };
  const date = mondayOnOrAfter(input);
  const today = todayIn(timeZone, now);
  if (date < mondayOnOrBefore(today)) return { ok: false, error: "The season can't start in the past. Pick a later Monday." };
  if (dateToDayNumber(date) - dateToDayNumber(today) > 366) return { ok: false, error: "Pick a season start within the next year." };
  return { ok: true, date, snapped: date !== input };
}

export type PeriodRange = { period: number; weekStart: number; weekEnd: number };

/**
 * Which matchup period the league home should feature for a given week:
 * the period containing the week; before the season, the first period; after
 * the last period (or in a gap before playoffs are generated), the latest
 * period that already ended. Null when there's no schedule.
 */
export function pickHomePeriod(periods: PeriodRange[], week: number): number | null {
  if (periods.length === 0) return null;
  const containing = periods.find((p) => p.weekStart <= week && week <= p.weekEnd);
  if (containing) return containing.period;
  const first = periods.reduce((a, b) => (b.weekStart < a.weekStart ? b : a));
  if (week < first.weekStart) return first.period;
  let best: PeriodRange | null = null;
  for (const p of periods) {
    if (p.weekEnd < week && (!best || p.weekEnd > best.weekEnd || (p.weekEnd === best.weekEnd && p.period > best.period))) best = p;
  }
  return (best ?? first).period;
}
