/**
 * Pure helpers for the lawyer pool list: parse ?filters, filter, sort and
 * build links. No DB access (unit tested).
 */
import { POSITIONS, type Position } from "@/lib/settings";

export const STATUS_FILTERS = ["available", "all", "free_agents", "waivers", "rostered"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];
export const STATUS_FILTER_LABELS: Record<StatusFilter, string> = {
  available: "Available",
  all: "All",
  free_agents: "Free agents",
  waivers: "On waivers",
  rostered: "Rostered",
};

export const SORTS = ["points", "projection", "rank", "name"] as const;
export type SortKey = (typeof SORTS)[number];
export const SORT_LABELS: Record<SortKey, string> = {
  points: "Season points",
  projection: "Projection",
  rank: "Draft rank",
  name: "Name",
};

export const PAGE_STEP = 50;
export const MAX_LIMIT = 1000;
export const MAX_QUERY = 60;

export type PlayerFilters = {
  position: Position | "all";
  status: StatusFilter;
  q: string;
  sort: SortKey;
  limit: number;
};

export const DEFAULT_FILTERS: PlayerFilters = { position: "all", status: "available", q: "", sort: "points", limit: PAGE_STEP };

type RawParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function oneOf<T extends string>(list: readonly T[], v: string | undefined, fallback: T): T {
  return v !== undefined && (list as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** Normalize a search string: trimmed, single spaces, capped length. */
export function normalizeQuery(raw: string | undefined): string {
  return (raw ?? "").trim().replace(/\s+/g, " ").slice(0, MAX_QUERY);
}

/** Read filters from ?pos=&status=&q=&sort=&limit= (bad values fall back to defaults). */
export function parsePlayerFilters(sp: RawParams): PlayerFilters {
  const pos = first(sp.pos);
  const limitRaw = first(sp.limit);
  let limit = PAGE_STEP;
  if (limitRaw && /^\d{1,5}$/.test(limitRaw)) {
    const n = Number(limitRaw);
    limit = Math.min(MAX_LIMIT, Math.max(PAGE_STEP, Math.ceil(n / PAGE_STEP) * PAGE_STEP));
  }
  return {
    position: oneOf(["all", ...POSITIONS] as const, pos, "all"),
    status: oneOf(STATUS_FILTERS, first(sp.status), DEFAULT_FILTERS.status),
    q: normalizeQuery(first(sp.q)),
    sort: oneOf(SORTS, first(sp.sort), DEFAULT_FILTERS.sort),
    limit,
  };
}

/** Link to the list with some filters changed; default values are left out of the URL. */
export function playersHref(base: string, f: PlayerFilters, patch: Partial<PlayerFilters> = {}): string {
  const next = { ...f, ...patch };
  // Changing what's shown starts back at the first page.
  if (!("limit" in patch)) next.limit = PAGE_STEP;
  const params = new URLSearchParams();
  if (next.position !== DEFAULT_FILTERS.position) params.set("pos", next.position);
  if (next.status !== DEFAULT_FILTERS.status) params.set("status", next.status);
  if (next.q) params.set("q", next.q);
  if (next.sort !== DEFAULT_FILTERS.sort) params.set("sort", next.sort);
  if (next.limit !== PAGE_STEP) params.set("limit", String(next.limit));
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

export type Availability = { kind: "rostered"; teamId: string } | { kind: "waivers" } | { kind: "free_agent" };

export function matchesStatus(a: Availability, s: StatusFilter): boolean {
  switch (s) {
    case "all":
      return true;
    case "available":
      return a.kind !== "rostered";
    case "free_agents":
      return a.kind === "free_agent";
    case "waivers":
      return a.kind === "waivers";
    case "rostered":
      return a.kind === "rostered";
  }
}

export type ListItem = {
  id: string;
  name: string;
  position: Position;
  organization: string | null;
  preseasonRank: number | null;
  seasonPoints: number;
  /** Projected points for the upcoming week (scouting). */
  projectedWeek?: number;
  availability: Availability;
  /** Extra searchable text, e.g. the firm's name. */
  searchText?: string;
};

function matchesQuery(item: ListItem, q: string): boolean {
  if (!q) return true;
  const hay = `${item.name} ${item.organization ?? ""} ${item.searchText ?? ""}`.toLowerCase();
  return q
    .toLowerCase()
    .split(" ")
    .every((word) => hay.includes(word));
}

const byName = (a: ListItem, b: ListItem) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
const byRank = (a: ListItem, b: ListItem) => (a.preseasonRank ?? Number.MAX_SAFE_INTEGER) - (b.preseasonRank ?? Number.MAX_SAFE_INTEGER);

export function sortItems<T extends ListItem>(items: T[], sort: SortKey): T[] {
  const out = [...items];
  switch (sort) {
    case "points":
      return out.sort((a, b) => b.seasonPoints - a.seasonPoints || byRank(a, b) || byName(a, b));
    case "projection":
      return out.sort((a, b) => (b.projectedWeek ?? 0) - (a.projectedWeek ?? 0) || byRank(a, b) || byName(a, b));
    case "rank":
      return out.sort((a, b) => byRank(a, b) || byName(a, b));
    case "name":
      return out.sort(byName);
  }
}

/** Filter by position, status and search, then sort. Returns every match (slice for paging). */
export function filterPlayers<T extends ListItem>(items: T[], f: PlayerFilters): T[] {
  const matches = items.filter(
    (i) => (f.position === "all" || i.position === f.position) && matchesStatus(i.availability, f.status) && matchesQuery(i, f.q),
  );
  return sortItems(matches, f.sort);
}

/** Short local day for badges, e.g. "Wed, Nov 18". */
export function formatShortDay(instant: Date, timeZone: string): string {
  return instant.toLocaleDateString("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" });
}
