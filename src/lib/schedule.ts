/**
 * Pure schedule generation: round-robin regular season and playoff brackets.
 */
import type { ScheduleSettings } from "./settings";
import { playoffRounds, regularSeasonWeeks } from "./settings";

export type Pairing = { teamA: string; teamB: string | null };
export type PeriodPairings = { period: number; weekStart: number; weekEnd: number; pairings: Pairing[] };

/**
 * Circle-method round robin. With an odd number of teams, the team paired with
 * the phantom slot plays the league median that period (teamB = null).
 * Cycles repeat (with home/away flipped) if there are more periods than rounds.
 */
export function roundRobin(teamIds: string[], periods: number): Pairing[][] {
  if (teamIds.length < 2) return Array.from({ length: periods }, () => []);
  const slots: (string | null)[] = [...teamIds];
  if (slots.length % 2 === 1) slots.push(null);
  const n = slots.length;
  const rounds: Pairing[][] = [];
  const arr = [...slots];
  for (let r = 0; r < n - 1; r++) {
    const pairs: Pairing[] = [];
    for (let i = 0; i < n / 2; i++) {
      const a = arr[i];
      const b = arr[n - 1 - i];
      if (a === null && b === null) continue;
      if (a === null) pairs.push({ teamA: b!, teamB: null });
      else if (b === null) pairs.push({ teamA: a, teamB: null });
      else pairs.push(r % 2 === 0 ? { teamA: a, teamB: b } : { teamA: b, teamB: a });
    }
    rounds.push(pairs);
    // rotate all but the first
    const last = arr.pop()!;
    arr.splice(1, 0, last);
  }
  const out: Pairing[][] = [];
  for (let p = 0; p < periods; p++) {
    const cycle = Math.floor(p / rounds.length);
    const base = rounds[p % rounds.length];
    out.push(
      cycle % 2 === 0
        ? base
        : base.map((x) => (x.teamB ? { teamA: x.teamB, teamB: x.teamA } : x)),
    );
  }
  return out;
}

export function regularSeasonSchedule(teamIds: string[], s: ScheduleSettings): PeriodPairings[] {
  const rr = roundRobin(teamIds, s.regularSeasonMatchups);
  return rr.map((pairings, i) => ({
    period: i + 1,
    weekStart: i * s.matchupWeeks + 1,
    weekEnd: (i + 1) * s.matchupWeeks,
    pairings,
  }));
}

/** Week range of a playoff round (1-based round). */
export function playoffRoundWeeks(round: number, s: ScheduleSettings): { weekStart: number; weekEnd: number; period: number } {
  const start = regularSeasonWeeks(s) + (round - 1) * s.playoffRoundWeeks + 1;
  return { weekStart: start, weekEnd: start + s.playoffRoundWeeks - 1, period: s.regularSeasonMatchups + round };
}

/** Standard bracket seed order for a bracket of size 2^k, e.g. 8 -> [1,8,4,5,2,7,3,6]. */
export function bracketSeedOrder(size: number): number[] {
  let order = [1, 2];
  while (order.length < size) {
    const n = order.length * 2;
    const next: number[] = [];
    for (const s of order) next.push(s, n + 1 - s);
    order = next;
  }
  return order;
}

export type BracketMatch = {
  bracketSlot: number;
  seedA: number;
  seedB: number | null; // null = bye for seedA
};

/** First-round matches for `playoffTeams` seeds. Top seeds get byes when not a power of two. */
export function firstRoundBracket(playoffTeams: number): BracketMatch[] {
  const rounds = playoffRounds(playoffTeams);
  if (rounds === 0) return [];
  const size = 2 ** rounds;
  const order = bracketSeedOrder(size);
  const matches: BracketMatch[] = [];
  for (let i = 0; i < size / 2; i++) {
    const s1 = order[2 * i];
    const s2 = order[2 * i + 1];
    const a = Math.min(s1, s2);
    const b = Math.max(s1, s2);
    matches.push({ bracketSlot: i, seedA: a, seedB: b <= playoffTeams ? b : null });
  }
  return matches;
}

export type RoundResult = {
  bracketSlot: number;
  winnerTeamId: string;
  winnerSeed: number;
};

/** Pair winners of adjacent bracket slots for the next round. */
export function nextRoundPairs(results: RoundResult[]): { bracketSlot: number; a: RoundResult; b: RoundResult }[] {
  const sorted = [...results].sort((x, y) => x.bracketSlot - y.bracketSlot);
  const out: { bracketSlot: number; a: RoundResult; b: RoundResult }[] = [];
  for (let i = 0; i + 1 < sorted.length; i += 2) {
    const [x, y] = [sorted[i], sorted[i + 1]];
    const [a, b] = x.winnerSeed <= y.winnerSeed ? [x, y] : [y, x];
    out.push({ bracketSlot: i / 2, a, b });
  }
  return out;
}

/**
 * Decide a matchup. Regular season ties are ties (null). Playoff ties go to the
 * higher seed (lower seed number).
 */
export function decideWinner(args: {
  teamA: string;
  teamB: string | null;
  scoreA: number;
  scoreB: number;
  isPlayoff: boolean;
  seedA?: number | null;
  seedB?: number | null;
}): string | null {
  const { teamA, teamB, scoreA, scoreB, isPlayoff, seedA, seedB } = args;
  if (scoreA > scoreB) return teamA;
  if (scoreB > scoreA) return teamB; // null for median games -> loss for A
  if (!isPlayoff) return null;
  if (!teamB) return teamA;
  return (seedA ?? 99) <= (seedB ?? 99) ? teamA : teamB;
}

/** Median of numbers (average of the middle two for even counts). */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
