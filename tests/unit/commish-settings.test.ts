import { describe, expect, it } from "vitest";
import {
  isoToLocalInput,
  localInputToIso,
  parseDraftForm,
  parseRosterForm,
  parseScheduleForm,
  parseScoringForm,
  parseTradesForm,
  parseWaiversForm,
  resolveScoring,
  seasonSummary,
  timezoneOptions,
  VALUED_EVENT_TYPES,
} from "@/app/leagues/[leagueId]/commish/settings/settings-form";
import { defaultLeagueSettings, presetScoring } from "@/lib/settings";
import { playoffTeamLimit, settingsLocks } from "@/server/services/settings-admin";

function form(values: Record<string, string | number>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, String(v));
  return f;
}

const OPEN = settingsLocks("setup", "not_started");

describe("settingsLocks", () => {
  it("leaves everything editable before the draft", () => {
    expect(OPEN).toEqual({ roster: false, draft: false, seasonStart: false, scheduleShape: false, playoffTeams: false, removeMembers: false });
    expect(settingsLocks("setup", null).roster).toBe(false);
  });

  it("locks roster, draft, members and the schedule shape once the draft starts", () => {
    for (const [status, draft] of [
      ["setup", "in_progress"],
      ["drafting", "in_progress"],
      ["drafting", "paused"],
      ["in_season", "complete"],
    ] as const) {
      const l = settingsLocks(status, draft);
      expect(l.roster && l.draft && l.seasonStart && l.scheduleShape && l.removeMembers).toBe(true);
      expect(l.playoffTeams).toBe(false);
    }
  });

  it("locks playoff teams once a playoff matchup exists or the playoffs have started", () => {
    expect(settingsLocks("in_season", "complete", true).playoffTeams).toBe(true);
    expect(settingsLocks("playoffs", "complete").playoffTeams).toBe(true);
    expect(settingsLocks("complete", "complete").playoffTeams).toBe(true);
  });

  it("limits playoff teams to max teams before the draft and to real teams after", () => {
    expect(playoffTeamLimit(OPEN, 8, 3)).toBe(8);
    expect(playoffTeamLimit(settingsLocks("in_season", "complete"), 8, 6)).toBe(6);
  });
});

describe("parseRosterForm", () => {
  const good = { roster_trial: 1, roster_appellate: 1, roster_prosecutor: 1, roster_defense: 1, roster_flex: 2, roster_firm: 1, roster_bench: 5, maxTeams: 10 };

  it("parses counts and max teams", () => {
    const r = parseRosterForm(form(good), { teamCount: 4 });
    expect(r).toEqual({ ok: true, data: { roster: { trial: 1, appellate: 1, prosecutor: 1, defense: 1, flex: 2, firm: 1, bench: 5 }, maxTeams: 10 } });
  });

  it("rejects out-of-range counts, no starters, decimals and max teams below the current count", () => {
    expect(parseRosterForm(form({ ...good, roster_trial: 4 }), { teamCount: 1 })).toMatchObject({ ok: false, error: expect.stringMatching(/between 0 and 3/) });
    expect(parseRosterForm(form({ ...good, roster_flex: 1.5 }), { teamCount: 1 })).toMatchObject({ ok: false, error: expect.stringMatching(/whole number/) });
    const none = { ...good, roster_trial: 0, roster_appellate: 0, roster_prosecutor: 0, roster_defense: 0, roster_flex: 0, roster_firm: 0 };
    expect(parseRosterForm(form(none), { teamCount: 1 })).toMatchObject({ ok: false, error: expect.stringMatching(/starting spot/) });
    expect(parseRosterForm(form({ ...good, maxTeams: 3 }), { teamCount: 5 })).toMatchObject({ ok: false, error: expect.stringMatching(/5 teams/) });
  });
});

