/**
 * Draft room model: the JSON shape the server sends to the draft room, plus
 * pure helpers shared by the draft service (server) and the draft room
 * (client). No DB or React imports here.
 */
import { openStarterSlots, snakeSlot } from "@/lib/draft";
import type { Position, RosterSettings, SlotType } from "@/lib/settings";
import { POSITIONS } from "@/lib/settings";

/** How often the draft room polls while the draft is live. */
export const DRAFT_POLL_MS = 2000;
/** Poll interval before the draft starts (to notice "Start draft"). */
export const SETUP_POLL_MS = 5000;
/** Most lawyers a team can have in its queue. */
export const MAX_QUEUE = 50;
/** Most auto-picks one advanceClock call makes (later polls continue). */
export const MAX_CATCHUP_PICKS = 25;
/** A manual pick sent this soon after the deadline still counts. */
export const PICK_GRACE_MS = 1500;
/** A team that lands on the clock after a catch-up gets at least this long. */
export const MIN_FRESH_CLOCK_SECONDS = 15;
/** Resuming a paused draft gives the team on the clock at least this long. */
export const MIN_RESUME_SECONDS = 10;

export type DraftStatus = "not_started" | "in_progress" | "paused" | "complete";
export type LeagueStatus = "setup" | "drafting" | "in_season" | "playoffs" | "complete";

export type DraftLawyer = {
  id: string;
  name: string;
  kind: "lawyer" | "firm";
  position: Position;
  organization: string | null;
  /** Preseason rank (1 = best), null if unranked. */
  rank: number | null;
};

export type DraftTeamInfo = {
  id: string;
  name: string;
  ownerName: string;
  /** 1-based slot; null until the order is set. */
  draftPosition: number | null;
};

export type DraftPickInfo = {
  /** 0-based overall pick number. */
  overall: number;
  round: number;
  pickInRound: number;
  teamId: string;
  lawyerId: string;
  isAuto: boolean;
};

export type OnClock = { overall: number; round: number; pickInRound: number; teamId: string };

/** Everything the draft room needs (except the lawyer pool, which is sent once). */
export type DraftStateJson = {
  leagueId: string;
  leagueStatus: LeagueStatus;
  status: DraftStatus;
  version: number;
  rounds: number;
  secondsPerPick: number;
  /** 0-based overall index of the pick on the clock. */
  currentPick: number;
  totalPicks: number;
  onClock: OnClock | null;
  /** ISO deadline for the pick on the clock (null unless live). */
  deadline: string | null;
  /** Remaining ms on the clock while paused. */
  pausedRemainingMs: number | null;
  /** Server time when this state was built, for clock-skew correction. */
  serverNow: string;
  scheduledAt: string | null;
  /** Teams in draft order (teams without a slot last, by join time). */
  teams: DraftTeamInfo[];
  /** True once every team has a draft slot. */
  orderSet: boolean;
  /** Picks ordered by overall. */
  picks: DraftPickInfo[];
  myTeamId: string | null;
  /** My queue (lawyer ids, best first). */
  myQueue: string[];
  isCommissioner: boolean;
  /** Number of lawyers in the league's pool; the room refetches the pool when this changes. */
  poolSize: number;
  /** Only included when requested (`?pool=1`) or on first render. */
  pool?: DraftLawyer[];
};

/** Response of the polling endpoint when nothing changed since `?since=`. */
export type DraftUnchangedJson = { unchanged: true; version: number; serverNow: string };
export type DraftPollJson = DraftStateJson | DraftUnchangedJson;

export function isUnchanged(r: DraftPollJson): r is DraftUnchangedJson {
  return (r as DraftUnchangedJson).unchanged === true;
}

// ---------------------------------------------------------------------------
// Server-side shaping (plain inputs -> JSON)
// ---------------------------------------------------------------------------

export type DraftStateSource = {
  leagueId: string;
  leagueStatus: LeagueStatus;
  status: DraftStatus;
  version: number;
  rounds: number;
  secondsPerPick: number;
  currentPick: number;
  pickDeadline: Date | null;
  pausedRemainingMs: number | null;
  scheduledAt: string | null;
  teams: DraftTeamInfo[];
  picks: DraftPickInfo[];
  queue: string[];
  poolSize: number;
  lawyers?: DraftLawyer[];
};

