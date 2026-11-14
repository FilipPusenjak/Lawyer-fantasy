/**
 * Scouting projections: projected weekly points, a low–high range, activity
 * rate, rest-of-season total and rankings for every lawyer and firm in a pool.
 *
 * Pure, deterministic and explainable. It only uses data in the app: case
 * appearances (active cases, case types, sides), approved scoring events and the
 * league's scoring settings. Points are always computed with
 * `computeLawyerPoints` (src/lib/scoring.ts), so targeting, the firm multiplier
 * (once per event) and the weekly filing cap match real scoring exactly.
 *
 * The model, in plain words:
 *
 * 1. History window: the last `lookbackWeeks` COMPLETE weeks before the current
 *    calendar week (weeks are counted from the season start, so preseason weeks
 *    are 0, -1, -2… and still count). The current, unfinished week is left out
 *    so a half-finished week doesn't look like a slow week.
 * 2. Own rate: a lawyer's recency-weighted average weekly points from events on
 *    their ACTIVE cases (plus lawyer-specific events that have no case). Weights
 *    halve every `halfLifeWeeks` weeks back. Only "observed" weeks count: weeks
 *    after the pool's first approved event (before that nothing was being
 *    recorded) and after their earliest active case started. Weeks with no
 *    events count as 0 points.
 * 3. Prior: what a typical case earns. For each case type (and position, when
 *    there's enough data) the pool's average points per case side per week,
 *    summed over the lawyer's active cases. Each level is shrunk toward its
 *    parent with `priorShrinkageWeeks` pseudo-weeks of data
 *    (position+type → type → default), so thin data falls back smoothly. If the
 *    pool has no approved events at all, the default per case type comes from
 *    the league's scoring values × assumed event frequencies
 *    (DEFAULT_WEEKLY_EVENT_RATES). Filing points in the prior are capped at the
 *    weekly filing cap, like real scoring.
 * 4. Blend (empirical-Bayes style shrinkage): weight on own rate =
 *    observedWeeks / (observedWeeks + ownShrinkageWeeks).
 * 5. Activity rate: blended share of observed weeks with any points; the prior
 *    side is the Poisson chance of at least one scoring event in a week.
 * 6. Range: projected ± |projected| × spread, where spread shrinks from 100%
 *    (no history) toward 30% as observed weeks grow. When at least 20% of weeks
 *    are expected to be scoreless (activity ≤ 80%), the range includes 0
 *    (20th/80th-percentile style).
 * 7. Closed cases contribute nothing going forward; no active cases → 0.
 * 8. Rest of season = projected weekly × weeks left (target week through the
 *    last week of the season).
 * 9. Firms: points from the distinct events on the firm's tracked cases (the
 *    firm itself plus its lawyers' cases) × firmMultiplier, once per event.
 *
 * No subjective labels anywhere: outputs are numbers and the factual inputs
 * behind them.
 */
import {
  activityRates,
  milestoneResolved,
  milestoneValue,
  milestoneWeekProbabilities,
  type CaseOutlook,
  type CreditTarget,
  type Milestone,
} from "./outlook";
import { computeLawyerPoints, round2, type AppearanceInput, type LawyerPoints, type ScoringEventInput } from "./scoring";
import {
  CASE_TYPES,
  POSITION_SHORT,
  type CaseType,
  type Position,
  type ScoringSettings,
  type Side,
  type ValuedEventType,
} from "./settings";
import { currentWeek, editableWeek, weekEndDate, weekOfDate, type WeekClock } from "./time";

/** One-line disclaimer shown wherever projections appear. */
export const PROJECTION_DISCLAIMER = "Projections are estimates from public court activity in this app and league scoring settings.";

export type ProjectionOptions = {
  /** Complete weeks of history used. */
  lookbackWeeks: number;
  /** Recency weighting: a week this many weeks older counts half as much. */
  halfLifeWeeks: number;
  /** k in observedWeeks / (observedWeeks + k): how fast own history takes over from the prior. */
  ownShrinkageWeeks: number;
  /** Pseudo case-weeks pulling each pool base rate toward its parent rate. */
  priorShrinkageWeeks: number;
};

export const DEFAULT_PROJECTION_OPTIONS: ProjectionOptions = {
  lookbackWeeks: 8,
  halfLifeWeeks: 3,
  ownShrinkageWeeks: 4,
  priorShrinkageWeeks: 12,
};

/** Range half-width as a share of |projected|: MIN_SPREAD with lots of history, MIN + EXTRA with none. */
const MIN_SPREAD = 0.3;
const EXTRA_SPREAD = 0.7;
/** If at least this share of weeks is expected to be scoreless, the range includes 0. */
const ZERO_WEEK_SHARE = 0.2;

