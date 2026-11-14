import { describe, expect, it, vi } from "vitest";

// results.ts imports DB services; the pure helpers tested here never touch the DB.
vi.mock("@/db", () => ({ db: {} }));

import {
  bracketRoundCount,
  canFinalizeWeek,
  canReopenWeek,
  currentPeriod,
  firstRoundRows,
  isRangeFinalized,
  listPeriods,
  nextRoundRows,
  periodLabel,
  periodOfWeek,
  planSeasonAdvance,
  playoffRoundName,
  rangeTotals,
  settleMatchup,
  weekState,
  weekStatusList,
} from "@/server/services/results";
import { defaultLeagueSettings, type ScheduleSettings } from "@/lib/settings";

const SEASON_START = "2026-09-07"; // a Monday

function schedule(over: Partial<ScheduleSettings> = {}): ScheduleSettings {
  return { ...defaultLeagueSettings().schedule, ...over };
}

describe("week states", () => {
  const none = new Set<number>();
  it("is upcoming before the week starts", () => {
    expect(weekState(2, SEASON_START, "2026-09-13", none)).toBe("upcoming");
  });
  it("is in progress from Monday through Sunday", () => {
    expect(weekState(1, SEASON_START, "2026-09-07", none)).toBe("in_progress");
    expect(weekState(1, SEASON_START, "2026-09-13", none)).toBe("in_progress");
  });
  it("has ended the day after Sunday", () => {
    expect(weekState(1, SEASON_START, "2026-09-14", none)).toBe("ended");
  });
  it("finalized wins over everything", () => {
    expect(weekState(1, SEASON_START, "2026-09-14", new Set([1]))).toBe("finalized");
  });
});

describe("periods", () => {
  const s = schedule({ matchupWeeks: 2, regularSeasonMatchups: 3, playoffTeams: 4, playoffRoundWeeks: 1 });
  it("maps regular-season weeks to their matchup period", () => {
    expect(periodOfWeek(1, s)).toEqual({ period: 1, weekStart: 1, weekEnd: 2, isPlayoff: false, playoffRound: null });
    expect(periodOfWeek(6, s)).toEqual({ period: 3, weekStart: 5, weekEnd: 6, isPlayoff: false, playoffRound: null });
  });
  it("maps playoff weeks to rounds", () => {
    expect(periodOfWeek(7, s)).toEqual({ period: 4, weekStart: 7, weekEnd: 7, isPlayoff: true, playoffRound: 1 });
    expect(periodOfWeek(8, s)).toEqual({ period: 5, weekStart: 8, weekEnd: 8, isPlayoff: true, playoffRound: 2 });
    expect(periodOfWeek(9, s)).toBeNull();
    expect(periodOfWeek(0, s)).toBeNull();
  });
  it("labels periods", () => {
    expect(periodLabel({ weekStart: 3, weekEnd: 4, isPlayoff: false, playoffRound: null })).toBe("Week 3–4");
    expect(periodLabel({ weekStart: 3, weekEnd: 3, isPlayoff: false, playoffRound: null })).toBe("Week 3");
    expect(periodLabel({ weekStart: 21, weekEnd: 22, isPlayoff: true, playoffRound: 1 })).toBe("Playoffs R1");
  });
  it("lists distinct periods in order and picks the current one", () => {
    const ms = [
      { period: 2, weekStart: 3, weekEnd: 4, isPlayoff: false, playoffRound: null },
      { period: 1, weekStart: 1, weekEnd: 2, isPlayoff: false, playoffRound: null },
      { period: 1, weekStart: 1, weekEnd: 2, isPlayoff: false, playoffRound: null },
    ];
    expect(listPeriods(ms).map((p) => p.label)).toEqual(["Week 1–2", "Week 3–4"]);
    expect(currentPeriod(ms, 3)).toBe(2);
    expect(currentPeriod(ms, -1)).toBe(1); // preseason
    expect(currentPeriod(ms, 9)).toBe(2); // after the season: latest period
    expect(currentPeriod([], 3)).toBeNull();
  });
  it("names playoff rounds", () => {
    expect(bracketRoundCount(4)).toBe(3);
    expect(bracketRoundCount(2)).toBe(2);
    expect(bracketRoundCount(1)).toBe(1);
    expect(playoffRoundName(3, 3)).toBe("Championship");
    expect(playoffRoundName(2, 3)).toBe("Semifinals");
    expect(playoffRoundName(1, 3)).toBe("Quarterfinals");
    expect(playoffRoundName(1, 4)).toBe("Round 1");
  });
});