export function shapeDraftState(
  src: DraftStateSource,
  viewer: { myTeamId: string | null; isCommissioner: boolean; now: Date; includePool: boolean },
): DraftStateJson {
  const totalPicks = src.rounds * src.teams.length;
  const live = src.status === "in_progress" || src.status === "paused";
  return {
    leagueId: src.leagueId,
    leagueStatus: src.leagueStatus,
    status: src.status,
    version: src.version,
    rounds: src.rounds,
    secondsPerPick: src.secondsPerPick,
    currentPick: src.currentPick,
    totalPicks,
    onClock: live ? onClockFor(src.currentPick, src.teams, src.rounds) : null,
    deadline: src.status === "in_progress" && src.pickDeadline ? src.pickDeadline.toISOString() : null,
    pausedRemainingMs: src.status === "paused" ? src.pausedRemainingMs : null,
    serverNow: viewer.now.toISOString(),
    scheduledAt: src.scheduledAt,
    teams: src.teams,
    orderSet: src.teams.length > 0 && src.teams.every((t) => t.draftPosition !== null),
    picks: src.picks,
    myTeamId: viewer.myTeamId,
    myQueue: src.queue,
    isCommissioner: viewer.isCommissioner,
    poolSize: src.poolSize,
    ...(viewer.includePool && src.lawyers ? { pool: src.lawyers } : {}),
  };
}

// ---------------------------------------------------------------------------
// Order & clock math
// ---------------------------------------------------------------------------

/**
 * Teams sorted for display/drafting: by draft slot, then teams without a slot
 * in the order they were given (join order).
 */
export function sortByDraftPosition<T extends { draftPosition: number | null }>(teams: T[]): T[] {
  return teams
    .map((t, i) => ({ t, i }))
    .sort((a, b) => {
      const pa = a.t.draftPosition ?? Number.MAX_SAFE_INTEGER;
      const pb = b.t.draftPosition ?? Number.MAX_SAFE_INTEGER;
      return pa - pb || a.i - b.i;
    })
    .map((x) => x.t);
}

/**
 * Final draft order when the draft starts: teams that already have a slot
 * keep their relative order; teams without one are shuffled in after them.
 * If nobody has a slot, the whole order is random.
 */
export function finalDraftOrder<T extends { id: string; draftPosition: number | null }>(
  teams: T[],
  shuffle: <U>(items: U[]) => U[],
): string[] {
  const placed = sortByDraftPosition(teams.filter((t) => t.draftPosition !== null));
  const unplaced = teams.filter((t) => t.draftPosition === null);
  return [...placed, ...shuffle(unplaced)].map((t) => t.id);
}

/** Move one id up (-1) or down (+1) in an ordered list. Returns a new array (unchanged if at the edge). */
export function moveInList<T>(items: T[], index: number, delta: -1 | 1): T[] {
  const j = index + delta;
  if (index < 0 || index >= items.length || j < 0 || j >= items.length) return [...items];
  const out = [...items];
  [out[index], out[j]] = [out[j], out[index]];
  return out;
}

/** The team on the clock for a 0-based overall pick, given teams in draft order. */
export function onClockFor(currentPick: number, teamsInOrder: { id: string }[], rounds: number): OnClock | null {
  const n = teamsInOrder.length;
  if (n === 0 || currentPick < 0 || currentPick >= rounds * n) return null;
  const slot = snakeSlot(currentPick, n);
  const team = teamsInOrder[slot.draftPosition - 1];
  if (!team) return null;
  return { overall: currentPick, round: slot.round, pickInRound: slot.pickInRound, teamId: team.id };
}

/** 0-based overall pick for a team's slot in a round (inverse of snakeSlot). */
export function overallFor(round: number, draftPosition: number, teamCount: number): number {
  const idx = round % 2 === 1 ? draftPosition - 1 : teamCount - draftPosition;
  return (round - 1) * teamCount + idx;
}

/**
 * Deadline for the next pick after an auto-pick that happened because
 * `expiredDeadlineMs` passed. Deadlines are chained from the expired one, so
 * the draft plays out the same no matter how often clients poll (if nobody
 * was watching, every pick whose turn ran out is auto-picked on the next
 * poll). A team that lands on the clock with almost no time left gets at
 * least MIN_FRESH_CLOCK_SECONDS.
 */
export function nextAutoPickDeadline(expiredDeadlineMs: number, nowMs: number, secondsPerPick: number): number {
  const chained = expiredDeadlineMs + secondsPerPick * 1000;
  if (chained <= nowMs) return chained; // also overdue: keep catching up
  return Math.max(chained, nowMs + Math.min(secondsPerPick, MIN_FRESH_CLOCK_SECONDS) * 1000);
}

/** Clock to give the team on the clock when a paused draft resumes. */
export function resumeClockMs(pausedRemainingMs: number | null, secondsPerPick: number): number {
  const full = secondsPerPick * 1000;
  const remaining = pausedRemainingMs ?? full;
  return Math.min(full, Math.max(remaining, Math.min(full, MIN_RESUME_SECONDS * 1000)));
}

