import { describe, expect, it } from "vitest";
import {
  defaultCaseRates,
  projectionWeeks,
  projectPool,
  type ProjectionCase,
  type ProjectionInput,
  type ProjectionLawyer,
} from "@/lib/projections";
import type { AppearanceInput, ScoringEventInput } from "@/lib/scoring";
import { presetScoring, type Position, type ScoringSettings } from "@/lib/settings";
import { addDays } from "@/lib/time";

const SEASON_START = "2026-11-02"; // a Monday
const halfPpf = presetScoring("half_ppf");

/** A date inside week `w` (Tuesday by default). Weeks ≤ 0 are preseason. */
const inWeek = (w: number, day = 1) => addDays(SEASON_START, (w - 1) * 7 + day);

const lawyer = (id: string, position: Position = "trial", firmId: string | null = null): ProjectionLawyer => ({
  id,
  name: id.toUpperCase(),
  kind: "lawyer",
  position,
  firmId,
});
const firm = (id: string): ProjectionLawyer => ({ id, name: id.toUpperCase(), kind: "firm", position: "firm", firmId: null });
const kase = (id: string, p: Partial<ProjectionCase> = {}): ProjectionCase => ({
  id,
  caseType: "civil",
  status: "active",
  filedOn: null,
  ...p,
});
const app = (lawyerId: string, caseId: string, side: "plaintiff" | "defendant" = "plaintiff"): AppearanceInput => ({ lawyerId, caseId, side });

let seq = 0;
const ev = (p: Partial<ScoringEventInput> & { week: number }): ScoringEventInput => {
  const { week, ...rest } = p;
  return {
    id: `e${String(++seq).padStart(5, "0")}`,
    type: "custom",
    customPoints: 2,
    occurredOn: inWeek(week),
    caseId: "c1",
    side: "plaintiff",
    lawyerId: null,
    ...rest,
  };
};
/** One event per week for weeks from..to (inclusive). */
const weekly = (from: number, to: number, p: Partial<ScoringEventInput>): ScoringEventInput[] => {
  const out: ScoringEventInput[] = [];
  for (let w = from; w <= to; w++) out.push(ev({ ...p, week: w }));
  return out;
};

function run(p: Partial<ProjectionInput> & Pick<ProjectionInput, "lawyers" | "cases" | "appearances" | "events">, scoring: ScoringSettings = halfPpf) {
  return projectPool({
    scoring,
    seasonStart: SEASON_START,
    historyThroughWeek: 0,
    remainingWeeks: 30,
    ...p,
  });
}

