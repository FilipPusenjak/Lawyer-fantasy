import { describe, expect, it } from "vitest";
import {
  activityRates,
  milestoneTiming,
  milestoneValue,
  milestoneWeekProbabilities,
  parseCaseOutlook,
  resolveMilestones,
  type CaseOutlook,
  type Milestone,
  type ResolvingEvent,
} from "@/lib/outlook";
import { projectPool, rankProjections, type ProjectionCase, type ProjectionLawyer } from "@/lib/projections";
import type { AppearanceInput, ScoringEventInput } from "@/lib/scoring";
import { presetScoring } from "@/lib/settings";

const SEASON = "2026-11-30"; // Monday, week 1
const scoring = presetScoring("half_ppf"); // filing 4 (cap 24), granted 16, denied −12, appeal_won 64, argument 40, firm ×0.5

const lawyer = (id: string, firmId: string | null = null): ProjectionLawyer => ({ id, name: id, kind: "lawyer", position: "appellate", firmId });
const firm = (id: string): ProjectionLawyer => ({ id, name: id, kind: "firm", position: "firm", firmId: null });
const app = (lawyerId: string, caseId: string, side: "plaintiff" | "defendant"): AppearanceInput => ({ lawyerId, caseId, side });

const quiet = { filingsPerWeek: { plaintiff: 0, defendant: 0 }, rulingsPerWeek: { plaintiff: 0, defendant: 0 }, grantRate: { plaintiff: 0.5, defendant: 0.5 }, basis: "" };

function milestone(p: Partial<Milestone>): Milestone {
  return {
    label: "Decision",
    windowStart: "2026-11-30",
    windowEnd: "2026-12-13", // weeks 1–2
    probability: 1,
    terminal: true,
    outcomes: [
      { probability: 0.7, label: "Reversed", events: [{ type: "appeal_won", side: "plaintiff", lawyerId: null }] },
      { probability: 0.3, label: "Affirmed", events: [{ type: "appeal_won", side: "defendant", lawyerId: null }] },
    ],
    sourceUrl: null,
    ...p,
  };
}
const outlook = (p: Partial<CaseOutlook> = {}): CaseOutlook => ({ asOf: "2026-11-14", stage: "", activity: quiet, milestones: [], sources: [], ...p });

function run(cases: ProjectionCase[], lawyers: ProjectionLawyer[], appearances: AppearanceInput[], opts: { events?: ScoringEventInput[]; remainingWeeks?: number; targetWeek?: number } = {}) {
  return projectPool({
    lawyers,
    cases,
    appearances,
    events: opts.events ?? [],
    scoring,
    seasonStart: SEASON,
    historyThroughWeek: -2,
    remainingWeeks: opts.remainingWeeks ?? 4,
    targetWeek: opts.targetWeek ?? 1,
  }).projections;
}

describe("outlook timing", () => {
  it("spreads probability evenly over the window's days, by week", () => {
    const p = milestoneWeekProbabilities(milestone({ probability: 0.8 }), SEASON, 1, 26);
    expect(p.get(1)).toBeCloseTo(0.4);
    expect(p.get(2)).toBeCloseTo(0.4);
    expect(p.has(3)).toBe(false);
  });

  it("conditions on not having happened before the target week", () => {
    // Half the window's mass is in week 1; from week 2 on, the rest is renormalized.
    const p = milestoneWeekProbabilities(milestone({ probability: 0.8 }), SEASON, 2, 26);
    expect(p.get(2)).toBeCloseTo(0.4 / 0.6);
    expect(milestoneWeekProbabilities(milestone({ probability: 1 }), SEASON, 3, 26).size).toBe(0);
  });

  it("a single-day window lands in one week", () => {
    const p = milestoneWeekProbabilities(milestone({ windowStart: "2026-12-08", windowEnd: "2026-12-08", probability: 0.97 }), SEASON, 1, 26);
    expect([...p.entries()]).toEqual([[2, 0.97]]);
  });

  it("an event-less milestone whose window passed probably happened unseen (not renormalized)", () => {
    const sentencing = milestone({ probability: 0.9, outcomes: [{ probability: 1, label: "Sentenced", events: [] }] });
    const after = milestoneTiming(sentencing, SEASON, 3, 26);
    expect(after.probs.size).toBe(0);
    expect(after.happenedUnseen).toBeCloseTo(0.9);
    const mid = milestoneTiming(sentencing, SEASON, 2, 26);
    expect(mid.probs.get(2)).toBeCloseTo(0.45);
    expect(mid.happenedUnseen).toBeCloseTo(0.45);
    // Partly observable: a mistrial (no event) is 5% of outcomes.
    const trial = milestone({
      probability: 0.8,
      outcomes: [
        { probability: 0.95, label: "Verdict", events: [{ type: "verdict_win", side: "plaintiff", lawyerId: null }] },
        { probability: 0.05, label: "Mistrial", events: [] },
      ],
    });
    const t = milestoneTiming(trial, SEASON, 2, 26);
    expect(t.probs.get(2)).toBeCloseTo(0.4 / (1 - 0.95 * 0.4));
    expect(t.happenedUnseen).toBeCloseTo((0.05 * 0.4) / (1 - 0.95 * 0.4));
    // Outcomes may sum to 0.99 (allowed): a fully observable milestone is still fully observable.
    const decision = milestone({
      outcomes: [
        { probability: 0.7, label: "Reversed", events: [{ type: "appeal_won", side: "plaintiff", lawyerId: null }] },
        { probability: 0.29, label: "Affirmed", events: [{ type: "appeal_won", side: "defendant", lawyerId: null }] },
      ],
    });
    expect(milestoneTiming(decision, SEASON, 3, 26).happenedUnseen).toBe(0);
  });
});

