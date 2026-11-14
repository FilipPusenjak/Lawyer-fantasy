import { describe, expect, it } from "vitest";
import {
  activityLabel,
  compareByProjectionRank,
  compareProjections,
  fmtProjection,
  projectionInputsLine,
  projectionRangeLabel,
  projectionSummaries,
  rankProjections,
  type LawyerProjection,
} from "@/lib/projections";
import type { Position } from "@/lib/settings";
import {
  defaultRankFilters,
  draftPositionRanks,
  filterRankRows,
  parseRankFilters,
  rankingsHref,
  RANK_PAGE_STEP,
  type RankFilters,
} from "@/app/leagues/[leagueId]/rankings/rankings-filters";

const proj = (lawyerId: string, projectedWeek: number, restOfSeason = projectedWeek * 10): LawyerProjection => ({
  lawyerId,
  projectedWeek,
  low: 0,
  high: projectedWeek * 2,
  activityRate: 0.5,
  restOfSeason,
  inputs: { activeCases: 1, eventsLookback: 0, observedWeeks: 0, ownRate: null, priorRate: projectedWeek, ownWeight: 0 },
});

const people: { id: string; name: string; position: Position }[] = [
  { id: "1", name: "Zed", position: "trial" },
  { id: "2", name: "Amy", position: "trial" },
  { id: "3", name: "Bob", position: "prosecutor" },
  { id: "4", name: "Big Firm", position: "firm" },
  { id: "5", name: "Cal", position: "trial" },
  { id: "6", name: "Amy", position: "defense" },
];