describe("canFinalizeWeek / canReopenWeek", () => {
  const s = schedule({ matchupWeeks: 1, regularSeasonMatchups: 2, playoffTeams: 2, playoffRoundWeeks: 1 });
  const base = { status: "in_season" as const, schedule: s, seasonStart: SEASON_START };

  it("needs the week to be over in league time", () => {
    const r = canFinalizeWeek({ ...base, week: 1, today: "2026-09-13", finalizedWeeks: [] });
    expect(r.ok).toBe(false);
    expect(canFinalizeWeek({ ...base, week: 1, today: "2026-09-14", finalizedWeeks: [] }).ok).toBe(true);
  });
  it("goes in order", () => {
    const r = canFinalizeWeek({ ...base, week: 2, today: "2026-12-01", finalizedWeeks: [] });
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("week 1 first") });
    expect(canFinalizeWeek({ ...base, week: 2, today: "2026-12-01", finalizedWeeks: [1] }).ok).toBe(true);
  });
  it("rejects finalized, out-of-season weeks and wrong statuses", () => {
    expect(canFinalizeWeek({ ...base, week: 1, today: "2026-12-01", finalizedWeeks: [1] }).ok).toBe(false);
    expect(canFinalizeWeek({ ...base, week: 4, today: "2026-12-01", finalizedWeeks: [1, 2, 3] }).ok).toBe(false);
    expect(canFinalizeWeek({ ...base, week: 3, today: "2026-12-01", finalizedWeeks: [1, 2] }).ok).toBe(true);
    expect(canFinalizeWeek({ ...base, status: "drafting", week: 1, today: "2026-12-01", finalizedWeeks: [] }).ok).toBe(false);
    expect(canFinalizeWeek({ ...base, status: "complete", week: 3, today: "2026-12-01", finalizedWeeks: [1, 2] }).ok).toBe(false);
  });
  it("only reopens the latest final week", () => {
    expect(canReopenWeek(2, [1, 2]).ok).toBe(true);
    expect(canReopenWeek(1, [1, 2]).ok).toBe(false);
    expect(canReopenWeek(3, [1, 2]).ok).toBe(false);
  });
  it("builds the commissioner week list", () => {
    const rows = weekStatusList({ ...base, today: "2026-09-22", finalizedWeeks: [1] });
    expect(rows.map((r) => r.state)).toEqual(["finalized", "ended", "in_progress"]);
    expect(rows.map((r) => r.canFinalize)).toEqual([false, true, false]);
    expect(rows.map((r) => r.canReopen)).toEqual([true, false, false]);
    expect(rows[2].periodLabel).toBe("Playoffs R1");
    expect(rows[0].startDate).toBe("2026-09-07");
    expect(rows[0].endDate).toBe("2026-09-13");
  });
});

describe("settling matchups", () => {
  const scores = [
    { teamId: "a", week: 1, points: 10 },
    { teamId: "a", week: 2, points: 5.5 },
    { teamId: "b", week: 1, points: 7 },
    { teamId: "b", week: 2, points: 8 },
    { teamId: "c", week: 1, points: 1 },
    { teamId: "d", week: 3, points: 50 }, // outside the range
  ];
  const totals = rangeTotals(scores, 1, 2, ["a", "b", "c", "d"]);
  const base = { isMedian: false, isBye: false, isPlayoff: false, seedA: null, seedB: null, weekStart: 1, weekEnd: 2 };

  it("sums each team over the range", () => {
    expect(Object.fromEntries(totals)).toEqual({ a: 15.5, b: 15, c: 1, d: 0 });
  });
  it("picks the higher score", () => {
    expect(settleMatchup({ ...base, teamAId: "b", teamBId: "a" }, totals)).toEqual({ scoreA: 15, scoreB: 15.5, winnerTeamId: "a" });
  });
  it("median games use the median of all teams' totals", () => {
    // totals 0, 1, 15, 15.5 -> median 8
    expect(settleMatchup({ ...base, teamAId: "a", teamBId: null, isMedian: true }, totals)).toEqual({
      scoreA: 15.5,
      scoreB: 8,
      winnerTeamId: "a",
    });
    expect(settleMatchup({ ...base, teamAId: "c", teamBId: null, isMedian: true }, totals).winnerTeamId).toBeNull();
  });
  it("regular-season ties have no winner; playoff ties go to the higher seed", () => {
    const tied = new Map([
      ["x", 4],
      ["y", 4],
    ]);
    expect(settleMatchup({ ...base, teamAId: "x", teamBId: "y" }, tied).winnerTeamId).toBeNull();
    expect(settleMatchup({ ...base, isPlayoff: true, teamAId: "x", teamBId: "y", seedA: 3, seedB: 2 }, tied).winnerTeamId).toBe("y");
  });
  it("knows when a range is finalized", () => {
    expect(isRangeFinalized({ weekStart: 1, weekEnd: 2 }, new Set([1]))).toBe(false);
    expect(isRangeFinalized({ weekStart: 1, weekEnd: 2 }, new Set([1, 2]))).toBe(true);
  });
});

