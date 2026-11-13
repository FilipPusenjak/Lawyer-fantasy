import { describe, expect, it } from "vitest";
import {
  addDays,
  currentWeek,
  dayOfWeek,
  editableWeek,
  isWeekLocked,
  mondayOnOrAfter,
  mondayOnOrBefore,
  nextWeeklyTime,
  weekLockTime,
  weekOfDate,
  zonedTimeToUtc,
} from "@/lib/time";

const clock = { seasonStart: "2026-11-02", lockTime: "06:00", timeZone: "America/New_York" };

describe("time", () => {
  it("day math", () => {
    expect(dayOfWeek("2026-11-02")).toBe(1); // Monday
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(mondayOnOrBefore("2026-11-08")).toBe("2026-11-02");
    expect(mondayOnOrAfter("2026-11-03")).toBe("2026-11-09");
    expect(mondayOnOrAfter("2026-11-02")).toBe("2026-11-02");
  });

  it("weekOfDate", () => {
    expect(weekOfDate("2026-11-02", clock.seasonStart)).toBe(1);
    expect(weekOfDate("2026-11-08", clock.seasonStart)).toBe(1);
    expect(weekOfDate("2026-11-09", clock.seasonStart)).toBe(2);
    expect(weekOfDate("2026-11-01", clock.seasonStart)).toBe(0);
  });

  it("zonedTimeToUtc handles EST/EDT", () => {
    expect(zonedTimeToUtc("2026-11-02", "06:00", "America/New_York").toISOString()).toBe("2026-11-02T11:00:00.000Z");
    expect(zonedTimeToUtc("2026-07-06", "06:00", "America/New_York").toISOString()).toBe("2026-07-06T10:00:00.000Z");
    expect(zonedTimeToUtc("2026-07-06", "06:00", "America/Los_Angeles").toISOString()).toBe("2026-07-06T13:00:00.000Z");
  });

  it("locks and editable week", () => {
    expect(weekLockTime(2, clock.seasonStart, clock.lockTime, clock.timeZone).toISOString()).toBe("2026-11-09T11:00:00.000Z");
    const beforeLock = new Date("2026-11-09T10:59:00Z");
    const afterLock = new Date("2026-11-09T11:00:00Z");
    expect(isWeekLocked(2, beforeLock, clock)).toBe(false);
    expect(isWeekLocked(2, afterLock, clock)).toBe(true);
    expect(editableWeek(beforeLock, clock)).toBe(2);
    expect(editableWeek(afterLock, clock)).toBe(3);
    expect(currentWeek(afterLock, clock)).toBe(2);
    // before the season: week 1 is editable
    expect(editableWeek(new Date("2026-10-01T00:00:00Z"), clock)).toBe(1);
  });

  it("nextWeeklyTime", () => {
    // Wednesday 03:00 ET after Monday Nov 9 2026
    const t = nextWeeklyTime(new Date("2026-11-09T12:00:00Z"), 3, "03:00", "America/New_York");
    expect(t.toISOString()).toBe("2026-11-11T08:00:00.000Z");
    // strictly after
    const t2 = nextWeeklyTime(t, 3, "03:00", "America/New_York");
    expect(t2.toISOString()).toBe("2026-11-18T08:00:00.000Z");
  });
});
