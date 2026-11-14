/**
 * Case outlooks: per-case, sourced expectations used by projections.
 *
 * An outlook says how busy a case's docket is (substantive filings and motion
 * rulings per side per week) and which scoring events are scheduled or likely
 * during the season (an argument date, a trial, a decision window), each with a
 * probability and the scoring events it would produce. They come from public
 * records (see data/real-pool-2026-27/) and are only used for projections —
 * real points still only come from approved scoring events.
 *
 * Pure and framework-free (safe on the client).
 */
import { z } from "zod";
import { SIDES, type ScoringSettings, type Side, type ValuedEventType } from "./settings";
import { addDays, dateToDayNumber, weekOfDate } from "./time";

/** Event types a milestone can produce (filings and rulings are covered by activity rates). */
export const MILESTONE_EVENT_TYPES = [
  "motion_granted",
  "motion_denied",
  "dismissed_favorable",
  "summary_judgment_won",
  "verdict_win",
  "verdict_loss",
  "settlement_favorable",
  "appeal_won",
  "scotus_argument",
  "guilty_plea",
  "plea_reduced",
] as const satisfies readonly ValuedEventType[];
export type MilestoneEventType = (typeof MILESTONE_EVENT_TYPES)[number];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const prob = z.number().min(0).max(1);
const perSide = (max: number) => z.object({ plaintiff: z.number().min(0).max(max), defendant: z.number().min(0).max(max) });

export const milestoneEventSchema = z
  .object({
    type: z.enum(MILESTONE_EVENT_TYPES),
    /** The side credited (every pool lawyer on that side); null for lawyer-specific events. */
    side: z.enum(SIDES).nullable(),
    /** The lawyer credited, for lawyer-specific events (Supreme Court argument). */
    lawyerId: z.string().uuid().nullable(),
  })
  .refine((e) => (e.side === null) !== (e.lawyerId === null), "An event credits either a side or one lawyer.");
export type MilestoneEvent = z.infer<typeof milestoneEventSchema>;

export const milestoneSchema = z.object({
  /** Neutral fact, e.g. "Oral argument scheduled for Jan 13, 2027". */
  label: z.string().min(1).max(200),
  /** Dates the event could happen on (inclusive); probability is spread evenly over these days. */
  windowStart: isoDate,
  windowEnd: isoDate,
  /** Chance it happens within the window. */
  probability: prob,
  /** True if it ends the case at this court (filings and rulings stop afterwards). */
  terminal: z.boolean(),
  /** Mutually exclusive outcomes; probabilities sum to 1. */
  outcomes: z
    .array(z.object({ probability: prob, label: z.string().max(120), events: z.array(milestoneEventSchema).max(6) }))
    .min(1)
    .max(6),
  sourceUrl: z.string().url().nullable(),
});
export type Milestone = z.infer<typeof milestoneSchema>;

export const caseOutlookSchema = z.object({
  /** Research date (YYYY-MM-DD). Approved events after it can resolve milestones. */
  asOf: isoDate,
  /** One neutral sentence: where the case stands. */
  stage: z.string().max(400),
  activity: z.object({
    /** Substantive filings per week by each side while the case is open. */
    filingsPerWeek: perSide(20),
    /** Rulings per week on each side's motions. */
    rulingsPerWeek: perSide(5),
    /** Share of those rulings that are granted. */
    grantRate: perSide(1),
    /** How the rates were estimated (neutral, factual). */
    basis: z.string().max(600),
  }),
  milestones: z.array(milestoneSchema).max(12),
  sources: z.array(z.string().url()).max(40),
});
export type CaseOutlook = z.infer<typeof caseOutlookSchema>;

/** Parse a stored outlook; anything invalid is ignored (projections fall back to typical rates). */
export function parseCaseOutlook(raw: unknown): CaseOutlook | null {
  if (raw === null || raw === undefined) return null;
  const r = caseOutlookSchema.safeParse(raw);
  if (!r.success) return null;
  return r.data.milestones.every((m) => m.windowEnd >= m.windowStart && outcomesSumToOne(m)) ? r.data : null;
}