describe("resolving milestones from approved events", () => {
  const ev = (type: string, occurredOn: string, side: "plaintiff" | "defendant" | null, lawyerId: string | null = null): ResolvingEvent => ({
    type,
    occurredOn,
    side,
    lawyerId,
  });
  const side = (type: Milestone["outcomes"][number]["events"][number]["type"], s: "plaintiff" | "defendant") => ({ type, side: s, lawyerId: null });

  it("an event of the same type and side after the research date resolves it (and a terminal one ends the case)", () => {
    const o = outlook({ milestones: [milestone({})] }); // appeal_won for either side
    expect(resolveMilestones(o, [ev("appeal_won", "2026-12-01", "plaintiff")], SEASON)).toEqual({
      resolved: new Set([0]),
      resolvedOn: new Map([[0, "2026-12-01"]]),
      ended: true,
      endedOn: "2026-12-01",
      consumed: new Set(),
    });
    expect(resolveMilestones(o, [ev("appeal_won", "2026-10-01", "plaintiff")], SEASON).resolved.size).toBe(0);
    expect(resolveMilestones(o, [ev("filing", "2026-12-01", "plaintiff")], SEASON).resolved.size).toBe(0);
    const oneSided = outlook({ milestones: [milestone({ outcomes: [{ probability: 1, label: "x", events: [side("dismissed_favorable", "defendant")] }] })] });
    expect(resolveMilestones(oneSided, [ev("dismissed_favorable", "2026-12-01", "plaintiff")], SEASON).resolved.size).toBe(0);
  });

  it("a co-defendant's plea never ends the case; an unambiguous one does", () => {
    const o = outlook({
      milestones: [
        milestone({
          label: "Plea by the pool client",
          terminal: true,
          outcomes: [
            { probability: 0.5, label: "Plea", events: [side("guilty_plea", "plaintiff")] },
            { probability: 0.5, label: "Reduced plea", events: [side("guilty_plea", "plaintiff"), side("plea_reduced", "defendant")] },
          ],
        }),
        milestone({ label: "Co-defendant plea", terminal: false, outcomes: [{ probability: 1, label: "Plea", events: [side("guilty_plea", "plaintiff")] }] }),
      ],
    });
    const one = resolveMilestones(o, [ev("guilty_plea", "2026-12-02", "plaintiff")], SEASON);
    expect([...one.resolved]).toEqual([1]); // the non-terminal one first
    expect(one.ended).toBe(false);
    // A second plea can only be the client's now (the co-defendant milestone is used up): the case ended.
    const two = resolveMilestones(o, [ev("guilty_plea", "2026-12-02", "plaintiff"), ev("guilty_plea", "2026-12-09", "plaintiff")], SEASON);
    expect(two.resolved.size).toBe(2);
    expect(two.ended).toBe(true);
    expect(resolveMilestones(o, [ev("plea_reduced", "2026-12-09", "defendant")], SEASON).ended).toBe(true);
  });

  it("routine rulings only resolve a motion milestone inside its window, and one order is one milestone", () => {
    const rule29 = milestone({
      windowStart: "2027-02-01",
      windowEnd: "2027-05-30",
      probability: 0.5,
      terminal: false,
      outcomes: [
        { probability: 0.9, label: "Denied", events: [side("motion_denied", "defendant")] },
        { probability: 0.1, label: "Granted", events: [side("dismissed_favorable", "defendant")] },
      ],
    });
    const o = outlook({ milestones: [rule29, { ...rule29, label: "Second motion" }] });
    expect(resolveMilestones(o, [ev("motion_granted", "2027-03-01", "plaintiff")], SEASON).resolved.size).toBe(0);
    expect(resolveMilestones(o, [ev("motion_denied", "2026-12-10", "defendant")], SEASON).resolved.size).toBe(0);
    expect(resolveMilestones(o, [ev("motion_denied", "2027-03-01", "defendant")], SEASON).resolved.size).toBe(1);
    // Two denials in one order (same day) resolve one milestone; on different days, two.
    expect(resolveMilestones(o, [ev("motion_denied", "2027-03-01", "defendant"), ev("motion_denied", "2027-03-01", "defendant")], SEASON).resolved.size).toBe(1);
    expect(resolveMilestones(o, [ev("motion_denied", "2027-03-01", "defendant"), ev("motion_denied", "2027-03-08", "defendant")], SEASON).resolved.size).toBe(2);
  });

  it("an ambiguous plea inside the client's window still resolves the co-defendant milestone first", () => {
    const plea = side("guilty_plea", "plaintiff");
    const client = milestone({ label: "Client plea", windowStart: "2026-12-07", windowEnd: "2027-01-03", probability: 0.9, terminal: true, outcomes: [{ probability: 1, label: "Plea", events: [plea] }] });
    const codef = milestone({ label: "Co-defendant plea", windowStart: "2027-02-01", windowEnd: "2027-02-21", probability: 0.5, terminal: false, outcomes: [{ probability: 1, label: "Plea", events: [plea] }] });
    const o = outlook({ milestones: [client, codef] });
    const one = resolveMilestones(o, [ev("guilty_plea", "2026-12-09", "plaintiff")], SEASON);
    expect([...one.resolved]).toEqual([1]);
    expect(one.ended).toBe(false);
  });

  it("reports the events it used, including same-day absorbed ones", () => {
    const o = outlook({ milestones: [milestone({ outcomes: [{ probability: 1, label: "x", events: [side("appeal_won", "plaintiff")] }] })] });
    const r = resolveMilestones(o, [{ ...ev("appeal_won", "2026-12-01", "plaintiff"), id: "a" }, { ...ev("appeal_won", "2026-12-01", "plaintiff"), id: "b" }, { ...ev("filing", "2026-12-01", "plaintiff"), id: "c" }], SEASON);
    expect([...r.consumed].sort()).toEqual(["a", "b"]);
  });

  it("a lawyer-specific event resolves only the milestone naming that lawyer", () => {
    const arg = (lawyerId: string) =>
      milestone({ windowStart: "2026-12-08", windowEnd: "2026-12-08", terminal: false, outcomes: [{ probability: 1, label: "Argues", events: [{ type: "scotus_argument", side: null, lawyerId }] }] });
    const a = "00000000-0000-4000-8000-00000000000a";
    const b = "00000000-0000-4000-8000-00000000000b";
    const o = outlook({ milestones: [arg(a), arg(b)] });
    expect([...resolveMilestones(o, [ev("scotus_argument", "2026-12-08", null, b)], SEASON).resolved]).toEqual([1]);
    expect(resolveMilestones(o, [ev("scotus_argument", "2026-12-08", null, a), ev("scotus_argument", "2026-12-08", null, b)], SEASON).resolved.size).toBe(2);
  });
});