/**
 * Fallback event frequencies, used only when the pool has no approved events
 * to learn from (and as the root that thin pool data is shrunk toward).
 * Assumed average number of each event type per case SIDE per week, averaged
 * over both sides and over a case's life. Rough, documented assumptions:
 * - a substantive filing about every 2 weeks per side in trial-level cases
 *   (fewer in appeals / the Supreme Court);
 * - a motion ruling about every 10 weeks per side, equally likely granted or
 *   denied;
 * - case-ending outcomes (dismissal, summary judgment, settlement, verdict,
 *   plea, appeal decision) a few times per thousand case-side weeks, i.e. a
 *   case typically runs one to two years.
 * Lawyer-specific "sanctioned" is too rare to assume. Values come from the
 * league's scoring settings, so the default follows the league's preset.
 */
export const DEFAULT_WEEKLY_EVENT_RATES: Record<CaseType, Partial<Record<ValuedEventType, number>>> = {
  civil: {
    filing: 0.5,
    motion_granted: 0.05,
    motion_denied: 0.05,
    dismissed_favorable: 0.004,
    summary_judgment_won: 0.003,
    settlement_favorable: 0.006,
    verdict_win: 0.002,
    verdict_loss: 0.002,
  },
  criminal: {
    filing: 0.5,
    motion_granted: 0.05,
    motion_denied: 0.05,
    dismissed_favorable: 0.003,
    guilty_plea: 0.008,
    plea_reduced: 0.006,
    verdict_win: 0.002,
    verdict_loss: 0.002,
  },
  appeal: {
    filing: 0.3,
    motion_granted: 0.02,
    motion_denied: 0.02,
    appeal_won: 0.006,
    win_reversed: 0.003,
  },
  supreme_court: {
    filing: 0.2,
    scotus_argument: 0.01,
    appeal_won: 0.005,
    win_reversed: 0.003,
  },
  other: {
    filing: 0.4,
    motion_granted: 0.04,
    motion_denied: 0.04,
    dismissed_favorable: 0.003,
    settlement_favorable: 0.003,
  },
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProjectionLawyer = {
  id: string;
  name: string;
  kind: "lawyer" | "firm";
  position: Position;
  firmId: string | null;
};

export type ProjectionCase = {
  id: string;
  caseType: CaseType;
  status: "active" | "closed";
  /** YYYY-MM-DD or null if unknown. */
  filedOn: string | null;
  /** Researched outlook (docket activity + scheduled events), if any. See src/lib/outlook.ts. */
  outlook?: CaseOutlook | null;
};

export type ProjectionInputs = {
  /** Distinct active cases (for a firm: the firm's and its lawyers' active cases). */
  activeCases: number;
  /** Distinct approved events in the history window that scored for them on active cases (or with no case). */
  eventsLookback: number;
  /** History weeks that counted (see the module comment). */
  observedWeeks: number;
  /** Recency-weighted weekly points from their own history, or null with no observed weeks. */
  ownRate: number | null;
  /** Typical weekly points for their active cases (pool base rate or default). */
  priorRate: number;
  /** Share of the projection that comes from their own history (0–1). */
  ownWeight: number;
  /** Active cases with a researched outlook (docket activity + schedule). */
  researchedCases: number;
  /** Scheduled or likely events (arguments, trials, decisions…) that could score for them this season. */
  scheduledEvents: number;
  /** Expected points from those events over the rest of the season (included in the projection). */
  scheduledPoints: number;
};

export type LawyerProjection = {
  lawyerId: string;
  projectedWeek: number;
  low: number;
  high: number;
  /** Expected share of weeks with any points (0–1). */
  activityRate: number;
  restOfSeason: number;
  inputs: ProjectionInputs;
};

export type ProjectionInput = {
  lawyers: ProjectionLawyer[];
  cases: ProjectionCase[];
  appearances: AppearanceInput[];
  /** Approved events only. */
  events: ScoringEventInput[];
  scoring: ScoringSettings;
  seasonStart: string;
  /** Last complete week included in history (usually the week before the current week). */
  historyThroughWeek: number;
  /** Weeks left to score, counting the projected week (0 once the season is over). */
  remainingWeeks: number;
  /** The week being projected (default: the week after the history window). */
  targetWeek?: number;
  options?: Partial<ProjectionOptions>;
};

export type ProjectionResult = {
  historyThroughWeek: number;
  lookbackWeeks: number;
  remainingWeeks: number;
  /** True if the pool has any approved event on or before the end of the history window. */
  poolHasHistory: boolean;
  projections: Map<string, LawyerProjection>;
};

export type CaseRates = {
  /** Expected non-filing points per case side per week. */
  other: number;
  /** Expected raw filing points per case side per week (capped per lawyer when summed). */
  filing: number;
  /** Expected number of scoring events per case side per week. */
  events: number;
};

// ---------------------------------------------------------------------------
// Week helpers
// ---------------------------------------------------------------------------

export type ProjectionWeeks = {
  /** Week being projected: the next week whose lineups can still be edited. */
  targetWeek: number;
  /** Last complete week used as history (can be ≤ 0 before the season). */
  historyThroughWeek: number;
  /** Weeks left including the target week (0 once the season is over). */
  remainingWeeks: number;
  phase: "preseason" | "in_season" | "complete";
};

/**
 * Which week to project and which weeks count as history. Before the season
 * the target is week 1; after the last week (or when the league is complete)
 * the phase is "complete" and no weeks remain.
 */
export function projectionWeeks(now: Date, clock: WeekClock, totalWeeks: number, leagueComplete = false): ProjectionWeeks {
  const cw = currentWeek(now, clock);
  const target = editableWeek(now, clock);
  const complete = leagueComplete || target > totalWeeks;
  return {
    targetWeek: complete ? totalWeeks + 1 : target,
    historyThroughWeek: cw - 1,
    remainingWeeks: complete ? 0 : totalWeeks - target + 1,
    phase: complete ? "complete" : cw < 1 ? "preseason" : "in_season",
  };
}

/** Last day ("YYYY-MM-DD", a Sunday) of the history window. */
export function historyEndDate(historyThroughWeek: number, seasonStart: string): string {
  return weekEndDate(historyThroughWeek, seasonStart);
}

// ---------------------------------------------------------------------------
// Default (no-history) rates
// ---------------------------------------------------------------------------

/**
 * Expected points per case side per week for each case type from the league's
 * scoring values and DEFAULT_WEEKLY_EVENT_RATES. A single filing scores at most
 * the weekly cap, and negative filing values never score (as in scoring.ts).
 */
export function defaultCaseRates(scoring: ScoringSettings): Record<CaseType, CaseRates> {
  const out = {} as Record<CaseType, CaseRates>;
  for (const type of CASE_TYPES) {
    let other = 0;
    let filing = 0;
    let events = 0;
    for (const [t, freq] of Object.entries(DEFAULT_WEEKLY_EVENT_RATES[type]) as [ValuedEventType, number][]) {
      const value = scoring.values[t];
      if (t === "filing") {
        const perFiling = Math.max(0, Math.min(value, scoring.filingWeeklyCap));
        filing += freq * perFiling;
        if (perFiling > 0) events += freq;
      } else {
        other += freq * value;
        if (value !== 0) events += freq;
      }
    }
    out[type] = { other, filing, events };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

type Stat = { other: number; filing: number; events: number; exposure: number };
type Unit = { caseId: string; side: Side; caseType: CaseType; active: boolean; exposure: number; start: number };

const emptyStat = (): Stat => ({ other: 0, filing: 0, events: 0, exposure: 0 });

function shrink(stat: Stat | undefined, parent: CaseRates, k: number): CaseRates {
  const s = stat ?? emptyStat();
  const d = s.exposure + k;
  if (d <= 0) return parent;
  return {
    other: (s.other + k * parent.other) / d,
    filing: (s.filing + k * parent.filing) / d,
    events: (s.events + k * parent.events) / d,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Project every lawyer and firm in `input.lawyers`. */
export function projectPool(input: ProjectionInput): ProjectionResult {
  const opts: ProjectionOptions = { ...DEFAULT_PROJECTION_OPTIONS, ...(input.options ?? {}) };
  const { scoring, seasonStart } = input;
  const L = Math.max(1, Math.floor(opts.lookbackWeeks));
  const H = input.historyThroughWeek;
  const windowStart = H - L + 1;
  const remainingWeeks = Math.max(0, input.remainingWeeks);
  const mult = scoring.firmMultiplier;

  const weekOf = (d: string) => weekOfDate(d, seasonStart);
  const lawyerById = new Map(input.lawyers.map((l) => [l.id, l]));
  const caseById = new Map(input.cases.map((c) => [c.id, c]));

  // Events that belong to this pool's cases (or have no case).
  const events = input.events.filter((e) => !e.caseId || caseById.has(e.caseId));
  const eventById = new Map(events.map((e) => [e.id, e]));

  // --- When recording started, and each case's known span -------------------
  let trackingStart = Infinity;
  const firstEventWeek = new Map<string, number>();
  const lastEventWeek = new Map<string, number>();
  for (const e of events) {
    const w = weekOf(e.occurredOn);
    if (w > H) continue; // not history yet
    if (w < trackingStart) trackingStart = w;
    if (e.caseId) {
      firstEventWeek.set(e.caseId, Math.min(firstEventWeek.get(e.caseId) ?? Infinity, w));
      lastEventWeek.set(e.caseId, Math.max(lastEventWeek.get(e.caseId) ?? -Infinity, w));
    }
  }
  const poolHasHistory = Number.isFinite(trackingStart);

  /** First week a case could have produced events (unknown filing date = always). */
  const caseStart = (c: ProjectionCase): number => {
    const filed = c.filedOn ? weekOf(c.filedOn) : -Infinity;
    return Math.min(filed, firstEventWeek.get(c.id) ?? Infinity);
  };
  /** Observed weeks of a case in the window. Closed cases count as open through their last event. */
  const caseExposure = (c: ProjectionCase): number => {
    const lo = Math.max(windowStart, trackingStart, caseStart(c));
    const end = c.status === "active" ? H : (lastEventWeek.get(c.id) ?? -Infinity);
    const hi = Math.min(H, end);
    return hi >= lo ? hi - lo + 1 : 0;
  };
  const exposureCache = new Map<string, number>();
  const exposureOf = (c: ProjectionCase): number => {
    let x = exposureCache.get(c.id);
    if (x === undefined) exposureCache.set(c.id, (x = caseExposure(c)));
    return x;
  };

  // --- Units: individual = an appearance; firm = a distinct tracked case side --
  const appsByLawyer = new Map<string, AppearanceInput[]>();
  const sideOn = new Map<string, Side>(); // lawyerId|caseId -> side
  for (const a of input.appearances) {
    if (!caseById.has(a.caseId) || !lawyerById.has(a.lawyerId)) continue;
    const arr = appsByLawyer.get(a.lawyerId);
    if (arr) arr.push(a);
    else appsByLawyer.set(a.lawyerId, [a]);
    sideOn.set(`${a.lawyerId}|${a.caseId}`, a.side);
  }
  const membersByFirm = new Map<string, string[]>();
  for (const l of input.lawyers) {
    if (l.kind !== "lawyer" || !l.firmId || lawyerById.get(l.firmId)?.kind !== "firm") continue;
    const arr = membersByFirm.get(l.firmId);
    if (arr) arr.push(l.id);
    else membersByFirm.set(l.firmId, [l.id]);
  }

  const unitsById = new Map<string, Map<string, Unit>>(); // lawyerId -> unitKey -> unit
  for (const l of input.lawyers) {
    const units = new Map<string, Unit>();
    const sources = l.kind === "firm" ? [l.id, ...(membersByFirm.get(l.id) ?? [])] : [l.id];
    for (const src of sources) {
      for (const a of appsByLawyer.get(src) ?? []) {
        const key = l.kind === "firm" ? `${a.caseId}|${a.side}` : a.caseId;
        if (units.has(key)) continue;
        const c = caseById.get(a.caseId)!;
        units.set(key, {
          caseId: c.id,
          side: a.side,
          caseType: c.caseType,
          active: c.status === "active",
          exposure: exposureOf(c),
          start: caseStart(c),
        });
      }
    }
    unitsById.set(l.id, units);
  }

  // --- Pool base rates --------------------------------------------------------
  const groupKey = (l: ProjectionLawyer) => `${l.kind}:${l.position}`;
  const typeStats = new Map<CaseType, Stat>(); // individuals only
  const groupStats = new Map<string, Stat>(); // groupKey|caseType
  const statFor = <K>(m: Map<K, Stat>, k: K): Stat => {
    let s = m.get(k);
    if (!s) m.set(k, (s = emptyStat()));
    return s;
  };
  for (const l of input.lawyers) {
    for (const u of unitsById.get(l.id)!.values()) {
      if (u.exposure === 0) continue;
      statFor(groupStats, `${groupKey(l)}|${u.caseType}`).exposure += u.exposure;
      if (l.kind === "lawyer") statFor(typeStats, u.caseType).exposure += u.exposure;
    }
  }

  // History-window points (shifted so the window is weeks 1..L for computeLawyerPoints).
  const windowWeekOf = (d: string) => weekOf(d) - windowStart + 1;
  const pointsFor = (evs: ScoringEventInput[]): Map<string, LawyerPoints> =>
    computeLawyerPoints({
      events: evs,
      appearances: input.appearances,
      lawyers: input.lawyers,
      scoring,
      weekOf: windowWeekOf,
      totalWeeks: L,
    });

  const allPoints = pointsFor(events);
  for (const [id, lp] of allPoints) {
    const l = lawyerById.get(id);
    if (!l) continue;
    const units = unitsById.get(id)!;
    for (const line of lp.lines) {
      const e = eventById.get(line.eventId);
      if (!e?.caseId) continue;
      let key: string | null = null;
      if (l.kind === "firm") {
        const side = e.side ?? (e.lawyerId ? sideOn.get(`${e.lawyerId}|${e.caseId}`) : undefined);
        if (side) key = `${e.caseId}|${side}`;
      } else {
        key = e.caseId;
      }
      const u = key ? units.get(key) : undefined;
      if (!u || u.exposure === 0) continue;
      const targets = [statFor(groupStats, `${groupKey(l)}|${u.caseType}`)];
      if (l.kind === "lawyer") targets.push(statFor(typeStats, u.caseType));
      for (const s of targets) {
        if (e.type === "filing") s.filing += line.points;
        else s.other += line.points;
        s.events += 1;
      }
    }
  }

  const K = opts.priorShrinkageWeeks;
  const defaults = defaultCaseRates(scoring);
  const typeRate = new Map<CaseType, CaseRates>();
  for (const t of CASE_TYPES) typeRate.set(t, shrink(typeStats.get(t), defaults[t], K));
  const groupRateCache = new Map<string, CaseRates>();
  const groupRate = (l: ProjectionLawyer, t: CaseType): CaseRates => {
    const key = `${groupKey(l)}|${t}`;
    let r = groupRateCache.get(key);
    if (!r) {
      const base = typeRate.get(t)!;
      // A firm scores firmMultiplier × each event once on each tracked case side.
      const parent = l.kind === "firm" ? { other: base.other * mult, filing: base.filing * mult, events: mult > 0 ? base.events : 0 } : base;
      r = shrink(groupStats.get(key), parent, K);
      groupRateCache.set(key, r);
    }
    return r;
  };

  // --- Outlooks: scheduled events and when each case is expected to end -------
  const target = input.targetWeek ?? H + 1;
  // Weeks to project: the target week through the last week (at least the target week itself).
  const lastWeek = target + Math.max(remainingWeeks, 1) - 1;
  const seasonWeeks: number[] = [];
  for (let w = target; w <= lastWeek; w++) seasonWeeks.push(w);
  const inSeason = (w: number) => remainingWeeks > 0 && w <= target + remainingWeeks - 1;

  type LiveMilestone = { caseId: string; m: Milestone; probs: Map<number, number> };
  type CaseOutlookState = { outlook: CaseOutlook; ended: boolean; milestones: LiveMilestone[]; survival: Map<number, number> };
  const eventsByCase = new Map<string, ScoringEventInput[]>();
  for (const e of events) {
    if (!e.caseId) continue;
    const arr = eventsByCase.get(e.caseId);
    if (arr) arr.push(e);
    else eventsByCase.set(e.caseId, [e]);
  }
  const outlookState = new Map<string, CaseOutlookState>();
  for (const c of input.cases) {
    if (c.status !== "active" || !c.outlook) continue;
    const caseEvents = eventsByCase.get(c.id) ?? [];
    let ended = false;
    const live: LiveMilestone[] = [];
    for (const m of c.outlook.milestones) {
      if (milestoneResolved(m, c.outlook.asOf, caseEvents)) {
        if (m.terminal) ended = true;
        continue;
      }
      live.push({ caseId: c.id, m, probs: milestoneWeekProbabilities(m, seasonStart, target, lastWeek) });
    }
    // Survival: chance the case is still open at the start of each week (terminal milestones end it).
    const survival = new Map<number, number>();
    const done = live.filter((x) => x.m.terminal).map(() => 0);
    const terminals = live.filter((x) => x.m.terminal);
    for (const w of seasonWeeks) {
      let s = ended ? 0 : 1;
      terminals.forEach((t, i) => (s *= 1 - Math.min(1, done[i])));
      survival.set(w, s);
      terminals.forEach((t, i) => (done[i] += t.probs.get(w) ?? 0));
    }
    outlookState.set(c.id, { outlook: c.outlook, ended, milestones: ended ? [] : live, survival });
  }

  /** Milestones that can credit each lawyer/firm, with the value to them if they happen. */
  const sidesOn = new Map<string, Map<string, Set<Side>>>(); // lawyerId -> caseId -> sides (firms include members)
  for (const l of input.lawyers) {
    const byCase = new Map<string, Set<Side>>();
    const sources = l.kind === "firm" ? [l.id, ...(membersByFirm.get(l.id) ?? [])] : [l.id];
    for (const src of sources) {
      for (const a of appsByLawyer.get(src) ?? []) {
        const set = byCase.get(a.caseId) ?? new Set<Side>();
        set.add(a.side);
        byCase.set(a.caseId, set);
      }
    }
    sidesOn.set(l.id, byCase);
  }
  const firmOf = (id: string): string | null => {
    const fid = lawyerById.get(id)?.firmId;
    return fid && lawyerById.get(fid)?.kind === "firm" ? fid : null;
  };
  // Lawyer-specific milestone events (e.g. a Supreme Court argument) reach that lawyer and their firm.
  const lawyerSpecific = new Map<string, Set<string>>(); // lawyerId or firmId -> caseIds
  for (const st of outlookState.values()) {
    for (const lm of st.milestones) {
      for (const o of lm.m.outcomes) {
        for (const e of o.events) {
          if (!e.lawyerId) continue;
          for (const id of [e.lawyerId, firmOf(e.lawyerId)]) {
            if (!id) continue;
            const set = lawyerSpecific.get(id) ?? new Set<string>();
            set.add(lm.caseId);
            lawyerSpecific.set(id, set);
          }
        }
      }
    }
  }
  type ScoredMilestone = { probs: Map<number, number>; points: number; scoreChance: number };
  const milestonesFor = (l: ProjectionLawyer): ScoredMilestone[] => {
    const byCase = sidesOn.get(l.id)!;
    const caseIds = new Set<string>([...byCase.keys(), ...(lawyerSpecific.get(l.id) ?? [])]);
    const ids = new Set<string>(l.kind === "firm" ? [l.id, ...(membersByFirm.get(l.id) ?? [])] : [l.id]);
    const out: ScoredMilestone[] = [];
    for (const caseId of caseIds) {
      const st = outlookState.get(caseId);
      if (!st) continue;
      const t: CreditTarget = { kind: l.kind, ids, sides: byCase.get(caseId) ?? new Set<Side>() };
      for (const lm of st.milestones) {
        const v = milestoneValue(lm.m, t, scoring);
        if (v.points !== 0 || v.scoreChance > 0) out.push({ probs: lm.probs, points: v.points, scoreChance: v.scoreChance });
      }
    }
    return out;
  };

  // --- Own history (active cases only) and the blend -------------------------
  const activeEvents = events.filter((e) => !e.caseId || caseById.get(e.caseId)!.status === "active");
  const ownPoints = pointsFor(activeEvents);
  const decay = (w: number) => Math.pow(0.5, (H - w) / opts.halfLifeWeeks);

  const projections = new Map<string, LawyerProjection>();
  for (const l of input.lawyers) {
    const units = [...unitsById.get(l.id)!.values()].filter((u) => u.active);
    const activeCases = new Set(units.map((u) => u.caseId)).size;
    const own = ownPoints.get(l.id);
    const eventsLookback = own ? new Set(own.lines.map((x) => x.eventId)).size : 0;

    // Per-unit weekly rates: the case's researched activity when there is one, else the typical rate.
    const unitRates = units.map((u) => {
      const st = outlookState.get(u.caseId);
      if (st) {
        const r = activityRates(st.outlook, u.side, scoring);
        const k = l.kind === "firm" ? mult : 1;
        return { caseId: u.caseId, other: r.other * k, filing: r.filing * k, events: k > 0 ? r.events : 0, survival: st.survival };
      }
      const r = groupRate(l, u.caseType);
      return { caseId: u.caseId, other: r.other, filing: r.filing, events: r.events, survival: null as Map<number, number> | null };
    });
    const filingCap = scoring.filingWeeklyCap * (l.kind === "firm" ? mult : 1);
    const priorAt = (w: number) => {
      let other = 0;
      let filing = 0;
      let evs = 0;
      let open = 0;
      for (const r of unitRates) {
        const s = r.survival ? (r.survival.get(w) ?? 0) : 1;
        other += r.other * s;
        filing += r.filing * s;
        evs += r.events * s;
        open += s;
      }
      return { rate: other + clamp(filing, 0, filingCap), events: evs, open: unitRates.length ? open / unitRates.length : 1 };
    };
    const priorTarget = priorAt(target);
    const priorRate = priorTarget.rate;

    // Own rate over observed weeks.
    const start = units.reduce((m, u) => Math.min(m, u.start), Infinity);
    const lo = Math.max(windowStart, trackingStart, start);
    let wSum = 0;
    let xSum = 0;
    let observedWeeks = 0;
    let activeWeeks = 0;
    for (let w = lo; w <= H; w++) {
      const x = own?.byWeek.get(w - windowStart + 1) ?? 0;
      const d = decay(w);
      wSum += d;
      xSum += d * x;
      observedWeeks++;
      if (x !== 0) activeWeeks++;
    }
    const ownRate = observedWeeks > 0 ? xSum / wSum : null;
    const ownActivity = observedWeeks > 0 ? activeWeeks / observedWeeks : 0;

    const kOwn = opts.ownShrinkageWeeks;
    const ownWeight = observedWeeks / (observedWeeks + kOwn);

    // Weekly expectation: blended base (scaled by the chance its cases are still open) + scheduled events.
    const scheduled = activeCases > 0 || lawyerSpecific.has(l.id) ? milestonesFor(l) : [];
    const expectedAt = (w: number): { points: number; scheduledPoints: number; events: number } => {
      const p = priorAt(w);
      const base = activeCases > 0 ? ownWeight * (ownRate ?? 0) * p.open + (1 - ownWeight) * p.rate : 0;
      let sched = 0;
      let schedEvents = 0;
      for (const m of scheduled) {
        const pw = m.probs.get(w) ?? 0;
        sched += pw * m.points;
        schedEvents += pw * m.scoreChance;
      }
      return { points: base + sched, scheduledPoints: sched, events: (activeCases > 0 ? p.events : 0) + schedEvents };
    };

    const atTarget = expectedAt(target);
    const projected = round2(atTarget.points);
    let rest = 0;
    let scheduledPoints = 0;
    if (remainingWeeks > 0) {
      for (const w of seasonWeeks) {
        if (!inSeason(w)) continue;
        const e = w === target ? atTarget : expectedAt(w);
        rest += round2(e.points);
        scheduledPoints += e.scheduledPoints;
      }
    }

    const priorActivity = 1 - Math.exp(-Math.max(0, atTarget.events));
    const activity = activeCases > 0 || scheduled.length > 0 ? ownWeight * ownActivity + (1 - ownWeight) * priorActivity : 0;
    const spread = MIN_SPREAD + EXTRA_SPREAD * (kOwn / (observedWeeks + kOwn));
    let low = projected - Math.abs(projected) * spread;
    let high = projected + Math.abs(projected) * spread;
    if (activity <= 1 - ZERO_WEEK_SHARE) {
      low = Math.min(low, 0);
      high = Math.max(high, 0);
    }
    const scheduledEvents = remainingWeeks > 0 ? scheduled.filter((m) => [...m.probs.entries()].some(([w, p]) => p > 0 && inSeason(w))).length : 0;

    projections.set(l.id, {
      lawyerId: l.id,
      projectedWeek: projected,
      low: round2(low),
      high: round2(high),
      activityRate: round2(clamp(activity, 0, 1)),
      restOfSeason: round2(rest),
      inputs: {
        activeCases,
        eventsLookback,
        observedWeeks,
        ownRate: ownRate === null ? null : round2(ownRate),
        priorRate: activeCases > 0 ? round2(priorRate) : 0,
        ownWeight: round2(ownWeight),
        researchedCases: new Set(units.filter((u) => outlookState.has(u.caseId)).map((u) => u.caseId)).size,
        scheduledEvents,
        scheduledPoints: round2(scheduledPoints),
      },
    });
  }

  return { historyThroughWeek: H, lookbackWeeks: L, remainingWeeks, poolHasHistory, projections };
}

// ---------------------------------------------------------------------------
// Rankings
// ---------------------------------------------------------------------------

export type RankedProjection = LawyerProjection & {
  name: string;
  position: Position;
  /**
   * Season rank: 1 = most projected points over the rest of the season (firms
   * included). This is the order draft ranks use.
   */
  overallRank: number;
  /** Season rank at this position (1 = best). */
  positionRank: number;
  /** e.g. "TRL3", "FIRM1" (season rank at the position). */
  positionLabel: string;
  /** Week rank: 1 = highest projection for the projected week. */
  weekRank: number;
  /** Week rank at this position. */
  weekPositionRank: number;
  /** e.g. "TRL3" (week rank at the position). */
  weekPositionLabel: string;
};

type Rankable = Pick<LawyerProjection, "lawyerId" | "projectedWeek" | "restOfSeason"> & { name: string };

/** Projected week (desc) → rest of season (desc) → name → id. Deterministic. */
export function compareProjections(a: Rankable, b: Rankable): number {
  return (
    b.projectedWeek - a.projectedWeek ||
    b.restOfSeason - a.restOfSeason ||
    a.name.localeCompare(b.name, "en") ||
    (a.lawyerId < b.lawyerId ? -1 : a.lawyerId > b.lawyerId ? 1 : 0)
  );
}

/** Rest of season (desc) first, then the usual order. */
export function compareProjectionsRestOfSeason(a: Rankable, b: Rankable): number {
  return b.restOfSeason - a.restOfSeason || compareProjections(a, b);
}

/**
 * Season ranks (rest of season, then the projected week) and week ranks (the
 * projected week, then rest of season), overall and per position. Sorted by
 * season rank, best first. Lawyers without a projection are skipped.
 */
export function rankProjections(
  projections: ReadonlyMap<string, LawyerProjection>,
  lawyers: readonly Pick<ProjectionLawyer, "id" | "name" | "position">[],
): RankedProjection[] {
  const rows = lawyers.flatMap((l) => {
    const p = projections.get(l.id);
    return p ? [{ ...p, name: l.name, position: l.position }] : [];
  });
  const rankBy = (cmp: typeof compareProjections) => {
    const sorted = [...rows].sort(cmp);
    const perPosition = new Map<Position, number>();
    const out = new Map<string, { overall: number; position: number }>();
    sorted.forEach((r, i) => {
      const position = (perPosition.get(r.position) ?? 0) + 1;
      perPosition.set(r.position, position);
      out.set(r.lawyerId, { overall: i + 1, position });
    });
    return { sorted, out };
  };
  const season = rankBy(compareProjectionsRestOfSeason);
  const week = rankBy(compareProjections).out;
  return season.sorted.map((r) => {
    const s = season.out.get(r.lawyerId)!;
    const w = week.get(r.lawyerId)!;
    return {
      ...r,
      overallRank: s.overall,
      positionRank: s.position,
      positionLabel: `${POSITION_SHORT[r.position]}${s.position}`,
      weekRank: w.overall,
      weekPositionRank: w.position,
      weekPositionLabel: `${POSITION_SHORT[r.position]}${w.position}`,
    };
  });
}

/** Small, JSON-safe slice of a ranked projection for client components (draft room, lists). */
export type ProjectionSummary = Pick<
  RankedProjection,
  "projectedWeek" | "low" | "high" | "activityRate" | "restOfSeason" | "overallRank" | "positionLabel"
>;

/** lawyerId → summary, safe to pass from a Server Component to a Client Component. */
export function projectionSummaries(rows: readonly RankedProjection[]): Record<string, ProjectionSummary> {
  const out: Record<string, ProjectionSummary> = {};
  for (const r of rows) {
    out[r.lawyerId] = {
      projectedWeek: r.projectedWeek,
      low: r.low,
      high: r.high,
      activityRate: r.activityRate,
      restOfSeason: r.restOfSeason,
      overallRank: r.overallRank,
      positionLabel: r.positionLabel,
    };
  }
  return out;
}

/** Sort helper: best projection rank first, lawyers without one last (then by name/id). */
export function compareByProjectionRank(
  summaries: Readonly<Record<string, Pick<ProjectionSummary, "overallRank">>>,
  a: { id: string; name: string },
  b: { id: string; name: string },
): number {
  const ra = summaries[a.id]?.overallRank ?? Number.MAX_SAFE_INTEGER;
  const rb = summaries[b.id]?.overallRank ?? Number.MAX_SAFE_INTEGER;
  return ra - rb || a.name.localeCompare(b.name, "en") || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Display helpers (neutral, factual)
// ---------------------------------------------------------------------------

function plural(n: number, word: string): string {
  return `${n} ${n === 1 ? word : `${word}s`}`;
}

/** Projection numbers for display: one decimal, no trailing ".0". */
export function fmtProjection(n: number): string {
  const r = Math.round(n * 10) / 10;
  return (Object.is(r, -0) ? 0 : r).toFixed(1).replace(/\.0$/, "");
}

/**
 * Factual inputs line, e.g. "4 active cases · 6 scoring events in the last 8 weeks · 2 case milestones this season".
 */
export function projectionInputsLine(p: Pick<LawyerProjection, "inputs">, lookbackWeeks: number): string {
  const parts = [
    plural(p.inputs.activeCases, "active case"),
    `${plural(p.inputs.eventsLookback, "scoring event")} in the last ${plural(lookbackWeeks, "week")}`,
  ];
  if (p.inputs.scheduledEvents > 0) parts.push(`${plural(p.inputs.scheduledEvents, "case milestone")} this season`);
  return parts.join(" · ");
}

/** Range text, e.g. "0–12.4". */
export function projectionRangeLabel(p: Pick<LawyerProjection, "low" | "high">): string {
  return `${fmtProjection(p.low)}–${fmtProjection(p.high)}`;
}

/** Activity as a whole percent, e.g. "45%". */
export function activityLabel(p: Pick<LawyerProjection, "activityRate">): string {
  return `${Math.round(p.activityRate * 100)}%`;
}
