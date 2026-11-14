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

/** Docket pace: substantive filings and motion rulings per side per week, and the share of rulings granted. */
const activityRatesSchema = z.object({
  /** Substantive filings per week by each side while the case is open. */
  filingsPerWeek: perSide(20),
  /** Rulings per week on each side's motions. */
  rulingsPerWeek: perSide(5),
  /** Share of those rulings that are granted. */
  grantRate: perSide(1),
});
export type ActivityRates = z.infer<typeof activityRatesSchema>;

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
  /**
   * Docket pace once this milestone has happened, replacing the case's activity
   * (e.g. post-verdict motions and sentencing papers after a trial). Only on a
   * non-terminal milestone, and at most one per outlook.
   */
  activityAfter: activityRatesSchema.optional(),
});
export type Milestone = z.infer<typeof milestoneSchema>;

export const caseOutlookSchema = z.object({
  /** Research date (YYYY-MM-DD). Approved events after it can resolve milestones. */
  asOf: isoDate,
  /** One neutral sentence: where the case stands. */
  stage: z.string().max(400),
  activity: activityRatesSchema.extend({
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
  const ms = r.data.milestones;
  const valid =
    ms.every((m) => m.windowEnd >= m.windowStart && outcomesSumToOne(m) && !(m.terminal && m.activityAfter)) &&
    ms.filter((m) => m.activityAfter).length <= 1;
  return valid ? r.data : null;
}

function outcomesSumToOne(m: Milestone): boolean {
  const s = m.outcomes.reduce((n, o) => n + o.probability, 0);
  return Math.abs(s - 1) < 0.02;
}

// ---------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------

/** Expected points per week for one side from activity (an outlook's, or a milestone's activityAfter): raw filing points (capped later) and the rest. */
export function activityRates(
  source: CaseOutlook | ActivityRates,
  side: Side,
  scoring: ScoringSettings,
): { filing: number; other: number; events: number } {
  const a = "activity" in source ? source.activity : source;
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
 * Share of a milestone's outcomes that would leave an approved event behind
 * (any event other than the automatic verdict_loss). A sentencing, or a
 * Supreme Court argument by someone outside the pool, leaves none, so the app
 * can't see whether it has happened.
 */
export function observableShare(m: Milestone): number {
  let q = 0;
  let total = 0;
  for (const o of m.outcomes) {
    total += o.probability;
    if (o.events.some((e) => e.type !== "verdict_loss")) q += o.probability;
  }
  return total > 0 ? Math.min(1, q / total) : 0;
}

/**
 * When a milestone happens, given that no approved event has resolved it.
 * Probability is spread evenly over the window's days. Mass in weeks before
 * `firstWeek` (the first week not known to be over) has either happened
 * unseen (the unobservable share) or not happened, so the rest is
 * renormalized only by what an approved event would have shown:
 * P(week w) = p_w / (1 − q·before) and happenedUnseen = (1 − q)·before / (1 − q·before),
 * where q = observableShare(m).
 */
export function milestoneTiming(
  m: Milestone,
  seasonStart: string,
  firstWeek: number,
  lastWeek: number,
): { probs: Map<number, number>; happenedUnseen: number } {
  const out = new Map<number, number>();
  const start = dateToDayNumber(m.windowStart);
  const end = dateToDayNumber(m.windowEnd);
  const days = end - start + 1;
  if (days <= 0 || m.probability <= 0) return { probs: out, happenedUnseen: 0 };
  const perDay = m.probability / days;
  let before = 0;
  for (let d = start; d <= end; d++) {
    const w = weekOfDate(addDays(m.windowStart, d - start), seasonStart);
    if (w < firstWeek) before += perDay;
    else if (w <= lastWeek) out.set(w, (out.get(w) ?? 0) + perDay);
  }
  const q = observableShare(m);
  const remaining = 1 - q * before;
  if (remaining <= 1e-9) return { probs: new Map(), happenedUnseen: 0 };
  if (before > 0) for (const [w, p] of out) out.set(w, p / remaining);
  return { probs: out, happenedUnseen: ((1 - q) * before) / remaining };
}

/** Week → probability that the milestone happens that week (see milestoneTiming). */
export function milestoneWeekProbabilities(m: Milestone, seasonStart: string, firstWeek: number, lastWeek: number): Map<number, number> {
  return milestoneTiming(m, seasonStart, firstWeek, lastWeek).probs;
}

/** An approved event on the case, as milestone resolution needs it. */
export type ResolvingEvent = { id?: string; type: string; occurredOn: string; side: Side | null; lawyerId: string | null };

/** Rulings that docket activity also produces: they only resolve a milestone inside its window. */
const ROUTINE_RULINGS: ReadonlySet<string> = new Set(["motion_granted", "motion_denied"]);

/** Could this milestone have produced the approved event? Same type; a lawyer event for the same lawyer, a side event for the same side. */
function couldProduce(m: Milestone, e: ResolvingEvent): boolean {
  return m.outcomes.some((o) =>
    o.events.some((x) => {
      if (x.type === "verdict_loss" || x.type !== e.type) return false;
      if (x.lawyerId) return e.lawyerId === x.lawyerId;
      return e.lawyerId === null && (e.side === null || e.side === x.side);
    }),
  );
}

/**
 * Which milestones approved events have already resolved, whether (and when)
 * the case has ended, and which events were used up doing it. Only events dated
 * on/after the research date count, in date order. An event can resolve a
 * milestone that could have produced it (couldProduce); a routine ruling
 * (motion_granted/denied) only inside the milestone's window, where a window
 * starting on or before the season start counts from the research date. Each
 * event resolves at most one milestone: a non-terminal one first (so an
 * ambiguous match, e.g. a co-defendant's plea, never ends a case while a
 * non-terminal explanation is open), then one whose window contains its date,
 * then the likeliest (probability per window day), then list order. When every
 * open milestone that could explain the event is terminal, the case has ended
 * whichever one it was. Events on the same day that a milestone resolved that
 * day could have produced are absorbed by it (one order denying two motions).
 */
export function resolveMilestones(
  outlook: CaseOutlook,
  caseEvents: readonly ResolvingEvent[],
  seasonStart: string,
): { resolved: Set<number>; ended: boolean; endedOn: string | null; consumed: Set<string> } {
  const ms = outlook.milestones;
  const from = (m: Milestone) => (m.windowStart <= seasonStart ? outlook.asOf : m.windowStart);
  const inWindow = (m: Milestone, d: string) => d >= from(m) && d <= m.windowEnd;
  const density = (m: Milestone) => m.probability / (dateToDayNumber(m.windowEnd) - dateToDayNumber(m.windowStart) + 1);
  const resolved = new Set<number>();
  const resolvedOn = new Map<number, string>();
  const consumed = new Set<string>();
  let endedOn: string | null = null;
  const end = (d: string) => {
    if (endedOn === null || d < endedOn) endedOn = d;
  };
  const evs = caseEvents.filter((e) => e.occurredOn >= outlook.asOf).sort((a, b) => a.occurredOn.localeCompare(b.occurredOn));
  for (const e of evs) {
    const all = ms
      .map((_, i) => i)
      .filter((i) => couldProduce(ms[i], e) && (!ROUTINE_RULINGS.has(e.type) || inWindow(ms[i], e.occurredOn)));
    const sameDay = all.find((i) => resolvedOn.get(i) === e.occurredOn);
    if (sameDay !== undefined) {
      if (e.id) consumed.add(e.id);
      continue; // absorbed by the milestone it resolved today
    }
    const open = all.filter((i) => !resolved.has(i));
    if (open.length === 0) continue;
    const rank = (i: number) => [ms[i].terminal ? 1 : 0, inWindow(ms[i], e.occurredOn) ? 0 : 1, -density(ms[i]), i];
    open.sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      for (let k = 0; k < ra.length; k++) if (ra[k] !== rb[k]) return ra[k] - rb[k];
      return 0;
    });
    const i = open[0];
    resolved.add(i);
    resolvedOn.set(i, e.occurredOn);
    if (e.id) consumed.add(e.id);
    // Non-terminal milestones rank first, so a terminal pick means every open explanation is terminal.
    if (ms[i].terminal) end(e.occurredOn);
  }
  return { resolved, ended: endedOn !== null, endedOn, consumed };
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

/**
 * Points each outcome would give this lawyer or firm IF the milestone happens
 * (same crediting as milestoneValue), for the weekly range.
 */
export function milestoneOutcomePoints(m: Milestone, t: CreditTarget, scoring: ScoringSettings): { probability: number; points: number }[] {
  const mult = t.kind === "firm" ? scoring.firmMultiplier : 1;
  return m.outcomes.map((o) => ({
    probability: o.probability,
    points: o.events.reduce(
      (sum, e) => sum + ((e.lawyerId ? t.ids.has(e.lawyerId) : e.side ? t.sides.has(e.side) : false) ? scoring.values[e.type] * mult : 0),
      0,
    ),
  }));
}