describe("outlook values", () => {
  it("activity rates: filings × filing value, rulings × expected ruling value", () => {
    const o = outlook({ activity: { ...quiet, filingsPerWeek: { plaintiff: 2, defendant: 0 }, rulingsPerWeek: { plaintiff: 0.5, defendant: 0 }, grantRate: { plaintiff: 0.5, defendant: 0.5 } } });
    const r = activityRates(o, "plaintiff", scoring);
    expect(r.filing).toBe(8);
    expect(r.other).toBeCloseTo(0.5 * (0.5 * 16 - 0.5 * 12));
    expect(r.events).toBeCloseTo(2.5);
  });

  it("credits sides, a specific arguing lawyer, and a firm once at ×0.5", () => {
    const m = milestone({
      outcomes: [{ probability: 1, label: "Argued", events: [{ type: "scotus_argument", side: null, lawyerId: "a" }, { type: "scotus_argument", side: null, lawyerId: "b" }] }],
    });
    expect(milestoneValue(m, { kind: "lawyer", ids: new Set(["a"]), sides: new Set() }, scoring)).toEqual({ points: 40, scoreChance: 1 });
    expect(milestoneValue(m, { kind: "lawyer", ids: new Set(["c"]), sides: new Set(["plaintiff"]) }, scoring).points).toBe(0);
    // Both arguers are at the same firm: two events → firm gets 2 × 40 × 0.5.
    expect(milestoneValue(m, { kind: "firm", ids: new Set(["f", "a", "b"]), sides: new Set() }, scoring).points).toBe(40);
    const side = milestoneValue(milestone({}), { kind: "lawyer", ids: new Set(["x"]), sides: new Set(["plaintiff"]) }, scoring);
    expect(side.points).toBeCloseTo(0.7 * 64);
    expect(side.scoreChance).toBeCloseTo(0.7);
  });

  it("parseCaseOutlook rejects bad data instead of throwing", () => {
    expect(parseCaseOutlook(null)).toBeNull();
    expect(parseCaseOutlook({ asOf: "nope" })).toBeNull();
    const bad = outlook({ milestones: [milestone({ outcomes: [{ probability: 0.5, label: "x", events: [] }] })] });
    expect(parseCaseOutlook(bad)).toBeNull(); // outcomes don't sum to 1
    expect(parseCaseOutlook(outlook({ milestones: [milestone({})] }))).not.toBeNull();
    const after = { filingsPerWeek: { plaintiff: 0.3, defendant: 0.5 }, rulingsPerWeek: { plaintiff: 0, defendant: 0 }, grantRate: { plaintiff: 0.5, defendant: 0.5 } };
    expect(parseCaseOutlook(outlook({ milestones: [milestone({ terminal: false, activityAfter: after })] }))?.milestones[0].activityAfter).toEqual(after);
    expect(parseCaseOutlook(outlook({ milestones: [milestone({ terminal: true, activityAfter: after })] }))).toBeNull(); // terminal: nothing after
    const twice = [milestone({ terminal: false, activityAfter: after }), milestone({ terminal: false, activityAfter: after })];
    expect(parseCaseOutlook(outlook({ milestones: twice }))).toBeNull(); // at most one
  });
});