describe("projectPool — no history", () => {
  it("uses the documented default per active case when the pool has no events", () => {
    const res = run({
      lawyers: [lawyer("a")],
      cases: [kase("c1"), kase("c2")],
      appearances: [app("a", "c1"), app("a", "c2", "defendant")],
      events: [],
    });
    const d = defaultCaseRates(halfPpf).civil;
    const p = res.projections.get("a")!;
    expect(res.poolHasHistory).toBe(false);
    expect(p.inputs).toMatchObject({ activeCases: 2, eventsLookback: 0, observedWeeks: 0, ownRate: null, ownWeight: 0 });
    expect(p.projectedWeek).toBeCloseTo(2 * (d.other + d.filing), 2);
    expect(p.inputs.priorRate).toBe(p.projectedWeek);
    expect(p.restOfSeason).toBeCloseTo(p.projectedWeek * 30, 2);
    // No history → widest range, and it includes 0 (scoreless weeks are likely).
    expect(p.low).toBe(0);
    expect(p.high).toBeCloseTo(p.projectedWeek * 2, 1);
  });

  it("default rates follow the league's scoring values and filing cap", () => {
    const outcomes = defaultCaseRates(presetScoring("outcomes"));
    const full = defaultCaseRates(presetScoring("full_ppf"));
    expect(outcomes.civil.filing).toBe(0); // filings are worth 0
    expect(full.civil.filing).toBeGreaterThan(defaultCaseRates(halfPpf).civil.filing);
    const capped = defaultCaseRates({ ...halfPpf, values: { ...halfPpf.values, filing: 10 }, filingWeeklyCap: 1 });
    expect(capped.civil.filing).toBeCloseTo(0.5 * 1, 5); // one filing scores at most the cap
    const negative = defaultCaseRates({ ...halfPpf, values: { ...halfPpf.values, filing: -1 } });
    expect(negative.civil.filing).toBe(0); // negative filings never score
  });

  it("new lawyers in a pool with history get the pool's base rate for their case type", () => {
    // Five lawyers, each on an active civil case scoring 2 points every week.
    const vets = ["v1", "v2", "v3", "v4", "v5"];
    const cases = [...vets.map((v) => kase(`case-${v}`)), kase("fresh", { filedOn: inWeek(1) })];
    const events = vets.flatMap((v) => weekly(-7, 0, { caseId: `case-${v}`, customPoints: 2 }));
    const input = {
      lawyers: [...vets.map((v) => lawyer(v)), lawyer("rookie")],
      cases,
      appearances: [...vets.map((v) => app(v, `case-${v}`)), app("rookie", "fresh")],
      events,
    };
    const exact = run({ ...input, options: { priorShrinkageWeeks: 0 } }).projections.get("rookie")!;
    expect(exact.inputs.observedWeeks).toBe(0); // case filed after the history window
    expect(exact.inputs.priorRate).toBe(2);
    expect(exact.projectedWeek).toBe(2);

    const shrunk = run(input).projections.get("rookie")!;
    const d = defaultCaseRates(halfPpf).civil;
    // Pulled a little toward the default, but mostly the pool's rate.
    expect(shrunk.projectedWeek).toBeGreaterThan(1.5);
    expect(shrunk.projectedWeek).toBeLessThan(2);
    expect(shrunk.projectedWeek).toBeGreaterThan(d.other + d.filing);
  });

  it("uses position-specific base rates when there is data, else the case-type rate", () => {
    // Prosecutors on criminal cases score 4/week; defense attorneys 0/week.
    const lawyers = [lawyer("p1", "prosecutor"), lawyer("d1", "defense"), lawyer("p2", "prosecutor"), lawyer("d2", "defense")];
    const cases = [kase("k1", { caseType: "criminal" }), kase("k2", { caseType: "criminal", filedOn: inWeek(2) })];
    const appearances = [app("p1", "k1", "plaintiff"), app("d1", "k1", "defendant"), app("p2", "k2", "plaintiff"), app("d2", "k2", "defendant")];
    const events = weekly(-7, 0, { caseId: "k1", side: "plaintiff", customPoints: 4 });
    const res = run({ lawyers, cases, appearances, events, options: { priorShrinkageWeeks: 0 } });
    expect(res.projections.get("p2")!.inputs.priorRate).toBe(4);
    expect(res.projections.get("d2")!.inputs.priorRate).toBe(0);
  });
});

