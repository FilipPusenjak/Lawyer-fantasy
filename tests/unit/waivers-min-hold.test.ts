import { describe, expect, it } from "vitest";
import { defaultLeagueSettings } from "@/lib/settings";
import { holdReleasable, WAIVER_MIN_HOLD_HOURS, waiverClearTime } from "@/lib/waivers";
import { toDropOptions, waiversClearAt, waiversUntilDay } from "@/app/leagues/[leagueId]/players/move-helpers";

const HOUR = 3_600_000;
// Wednesdays 03:00 New York (EST in November = 08:00 UTC).
const schedule = { processDay: 3, processTime: "03:00", timeZone: "America/New_York" };
const run = new Date("2026-11-18T08:00:00Z");
const nextWeek = new Date("2026-11-25T08:00:00Z");

describe("minimum time on waivers", () => {
  it("is a day", () => {
    expect(WAIVER_MIN_HOLD_HOURS).toBe(24);
  });

  it("releases a hold only once it is at least the minimum age", () => {
    expect(holdReleasable(new Date(run.getTime() - 24 * HOUR), run)).toBe(true);
    expect(holdReleasable(new Date(run.getTime() - 24 * HOUR + 1), run)).toBe(false);
    expect(holdReleasable(new Date(run.getTime() - 60_000), run)).toBe(false);
    expect(holdReleasable(new Date(run.getTime() - 7 * 24 * HOUR), run)).toBe(true);
  });

  it("clears at the next run when the drop is old enough", () => {
    expect(waiverClearTime(new Date("2026-11-12T10:00:00Z"), run, schedule)).toEqual(run);
    expect(waiverClearTime(new Date(run.getTime() - 24 * HOUR), run, schedule)).toEqual(run);
  });

  it("waits for the following run when the drop is too close to the next one", () => {
    // Dropped one minute before the run: a full extra week on waivers.
    expect(waiverClearTime(new Date(run.getTime() - 60_000), run, schedule)).toEqual(nextWeek);
    expect(waiverClearTime(new Date(run.getTime() - 24 * HOUR + 1), run, schedule)).toEqual(nextWeek);
    // Dropped right after a run: cleared by the next weekly run.
    expect(waiverClearTime(new Date(run.getTime() - 7 * 24 * HOUR + 60_000), run, schedule)).toEqual(run);
  });

  it("works for an overdue run that hasn't happened yet", () => {
    // Run was due yesterday; a drop now waits for the run after it (+ a day).
    const overdue = new Date("2026-11-11T08:00:00Z");
    expect(waiverClearTime(new Date("2026-11-12T08:00:00Z"), overdue, schedule)).toEqual(run);
  });
});

describe("players page helpers", () => {
  const settings = defaultLeagueSettings();
  const s = { ...settings, waivers: { processDay: 3, processTime: "03:00" }, schedule: { ...settings.schedule, timezone: "America/New_York" } };

  it("marks starters in the drop picker", () => {
    const roster = [
      { id: "a", name: "Ann", position: "trial" as const },
      { id: "b", name: "Bo", position: "defense" as const },
    ];
    expect(toDropOptions(roster, ["b", null])).toEqual([
      { id: "a", name: "Ann", position: "trial", isStarter: false },
      { id: "b", name: "Bo", position: "defense", isStarter: true },
    ]);
    expect(toDropOptions(roster, []).every((o) => !o.isStarter)).toBe(true);
  });

  it("shows each lawyer's own waiver end", () => {
    expect(waiversClearAt(undefined, null, s)).toBeNull();
    expect(waiversClearAt(undefined, run, s)).toEqual(run);
    expect(waiversClearAt(new Date(run.getTime() - 2 * HOUR), run, s)).toEqual(nextWeek);
    expect(waiversUntilDay(new Date(run.getTime() - 2 * HOUR), run, s)).toBe("Wed, Nov 25");
    expect(waiversUntilDay(new Date(run.getTime() - 48 * HOUR), run, s)).toBe("Wed, Nov 18");
  });
});
