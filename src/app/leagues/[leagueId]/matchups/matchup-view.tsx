/**
 * Shared bits for showing matchups (scoreboard, matchup detail, playoff bracket).
 * Server-safe: no hooks.
 */
import type { ReactNode } from "react";
import type { Matchup } from "@/db/schema";
import { Badge, cx, Points } from "@/components/ui";
import { median } from "@/lib/schedule";
import { round2 } from "@/lib/scoring";
import { formatShortDate, weekEndDate, weekStartDate } from "@/lib/time";
import { MATCHUP_PHASE_LABELS, WEEK_STATE_LABELS, type MatchupPhase, type WeekState } from "@/server/services/results";
import type { Scoreboard } from "@/server/services/scores";

export { matchupPhase, type MatchupPhase } from "@/server/services/results";

type PhaseTone = "neutral" | "brand" | "accent" | "warn";

/** Badge tones for the shared phase vocabulary (Upcoming / Live / Awaiting final / Final). */
export const PHASE_TONES: Record<MatchupPhase, PhaseTone> = {
  bye: "neutral",
  upcoming: "neutral",
  live: "brand",
  awaiting: "warn",
  final: "accent",
};

const WEEK_STATE_PHASE: Record<WeekState, MatchupPhase> = {
  upcoming: "upcoming",
  in_progress: "live",
  ended: "awaiting",
  finalized: "final",
};

export function PhaseBadge({ phase, className }: { phase: MatchupPhase; className?: string }) {
  return (
    <Badge tone={PHASE_TONES[phase]} className={className}>
      {MATCHUP_PHASE_LABELS[phase]}
    </Badge>
  );
}

/** A week's state with the same labels and colors as matchup phases. */
export function WeekStateBadge({ state }: { state: WeekState }) {
  return <Badge tone={PHASE_TONES[WEEK_STATE_PHASE[state]]}>{WEEK_STATE_LABELS[state]}</Badge>;
}

export type MatchupScores = {
  /** Null for byes. */
  scoreA: number | null;
  /** Null for byes; the league median for median games. */
  scoreB: number | null;
};

/**
 * Stored scores once final; otherwise live totals from the scoreboard (median
 * games compare against the median of every team's total for the same weeks).
 * Without a scoreboard, unsettled matchups show 0–0.
 */
export function matchupScores(m: Matchup, sb: Scoreboard | null, allTeamIds: string[]): MatchupScores {
  if (m.isBye) return { scoreA: null, scoreB: null };
  if (m.final) return { scoreA: m.scoreA ?? 0, scoreB: m.scoreB ?? 0 };
  if (!sb) return { scoreA: 0, scoreB: 0 };
  const scoreA = sb.teamRange(m.teamAId, m.weekStart, m.weekEnd);
  const scoreB = m.teamBId
    ? sb.teamRange(m.teamBId, m.weekStart, m.weekEnd)
    : round2(median(allTeamIds.map((id) => sb.teamRange(id, m.weekStart, m.weekEnd))));
  return { scoreA, scoreB };
}

/**
 * Which side to show as ahead: the stored winner once final (playoff ties go to
 * the higher seed), otherwise whoever has more points. Null = level / bye.
 */
export function leadingSide(m: Matchup, s: MatchupScores): "A" | "B" | null {
  if (m.isBye) return "A";
  if (m.final && m.winnerTeamId) return m.winnerTeamId === m.teamAId ? "A" : "B";
  if (s.scoreA === null || s.scoreB === null || s.scoreA === s.scoreB) return null;
  return s.scoreA > s.scoreB ? "A" : "B";
}

/** "Sep 7 – Sep 20" for an inclusive week range. */
export function weekRangeDates(weekStart: number, weekEnd: number, seasonStart: string): string {
  return `${formatShortDate(weekStartDate(weekStart, seasonStart))} – ${formatShortDate(weekEndDate(weekEnd, seasonStart))}`;
}

/** One side of a matchup: seed, name, optional subline, "You" tag and score. */
export function ScoreLine({
  name,
  sub,
  seed,
  score,
  leading,
  isMine,
  big,
}: {
  name: ReactNode;
  sub?: ReactNode;
  seed?: number | null;
  score: number | null;
  leading: boolean;
  isMine?: boolean;
  big?: boolean;
}) {
  return (
    <div className="flex min-h-11 items-center gap-2">
      {seed != null ? <span className="w-5 shrink-0 text-center text-xs font-semibold tabular-nums text-muted">{seed}</span> : null}
      <div className="min-w-0 flex-1">
        <p className={cx("truncate", leading ? "font-bold text-ink" : "font-semibold")}>{name}</p>
        {sub ? <p className="truncate text-xs text-muted">{sub}</p> : null}
      </div>
      {isMine ? <Badge tone="brand">You</Badge> : null}
      {score !== null ? (
        <Points
          value={score}
          className={cx("shrink-0 text-right", big ? "min-w-14 text-2xl" : "min-w-12 text-xl", leading ? "font-bold text-ink" : "text-muted")}
        />
      ) : null}
    </div>
  );
}
