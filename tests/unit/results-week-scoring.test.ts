import { describe, expect, it, vi } from "vitest";

// scores.ts imports the DB client; the pure helpers tested here never touch it.
vi.mock("@/db", () => ({ db: {} }));

import { computeLawyerPoints, type ScoringEventInput } from "@/lib/scoring";
import { presetScoring } from "@/lib/settings";
import { replaceWeeks, weekScoringOverrides } from "@/server/services/scores";

const steady = presetScoring("steady");
const halfPpf = presetScoring("half_ppf");

describe("weekScoringOverrides", () => {
  it("only weeks without a snapshot whose stored scoring differs, grouped by scoring", () => {
    const rows = [
      { week: 1, scoring: halfPpf }, // finalized: the snapshot wins
      { week: 2, scoring: halfPpf },
      { week: 3, scoring: steady }, // same as current
      { week: 4, scoring: halfPpf },
      { week: 5, scoring: { nope: true } }, // unreadable: current settings
    ];
    const out = weekScoringOverrides(rows, new Set([1]), steady);
    expect(out).toHaveLength(1);
    expect(out[0].scoring).toEqual(halfPpf);
    expect([...out[0].weeks].sort()).toEqual([2, 4]);
  });
  it("nothing to do when no week has stored scoring", () => {
    expect(weekScoringOverrides([], new Set(), steady)).toEqual([]);
  });
});

describe("replaceWeeks", () => {
  const lawyers = [
    { id: "L1", kind: "lawyer" as const, firmId: null },
    { id: "L2", kind: "lawyer" as const, firmId: null },
  ];
  const events: ScoringEventInput[] = [
    { id: "e1", type: "motion_denied", customPoints: null, occurredOn: "2026-01-01", caseId: null, side: null, lawyerId: "L1" },
    { id: "e2", type: "motion_denied", customPoints: null, occurredOn: "2026-01-08", caseId: null, side: null, lawyerId: "L1" },
    { id: "e3", type: "verdict_win", customPoints: null, occurredOn: "2026-01-08", caseId: null, side: null, lawyerId: "L2" },
  ];
  const weekOf = (d: string) => (d === "2026-01-01" ? 1 : 2);
  const compute = (scoring: typeof steady) =>
    computeLawyerPoints({ events, appearances: [], lawyers, scoring, weekOf, totalWeeks: 2 });

  it("a reopened week is scored with the stored settings; other weeks keep current settings", () => {
    const live = compute(steady);
    replaceWeeks(live, new Set([2]), compute(halfPpf));
    const l1 = live.get("L1")!;
    expect(l1.byWeek.get(1)).toBe(steady.values.motion_denied);
    expect(l1.byWeek.get(2)).toBe(halfPpf.values.motion_denied);
    expect(l1.total).toBe(steady.values.motion_denied + halfPpf.values.motion_denied);
    expect(l1.lines.map((l) => [l.week, l.points])).toEqual([
      [1, steady.values.motion_denied],
      [2, halfPpf.values.motion_denied],
    ]);
    expect(live.get("L2")!.byWeek.get(2)).toBe(halfPpf.values.verdict_win);
    expect(live.get("L2")!.total).toBe(halfPpf.values.verdict_win);
  });
  it("drops week points that score 0 under the stored settings", () => {
    const zero = { ...steady, values: { ...steady.values, verdict_win: 0 } };
    const live = compute(steady);
    replaceWeeks(live, new Set([2]), compute(zero));
    expect(live.get("L2")!.byWeek.has(2)).toBe(false);
    expect(live.get("L2")!.lines).toEqual([]);
    expect(live.get("L2")!.total).toBe(0);
  });
});