describe("projectPool — own history", () => {
  it("strong history dominates the prior", () => {
    const quiet = ["q1", "q2", "q3", "q4"];
    const res = run({
      lawyers: [lawyer("star"), ...quiet.map((q) => lawyer(q))],
      cases: [kase("c1"), ...quiet.map((q) => kase(`case-${q}`))],
      appearances: [app("star", "c1"), ...quiet.map((q) => app(q, `case-${q}`))],
      events: weekly(-7, 0, { caseId: "c1", customPoints: 10 }),
    });
    const p = res.projections.get("star")!;
    expect(p.inputs.observedWeeks).toBe(8);
    expect(p.inputs.ownRate).toBe(10);
    expect(p.inputs.ownWeight).toBeCloseTo(8 / 12, 2);
    expect(p.inputs.eventsLookback).toBe(8);
    expect(Math.abs(p.projectedWeek - 10)).toBeLessThan(Math.abs(p.projectedWeek - p.inputs.priorRate));
    expect(p.projectedWeek).toBeGreaterThan(6.5);
    expect(p.high).toBeGreaterThan(p.projectedWeek);
    // 8 of 8 weeks with points, shrunk toward a pool where most weeks are scoreless.
    expect(p.activityRate).toBeGreaterThan(0.6);
    expect(p.activityRate).toBeLessThan(1);
    // Quiet lawyers have 8 observed scoreless weeks.
    const q = res.projections.get("q1")!;
    expect(q.inputs.ownRate).toBe(0);
    expect(q.projectedWeek).toBeLessThan(p.projectedWeek);
    expect(q.low).toBe(0);
  });

  it("the range excludes 0 only when weeks with points are reliable", () => {
    const names = ["a", "b", "c", "d"];
    const res = run({
      lawyers: names.map((n) => lawyer(n)),
      cases: names.map((n) => kase(`case-${n}`)),
      appearances: names.map((n) => app(n, `case-${n}`)),
      events: names.flatMap((n) => weekly(-7, 0, { caseId: `case-${n}`, customPoints: 4 })),
    });
    const p = res.projections.get("a")!;
    expect(p.activityRate).toBeGreaterThan(0.8);
    expect(p.low).toBeGreaterThan(0);
    expect(p.low).toBeLessThan(p.projectedWeek);
    expect(p.high).toBeGreaterThan(p.projectedWeek);
  });

  it("weights recent weeks more (half-life 3 weeks)", () => {
    const res = run({
      lawyers: [lawyer("recent"), lawyer("old")],
      cases: [kase("cr"), kase("co")],
      appearances: [app("recent", "cr"), app("old", "co")],
      events: [...weekly(-2, 0, { caseId: "cr", customPoints: 6 }), ...weekly(-7, -5, { caseId: "co", customPoints: 6 })],
    });
    const r = res.projections.get("recent")!;
    const o = res.projections.get("old")!;
    const w = (age: number) => Math.pow(0.5, age / 3);
    let total = 0;
    for (let a = 0; a < 8; a++) total += w(a);
    expect(r.inputs.ownRate).toBeCloseTo((6 * (w(0) + w(1) + w(2))) / total, 2);
    expect(o.inputs.ownRate).toBeCloseTo((6 * (w(5) + w(6) + w(7))) / total, 2);
    expect(r.projectedWeek).toBeGreaterThan(o.projectedWeek);
    expect(r.inputs.eventsLookback).toBe(o.inputs.eventsLookback);
  });

  it("only counts weeks inside the lookback window, including preseason weeks", () => {
    const res = run({
      historyThroughWeek: -1, // season starts in two weeks
      lawyers: [lawyer("a")],
      cases: [kase("c1")],
      appearances: [app("a", "c1")],
      events: [
        ev({ week: -9, customPoints: 50 }), // before the 8-week window
        ...weekly(-5, -2, { customPoints: 3 }),
        ev({ week: 0, customPoints: 50 }), // current, unfinished week
      ],
    });
    const p = res.projections.get("a")!;
    expect(res.poolHasHistory).toBe(true);
    expect(p.inputs.eventsLookback).toBe(4);
    expect(p.inputs.observedWeeks).toBe(8); // recording started at week -9
    expect(p.inputs.ownRate).toBeGreaterThan(0);
    expect(p.inputs.ownRate).toBeLessThan(3);
  });

  it("doesn't count weeks before the pool started recording or before the case started", () => {
    const res = run({
      lawyers: [lawyer("a"), lawyer("b")],
      cases: [kase("c1"), kase("c2", { filedOn: inWeek(-1) })],
      appearances: [app("a", "c1"), app("b", "c2")],
      events: [ev({ week: -3, caseId: "c1", customPoints: 4 })],
    });
    expect(res.projections.get("a")!.inputs.observedWeeks).toBe(4); // weeks -3..0
    expect(res.projections.get("b")!.inputs.observedWeeks).toBe(2); // weeks -1..0
    expect(res.projections.get("b")!.inputs.ownRate).toBe(0);
  });
});