describe("projectPool with outlooks", () => {
  const lawyers = [lawyer("p", "F"), lawyer("d"), firm("F"), lawyer("argues")];
  const apps = [app("p", "c1", "plaintiff"), app("d", "c1", "defendant")];

  it("uses researched activity instead of the typical rate", () => {
    const busy = outlook({ activity: { ...quiet, filingsPerWeek: { plaintiff: 3, defendant: 0.5 } } });
    const res = run([{ id: "c1", caseType: "civil", status: "active", filedOn: null, outlook: busy }], lawyers, apps);
    expect(res.get("p")!.projectedWeek).toBe(12); // 3 filings × 4
    expect(res.get("d")!.projectedWeek).toBe(2);
    expect(res.get("F")!.projectedWeek).toBe(6); // firm of p: ×0.5
    expect(res.get("p")!.restOfSeason).toBe(48); // 4 weeks
    expect(res.get("p")!.inputs.researchedCases).toBe(1);
  });

  it("adds scheduled events in their weeks and stops activity after a terminal one", () => {
    const o = outlook({ activity: { ...quiet, filingsPerWeek: { plaintiff: 1, defendant: 1 } }, milestones: [milestone({})] });
    const res = run([{ id: "c1", caseType: "appeal", status: "active", filedOn: null, outlook: o }], lawyers, apps);
    const p = res.get("p")!;
    // Week 1: filing 4 + decision 0.5 × 0.7 × 64. Week 2: survival 0.5 → filing 2 + 22.4. Weeks 3–4: case over.
    expect(p.projectedWeek).toBeCloseTo(4 + 22.4, 1);
    expect(p.restOfSeason).toBeCloseTo(4 + 22.4 + 2 + 22.4, 1);
    expect(p.inputs.scheduledEvents).toBe(1);
    expect(p.inputs.scheduledPoints).toBeCloseTo(44.8, 1);
    const d = res.get("d")!;
    expect(d.restOfSeason).toBeCloseTo(4 + 0.5 * 0.3 * 64 + 2 + 0.5 * 0.3 * 64, 1);
  });

  it("credits a Supreme Court argument only to the arguing lawyer (even if not listed on the case)", () => {
    const o = outlook({
      milestones: [
        milestone({
          windowStart: "2026-12-08",
          windowEnd: "2026-12-08",
          probability: 0.97,
          terminal: false,
          outcomes: [{ probability: 1, label: "Argued", events: [{ type: "scotus_argument", side: null, lawyerId: "argues" }] }],
        }),
      ],
    });
    const res = run([{ id: "c1", caseType: "supreme_court", status: "active", filedOn: null, outlook: o }], lawyers, apps);
    expect(res.get("argues")!.projectedWeek).toBe(0); // the argument is in week 2
    expect(res.get("argues")!.restOfSeason).toBeCloseTo(0.97 * 40, 1);
    expect(res.get("p")!.restOfSeason).toBe(0);
  });

  it("an approved terminal event ends the case for projections", () => {
    const o = outlook({ activity: { ...quiet, filingsPerWeek: { plaintiff: 1, defendant: 1 } }, milestones: [milestone({})] });
    const decided: ScoringEventInput = { id: "e1", type: "appeal_won", customPoints: null, occurredOn: "2026-11-20", caseId: "c1", side: "plaintiff", lawyerId: null };
    const res = run([{ id: "c1", caseType: "appeal", status: "active", filedOn: null, outlook: o }], lawyers, apps, { events: [decided] });
    expect(res.get("p")!.restOfSeason).toBe(0);
  });

  it("cases without an outlook keep the typical-rate projection", () => {
    const res = run([{ id: "c1", caseType: "civil", status: "active", filedOn: null }], lawyers, apps);
    expect(res.get("p")!.projectedWeek).toBeGreaterThan(0);
    expect(res.get("p")!.restOfSeason).toBeCloseTo(res.get("p")!.projectedWeek * 4, 1);
    expect(res.get("p")!.inputs.researchedCases).toBe(0);
  });
});

