import { describe, expect, it } from "vitest";
import { defaultLeagueSettings, leagueSettingsSchema, parseLeagueSettings, presetScoring, SCORING_PRESETS } from "@/lib/settings";

describe("scoring presets", () => {
  it("Steady is the default and validates", () => {
    const d = defaultLeagueSettings();
    expect(d.scoring).toEqual(presetScoring("steady"));
    expect(leagueSettingsSchema.safeParse(d).success).toBe(true);
    expect(SCORING_PRESETS[0]).toBe("steady");
  });

  it("Steady weights regular filings up and swings down, keeping a verdict the biggest single play", () => {
    const s = presetScoring("steady");
    const h = presetScoring("half_ppf");
    expect(s.values.filing).toBeGreaterThan(h.values.filing);
    expect(s.filingWeeklyCap).toBeGreaterThan(h.filingWeeklyCap);
    expect(Math.abs(s.values.motion_denied)).toBeLessThan(Math.abs(h.values.motion_denied));
    expect(Math.abs(s.values.verdict_loss)).toBeLessThan(Math.abs(h.values.verdict_loss));
    const biggest = Math.max(...Object.values(s.values));
    expect(s.values.verdict_win).toBe(biggest);
  });

  it("leagues saved with Half-PPF keep their values", () => {
    const saved = { ...defaultLeagueSettings(), scoring: presetScoring("half_ppf") };
    expect(parseLeagueSettings(saved).scoring).toEqual(presetScoring("half_ppf"));
  });
});
