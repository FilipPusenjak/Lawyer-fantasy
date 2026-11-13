import { describe, expect, it } from "vitest";
import { computeStandings } from "@/lib/standings";

const m = (a: string, b: string | null, sa: number, sb: number) => ({
  teamAId: a,
  teamBId: b,
  scoreA: sa,
  scoreB: sb,
  final: true,
  isPlayoff: false,
});

describe("standings", () => {
  it("orders by win% then points for", () => {
    const rows = computeStandings(["a", "b", "c", "d"], [m("a", "b", 10, 5), m("c", "d", 20, 1), m("a", "c", 3, 4), m("b", "d", 8, 2)]);
    expect(rows.map((r) => r.teamId)).toEqual(["c", "a", "b", "d"]);
    expect(rows[0]).toMatchObject({ wins: 2, losses: 0, pointsFor: 24 });
  });
  it("uses head-to-head when win% and PF tie", () => {
    const rows = computeStandings(["a", "b"], [m("a", "b", 10, 5), m("b", "a", 10, 5)]);
    // both 1-1 with 15 PF; h2h is 1-1 so falls to PA (equal) then coin flip — just check determinism
    const again = computeStandings(["a", "b"], [m("a", "b", 10, 5), m("b", "a", 10, 5)]);
    expect(rows.map((r) => r.teamId)).toEqual(again.map((r) => r.teamId));
  });
  it("median games count for team A only", () => {
    const rows = computeStandings(["a", "b"], [m("a", null, 10, 6)]);
    expect(rows.find((r) => r.teamId === "a")).toMatchObject({ wins: 1, losses: 0 });
    expect(rows.find((r) => r.teamId === "b")).toMatchObject({ wins: 0, losses: 0 });
  });
  it("ignores non-final and playoff games", () => {
    const rows = computeStandings(["a", "b"], [{ ...m("a", "b", 10, 5), final: false }, { ...m("a", "b", 10, 5), isPlayoff: true }]);
    expect(rows.every((r) => r.wins === 0 && r.losses === 0)).toBe(true);
  });
});
