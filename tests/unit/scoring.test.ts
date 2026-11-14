import { describe, expect, it } from "vitest";
import { computeLawyerPoints, type ScoringEventInput } from "@/lib/scoring";
import { presetScoring } from "@/lib/settings";
import { weekOfDate } from "@/lib/time";

const scoring = presetScoring("half_ppf");
const weekOf = (d: string) => weekOfDate(d, "2026-11-02");
const lawyers = [
  { id: "firm1", kind: "firm" as const, firmId: null },
  { id: "a", kind: "lawyer" as const, firmId: "firm1" },
  { id: "b", kind: "lawyer" as const, firmId: "firm1" },
  { id: "c", kind: "lawyer" as const, firmId: null },
];
const appearances = [
  { caseId: "case1", lawyerId: "a", side: "plaintiff" as const },
  { caseId: "case1", lawyerId: "b", side: "plaintiff" as const },
  { caseId: "case1", lawyerId: "c", side: "defendant" as const },
];
const ev = (p: Partial<ScoringEventInput>): ScoringEventInput => ({
  id: p.id ?? Math.random().toString(36),
  type: "motion_granted",
  customPoints: null,
  occurredOn: "2026-11-03",
  caseId: "case1",
  side: "plaintiff",
  lawyerId: null,
  ...p,
});

describe("computeLawyerPoints", () => {
  it("credits every lawyer on the side and the firm once", () => {
    const pts = computeLawyerPoints({
      events: [ev({ id: "e1", type: "verdict_win" })],
      appearances,
      lawyers,
      scoring,
      weekOf,
      totalWeeks: 30,
    });
    expect(pts.get("a")!.total).toBe(20);
    expect(pts.get("b")!.total).toBe(20);
    expect(pts.get("firm1")!.total).toBe(10); // 20 × 0.5 once, not twice
    expect(pts.get("c")).toBeUndefined();
  });

  it("lawyer-specific events only hit that lawyer (and their firm)", () => {
    const pts = computeLawyerPoints({
      events: [ev({ id: "e1", type: "sanctioned", caseId: "case1", side: null, lawyerId: "a" })],
      appearances,
      lawyers,
      scoring,
      weekOf,
      totalWeeks: 30,
    });
    expect(pts.get("a")!.total).toBe(-15);
    expect(pts.get("b")).toBeUndefined();
    expect(pts.get("firm1")!.total).toBe(-7.5);
  });

  it("caps filing points per lawyer per week", () => {
    const events = Array.from({ length: 10 }, (_, i) => ev({ id: `f${i}`, type: "filing", side: "defendant" }));
    const pts = computeLawyerPoints({ events, appearances, lawyers, scoring, weekOf, totalWeeks: 30 });
    expect(pts.get("c")!.total).toBe(6); // 10 × 1 capped at 6
    // next week resets
    const pts2 = computeLawyerPoints({
      events: [...events, ev({ id: "g1", type: "filing", side: "defendant", occurredOn: "2026-11-10" })],
      appearances,
      lawyers,
      scoring,
      weekOf,
      totalWeeks: 30,
    });
    expect(pts2.get("c")!.byWeek.get(2)).toBe(1);
  });

  it("ignores events outside the season and handles custom points", () => {
    const pts = computeLawyerPoints({
      events: [
        ev({ id: "x", occurredOn: "2026-10-01" }),
        ev({ id: "y", type: "custom", customPoints: 7, side: "defendant" }),
      ],
      appearances,
      lawyers,
      scoring,
      weekOf,
      totalWeeks: 30,
    });
    expect(pts.get("a")).toBeUndefined();
    expect(pts.get("c")!.total).toBe(7);
  });

  it("outcomes preset gives no filing points", () => {
    const pts = computeLawyerPoints({
      events: [ev({ id: "f", type: "filing" })],
      appearances,
      lawyers,
      scoring: presetScoring("outcomes"),
      weekOf,
      totalWeeks: 30,
    });
    expect(pts.size).toBe(0);
  });
});
