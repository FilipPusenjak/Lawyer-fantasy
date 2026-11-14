/**
 * Pure helpers for the rankings page: parse ?pos=&status=&sort=&limit=,
 * filter/sort rows and build links. No DB access (unit tested).
 */
import { compareProjections, compareProjectionsRestOfSeason } from "@/lib/projections";
import { POSITION_SHORT, POSITIONS, type Position } from "@/lib/settings";

export const RANK_STATUS_FILTERS = ["all", "available", "mine"] as const;
export type RankStatusFilter = (typeof RANK_STATUS_FILTERS)[number];
export const RANK_STATUS_LABELS: Record<RankStatusFilter, string> = { all: "All", available: "Available", mine: "My team" };

export const RANK_SORTS = ["draft", "week", "ros"] as const;
export type RankSort = (typeof RANK_SORTS)[number];
export const RANK_SORT_LABELS: Record<RankSort, string> = { draft: "Draft rank", week: "Projected week", ros: "Rest of season" };

export const RANK_PAGE_STEP = 100;
export const RANK_MAX_LIMIT = 1000;

export type RankFilters = {
  position: Position | "all";
  status: RankStatusFilter;
  sort: RankSort;
  limit: number;
};

export const DEFAULT_RANK_FILTERS: RankFilters = { position: "all", status: "all", sort: "week", limit: RANK_PAGE_STEP };

/**
 * Until the draft is over, the page opens on the commissioner's draft rank
 * (the order auto-pick and the draft room use); afterwards on projections.
 */
export function defaultRankFilters(leagueStatus: string): RankFilters {
  const beforeDraft = leagueStatus === "setup" || leagueStatus === "drafting";
  return { ...DEFAULT_RANK_FILTERS, sort: beforeDraft ? "draft" : "week" };
}

type RawParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function oneOf<T extends string>(list: readonly T[], v: string | undefined, fallback: T): T {
  return v !== undefined && (list as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** Accepts position keys ("prosecutor") and short labels ("PRO", any case). */
function parsePosition(raw: string | undefined): Position | "all" {
  if (!raw) return "all";
  const v = raw.toLowerCase();
  if ((POSITIONS as readonly string[]).includes(v)) return v as Position;
  const byShort = POSITIONS.find((p) => POSITION_SHORT[p].toLowerCase() === v);
  return byShort ?? "all";
}

/** Read filters from the URL; bad values fall back to `defaults` (see defaultRankFilters). */
export function parseRankFilters(sp: RawParams, defaults: RankFilters = DEFAULT_RANK_FILTERS): RankFilters {
  const limitRaw = first(sp.limit);
  let limit = RANK_PAGE_STEP;
  if (limitRaw && /^\d{1,5}$/.test(limitRaw)) {
    const n = Number(limitRaw);
    limit = Math.min(RANK_MAX_LIMIT, Math.max(RANK_PAGE_STEP, Math.ceil(n / RANK_PAGE_STEP) * RANK_PAGE_STEP));
  }
  return {
    position: parsePosition(first(sp.pos)),
    status: oneOf(RANK_STATUS_FILTERS, first(sp.status), defaults.status),
    sort: oneOf(RANK_SORTS, first(sp.sort), defaults.sort),
    limit,
  };
}

/** Link with some filters changed; defaults are left out of the URL. Changing filters resets paging. */
export function rankingsHref(base: string, f: RankFilters, patch: Partial<RankFilters> = {}, defaults: RankFilters = DEFAULT_RANK_FILTERS): string {
  const next = { ...f, ...patch };
  if (!("limit" in patch)) next.limit = RANK_PAGE_STEP;
  const params = new URLSearchParams();
  if (next.position !== defaults.position) params.set("pos", next.position);
  if (next.status !== defaults.status) params.set("status", next.status);
  if (next.sort !== defaults.sort) params.set("sort", next.sort);
  if (next.limit !== RANK_PAGE_STEP) params.set("limit", String(next.limit));
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

export type RankRowStatus = { kind: "rostered"; teamId: string } | { kind: "waivers" } | { kind: "free_agent" };

export type RankRow = {
  lawyerId: string;
  name: string;
  position: Position;
  projectedWeek: number;
  restOfSeason: number;
  /** Commissioner's draft rank (lawyers.preseason_rank); null = unranked. */
  preseasonRank: number | null;
  status: RankRowStatus;
};

/** Draft rank first (unranked last), then the usual projection order. */
export function compareDraftRank(a: RankRow, b: RankRow): number {
  const ra = a.preseasonRank ?? Number.MAX_SAFE_INTEGER;
  const rb = b.preseasonRank ?? Number.MAX_SAFE_INTEGER;
  return ra - rb || compareProjections(a, b);
}

/** Position rank by draft rank across the whole pool ("DEF5" = 5th defense attorney in draft order). */
export function draftPositionRanks(rows: readonly RankRow[]): Map<string, number> {
  const out = new Map<string, number>();
  const perPosition = new Map<Position, number>();
  for (const r of [...rows].sort(compareDraftRank)) {
    if (r.preseasonRank === null) continue;
    const n = (perPosition.get(r.position) ?? 0) + 1;
    perPosition.set(r.position, n);
    out.set(r.lawyerId, n);
  }
  return out;
}

export function matchesRankStatus(s: RankRowStatus, f: RankStatusFilter, myTeamId: string | null): boolean {
  switch (f) {
    case "all":
      return true;
    case "available":
      return s.kind !== "rostered";
    case "mine":
      return s.kind === "rostered" && myTeamId !== null && s.teamId === myTeamId;
  }
}

/** Every matching row, sorted (slice for paging). */
export function filterRankRows<T extends RankRow>(rows: readonly T[], f: RankFilters, myTeamId: string | null): T[] {
  const out = rows.filter((r) => (f.position === "all" || r.position === f.position) && matchesRankStatus(r.status, f.status, myTeamId));
  return out.sort(f.sort === "draft" ? compareDraftRank : f.sort === "ros" ? compareProjectionsRestOfSeason : compareProjections);
}
