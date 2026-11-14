import { describe, expect, it } from "vitest";
import {
  barPercent,
  checkFinalizedWeeks,
  eventRows,
  safeHttpUrl,
  weeklyPoints,
} from "@/app/leagues/[leagueId]/lawyers/[lawyerId]/lawyer-stats";

describe("weeklyPoints", () => {
  it("keeps weeks with points plus the current week", () => {
    const pts: Record<number, number> = { 2: 4, 5: -3 };
    expect(weeklyPoints(6, 4, (w) => pts[w] ?? 0)).toEqual([
      { week: 2, points: 4, isCurrent: false },
      { week: 4, points: 0, isCurrent: true },
      { week: 5, points: -3, isCurrent: false },
    ]);
  });

  it("ignores a current week outside the season", () => {
    expect(weeklyPoints(3, 0, () => 0)).toEqual([]);
    expect(weeklyPoints(3, 9, () => 0)).toEqual([]);
  });
});

describe("barPercent", () => {
  it("scales by the largest magnitude with a minimum sliver", () => {
    expect(barPercent(0, 10)).toBe(0);
    expect(barPercent(10, 10)).toBe(100);
    expect(barPercent(-5, 10)).toBe(50);
    expect(barPercent(0.1, 100)).toBe(4);
    expect(barPercent(3, 0)).toBe(0);
  });
});

describe("eventRows", () => {
  it("joins details, newest first, skipping missing events", () => {
    const lines = [
      { eventId: "e1", week: 1, points: 2, viaFirm: false },
      { eventId: "e2", week: 3, points: -1, viaFirm: true },
      { eventId: "gone", week: 2, points: 5, viaFirm: false },
    ];
    const details = new Map([
      ["e1", { occurredOn: "2026-09-01" }],
      ["e2", { occurredOn: "2026-09-20" }],
    ]);
    expect(eventRows(lines, details).map((r) => r.line.eventId)).toEqual(["e2", "e1"]);
  });
});

describe("safeHttpUrl", () => {
  it("allows only http(s) links", () => {
    expect(safeHttpUrl("https://www.courtlistener.com/docket/1/")).toBe("https://www.courtlistener.com/docket/1/");
    expect(safeHttpUrl("http://example.com")).toBe("http://example.com/");
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("not a url")).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
  });
});

describe("checkFinalizedWeeks", () => {
  const finalizedAt = new Date("2026-09-15T12:00:00Z");
  const before = new Date("2026-09-14T12:00:00Z");
  const after = new Date("2026-09-20T12:00:00Z");
  const line = (eventId: string, week: number, points: number) => ({ eventId, week, points, viaFirm: false });

  it("flags nothing when the saved score matches the listed events", () => {
    const lines = [line("e1", 1, 3), line("e2", 1, 2.5), line("e3", 2, 4)];
    const res = checkFinalizedWeeks(lines, new Map([[1, finalizedAt]]), new Map([["e2", after]]), () => 5.5);
    expect(res.notCounted.size).toBe(0);
    expect(res.mismatched).toEqual([]);
  });

  it("marks events approved after their week was finalized", () => {
    const lines = [line("e1", 1, 3), line("late", 1, 4), line("open", 2, 4)];
    const res = checkFinalizedWeeks(
      lines,
      new Map([[1, finalizedAt]]),
      new Map([
        ["e1", before],
        ["late", after],
      ]),
      (w) => (w === 1 ? 3 : 0),
    );
    expect([...res.notCounted]).toEqual(["late"]);
    expect(res.mismatched).toEqual([]);
  });

  it("reports weeks that still differ, e.g. after point values changed", () => {
    const lines = [line("e1", 1, 6), line("late", 1, 2)];
    const res = checkFinalizedWeeks(
      lines,
      new Map([
        [1, finalizedAt],
        [2, finalizedAt],
      ]),
      new Map([
        ["e1", before],
        ["late", after],
      ]),
      // Week 1 was saved when e1 was worth 5; week 2 had points from an event that was later reverted.
      (w) => (w === 1 ? 5 : 3),
    );
    expect([...res.notCounted]).toEqual(["late"]);
    expect(res.mismatched).toEqual([
      { week: 1, points: 5 },
      { week: 2, points: 3 },
    ]);
  });

  it("can't single out events when the finalization time is unknown", () => {
    const res = checkFinalizedWeeks([line("e1", 1, 3)], new Map([[1, null]]), new Map([["e1", after]]), () => 0);
    expect(res.notCounted.size).toBe(0);
    expect(res.mismatched).toEqual([{ week: 1, points: 0 }]);
  });
});