describe("rankProjections", () => {
  const map = new Map([
    ["1", proj("1", 3)],
    ["2", proj("2", 3)],
    ["3", proj("3", 5)],
    ["4", proj("4", 4)],
    ["5", proj("5", 3, 31)],
    ["6", proj("6", 3)],
  ]);

  it("ranks by projected week, then rest of season, then name, then id", () => {
    const ranked = rankProjections(map, people);
    expect(ranked.map((r) => r.lawyerId)).toEqual(["3", "4", "5", "2", "6", "1"]);
    expect(ranked.map((r) => r.overallRank)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("gives position ranks and labels; firms rank within FIRM and overall", () => {
    const ranked = rankProjections(map, people);
    const byId = new Map(ranked.map((r) => [r.lawyerId, r]));
    expect(byId.get("3")!.positionLabel).toBe("PRO1");
    expect(byId.get("4")).toMatchObject({ overallRank: 2, positionRank: 1, positionLabel: "FIRM1" });
    expect(byId.get("5")!.positionLabel).toBe("TRL1");
    expect(byId.get("2")!.positionLabel).toBe("TRL2");
    expect(byId.get("1")!.positionLabel).toBe("TRL3");
    expect(byId.get("6")!.positionLabel).toBe("DEF1");
  });

  it("is deterministic regardless of input order", () => {
    const a = rankProjections(map, people);
    const b = rankProjections(new Map([...map].reverse()), [...people].reverse());
    expect(b).toEqual(a);
  });

  it("skips lawyers without a projection", () => {
    expect(rankProjections(new Map([["3", proj("3", 1)]]), people).map((r) => r.lawyerId)).toEqual(["3"]);
  });

  it("compareProjections breaks exact ties by id", () => {
    const a = { lawyerId: "a", name: "Same", projectedWeek: 1, restOfSeason: 1 };
    const b = { lawyerId: "b", name: "Same", projectedWeek: 1, restOfSeason: 1 };
    expect(compareProjections(a, b)).toBeLessThan(0);
    expect(compareProjections(b, a)).toBeGreaterThan(0);
  });
});

describe("projection summaries", () => {
  it("builds a JSON-safe map and sorts by projection rank", () => {
    const ranked = rankProjections(new Map([["3", proj("3", 5)], ["2", proj("2", 1)]]), people);
    const s = projectionSummaries(ranked);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    expect(s["3"]).toMatchObject({ overallRank: 1, positionLabel: "PRO1", projectedWeek: 5 });
    const list = people.map((p) => ({ id: p.id, name: p.name }));
    expect([...list].sort((a, b) => compareByProjectionRank(s, a, b)).map((l) => l.id)).toEqual(["3", "2", "6", "4", "5", "1"]);
  });
});

describe("display helpers", () => {
  it("formats projections with one decimal and neutral, factual inputs", () => {
    expect(fmtProjection(3)).toBe("3");
    expect(fmtProjection(3.456)).toBe("3.5");
    expect(fmtProjection(-0.04)).toBe("0");
    const p = { ...proj("1", 2.25), low: 0, high: 4.5, activityRate: 0.456 };
    p.inputs = { ...p.inputs, activeCases: 4, eventsLookback: 1 };
    expect(projectionInputsLine(p, 8)).toBe("4 active cases · 1 scoring event in the last 8 weeks");
    expect(projectionRangeLabel(p)).toBe("0–4.5");
    expect(activityLabel(p)).toBe("46%");
  });
});

describe("rankings filters", () => {
  const base = "/leagues/x/rankings";

  it("parses params with safe fallbacks", () => {
    expect(parseRankFilters({})).toEqual({ position: "all", status: "all", sort: "week", limit: RANK_PAGE_STEP });
    expect(parseRankFilters({ pos: "PRO", status: "mine", sort: "ros", limit: "150" })).toEqual({
      position: "prosecutor",
      status: "mine",
      sort: "ros",
      limit: 200,
    });
    expect(parseRankFilters({ pos: "firm", status: "nope", sort: "x", limit: "-1" })).toMatchObject({
      position: "firm",
      status: "all",
      sort: "week",
      limit: RANK_PAGE_STEP,
    });
    expect(parseRankFilters({ limit: "99999" }).limit).toBe(1000);
  });

  it("builds links without defaults and resets paging on filter changes", () => {
    const f: RankFilters = { position: "trial", status: "available", sort: "week", limit: 300 };
    expect(rankingsHref(base, f, { sort: "ros" })).toBe(`${base}?pos=trial&status=available&sort=ros`);
    expect(rankingsHref(base, f, { limit: 400 })).toBe(`${base}?pos=trial&status=available&limit=400`);
    expect(rankingsHref(base, { ...f, position: "all", status: "all" })).toBe(base);
  });

  it("filters by position and status and sorts", () => {
    const rows = [
      { lawyerId: "1", name: "A", position: "trial" as const, projectedWeek: 2, restOfSeason: 20, preseasonRank: 5, status: { kind: "free_agent" as const } },
      { lawyerId: "2", name: "B", position: "trial" as const, projectedWeek: 3, restOfSeason: 10, preseasonRank: null, status: { kind: "rostered" as const, teamId: "t1" } },
      { lawyerId: "3", name: "C", position: "firm" as const, projectedWeek: 1, restOfSeason: 30, preseasonRank: 2, status: { kind: "waivers" as const } },
    ];
    const f = parseRankFilters({});
    expect(filterRankRows(rows, f, "t1").map((r) => r.lawyerId)).toEqual(["2", "1", "3"]);
    expect(filterRankRows(rows, { ...f, sort: "ros" }, "t1").map((r) => r.lawyerId)).toEqual(["3", "1", "2"]);
    expect(filterRankRows(rows, { ...f, status: "available" }, "t1").map((r) => r.lawyerId)).toEqual(["1", "3"]);
    expect(filterRankRows(rows, { ...f, status: "mine" }, "t1").map((r) => r.lawyerId)).toEqual(["2"]);
    expect(filterRankRows(rows, { ...f, status: "mine" }, null)).toEqual([]);
    expect(filterRankRows(rows, { ...f, position: "trial" }, null).map((r) => r.lawyerId)).toEqual(["2", "1"]);
    // Draft rank: lowest number first, unranked last.
    expect(filterRankRows(rows, { ...f, sort: "draft" }, null).map((r) => r.lawyerId)).toEqual(["3", "1", "2"]);
  });

  it("opens on draft rank until the draft is over, then on projections", () => {
    expect(defaultRankFilters("setup").sort).toBe("draft");
    expect(defaultRankFilters("drafting").sort).toBe("draft");
    expect(defaultRankFilters("in_season").sort).toBe("week");
    expect(defaultRankFilters("playoffs").sort).toBe("week");
    expect(defaultRankFilters("complete").sort).toBe("week");
    const pre = defaultRankFilters("setup");
    expect(parseRankFilters({}, pre).sort).toBe("draft");
    expect(parseRankFilters({ sort: "week" }, pre).sort).toBe("week");
    expect(parseRankFilters({ sort: "bogus" }, pre).sort).toBe("draft");
    // The league's own default is left out of links; the other sorts are kept.
    expect(rankingsHref(base, pre, {}, pre)).toBe(base);
    expect(rankingsHref(base, pre, { sort: "week" }, pre)).toBe(`${base}?sort=week`);
    const inSeason = defaultRankFilters("in_season");
    expect(rankingsHref(base, inSeason, { sort: "draft" }, inSeason)).toBe(`${base}?sort=draft`);
  });

  it("draftPositionRanks numbers each position in draft order and skips unranked", () => {
    const row = (lawyerId: string, position: Position, preseasonRank: number | null) => ({
      lawyerId,
      name: lawyerId,
      position,
      projectedWeek: 1,
      restOfSeason: 10,
      preseasonRank,
      status: { kind: "free_agent" as const },
    });
    const ranks = draftPositionRanks([row("ifrah", "defense", 3), row("steel", "defense", 18), row("klein", "defense", 17), row("x", "trial", 1), row("u", "defense", null)]);
    expect(ranks.get("ifrah")).toBe(1);
    expect(ranks.get("klein")).toBe(2);
    expect(ranks.get("steel")).toBe(3);
    expect(ranks.get("x")).toBe(1);
    expect(ranks.has("u")).toBe(false);
  });
});
