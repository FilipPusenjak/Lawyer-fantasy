import { z } from "zod";

/** Lawyer positions. "firm" is the D/ST-style Law Firm position. */
export const POSITIONS = ["trial", "appellate", "prosecutor", "defense", "firm"] as const;
export type Position = (typeof POSITIONS)[number];

export const POSITION_LABELS: Record<Position, string> = {
  trial: "Trial Lawyer",
  appellate: "Appellate Lawyer",
  prosecutor: "Prosecutor",
  defense: "Defense Attorney",
  firm: "Law Firm",
};

export const POSITION_SHORT: Record<Position, string> = {
  trial: "TRL",
  appellate: "APP",
  prosecutor: "PRO",
  defense: "DEF",
  firm: "FIRM",
};

/** Starting lineup slot types. FLEX accepts any individual lawyer (not firms). */
export const SLOT_TYPES = ["trial", "appellate", "prosecutor", "defense", "flex", "firm"] as const;
export type SlotType = (typeof SLOT_TYPES)[number];

export const SLOT_LABELS: Record<SlotType, string> = {
  trial: "TRL",
  appellate: "APP",
  prosecutor: "PRO",
  defense: "DEF",
  flex: "FLEX",
  firm: "FIRM",
};

/** Scoring event types. Values are per-league and editable by the commissioner. */
export const EVENT_TYPES = [
  "motion_granted",
  "motion_denied",
  "dismissed_favorable",
  "summary_judgment_won",
  "verdict_win",
  "verdict_loss",
  "settlement_favorable",
  "appeal_won",
  "win_reversed",
  "sanctioned",
  "scotus_argument",
  "guilty_plea",
  "plea_reduced",
  "filing",
  "custom",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export type ValuedEventType = Exclude<EventType, "custom">;

export const EVENT_LABELS: Record<EventType, string> = {
  motion_granted: "Motion granted",
  motion_denied: "Motion denied",
  dismissed_favorable: "Case dismissed in client's favor",
  summary_judgment_won: "Summary judgment for client",
  verdict_win: "Trial verdict won",
  verdict_loss: "Trial verdict lost",
  settlement_favorable: "Favorable settlement announced",
  appeal_won: "Appeal won",
  win_reversed: "Win reversed on appeal",
  sanctioned: "Sanctioned by the court",
  scotus_argument: "Argued before the U.S. Supreme Court",
  guilty_plea: "Guilty plea secured",
  plea_reduced: "Charges reduced in plea",
  filing: "Substantive filing",
  custom: "Other (custom points)",
};

/** Events that apply to one specific lawyer rather than a whole side of a case. */
export const LAWYER_SPECIFIC_EVENTS: ReadonlySet<EventType> = new Set(["sanctioned", "scotus_argument"]);

export type ScoringValues = Record<ValuedEventType, number>;

export const SCORING_PRESETS = ["outcomes", "half_ppf", "full_ppf"] as const;
export type ScoringPreset = (typeof SCORING_PRESETS)[number] | "custom";

export const PRESET_LABELS: Record<ScoringPreset, string> = {
  outcomes: "Outcomes only",
  half_ppf: "Half-PPF (points per filing)",
  full_ppf: "Full PPF (points per filing)",
  custom: "Custom",
};

const BASE_VALUES: Omit<ScoringValues, "filing"> = {
  motion_granted: 2,
  motion_denied: -2,
  dismissed_favorable: 5,
  summary_judgment_won: 6,
  verdict_win: 10,
  verdict_loss: -8,
  settlement_favorable: 6,
  appeal_won: 8,
  win_reversed: -5,
  sanctioned: -10,
  scotus_argument: 5,
  guilty_plea: 4,
  plea_reduced: 3,
};

export function presetScoring(preset: Exclude<ScoringPreset, "custom">): ScoringSettings {
  switch (preset) {
    case "outcomes":
      return { preset, values: { ...BASE_VALUES, filing: 0 }, filingWeeklyCap: 0, firmMultiplier: 0.5 };
    case "half_ppf":
      return { preset, values: { ...BASE_VALUES, filing: 0.5 }, filingWeeklyCap: 3, firmMultiplier: 0.5 };
    case "full_ppf":
      return { preset, values: { ...BASE_VALUES, filing: 1 }, filingWeeklyCap: 5, firmMultiplier: 0.5 };
  }
}

const num = z.number().finite().min(-100).max(100);

export const scoringSchema = z.object({
  preset: z.enum([...SCORING_PRESETS, "custom"]),
  values: z.object({
    motion_granted: num,
    motion_denied: num,
    dismissed_favorable: num,
    summary_judgment_won: num,
    verdict_win: num,
    verdict_loss: num,
    settlement_favorable: num,
    appeal_won: num,
    win_reversed: num,
    sanctioned: num,
    scotus_argument: num,
    guilty_plea: num,
    plea_reduced: num,
    filing: num,
  }),
  /** Max points per lawyer per week from "filing" events (raw, before firm multiplier). 0 = no filing points. */
  filingWeeklyCap: z.number().min(0).max(100),
  /** Law Firm position scores this multiple of each event on its tracked cases. */
  firmMultiplier: z.number().min(0).max(5),
});
export type ScoringSettings = z.infer<typeof scoringSchema>;

export const rosterSchema = z.object({
  trial: z.number().int().min(0).max(3),
  appellate: z.number().int().min(0).max(3),
  prosecutor: z.number().int().min(0).max(3),
  defense: z.number().int().min(0).max(3),
  flex: z.number().int().min(0).max(4),
  firm: z.number().int().min(0).max(2),
  bench: z.number().int().min(0).max(10),
});
export type RosterSettings = z.infer<typeof rosterSchema>;

export const scheduleSchema = z.object({
  /** IANA time zone used for weeks and lineup locks. */
  timezone: z.string().min(1),
  /** Lineups lock at this local time on the first day (Monday) of each week, "HH:MM". */
  lockTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  /** Weeks per regular-season matchup. */
  matchupWeeks: z.number().int().min(1).max(4),
  /** Number of regular-season matchups. */
  regularSeasonMatchups: z.number().int().min(1).max(30),
  /** Number of playoff teams (0 = no playoffs). */
  playoffTeams: z.number().int().min(0).max(12),
  /** Weeks per playoff round. */
  playoffRoundWeeks: z.number().int().min(1).max(4),
});
export type ScheduleSettings = z.infer<typeof scheduleSchema>;

export const draftSettingsSchema = z.object({
  secondsPerPick: z.number().int().min(15).max(600),
  /** ISO timestamp the draft is scheduled for, if any. */
  scheduledAt: z.string().nullable(),
});
export type DraftSettings = z.infer<typeof draftSettingsSchema>;

export const waiverSettingsSchema = z.object({
  /** Day of week waivers process: 0=Sunday … 6=Saturday. */
  processDay: z.number().int().min(0).max(6),
  /** Local time ("HH:MM") waivers process on that day. */
  processTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
});
export type WaiverSettings = z.infer<typeof waiverSettingsSchema>;

export const tradeSettingsSchema = z.object({
  /** Hours the commissioner has to veto an accepted trade. */
  reviewHours: z.number().int().min(0).max(168),
  /** Last week (inclusive) trades may be proposed; null = no deadline. */
  deadlineWeek: z.number().int().min(1).nullable(),
});
export type TradeSettings = z.infer<typeof tradeSettingsSchema>;

export const leagueSettingsSchema = z.object({
  maxTeams: z.number().int().min(2).max(12),
  roster: rosterSchema,
  scoring: scoringSchema,
  schedule: scheduleSchema,
  draft: draftSettingsSchema,
  waivers: waiverSettingsSchema,
  trades: tradeSettingsSchema,
});
export type LeagueSettings = z.infer<typeof leagueSettingsSchema>;

export function defaultLeagueSettings(): LeagueSettings {
  return {
    maxTeams: 12,
    roster: { trial: 1, appellate: 1, prosecutor: 1, defense: 1, flex: 2, firm: 1, bench: 5 },
    scoring: presetScoring("half_ppf"),
    schedule: {
      timezone: "America/New_York",
      lockTime: "06:00",
      matchupWeeks: 2,
      regularSeasonMatchups: 10,
      playoffTeams: 4,
      playoffRoundWeeks: 2,
    },
    draft: { secondsPerPick: 90, scheduledAt: null },
    waivers: { processDay: 3, processTime: "03:00" },
    trades: { reviewHours: 24, deadlineWeek: null },
  };
}

/** Parse settings from the DB, filling any missing keys from defaults. */
export function parseLeagueSettings(raw: unknown): LeagueSettings {
  const defaults = defaultLeagueSettings();
  const r = (raw ?? {}) as Partial<LeagueSettings>;
  const merged = {
    ...defaults,
    ...r,
    roster: { ...defaults.roster, ...(r.roster ?? {}) },
    scoring: {
      ...defaults.scoring,
      ...(r.scoring ?? {}),
      values: { ...defaults.scoring.values, ...(r.scoring?.values ?? {}) },
    },
    schedule: { ...defaults.schedule, ...(r.schedule ?? {}) },
    draft: { ...defaults.draft, ...(r.draft ?? {}) },
    waivers: { ...defaults.waivers, ...(r.waivers ?? {}) },
    trades: { ...defaults.trades, ...(r.trades ?? {}) },
  };
  return leagueSettingsSchema.parse(merged);
}

/** Ordered list of starting slot types, e.g. ["trial","appellate",…,"flex","flex","firm"]. */
export function starterSlots(roster: RosterSettings): SlotType[] {
  const out: SlotType[] = [];
  for (const t of SLOT_TYPES) {
    for (let i = 0; i < roster[t]; i++) out.push(t);
  }
  return out;
}

export function rosterSize(roster: RosterSettings): number {
  return starterSlots(roster).length + roster.bench;
}

export function slotAccepts(slot: SlotType, position: Position): boolean {
  if (slot === "flex") return position !== "firm";
  return slot === position;
}

/** Number of playoff rounds for a given playoff team count. */
export function playoffRounds(playoffTeams: number): number {
  if (playoffTeams < 2) return 0;
  return Math.ceil(Math.log2(playoffTeams));
}

export function regularSeasonWeeks(s: ScheduleSettings): number {
  return s.matchupWeeks * s.regularSeasonMatchups;
}

export function totalSeasonWeeks(s: ScheduleSettings): number {
  return regularSeasonWeeks(s) + playoffRounds(s.playoffTeams) * s.playoffRoundWeeks;
}

/** Side labels depend on the kind of case. */
export const CASE_TYPES = ["civil", "criminal", "appeal", "supreme_court", "other"] as const;
export type CaseType = (typeof CASE_TYPES)[number];
export const CASE_TYPE_LABELS: Record<CaseType, string> = {
  civil: "Civil",
  criminal: "Criminal",
  appeal: "Appeal",
  supreme_court: "U.S. Supreme Court",
  other: "Other",
};

export const SIDES = ["plaintiff", "defendant"] as const;
export type Side = (typeof SIDES)[number];

export function sideLabel(caseType: CaseType, side: Side): string {
  switch (caseType) {
    case "criminal":
      return side === "plaintiff" ? "Prosecution" : "Defense";
    case "appeal":
      return side === "plaintiff" ? "Appellant" : "Appellee";
    case "supreme_court":
      return side === "plaintiff" ? "Petitioner" : "Respondent";
    default:
      return side === "plaintiff" ? "Plaintiff" : "Defendant";
  }
}

export function otherSide(side: Side): Side {
  return side === "plaintiff" ? "defendant" : "plaintiff";
}