describe("projectPool — closed cases", () => {
  it("closed cases contribute nothing going forward; no active cases projects 0", () => {
    const res = run({
      lawyers: [lawyer("gone"), lawyer("mixed")],
      cases: [kase("closed", { status: "closed" }), kase("open")],
      appearances: [app("gone", "closed"), app("mixed", "closed"), app("mixed", "open")],
      events: weekly(-7, 0, { caseId: "closed", customPoints: 8 }),
    });
    const gone = res.projections.get("gone")!;
    expect(gone).toMatchObject({ projectedWeek: 0, low: 0, high: 0, activityRate: 0, restOfSeason: 0 });
    expect(gone.inputs.activeCases).toBe(0);
    const mixed = res.projections.get("mixed")!;
    expect(mixed.inputs.activeCases).toBe(1);
    expect(mixed.inputs.eventsLookback).toBe(0); // events on the closed case don't count
    expect(mixed.inputs.ownRate).toBe(0);
  });

  it("closed cases still inform the base rate, counted as open through their last event", () => {
    const res = run({
      lawyers: [lawyer("z"), lawyer("c")],
      cases: [kase("closed", { status: "closed" }), kase("open")],
      appearances: [app("z", "closed"), app("c", "open")],
      events: weekly(-7, -4, { caseId: "closed", customPoints: 2 }),
      options: { priorShrinkageWeeks: 0 },
    });
    // 8 points over 4 closed-case weeks + 8 open-case weeks with 0 points.
    expect(res.projections.get("c")!.inputs.priorRate).toBeCloseTo(8 / 12, 2);
  });
});

describe("projectPool — firms", () => {
  const lawyers = [firm("f"), lawyer("a", "trial", "f"), lawyer("b", "trial", "f")];
  const appearances = [app("a", "c1"), app("b", "c1"), app("f", "c1")];

  it("counts each event once for a firm, times the firm multiplier", () => {
    const res = run({ lawyers, cases: [kase("c1")], appearances, events: weekly(-7, 0, { type: "motion_granted", customPoints: null }) });
    const f = res.projections.get("f")!;
    expect(f.inputs.ownRate).toBe(1); // 2 × 0.5 once per event, not per lawyer
    expect(f.inputs.eventsLookback).toBe(8);
    expect(f.inputs.activeCases).toBe(1);
    expect(res.projections.get("a")!.inputs.ownRate).toBe(2);
  });

  it("tracks the firm's lawyers' cases and uses the multiplier in the prior", () => {
    const res = run({
      lawyers,
      cases: [kase("c1"), kase("c2")],
      appearances: [app("a", "c1"), app("b", "c2", "defendant")],
      events: [],
    });
    const d = defaultCaseRates(halfPpf).civil;
    const f = res.projections.get("f")!;
    expect(f.inputs.activeCases).toBe(2);
    expect(f.projectedWeek).toBeCloseTo(0.5 * 2 * (d.other + d.filing), 2);
  });

  it("firms with a 0 multiplier project 0", () => {
    const res = run(
      { lawyers, cases: [kase("c1")], appearances, events: weekly(-7, 0, { customPoints: 5 }) },
      { ...halfPpf, firmMultiplier: 0 },
    );
    expect(res.projections.get("f")!.projectedWeek).toBe(0);
    expect(res.projections.get("a")!.projectedWeek).toBeGreaterThan(0);
  });
});

describe("projectPool — filing cap", () => {
  it("own history respects the weekly filing cap", () => {
    const events: ScoringEventInput[] = [];
    for (let w = -7; w <= 0; w++) for (let i = 0; i < 10; i++) events.push(ev({ week: w, type: "filing", customPoints: null }));
    const res = run({ lawyers: [lawyer("a")], cases: [kase("c1")], appearances: [app("a", "c1")], events });
    const p = res.projections.get("a")!;
    expect(p.inputs.ownRate).toBe(halfPpf.filingWeeklyCap); // 10 × 0.5 = 5 raw, capped at 3
    expect(p.projectedWeek).toBeLessThanOrEqual(halfPpf.filingWeeklyCap + 1e-9);
  });

  it("the prior caps filing points too", () => {
    const cases = Array.from({ length: 20 }, (_, i) => kase(`c${i}`));
    const res = run({ lawyers: [lawyer("busy")], cases, appearances: cases.map((c) => app("busy", c.id)), events: [] });
    const d = defaultCaseRates(halfPpf).civil;
    expect(20 * d.filing).toBeGreaterThan(halfPpf.filingWeeklyCap);
    expect(res.projections.get("busy")!.inputs.priorRate).toBeCloseTo(20 * d.other + halfPpf.filingWeeklyCap, 2);
  });
});