describe("playoff bracket shaping", () => {
  const s = schedule({ matchupWeeks: 2, regularSeasonMatchups: 5, playoffTeams: 6, playoffRoundWeeks: 2 });

  it("seeds round 1 with byes for the top seeds", () => {
    const rows = firstRoundRows(["t1", "t2", "t3", "t4", "t5", "t6"], s);
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(r).toMatchObject({ playoffRound: 1, period: 6, weekStart: 11, weekEnd: 12, isPlayoff: true });
    }
    const byes = rows.filter((r) => r.isBye);
    expect(byes.map((r) => [r.teamAId, r.seedA, r.teamBId, r.final, r.winnerTeamId, r.scoreA])).toEqual([
      ["t1", 1, null, true, "t1", null],
      ["t2", 2, null, true, "t2", null],
    ]);
    const games = rows.filter((r) => !r.isBye).map((r) => [r.seedA, r.seedB, r.final]);
    expect(games).toEqual([
      [4, 5, false],
      [3, 6, false],
    ]);
  });

  it("pairs adjacent winners for the next round, carrying seeds", () => {
    const r1 = firstRoundRows(["t1", "t2", "t3", "t4", "t5", "t6"], s).map((r) =>
      r.isBye ? r : { ...r, final: true, winnerTeamId: r.seedA === 4 ? "t5" : "t3" },
    );
    const r2 = nextRoundRows(r1, 1, s)!;
    expect(r2).toHaveLength(2);
    expect(r2.map((r) => [r.bracketSlot, r.teamAId, r.seedA, r.teamBId, r.seedB, r.playoffRound, r.weekStart, r.weekEnd, r.period])).toEqual([
      [0, "t1", 1, "t5", 5, 2, 13, 14, 7],
      [1, "t2", 2, "t3", 3, 2, 13, 14, 7],
    ]);
    const champ = nextRoundRows([{ ...r2[0], final: true, winnerTeamId: "t5" }, { ...r2[1], final: true, winnerTeamId: "t2" }], 2, s)!;
    expect(champ.map((r) => [r.teamAId, r.seedA, r.teamBId, r.seedB, r.playoffRound])).toEqual([["t2", 2, "t5", 5, 3]]);
    expect(nextRoundRows([{ ...champ[0], final: true, winnerTeamId: "t5" }], 3, s)).toBeNull();
  });

  it("refuses to advance an unsettled round", () => {
    const r1 = firstRoundRows(["t1", "t2"], s);
    expect(() => nextRoundRows(r1, 1, s)).toThrow();
  });
});

describe("planSeasonAdvance", () => {
  const s = schedule({ matchupWeeks: 1, regularSeasonMatchups: 2, playoffTeams: 2, playoffRoundWeeks: 1 });
  const reg = (final: boolean) => ({
    isPlayoff: false,
    playoffRound: null,
    bracketSlot: null,
    teamAId: "a",
    teamBId: "b",
    seedA: null,
    seedB: null,
    winnerTeamId: null,
    final,
  });

  it("waits for the regular season to finish", () => {
    expect(planSeasonAdvance({ status: "in_season", matchups: [reg(true), reg(false)], playoffTeams: 2, teamCount: 4, schedule: s })).toEqual({
      kind: "none",
    });
  });
  it("seeds the playoffs (capped at the team count) or completes the season", () => {
    expect(planSeasonAdvance({ status: "in_season", matchups: [reg(true)], playoffTeams: 2, teamCount: 4, schedule: s })).toEqual({
      kind: "seed_playoffs",
      playoffTeams: 2,
    });
    expect(planSeasonAdvance({ status: "in_season", matchups: [reg(true)], playoffTeams: 8, teamCount: 3, schedule: s })).toEqual({
      kind: "seed_playoffs",
      playoffTeams: 3,
    });
    expect(planSeasonAdvance({ status: "in_season", matchups: [reg(true)], playoffTeams: 0, teamCount: 4, schedule: s })).toEqual({
      kind: "complete",
    });
    expect(planSeasonAdvance({ status: "complete", matchups: [reg(true)], playoffTeams: 0, teamCount: 4, schedule: s })).toEqual({
      kind: "none",
    });
  });
  it("creates the next round and completes after the championship", () => {
    const r1 = firstRoundRows(["t1", "t2", "t3", "t4"], s);
    const pending = planSeasonAdvance({ status: "playoffs", matchups: [reg(true), ...r1], playoffTeams: 4, teamCount: 4, schedule: s });
    expect(pending).toEqual({ kind: "none" });
    const done = r1.map((r) => ({ ...r, final: true, winnerTeamId: r.teamAId }));
    const next = planSeasonAdvance({ status: "playoffs", matchups: [reg(true), ...done], playoffTeams: 4, teamCount: 4, schedule: s });
    expect(next.kind).toBe("next_round");
    if (next.kind !== "next_round") return;
    expect(next.round).toBe(2);
    expect(next.rows.map((r) => [r.teamAId, r.teamBId])).toEqual([["t1", "t2"]]);
    const champ = next.rows.map((r) => ({ ...r, final: true, winnerTeamId: r.teamBId }));
    expect(
      planSeasonAdvance({ status: "playoffs", matchups: [reg(true), ...done, ...champ], playoffTeams: 4, teamCount: 4, schedule: s }),
    ).toEqual({ kind: "complete" });
  });
});
