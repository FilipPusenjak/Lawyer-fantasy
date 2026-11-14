import { describe, expect, it } from "vitest";
import {
  activityRates,
  milestoneResolved,
  milestoneValue,
  milestoneWeekProbabilities,
  parseCaseOutlook,
  type CaseOutlook,
  type Milestone,
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

  it("an approved event of the milestone's type after the research date resolves it", () => {
    const m = milestone({});
    expect(milestoneResolved(m, "2026-11-14", [{ type: "appeal_won", occurredOn: "2026-12-01" }])).toBe(true);
    expect(milestoneResolved(m, "2026-11-14", [{ type: "appeal_won", occurredOn: "2026-10-01" }])).toBe(false);
    expect(milestoneResolved(m, "2026-11-14", [{ type: "filing", occurredOn: "2026-12-01" }])).toBe(false);
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