describe("projectPool timing, own history and ranges", () => {
  const lawyers = [lawyer("p", "F"), lawyer("d"), firm("F")];
  const apps = [app("p", "c1", "plaintiff"), app("d", "c1", "defendant")];
  const verdict = (p: Partial<Milestone> = {}) =>
    milestone({
      windowStart: "2026-11-30",
      windowEnd: "2026-12-15",
      probability: 0.85,
      terminal: false,
      outcomes: [{ probability: 1, label: "Verdict", events: [{ type: "verdict_win", side: "plaintiff", lawyerId: null }] }],
      ...p,
    });
  const runAt = (o: CaseOutlook, historyThroughWeek: number, targetWeek: number, remainingWeeks: number, events: ScoringEventInput[] = []) =>
    projectPool({
      lawyers,
      cases: [{ id: "c1", caseType: "criminal", status: "active", filedOn: null, outlook: o }],
      appearances: apps,
      events,
      scoring,
      seasonStart: SEASON,
      historyThroughWeek,
      remainingWeeks,
      targetWeek,
    }).projections;

  it("after Monday's lock, timing conditions only on complete weeks (the current week is still open)", () => {
    const perDay = 0.85 / 16;
    // History through week 1, projecting week 3: week 2 is in progress, so only week 1's mass is removed.
    const p3 = (2 * perDay) / (1 - 7 * perDay);
    expect(runAt(outlook({ milestones: [verdict()] }), 1, 3, 1).get("p")!.projectedWeek).toBeCloseTo(p3 * 80, 1);
    // Once week 2 is complete, its mass is removed too.
    expect(runAt(outlook({ milestones: [verdict()] }), 2, 3, 1).get("p")!.projectedWeek).toBeCloseTo(((2 * perDay) / (1 - 14 * perDay)) * 80, 1);
    // Terminal: the chance it ends during week 2 lowers week 3's activity.
    const busy = { ...quiet, filingsPerWeek: { plaintiff: 1, defendant: 0 } };
    const s3 = 1 - (7 * perDay) / (1 - 7 * perDay);
    const res = runAt(outlook({ activity: busy, milestones: [verdict({ terminal: true })] }), 1, 3, 1).get("p")!;
    expect(res.projectedWeek).toBeCloseTo(4 * s3 + p3 * 80, 1);
    expect(res.inputs.scheduledEvents).toBe(1);
  });

  it("a passed sentencing window means the case has probably ended, not that it stays open", () => {
    const busy = { ...quiet, filingsPerWeek: { plaintiff: 1, defendant: 0 } };
    const sentencing = milestone({ probability: 0.9, terminal: true, outcomes: [{ probability: 1, label: "Sentenced", events: [] }] });
    expect(runAt(outlook({ activity: busy, milestones: [sentencing] }), 2, 3, 2).get("p")!.projectedWeek).toBeCloseTo(0.4, 2);
  });

  it("an approved verdict doesn't come back as a weekly rate through own history", () => {
    const busy = { ...quiet, filingsPerWeek: { plaintiff: 1, defendant: 1 } };
    const o = outlook({
      activity: busy,
      milestones: [
        verdict({
          windowEnd: "2026-12-13",
          probability: 0.9,
          outcomes: [
            { probability: 0.8, label: "Guilty", events: [{ type: "verdict_win", side: "plaintiff", lawyerId: null }, { type: "verdict_loss", side: "defendant", lawyerId: null }] },
            { probability: 0.2, label: "Acquitted", events: [{ type: "verdict_win", side: "defendant", lawyerId: null }, { type: "verdict_loss", side: "plaintiff", lawyerId: null }] },
          ],
        }),
      ],
    });
    const filing = (d: string, s: "plaintiff" | "defendant", i: number): ScoringEventInput => ({ id: `f${s}${i}`, type: "filing", customPoints: null, occurredOn: d, caseId: "c1", side: s, lawyerId: null });
    const history = ["2026-12-01", "2026-12-08", "2026-12-15"].flatMap((d, i) => [filing(d, "plaintiff", i), filing(d, "defendant", i)]);
    const verdictEvents: ScoringEventInput[] = [
      { id: "v1", type: "verdict_win", customPoints: null, occurredOn: "2026-12-10", caseId: "c1", side: "plaintiff", lawyerId: null },
      { id: "v2", type: "verdict_loss", customPoints: null, occurredOn: "2026-12-10", caseId: "c1", side: "defendant", lawyerId: null },
    ];
    const without = runAt(o, 3, 4, 23, history);
    const withVerdict = runAt(o, 3, 4, 23, [...history, ...verdictEvents]);
    expect(without.get("p")!.projectedWeek).toBe(4);
    for (const id of ["p", "d", "F"]) {
      expect(withVerdict.get(id)!.projectedWeek).toBe(without.get(id)!.projectedWeek);
      expect(withVerdict.get(id)!.restOfSeason).toBe(without.get(id)!.restOfSeason);
    }
  });

  it("a ruling that resolved a milestone doesn't come back as a weekly rate either", () => {
    const busy = { ...quiet, filingsPerWeek: { plaintiff: 1, defendant: 1 } };
    const o = outlook({
      activity: busy,
      milestones: [
        verdict({
          windowEnd: "2026-12-20",
          probability: 0.9,
          outcomes: [
            { probability: 0.8, label: "Denied", events: [{ type: "motion_denied", side: "defendant", lawyerId: null }] },
            { probability: 0.2, label: "Granted", events: [{ type: "motion_granted", side: "defendant", lawyerId: null }] },
          ],
        }),
      ],
    });
    const filing = (d: string, s: "plaintiff" | "defendant", i: number): ScoringEventInput => ({ id: `f${s}${i}`, type: "filing", customPoints: null, occurredOn: d, caseId: "c1", side: s, lawyerId: null });
    const history = ["2026-12-01", "2026-12-08", "2026-12-15"].flatMap((d, i) => [filing(d, "plaintiff", i), filing(d, "defendant", i)]);
    // One order denying the defense's two motions.
    const denials: ScoringEventInput[] = ["m1", "m2"].map((id) => ({ id, type: "motion_denied", customPoints: null, occurredOn: "2026-12-09", caseId: "c1", side: "defendant", lawyerId: null }));
    const without = runAt(o, 3, 4, 10, history).get("d")!;
    const withDenials = runAt(o, 3, 4, 10, [...history, ...denials]).get("d")!;
    expect(withDenials.projectedWeek).toBe(without.projectedWeek);
    expect(withDenials.restOfSeason).toBe(without.restOfSeason);
  });

  it("a plea before trial ends the case; a conviction keeps post-trial milestones; an acquittal (endsCase) ends it", () => {
    const s = (type: Milestone["outcomes"][number]["events"][number]["type"], x: "plaintiff" | "defendant") => ({ type, side: x, lawyerId: null });
    const o = outlook({
      milestones: [
        milestone({ label: "Plea", windowStart: "2026-11-30", windowEnd: "2027-01-31", probability: 0.3, terminal: true, outcomes: [{ probability: 1, label: "Plea", events: [s("guilty_plea", "plaintiff"), s("plea_reduced", "defendant")] }] }),
        milestone({
          label: "Trial",
          windowStart: "2027-02-08",
          windowEnd: "2027-03-28",
          probability: 0.5,
          terminal: false,
          outcomes: [
            { probability: 0.8, label: "Guilty", events: [s("verdict_win", "plaintiff"), s("verdict_loss", "defendant")] },
            { probability: 0.2, label: "Acquitted", events: [s("verdict_win", "defendant"), s("verdict_loss", "plaintiff")], endsCase: true },
          ],
        }),
        milestone({ label: "Rule 29", windowStart: "2027-04-01", windowEnd: "2027-05-30", probability: 0.4, terminal: false, outcomes: [{ probability: 1, label: "Denied", events: [s("motion_denied", "defendant")] }] }),
      ],
    });
    const e = (id: string, type: string, occurredOn: string, x: "plaintiff" | "defendant"): ScoringEventInput => ({ id, type, customPoints: null, occurredOn, caseId: "c1", side: x, lawyerId: null });
    // Week 14 starts Mar 1, 2027.
    expect(runAt(o, 13, 14, 13, [e("p", "plea_reduced", "2026-12-15", "defendant")]).get("d")!.restOfSeason).toBe(0);
    expect(runAt(o, 13, 14, 13, [e("v", "verdict_win", "2027-03-01", "plaintiff")]).get("d")!.restOfSeason).toBeCloseTo(0.4 * -12, 1);
    expect(runAt(o, 13, 14, 13, [e("a", "verdict_win", "2027-03-01", "defendant")]).get("d")!.restOfSeason).toBe(0);
    // A conviction and an acquittal on the same day (co-defendants): the case goes on.
    const mixed = resolveMilestones(o, [e("a", "verdict_win", "2027-03-01", "defendant"), e("v", "verdict_win", "2027-03-01", "plaintiff")], SEASON);
    expect(mixed.ended).toBe(false);
  });

  it("endsCase outcomes lower survival like a terminal milestone, by their share", () => {
    const busy = { ...quiet, filingsPerWeek: { plaintiff: 1, defendant: 0 } };
    const o = outlook({
      activity: busy,
      milestones: [
        verdict({
          windowEnd: "2026-12-13",
          probability: 1,
          outcomes: [
            { probability: 0.8, label: "Guilty", events: [{ type: "verdict_win", side: "plaintiff", lawyerId: null }] },
            { probability: 0.2, label: "Acquitted", events: [{ type: "verdict_win", side: "defendant", lawyerId: null }], endsCase: true },
          ],
        }),
      ],
    });
    const p = runAt(o, -2, 1, 4).get("p")!;
    // Weeks 1–2 at 4 (the verdict is spread over them), then open 80% of the time; the verdict: 0.5 × 0.8 × 80 in each.
    expect(p.restOfSeason).toBeCloseTo(4 + 32 + (4 * 0.9 + 32) + 3.2 + 3.2, 1);
    expect(parseCaseOutlook(outlook({ milestones: [milestone({ terminal: true, outcomes: [{ probability: 1, label: "x", events: [], endsCase: true }] })] }))).toBeNull();
  });

  it("own history follows the expected pace: a busy trial phase isn't carried past the verdict", () => {
    const busy = { ...quiet, filingsPerWeek: { plaintiff: 2, defendant: 0 } };
    const after = { filingsPerWeek: { plaintiff: 0.5, defendant: 0 }, rulingsPerWeek: { plaintiff: 0, defendant: 0 }, grantRate: { plaintiff: 0.5, defendant: 0.5 } };
    const o = outlook({ activity: busy, milestones: [verdict({ windowEnd: "2026-12-20", probability: 1, activityAfter: after })] });
    const filing = (d: string, i: number): ScoringEventInput => ({ id: `f${i}`, type: "filing", customPoints: null, occurredOn: d, caseId: "c1", side: "plaintiff", lawyerId: null });
    const history = ["2026-12-01", "2026-12-02", "2026-12-08", "2026-12-09", "2026-12-15", "2026-12-16"].map(filing);
    const verdictWin: ScoringEventInput = { id: "v", type: "verdict_win", customPoints: null, occurredOn: "2026-12-17", caseId: "c1", side: "plaintiff", lawyerId: null };
    const p = runAt(o, 3, 4, 10, [...history, verdictWin]).get("p")!;
    // Own rate 8/week at the trial pace (8): scaled to the post-verdict pace (2) → 2, blended with the prior 2.
    expect(p.projectedWeek).toBeCloseTo(2, 1);
  });

  it("a quiet case ending barely changes a busy lawyer's own-history term", () => {
    const busy = outlook({ activity: { ...quiet, filingsPerWeek: { plaintiff: 2, defendant: 0 } } });
    const quietCase = outlook({ activity: { ...quiet, filingsPerWeek: { plaintiff: 0.01, defendant: 0 } }, milestones: [milestone({ windowStart: "2026-12-01", windowEnd: "2027-05-30", probability: 0.5 })] });
    const ls = [lawyer("x"), lawyer("y")];
    const ap = [app("x", "c1", "plaintiff"), app("y", "c1", "plaintiff"), app("x", "c2", "plaintiff")];
    const hist = ["2026-12-01", "2026-12-02", "2026-12-08", "2026-12-09", "2026-12-15", "2026-12-16"].map(
      (d, i): ScoringEventInput => ({ id: `f${i}`, type: "filing", customPoints: null, occurredOn: d, caseId: "c1", side: "plaintiff", lawyerId: null }),
    );
    const decided: ScoringEventInput = { id: "d", type: "appeal_won", customPoints: null, occurredOn: "2026-12-10", caseId: "c2", side: "plaintiff", lawyerId: null };
    const res = projectPool({
      lawyers: ls,
      cases: [
        { id: "c1", caseType: "civil", status: "active", filedOn: null, outlook: busy },
        { id: "c2", caseType: "appeal", status: "active", filedOn: null, outlook: quietCase },
      ],
      appearances: ap,
      events: [...hist, decided],
      scoring,
      seasonStart: SEASON,
      historyThroughWeek: 3,
      remainingWeeks: 10,
      targetWeek: 4,
    }).projections;
    expect(Math.abs(res.get("x")!.projectedWeek - res.get("y")!.projectedWeek)).toBeLessThan(0.1);
  });

  it("routine rulings count at their expected value in own history; ended cases show no activity", () => {
    const o = outlook({ activity: { ...quiet, filingsPerWeek: { plaintiff: 1, defendant: 1 }, rulingsPerWeek: { plaintiff: 0, defendant: 0.2 }, grantRate: { plaintiff: 0.5, defendant: 0.5 } } });
    const f = (d: string, x: "plaintiff" | "defendant", i: number): ScoringEventInput => ({ id: `f${x}${i}`, type: "filing", customPoints: null, occurredOn: d, caseId: "c1", side: x, lawyerId: null });
    const hist = ["2026-12-01", "2026-12-08", "2026-12-15"].flatMap((d, i) => [f(d, "plaintiff", i), f(d, "defendant", i)]);
    const ruling = (type: string): ScoringEventInput => ({ id: "r", type, customPoints: null, occurredOn: "2026-12-09", caseId: "c1", side: "defendant", lawyerId: null });
    const denied = runAt(o, 3, 4, 10, [...hist, ruling("motion_denied")]).get("d")!;
    const granted = runAt(o, 3, 4, 10, [...hist, ruling("motion_granted")]).get("d")!;
    expect(denied.restOfSeason).toBe(granted.restOfSeason);
    // A terminal decision ended the case: nothing projected, no activity.
    const ended = outlook({ activity: { ...quiet, filingsPerWeek: { plaintiff: 1, defendant: 1 } }, milestones: [milestone({})] });
    const win: ScoringEventInput = { id: "w", type: "appeal_won", customPoints: null, occurredOn: "2026-12-16", caseId: "c1", side: "plaintiff", lawyerId: null };
    const after = runAt(ended, 3, 4, 10, [...hist, win]).get("p")!;
    expect(after.projectedWeek).toBe(0);
    expect(after.activityRate).toBe(0);
  });

  it("activityAfter switches the docket pace once its milestone is likely to have happened", () => {
    const busy = { ...quiet, filingsPerWeek: { plaintiff: 2, defendant: 0 } };
    const after = { filingsPerWeek: { plaintiff: 0.5, defendant: 0 }, rulingsPerWeek: { plaintiff: 0, defendant: 0 }, grantRate: { plaintiff: 0.5, defendant: 0.5 } };
    const o = outlook({ activity: busy, milestones: [verdict({ windowEnd: "2026-12-13", probability: 1, activityAfter: after })] });
    const p = runAt(o, -2, 1, 4).get("p")!;
    // Week 1: 8 + 0.5 × 80. Week 2: half after (5) + 40. Weeks 3–4: 2 each.
    expect(p.projectedWeek).toBeCloseTo(48, 1);
    expect(p.restOfSeason).toBeCloseTo(48 + 45 + 2 + 2, 1);
    const decided: ScoringEventInput = { id: "e1", type: "verdict_win", customPoints: null, occurredOn: "2026-11-20", caseId: "c1", side: "plaintiff", lawyerId: null };
    const r = runAt(o, -2, 1, 4, [decided]).get("p")!;
    expect(r.projectedWeek).toBeCloseTo(2, 1);
    expect(r.restOfSeason).toBeCloseTo(8, 1);
  });

  it("the weekly range includes a likely big scheduled outcome", () => {
    const busy = { ...quiet, filingsPerWeek: { plaintiff: 0.5, defendant: 0.5 } };
    const o = outlook({
      activity: busy,
      milestones: [
        verdict({
          windowEnd: "2026-12-06", // week 1 only
          probability: (0.85 * 7) / 16,
          outcomes: [
            { probability: 0.85, label: "Guilty", events: [{ type: "verdict_win", side: "plaintiff", lawyerId: null }, { type: "verdict_loss", side: "defendant", lawyerId: null }] },
            { probability: 0.1, label: "Acquitted", events: [{ type: "verdict_win", side: "defendant", lawyerId: null }, { type: "verdict_loss", side: "plaintiff", lawyerId: null }] },
            { probability: 0.05, label: "Hung jury", events: [] },
          ],
        }),
      ],
    });
    const res = runAt(o, -2, 1, 1);
    const p = res.get("p")!;
    const d = res.get("d")!;
    expect(p.high).toBeGreaterThanOrEqual(80);
    expect(p.low).toBeLessThanOrEqual(1);
    expect(d.low).toBeLessThanOrEqual(-44);
    for (const x of [p, d]) {
      expect(x.low).toBeLessThanOrEqual(x.projectedWeek);
      expect(x.high).toBeGreaterThanOrEqual(x.projectedWeek);
    }
  });
});

describe("season vs week ranks", () => {
  it("season rank orders by rest of season; week rank by the projected week", () => {
    const proj = new Map([
      ["a", { lawyerId: "a", projectedWeek: 1, low: 0, high: 2, activityRate: 0.5, restOfSeason: 100, inputs: {} as never }],
      ["b", { lawyerId: "b", projectedWeek: 5, low: 0, high: 9, activityRate: 0.5, restOfSeason: 50, inputs: {} as never }],
    ]);
    const ranked = rankProjections(proj, [
      { id: "a", name: "A", position: "appellate" },
      { id: "b", name: "B", position: "appellate" },
    ]);
    expect(ranked.map((r) => [r.lawyerId, r.overallRank, r.positionLabel, r.weekRank, r.weekPositionLabel])).toEqual([
      ["a", 1, "APP1", 2, "APP2"],
      ["b", 2, "APP2", 1, "APP1"],
    ]);
  });
});