function outcomesSumToOne(m: Milestone): boolean {
  const s = m.outcomes.reduce((n, o) => n + o.probability, 0);
  return Math.abs(s - 1) < 0.02;
}

// ---------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------

/** Expected points per week for one side from activity: raw filing points (capped later) and the rest. */
export function activityRates(
  outlook: CaseOutlook,
  side: Side,
  scoring: ScoringSettings,
): { filing: number; other: number; events: number } {
  const a = outlook.activity;
  const perFiling = Math.max(0, Math.min(scoring.values.filing, scoring.filingWeeklyCap));
  const filings = a.filingsPerWeek[side];
  const rulings = a.rulingsPerWeek[side];
  const g = a.grantRate[side];
  const other = rulings * (g * scoring.values.motion_granted + (1 - g) * scoring.values.motion_denied);
  return {
    filing: filings * perFiling,
    other,
    events: (perFiling > 0 ? filings : 0) + (scoring.values.motion_granted !== 0 || scoring.values.motion_denied !== 0 ? rulings : 0),
  };
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/**
 * Probability that a milestone happens in each season week, from `firstWeek`
 * on, given it hasn't happened before `firstWeek` (the mass before is
 * removed and the rest renormalized). Returns week → probability.
 */
export function milestoneWeekProbabilities(m: Milestone, seasonStart: string, firstWeek: number, lastWeek: number): Map<number, number> {
  const out = new Map<number, number>();
  const start = dateToDayNumber(m.windowStart);
  const end = dateToDayNumber(m.windowEnd);
  const days = end - start + 1;
  if (days <= 0 || m.probability <= 0) return out;
  const perDay = m.probability / days;
  let before = 0;
  for (let d = start; d <= end; d++) {
    const w = weekOfDate(addDays(m.windowStart, d - start), seasonStart);
    if (w < firstWeek) before += perDay;
    else if (w <= lastWeek) out.set(w, (out.get(w) ?? 0) + perDay);
  }
  const remaining = 1 - before;
  if (remaining <= 1e-9) return new Map();
  if (before > 0) for (const [w, p] of out) out.set(w, p / remaining);
  return out;
}

/**
 * Has an approved event already resolved this milestone? True when the case
 * has an approved event of one of the milestone's types (other than the
 * automatic verdict_loss) dated on/after the outlook's research date.
 */
export function milestoneResolved(
  m: Milestone,
  asOf: string,
  caseEvents: readonly { type: string; occurredOn: string }[],
): boolean {
  const types = new Set<string>();
  for (const o of m.outcomes) for (const e of o.events) if (e.type !== "verdict_loss") types.add(e.type);
  if (types.size === 0) return false;
  return caseEvents.some((e) => types.has(e.type) && e.occurredOn >= asOf);
}

// ---------------------------------------------------------------------------
// Value of a milestone to one lawyer or firm
// ---------------------------------------------------------------------------

export type CreditTarget = {
  kind: "lawyer" | "firm";
  /** For a lawyer: their id. For a firm: the firm id and its members' ids. */
  ids: ReadonlySet<string>;
  /** Sides of this case the target appears on (a firm: itself or any member). */
  sides: ReadonlySet<Side>;
};

/**
 * Expected points from a milestone IF it happens, and the chance it gives any
 * points. Mirrors real scoring: a side event credits everyone on that side, a
 * lawyer event credits that lawyer, and a firm gets value × multiplier once per
 * event when it or any of its lawyers is credited.
 */
export function milestoneValue(m: Milestone, t: CreditTarget, scoring: ScoringSettings): { points: number; scoreChance: number } {
  const mult = t.kind === "firm" ? scoring.firmMultiplier : 1;
  let points = 0;
  let scoreChance = 0;
  for (const o of m.outcomes) {
    let pts = 0;
    let any = false;
    for (const e of o.events) {
      const credited = e.lawyerId ? t.ids.has(e.lawyerId) : e.side ? t.sides.has(e.side) : false;
      if (!credited) continue;
      const v = scoring.values[e.type] * mult;
      pts += v;
      if (v !== 0) any = true;
    }
    points += o.probability * pts;
    if (any) scoreChance += o.probability;
  }
  return { points, scoreChance };
}
