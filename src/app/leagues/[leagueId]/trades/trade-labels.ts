/**
 * Pure display helpers for trade pages. No DB access (unit tested).
 */
import { formatDate, weekEndDate } from "@/lib/time";
import type { LeagueStatus, TradeStatus } from "@/server/services/trades";

export const TRADE_STATUS_LABELS: Record<TradeStatus, string> = {
  proposed: "Waiting",
  accepted: "In review",
  completed: "Completed",
  rejected: "Declined",
  cancelled: "Cancelled",
  vetoed: "Vetoed",
  failed: "Fell through",
};

export function tradeStatusTone(status: TradeStatus): "neutral" | "brand" | "accent" | "pos" | "neg" | "warn" {
  switch (status) {
    case "proposed":
      return "warn";
    case "accepted":
      return "accent";
    case "completed":
      return "pos";
    case "rejected":
    case "vetoed":
      return "neg";
    default:
      return "neutral";
  }
}

/** One short line about the trade deadline for the trades pages. */
export function tradeDeadlineText(args: {
  leagueStatus: LeagueStatus;
  deadlineWeek: number | null;
  currentWeek: number;
  seasonStart: string;
}): string {
  const { leagueStatus, deadlineWeek, currentWeek, seasonStart } = args;
  if (leagueStatus === "setup" || leagueStatus === "drafting") return "Trades open once the draft is done.";
  if (leagueStatus === "complete") return "The season is over, so trades are closed.";
  if (deadlineWeek === null) return "No trade deadline this season.";
  if (currentWeek > deadlineWeek) return `The trade deadline (week ${deadlineWeek}) has passed.`;
  return `Trade deadline: end of week ${deadlineWeek} (${formatDate(weekEndDate(deadlineWeek, seasonStart))}).`;
}

/** How the commissioner review works, in one line. */
export function reviewText(reviewHours: number): string {
  if (reviewHours === 0) return "Accepted trades go through right away.";
  const span = reviewHours % 24 === 0 ? `${reviewHours / 24}-day` : `${reviewHours}-hour`;
  return `Accepted trades go through after a ${span} commissioner review.`;
}

/** First value of a search param. */
export function firstParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** All values of a search param that look like ids (deduped, capped). */
export function idParams(v: string | string[] | undefined, isId: (s: string) => boolean, max = 30): string[] {
  const arr = Array.isArray(v) ? v : v ? v.split(",") : [];
  return [...new Set(arr.map((s) => s.trim()).filter(isId))].slice(0, max);
}

/** Link to the new-trade page, optionally pre-filled. */
export function newTradeHref(leagueId: string, opts?: { withTeamId?: string; give?: string[]; get?: string[] }): string {
  const q = new URLSearchParams();
  if (opts?.withTeamId) q.set("with", opts.withTeamId);
  if (opts?.give?.length) q.set("give", opts.give.join(","));
  if (opts?.get?.length) q.set("get", opts.get.join(","));
  const qs = q.toString();
  return `/leagues/${leagueId}/trades/new${qs ? `?${qs}` : ""}`;
}