describe("scoring", () => {
  const values = (s = presetScoring("half_ppf")) => {
    const out: Record<string, string | number> = { firmMultiplier: s.firmMultiplier, filingWeeklyCap: s.filingWeeklyCap };
    for (const t of VALUED_EVENT_TYPES) out[`value_${t}`] = s.values[t];
    return out;
  };

  it("applies a newly chosen preset even if the typed values are stale (no-JS form)", () => {
    const r = parseScoringForm(form({ ...values(), preset: "full_ppf" }), { currentPreset: "half_ppf" });
    expect(r).toEqual({ ok: true, data: presetScoring("full_ppf") });
  });

  it("keeps the preset when values match it", () => {
    const r = parseScoringForm(form({ ...values(), preset: "half_ppf" }), { currentPreset: "half_ppf" });
    expect(r).toEqual({ ok: true, data: presetScoring("half_ppf") });
  });

  it("switches to custom when values were edited under the same preset", () => {
    const r = parseScoringForm(form({ ...values(), value_verdict_win: 12, preset: "half_ppf" }), { currentPreset: "half_ppf" });
    expect(r.ok && r.data.preset).toBe("custom");
    expect(r.ok && r.data.values.verdict_win).toBe(12);
  });

  it("keeps custom values, including negatives and decimals", () => {
    const r = parseScoringForm(form({ ...values(), value_motion_denied: "-2.5", firmMultiplier: "0.75", preset: "custom" }), {
      currentPreset: "custom",
    });
    expect(r).toMatchObject({ ok: true, data: { preset: "custom", firmMultiplier: 0.75 } });
    expect(r.ok && r.data.values.motion_denied).toBe(-2.5);
  });

  it("rejects bad numbers", () => {
    expect(parseScoringForm(form({ ...values(), value_filing: "abc", preset: "custom" }), { currentPreset: "custom" }).ok).toBe(false);
    expect(parseScoringForm(form({ ...values(), value_filing: 101, preset: "custom" }), { currentPreset: "custom" }).ok).toBe(false);
    expect(parseScoringForm(form({ ...values(), firmMultiplier: 6, preset: "custom" }), { currentPreset: "custom" }).ok).toBe(false);
    expect(parseScoringForm(form({ ...values(), preset: "nope" }), { currentPreset: "custom" }).ok).toBe(false);
  });

  it("resolveScoring prefers custom typed values", () => {
    const typed = { values: presetScoring("outcomes").values, firmMultiplier: 0.5, filingWeeklyCap: 0 };
    expect(resolveScoring("custom", typed, "outcomes").preset).toBe("custom");
    expect(resolveScoring("outcomes", typed, "outcomes").preset).toBe("outcomes");
  });
});

describe("parseScheduleForm", () => {
  const cur = defaultLeagueSettings().schedule; // 2-week matchups x 10, 4 playoff teams, 2-week rounds
  const base = {
    seasonStart: "2027-01-04", // Monday
    timezone: "America/Chicago",
    lockTime: "07:30",
    matchupWeeks: 1,
    regularSeasonMatchups: 12,
    playoffTeams: 6,
    playoffRoundWeeks: 1,
  };
  const opts = { locks: OPEN, current: cur, seasonStart: "2026-12-07", playoffLimit: 8, maxSeasonWeeks: 52 };

  it("parses everything before the draft", () => {
    expect(parseScheduleForm(form(base), opts)).toEqual({
      ok: true,
      data: {
        seasonStart: "2027-01-04",
        schedule: { timezone: "America/Chicago", lockTime: "07:30", matchupWeeks: 1, regularSeasonMatchups: 12, playoffTeams: 6, playoffRoundWeeks: 1 },
        snapped: false,
      },
    });
  });

  it("moves a non-Monday season start to the next Monday, like creating a league does", () => {
    expect(parseScheduleForm(form({ ...base, seasonStart: "2027-01-05" }), opts)).toMatchObject({
      ok: true,
      data: { seasonStart: "2027-01-11", snapped: true },
    });
    expect(parseScheduleForm(form({ ...base, seasonStart: "2027-01-10" }), opts)).toMatchObject({
      ok: true,
      data: { seasonStart: "2027-01-11", snapped: true },
    });
    expect(parseScheduleForm(form({ ...base, seasonStart: "2027-02-30" }), opts)).toMatchObject({ ok: false, error: expect.stringMatching(/season start/) });
  });

  it("requires a real time zone and a sane playoff count", () => {
    expect(parseScheduleForm(form({ ...base, timezone: "Mars/Olympus" }), opts)).toMatchObject({ ok: false, error: expect.stringMatching(/time zone/) });
    expect(parseScheduleForm(form({ ...base, playoffTeams: 1 }), opts).ok).toBe(false);
    expect(parseScheduleForm(form({ ...base, playoffTeams: 9 }), opts)).toMatchObject({ ok: false, error: expect.stringMatching(/between 2 and 8/) });
    expect(parseScheduleForm(form({ ...base, playoffTeams: 0 }), opts).ok).toBe(true);
    expect(parseScheduleForm(form({ ...base, lockTime: "25:00" }), opts).ok).toBe(false);
  });

  it("rejects seasons longer than the max", () => {
    const r = parseScheduleForm(form({ ...base, matchupWeeks: 4, regularSeasonMatchups: 30 }), opts);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/weeks/) });
  });

  it("keeps locked fields at their current values after the draft", () => {
    const locks = settingsLocks("in_season", "complete");
    const r = parseScheduleForm(form({ lockTime: "08:00", playoffTeams: 2 }), { ...opts, locks });
    expect(r).toEqual({
      ok: true,
      data: { seasonStart: "2026-12-07", schedule: { ...cur, lockTime: "08:00", playoffTeams: 2 }, snapped: false },
    });
    const afterPlayoffs = parseScheduleForm(form({ lockTime: "08:00", playoffTeams: 2 }), { ...opts, locks: settingsLocks("playoffs", "complete") });
    expect(afterPlayoffs.ok && afterPlayoffs.data.schedule.playoffTeams).toBe(cur.playoffTeams);
  });

  it("summarizes the season", () => {
    expect(seasonSummary(cur, "2027-01-04")).toEqual({ regularWeeks: 20, playoffRounds: 2, playoffWeeks: 4, totalWeeks: 24, endDate: "2027-06-20" });
  });

  it("offers the league's zone even if it isn't a common US zone", () => {
    expect(timezoneOptions("America/New_York")[0].id).toBe("America/New_York");
    expect(timezoneOptions("Europe/London")[0]).toEqual({ id: "Europe/London", label: "Europe/London" });
  });
});