describe("projectPool — ranges and determinism", () => {
  it("keeps low ≤ projected ≤ high, also for negative projections", () => {
    const res = run({
      lawyers: [lawyer("a")],
      cases: [kase("c1")],
      appearances: [app("a", "c1")],
      events: weekly(-7, 0, { type: "sanctioned", customPoints: null, caseId: null, side: null, lawyerId: "a" }),
    });
    const p = res.projections.get("a")!;
    expect(p.projectedWeek).toBeLessThan(0);
    expect(p.low).toBeLessThanOrEqual(p.projectedWeek);
    expect(p.high).toBeGreaterThanOrEqual(p.projectedWeek);
  });

  it("narrows the range with more observed weeks", () => {
    const base = { lawyers: [lawyer("a")], cases: [kase("c1")], appearances: [app("a", "c1")] };
    const short = run({ ...base, events: weekly(-1, 0, { customPoints: 5 }) }).projections.get("a")!;
    const long = run({ ...base, events: weekly(-7, 0, { customPoints: 5 }) }).projections.get("a")!;
    const width = (p: typeof short) => (p.high - p.low) / p.projectedWeek;
    expect(width(long)).toBeLessThan(width(short));
  });

  it("is deterministic regardless of input order", () => {
    const lawyers = [firm("f"), lawyer("a", "trial", "f"), lawyer("b", "defense"), lawyer("c", "appellate")];
    const cases = [kase("c1"), kase("c2", { caseType: "appeal" }), kase("c3", { status: "closed" })];
    const appearances = [app("a", "c1"), app("b", "c1", "defendant"), app("c", "c2"), app("b", "c3")];
    const events = [
      ...weekly(-6, 0, { caseId: "c1", type: "filing", customPoints: null }),
      ...weekly(-4, -1, { caseId: "c1", side: "defendant", customPoints: 3 }),
      ...weekly(-7, -3, { caseId: "c2", type: "appeal_won", customPoints: null }),
      ...weekly(-7, 0, { caseId: "c3", side: "plaintiff", customPoints: 9 }),
    ];
    const a = run({ lawyers, cases, appearances, events });
    const b = run({
      lawyers: [...lawyers].reverse(),
      cases: [...cases].reverse(),
      appearances: [...appearances].reverse(),
      events: [...events].reverse(),
    });
    for (const l of lawyers) expect(b.projections.get(l.id)).toEqual(a.projections.get(l.id));
  });
});

describe("projectionWeeks", () => {
  const clock = { seasonStart: SEASON_START, lockTime: "06:00", timeZone: "America/New_York" };

  it("before the season projects week 1 with preseason history", () => {
    const w = projectionWeeks(new Date("2026-10-21T15:00:00Z"), clock, 20); // Wed of week -1
    expect(w).toEqual({ targetWeek: 1, historyThroughWeek: -2, remainingWeeks: 20, phase: "preseason" });
  });

  it("mid-season projects the next editable week from complete weeks", () => {
    const w = projectionWeeks(new Date("2026-11-18T15:00:00Z"), clock, 20); // Wed of week 3 (locked)
    expect(w).toEqual({ targetWeek: 4, historyThroughWeek: 2, remainingWeeks: 17, phase: "in_season" });
  });

  it("after the last week (or a complete league) the season is complete", () => {
    expect(projectionWeeks(new Date("2027-06-01T15:00:00Z"), clock, 20).phase).toBe("complete");
    const w = projectionWeeks(new Date("2026-11-18T15:00:00Z"), clock, 20, true);
    expect(w.phase).toBe("complete");
    expect(w.remainingWeeks).toBe(0);
  });
});