/** Number of picks before my next turn (0 = I'm on the clock), or null if I have no picks left. */
export function picksUntilMyTurn(
  currentPick: number,
  myDraftPosition: number | null,
  teamCount: number,
  totalPicks: number,
): number | null {
  if (!myDraftPosition || teamCount === 0) return null;
  for (let p = Math.max(0, currentPick); p < totalPicks; p++) {
    if (snakeSlot(p, teamCount).draftPosition === myDraftPosition) return p - currentPick;
  }
  return null;
}

/** Milliseconds left on the clock, corrected for client/server clock skew. */
export function remainingMs(deadlineIso: string | null, clientNowMs: number, skewMs: number): number | null {
  if (!deadlineIso) return null;
  return Math.max(0, Date.parse(deadlineIso) - (clientNowMs + skewMs));
}

/** Polling health. "signed_out" and "removed" are terminal: polling stops. */
export type PollConnection = "ok" | "retrying" | "signed_out" | "removed";

/**
 * How a poll response's HTTP status affects the connection. 401 (signed out)
 * and 403/404 (not a member any more, or the league is gone) won't fix
 * themselves, so they stop polling; anything else non-2xx is retried.
 */
export function connectionForStatus(status: number): PollConnection {
  if (status === 401) return "signed_out";
  if (status === 403 || status === 404) return "removed";
  return status >= 200 && status < 300 ? "ok" : "retrying";
}

export function isTerminalConnection(c: PollConnection): boolean {
  return c === "signed_out" || c === "removed";
}

/** Where the season stands once the draft is done (computed by the page). */
export type AfterDraftInfo = {
  phase: "preseason" | "in_season" | "playoffs" | "complete";
  /** Next lineup lock, formatted in the league time zone (null when there is none). */
  nextLock: string | null;
};

/** Heading and text for the "draft is done" card, by where the season stands. */
export function afterDraftCopy(info: AfterDraftInfo): { title: string; body: string } {
  const lock = info.nextLock ? ` (${info.nextLock})` : "";
  switch (info.phase) {
    case "preseason":
      return {
        title: "The draft is done!",
        body: `The season is set up. Check your roster and set your starting lineup before the first lineup lock${lock}.`,
      };
    case "in_season":
      return {
        title: "The draft is done",
        body: info.nextLock
          ? `The season is under way. Check your roster and set your lineup before the next lineup lock${lock}.`
          : "The season is under way. Check your roster and follow your matchups.",
      };
    case "playoffs":
      return {
        title: "Draft results",
        body: "The regular season is over and the playoffs are on. Follow the bracket on the standings page.",
      };
    case "complete":
      return { title: "Draft results", body: "The season is over. Here's how the draft went." };
  }
}

/** "1:05", "0:09". Rounds up so the clock shows 0:00 only when time is up. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Lawyer lists, board, my team
// ---------------------------------------------------------------------------

export function compareByRank(a: DraftLawyer, b: DraftLawyer): number {
  const ra = a.rank ?? Number.MAX_SAFE_INTEGER;
  const rb = b.rank ?? Number.MAX_SAFE_INTEGER;
  return ra - rb || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

/** Available lawyers matching a search and position filter, best rank first. */
export function filterAvailable(
  pool: DraftLawyer[],
  picked: ReadonlySet<string>,
  opts: { query?: string; position?: Position | "all" },
): DraftLawyer[] {
  const q = (opts.query ?? "").trim().toLowerCase();
  const pos = opts.position ?? "all";
  return pool
    .filter((l) => !picked.has(l.id))
    .filter((l) => pos === "all" || l.position === pos)
    .filter((l) => !q || l.name.toLowerCase().includes(q) || (l.organization ?? "").toLowerCase().includes(q))
    .sort(compareByRank);
}

/** Board grid: rows = rounds, columns = teams in draft order. */
export function buildBoard(
  teamsInOrder: { id: string }[],
  picks: DraftPickInfo[],
  rounds: number,
): (DraftPickInfo | null)[][] {
  const col = new Map(teamsInOrder.map((t, i) => [t.id, i]));
  const grid: (DraftPickInfo | null)[][] = Array.from({ length: rounds }, () => teamsInOrder.map(() => null));
  for (const p of picks) {
    const c = col.get(p.teamId);
    if (c === undefined || p.round < 1 || p.round > rounds) continue;
    grid[p.round - 1][c] = p;
  }
  return grid;
}

/** A team's drafted lawyers grouped by position (positions in standard order, empty groups omitted). */
export function groupByPosition(lawyers: DraftLawyer[]): { position: Position; lawyers: DraftLawyer[] }[] {
  return POSITIONS.map((position) => ({
    position,
    lawyers: lawyers.filter((l) => l.position === position),
  })).filter((g) => g.lawyers.length > 0);
}

/** Starter slots a team still needs to fill, given the lawyers it has drafted. */
export function openSlotsFor(lawyers: DraftLawyer[], roster: RosterSettings): SlotType[] {
  return openStarterSlots(
    lawyers.map((l) => l.position),
    roster,
  );
}