describe("draft form", () => {
  const tz = "America/New_York";

  it("converts datetime-local values in the league time zone (DST aware)", () => {
    expect(localInputToIso("2027-01-15T19:00", tz)).toBe("2027-01-16T00:00:00.000Z");
    expect(localInputToIso("2027-07-15T19:00", tz)).toBe("2027-07-15T23:00:00.000Z");
    expect(localInputToIso("", tz)).toBeNull();
    expect(localInputToIso("2027-02-30T10:00", tz)).toBeUndefined();
    expect(isoToLocalInput("2027-01-16T00:00:00.000Z", tz)).toBe("2027-01-15T19:00");
    expect(isoToLocalInput(null, tz)).toBe("");
    expect(isoToLocalInput("garbage", tz)).toBe("");
  });

  it("parses preset and custom clocks", () => {
    expect(parseDraftForm(form({ secondsChoice: "90", scheduledAt: "" }), { timeZone: tz })).toEqual({
      ok: true,
      data: { secondsPerPick: 90, scheduledAt: null },
    });
    expect(parseDraftForm(form({ secondsChoice: "custom", customSeconds: 45, scheduledAt: "2027-01-15T19:00" }), { timeZone: tz })).toEqual({
      ok: true,
      data: { secondsPerPick: 45, scheduledAt: "2027-01-16T00:00:00.000Z" },
    });
    expect(parseDraftForm(form({ secondsChoice: "custom", customSeconds: 5 }), { timeZone: tz }).ok).toBe(false);
    expect(parseDraftForm(form({ secondsChoice: "45" }), { timeZone: tz }).ok).toBe(false);
    expect(parseDraftForm(form({ secondsChoice: "60", scheduledAt: "tomorrow" }), { timeZone: tz }).ok).toBe(false);
  });
});

describe("waivers & trades", () => {
  it("parses waiver day/time", () => {
    expect(parseWaiversForm(form({ processDay: 3, processTime: "03:00" }))).toEqual({ ok: true, data: { processDay: 3, processTime: "03:00" } });
    expect(parseWaiversForm(form({ processDay: 7, processTime: "03:00" })).ok).toBe(false);
  });

  it("parses trade review hours and an optional deadline", () => {
    expect(parseTradesForm(form({ reviewHours: 24, deadlineWeek: "" }), { totalWeeks: 24 })).toEqual({
      ok: true,
      data: { reviewHours: 24, deadlineWeek: null },
    });
    expect(parseTradesForm(form({ reviewHours: 0, deadlineWeek: 12 }), { totalWeeks: 24 })).toEqual({
      ok: true,
      data: { reviewHours: 0, deadlineWeek: 12 },
    });
    expect(parseTradesForm(form({ reviewHours: 200, deadlineWeek: "" }), { totalWeeks: 24 }).ok).toBe(false);
    expect(parseTradesForm(form({ reviewHours: 24, deadlineWeek: 25 }), { totalWeeks: 24 }).ok).toBe(false);
  });
});
