import { describe, expect, it } from "vitest";
import {
  DEFAULT_FILTERS,
  filterPlayers,
  matchesStatus,
  PAGE_STEP,
  parsePlayerFilters,
  playersHref,
  sortItems,
  type ListItem,
} from "@/app/leagues/[leagueId]/players/player-filters";

const item = (over: Partial<ListItem> & { id: string }): ListItem => ({
  name: over.id,
  position: "trial",
  organization: null,
  preseasonRank: null,
  seasonPoints: 0,
  availability: { kind: "free_agent" },
  ...over,
});

describe("parsePlayerFilters", () => {
  it("uses defaults for missing or bad values", () => {
    expect(parsePlayerFilters({})).toEqual(DEFAULT_FILTERS);
    expect(parsePlayerFilters({ pos: "goalie", status: "nope", sort: "x", limit: "abc" })).toEqual(DEFAULT_FILTERS);
  });

  it("reads valid values and normalizes the query", () => {
    const f = parsePlayerFilters({ pos: "firm", status: "waivers", q: "  Jane   Doe ", sort: "name", limit: "120" });
    expect(f).toEqual({ position: "firm", status: "waivers", q: "Jane Doe", sort: "name", limit: 150 });
  });

  it("clamps the limit and takes the first of repeated params", () => {
    expect(parsePlayerFilters({ limit: "99999" }).limit).toBe(1000);
    expect(parsePlayerFilters({ limit: "1" }).limit).toBe(PAGE_STEP);
    expect(parsePlayerFilters({ pos: ["appellate", "trial"] }).position).toBe("appellate");
  });

  it("caps the search length", () => {
    expect(parsePlayerFilters({ q: "a".repeat(200) }).q).toHaveLength(60);
  });
});

describe("playersHref", () => {
  it("omits defaults and resets paging when filters change", () => {
    const base = "/leagues/L/players";
    expect(playersHref(base, DEFAULT_FILTERS)).toBe(base);
    const f = { ...DEFAULT_FILTERS, limit: 150, q: "smith" };
    expect(playersHref(base, f, { position: "defense" })).toBe(`${base}?pos=defense&q=smith`);
    expect(playersHref(base, f, { limit: 200 })).toBe(`${base}?q=smith&limit=200`);
    expect(playersHref(base, DEFAULT_FILTERS, { status: "all", sort: "rank" })).toBe(`${base}?status=all&sort=rank`);
  });
});

describe("filterPlayers", () => {
  const items: ListItem[] = [
    item({ id: "a", name: "Ana Diaz", position: "trial", seasonPoints: 5, preseasonRank: 3 }),
    item({ id: "b", name: "Ben Ito", position: "defense", seasonPoints: 12, availability: { kind: "waivers" } }),
    item({ id: "c", name: "Cara Lee", position: "trial", seasonPoints: 12, preseasonRank: 1, availability: { kind: "rostered", teamId: "t1" } }),
    item({ id: "d", name: "Dewey & Co", position: "firm", organization: "Big Firm LLP", seasonPoints: -2 }),
  ];

  it("status filters", () => {
    expect(matchesStatus({ kind: "rostered", teamId: "t" }, "available")).toBe(false);
    expect(matchesStatus({ kind: "waivers" }, "available")).toBe(true);
    const ids = (status: (typeof DEFAULT_FILTERS)["status"]) => filterPlayers(items, { ...DEFAULT_FILTERS, status }).map((i) => i.id);
    expect(ids("available")).toEqual(["b", "a", "d"]);
    expect(ids("all")).toEqual(["c", "b", "a", "d"]);
    expect(ids("free_agents")).toEqual(["a", "d"]);
    expect(ids("waivers")).toEqual(["b"]);
    expect(ids("rostered")).toEqual(["c"]);
  });

  it("position and search (name or organization, every word)", () => {
    expect(filterPlayers(items, { ...DEFAULT_FILTERS, status: "all", position: "trial" }).map((i) => i.id)).toEqual(["c", "a"]);
    expect(filterPlayers(items, { ...DEFAULT_FILTERS, q: "big llp" }).map((i) => i.id)).toEqual(["d"]);
    expect(filterPlayers(items, { ...DEFAULT_FILTERS, q: "ANA" }).map((i) => i.id)).toEqual(["a"]);
    expect(filterPlayers(items, { ...DEFAULT_FILTERS, q: "ana zzz" })).toEqual([]);
  });

  it("sorts by points (rank breaks ties), rank (nulls last) and name", () => {
    expect(sortItems(items, "points").map((i) => i.id)).toEqual(["c", "b", "a", "d"]);
    expect(sortItems(items, "rank").map((i) => i.id)).toEqual(["c", "a", "b", "d"]);
    expect(sortItems(items, "name").map((i) => i.id)).toEqual(["a", "b", "c", "d"]);
  });
});
