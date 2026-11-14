import { describe, expect, it } from "vitest";
import { barPercent, eventRows, safeHttpUrl, weeklyPoints } from "@/app/leagues/[leagueId]/lawyers/[lawyerId]/lawyer-stats";

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
