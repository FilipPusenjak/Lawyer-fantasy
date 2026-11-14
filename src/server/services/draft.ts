/**
 * Live snake draft.
 *
 * Every draft mutation runs in a transaction that first locks the league's
 * `drafts` row (SELECT … FOR UPDATE), so concurrent polls/actions are
 * serialized. The pick clock is lazy: `advanceClock` (called by every poll and
 * before every pick) auto-picks for each pick whose deadline has passed.
 *
 * No `server-only` / cookies here so scripts can use it.
 */
import { randomInt } from "node:crypto";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "@/db";
import {
  draftPicks,
  draftQueue,
  drafts,
  lawyers,
  leagues,
  rosterSpots,
  teams,
  transactions,
  users,
  type Draft,
} from "@/db/schema";
import { chooseAutoPick, snakeSlot } from "@/lib/draft";
import { parseLeagueSettings, rosterSize, type LeagueSettings, type Position } from "@/lib/settings";
import { UserError } from "@/server/action-result";
import {
  MAX_CATCHUP_PICKS,
  MAX_QUEUE,
  PICK_GRACE_MS,
  compareByRank,
  finalDraftOrder,
  moveInList,
  nextAutoPickDeadline,
  onClockFor,
  resumeClockMs,
  sortByDraftPosition,
  type DraftLawyer,
  type DraftPickInfo,
  type DraftStateSource,
  type DraftTeamInfo,
  type LeagueStatus,
  type OnClock,
} from "@/components/draft/model";
import { addLawyerToTeam, removeLawyerFromTeam } from "./roster";
import { startSeason } from "./season";

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

type LeagueInfo = {
  id: string;
  poolId: string;
  status: LeagueStatus;
  seasonStart: string;
  settings: LeagueSettings;
};

type DraftCtx = {
  league: LeagueInfo;
  /** Teams in draft order. */
  teams: DraftTeamInfo[];
};

async function loadLeagueInfo(db: DbOrTx, leagueId: string, opts: { lock?: boolean } = {}): Promise<LeagueInfo> {
  const q = db
    .select({
      id: leagues.id,
      poolId: leagues.poolId,
      status: leagues.status,
      seasonStart: leagues.seasonStart,
      settings: leagues.settings,
    })
    .from(leagues)
    .where(eq(leagues.id, leagueId));
  // NO KEY UPDATE still lets other transactions insert rows that reference the
  // league (FK checks take KEY SHARE), but conflicts with joins and settings
  // edits, which lock the league row FOR UPDATE.
  const [l] = opts.lock ? await q.for("no key update") : await q;
  if (!l) throw new UserError("League not found.");
  return { ...l, settings: parseLeagueSettings(l.settings) };
}

/** A league's teams in draft order (teams without a slot last, by join time). */
export async function loadDraftTeams(db: DbOrTx, leagueId: string): Promise<DraftTeamInfo[]> {
  const rows = await db
    .select({
      id: teams.id,
      name: teams.name,
      ownerName: users.displayName,
      draftPosition: teams.draftPosition,
    })
    .from(teams)
    .innerJoin(users, eq(users.id, teams.ownerId))
    .where(eq(teams.leagueId, leagueId))
    .orderBy(asc(teams.createdAt), asc(teams.id));
  return sortByDraftPosition(rows);
}

/** Every lawyer/firm in a pool, for the draft room. */
export async function loadPoolLawyers(db: DbOrTx, poolId: string): Promise<DraftLawyer[]> {
  return db
    .select({
      id: lawyers.id,
      name: lawyers.name,
      kind: lawyers.kind,
      position: lawyers.position,
      organization: lawyers.organization,
      rank: lawyers.preseasonRank,
    })
    .from(lawyers)
    .where(eq(lawyers.poolId, poolId))
    .orderBy(asc(lawyers.name));
}

async function loadPicks(db: DbOrTx, leagueId: string): Promise<DraftPickInfo[]> {
  return db
    .select({
      overall: draftPicks.overall,
      round: draftPicks.round,
      pickInRound: draftPicks.pickInRound,
      teamId: draftPicks.teamId,
      lawyerId: draftPicks.lawyerId,
      isAuto: draftPicks.isAuto,
    })
    .from(draftPicks)
    .where(eq(draftPicks.leagueId, leagueId))
    .orderBy(asc(draftPicks.overall));
}

/** Lawyers on any roster in the league (normally exactly the drafted ones). */
async function loadRosteredIds(db: DbOrTx, leagueId: string): Promise<Set<string>> {
  const rows = await db.select({ lawyerId: rosterSpots.lawyerId }).from(rosterSpots).where(eq(rosterSpots.leagueId, leagueId));
  return new Set(rows.map((r) => r.lawyerId));
}

/** A team's queue (lawyer ids, best first). */
export async function getQueue(db: DbOrTx, teamId: string): Promise<string[]> {
  const rows = await db
    .select({ lawyerId: draftQueue.lawyerId })
    .from(draftQueue)
    .where(eq(draftQueue.teamId, teamId))
    .orderBy(asc(draftQueue.rank));
  return rows.map((r) => r.lawyerId);
}

function defaultDraftRow(leagueId: string, settings: LeagueSettings): Draft {
  return {
    leagueId,
    status: "not_started",
    secondsPerPick: settings.draft.secondsPerPick,
    rounds: rosterSize(settings.roster),
    currentPick: 0,
    pickDeadline: null,
    pausedRemainingMs: null,
    startedAt: null,
    completedAt: null,
    version: 0,
  };
}

export type DraftState = DraftStateSource & {
  poolId: string;
  settings: LeagueSettings;
  startedAt: Date | null;
  completedAt: Date | null;
  totalPicks: number;
  onClock: OnClock | null;
  /** Lawyers not yet drafted, best rank first (only with includeLawyers). */
  available?: DraftLawyer[];
};

/**
 * Current draft state. Pass `teamId` to include that team's queue and
 * `includeLawyers` for the whole pool plus the available list.
 */
export async function getDraftState(
  db: DbOrTx,
  leagueId: string,
  opts: { teamId?: string | null; includeLawyers?: boolean } = {},
): Promise<DraftState> {
  const league = await loadLeagueInfo(db, leagueId);
  const [row] = await db.select().from(drafts).where(eq(drafts.leagueId, leagueId));
  const draft = row ?? defaultDraftRow(leagueId, league.settings);
  const [teamRows, picks, queue, lawyerRows, poolCount, rostered] = await Promise.all([
    loadDraftTeams(db, leagueId),
    loadPicks(db, leagueId),
    opts.teamId ? getQueue(db, opts.teamId) : Promise.resolve([] as string[]),
    opts.includeLawyers ? loadPoolLawyers(db, league.poolId) : Promise.resolve(undefined),
    opts.includeLawyers
      ? Promise.resolve(null)
      : db.select({ n: count() }).from(lawyers).where(eq(lawyers.poolId, league.poolId)),
    opts.includeLawyers ? loadRosteredIds(db, leagueId) : Promise.resolve(new Set<string>()),
  ]);
  // Before the draft starts, show what the current settings would produce.
  const notStarted = draft.status === "not_started";
  const rounds = notStarted ? rosterSize(league.settings.roster) : draft.rounds;
  const secondsPerPick = notStarted ? league.settings.draft.secondsPerPick : draft.secondsPerPick;
  const live = draft.status === "in_progress" || draft.status === "paused";
  let available: DraftLawyer[] | undefined;
  if (lawyerRows) {
    const picked = new Set([...picks.map((p) => p.lawyerId), ...rostered]);
    available = lawyerRows.filter((l) => !picked.has(l.id)).sort(compareByRank);
  }
  return {
    leagueId,
    leagueStatus: league.status,
    poolId: league.poolId,
    settings: league.settings,
    status: draft.status,
    version: draft.version,
    rounds,
    secondsPerPick,
    currentPick: draft.currentPick,
    pickDeadline: draft.status === "in_progress" ? draft.pickDeadline : null,
    pausedRemainingMs: draft.pausedRemainingMs,
    scheduledAt: league.settings.draft.scheduledAt,
    startedAt: draft.startedAt,
    completedAt: draft.completedAt,
    teams: teamRows,
    picks,
    queue,
    poolSize: lawyerRows ? lawyerRows.length : (poolCount?.[0]?.n ?? 0),
    lawyers: lawyerRows,
    available,
    totalPicks: rounds * teamRows.length,
    onClock: live ? onClockFor(draft.currentPick, teamRows, rounds) : null,
  };
}

/** Cheap read of the draft row's version/status (for the polling endpoint). */
export async function peekDraft(
  db: DbOrTx,
  leagueId: string,
): Promise<Pick<Draft, "status" | "version" | "pickDeadline"> | null> {
  const [d] = await db
    .select({ status: drafts.status, version: drafts.version, pickDeadline: drafts.pickDeadline })
    .from(drafts)
    .where(eq(drafts.leagueId, leagueId));
  return d ?? null;
}

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

async function lockDraftRow(tx: DbOrTx, leagueId: string, settings: LeagueSettings | (() => Promise<LeagueSettings>)): Promise<Draft> {
  const [d] = await tx.select().from(drafts).where(eq(drafts.leagueId, leagueId)).for("update");
  if (d) return d;
  // Leagues created outside createLeague may not have a draft row yet.
  const s = typeof settings === "function" ? await settings() : settings;
  await tx.insert(drafts).values(defaultDraftRow(leagueId, s)).onConflictDoNothing();
  const [created] = await tx.select().from(drafts).where(eq(drafts.leagueId, leagueId)).for("update");
  return created;
}

/**
 * Run `fn` in a transaction holding the league's draft row lock, then the
 * league row lock (same order as the settings service). The league and its
 * teams are read only after both locks are held, so a settings edit or a join
 * that committed while we waited is never missed (e.g. a team joining while
 * the draft starts).
 */
async function withLockedDraft<T>(
  db: DbOrTx,
  leagueId: string,
  fn: (tx: DbOrTx, draft: Draft, ctx: DraftCtx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const draft = await lockDraftRow(tx, leagueId, async () => (await loadLeagueInfo(tx, leagueId)).settings);
    const league = await loadLeagueInfo(tx, leagueId, { lock: true });
    const teamRows = await loadDraftTeams(tx, leagueId);
    return fn(tx, draft, { league, teams: teamRows });
  });
}

const bump = { version: sql`${drafts.version} + 1` };

async function updateDraft(tx: DbOrTx, leagueId: string, values: Partial<Draft>): Promise<Draft> {
  const [d] = await tx
    .update(drafts)
    .set({ ...values, ...bump })
    .where(eq(drafts.leagueId, leagueId))
    .returning();
  return d;
}

// ---------------------------------------------------------------------------
// Picks
// ---------------------------------------------------------------------------

type PickArgs = {
  teamId: string;
  lawyerId: string;
  userId: string | null;
  isAuto: boolean;
  now: Date;
  /** When the pick happened (auto-picks use the expired deadline). Defaults to now. */
  madeAt?: Date;
  /** Deadline for the next pick. Defaults to now + secondsPerPick. */
  nextDeadline?: Date;
  /** Commissioners may pick while the draft is paused. */
  allowPaused?: boolean;
  /** Already-validated lawyer (auto-picks), skipping the pool/taken checks. */
  lawyer?: { id: string; name: string };
};

export type PickResult = {
  draft: Draft;
  pick: DraftPickInfo;
  lawyerName: string;
  teamName: string;
  completed: boolean;
};

/** Make the pick on the clock. Caller holds the draft row lock. */
async function makePickLocked(tx: DbOrTx, d: Draft, ctx: DraftCtx, args: PickArgs): Promise<PickResult> {
  const leagueId = ctx.league.id;
  if (d.status !== "in_progress" && !(args.allowPaused && d.status === "paused")) {
    if (d.status === "paused") throw new UserError("The draft is paused.");
    if (d.status === "complete") throw new UserError("The draft is over.");
    throw new UserError("The draft hasn't started yet.");
  }
  const n = ctx.teams.length;
  const total = d.rounds * n;
  if (d.currentPick >= total) throw new UserError("The draft is over.");
  const slot = snakeSlot(d.currentPick, n);
  const team = ctx.teams[slot.draftPosition - 1];
  if (!team || team.id !== args.teamId) throw new UserError("It's not your turn.");

  let lawyer = args.lawyer;
  if (!lawyer) {
    const [l] = await tx
      .select({ id: lawyers.id, name: lawyers.name })
      .from(lawyers)
      .where(and(eq(lawyers.id, args.lawyerId), eq(lawyers.poolId, ctx.league.poolId)));
    if (!l) throw new UserError("That lawyer isn't in this league's pool.");
    const [taken] = await tx
      .select({ overall: draftPicks.overall })
      .from(draftPicks)
      .where(and(eq(draftPicks.leagueId, leagueId), eq(draftPicks.lawyerId, args.lawyerId)));
    if (taken) throw new UserError(`${l.name} was already drafted.`);
    lawyer = l;
  }

  const madeAt = args.madeAt ?? args.now;
  const pick: DraftPickInfo = {
    overall: d.currentPick,
    round: slot.round,
    pickInRound: slot.pickInRound,
    teamId: team.id,
    lawyerId: lawyer.id,
    isAuto: args.isAuto,
  };
  await tx.insert(draftPicks).values({ leagueId, ...pick, madeBy: args.userId, madeAt });
  await addLawyerToTeam(tx, {
    leagueId,
    settings: ctx.league.settings,
    teamId: team.id,
    lawyerId: lawyer.id,
    via: "draft",
    skipSizeCheck: true,
  });
  // Nobody can draft this lawyer any more, so drop them from every queue.
  await tx.delete(draftQueue).where(
    and(
      eq(draftQueue.lawyerId, lawyer.id),
      inArray(
        draftQueue.teamId,
        ctx.teams.map((t) => t.id),
      ),
    ),
  );
  // Same as logTransaction(), but stamped with the pick time so a batch of
  // catch-up auto-picks keeps its order in the activity log.
  await tx.insert(transactions).values({
    leagueId,
    teamId: team.id,
    type: "draft",
    lawyerId: lawyer.id,
    description: `${args.isAuto ? "Auto-drafted" : "Drafted"} ${lawyer.name} (round ${slot.round}, pick ${slot.pickInRound})`,
    createdAt: madeAt,
  });

  const next = d.currentPick + 1;
  if (next >= total) {
    const done = await updateDraft(tx, leagueId, {
      currentPick: next,
      status: "complete",
      completedAt: args.now,
      pickDeadline: null,
      pausedRemainingMs: null,
    });
    await tx.delete(draftQueue).where(
      inArray(
        draftQueue.teamId,
        ctx.teams.map((t) => t.id),
      ),
    );
    await startSeason(tx, leagueId, args.now);
    return { draft: done, pick, lawyerName: lawyer.name, teamName: team.name, completed: true };
  }
  const full = d.secondsPerPick * 1000;
  const paused = d.status === "paused";
  const updated = await updateDraft(tx, leagueId, {
    currentPick: next,
    pickDeadline: paused ? null : (args.nextDeadline ?? new Date(args.now.getTime() + full)),
    pausedRemainingMs: paused ? full : null,
  });
  return { draft: updated, pick, lawyerName: lawyer.name, teamName: team.name, completed: false };
}

/**
 * Auto-pick for every pick whose deadline is at or before `now` (up to
 * MAX_CATCHUP_PICKS per call). Caller holds the draft row lock.
 */
async function runOverdueLocked(tx: DbOrTx, d: Draft, ctx: DraftCtx, now: Date): Promise<{ draft: Draft; picks: number }> {
  const overdue = (x: Draft) => x.status === "in_progress" && !!x.pickDeadline && x.pickDeadline.getTime() <= now.getTime();
  if (!overdue(d)) return { draft: d, picks: 0 };

  const pool = await loadPoolLawyers(tx, ctx.league.poolId);
  const byId = new Map(pool.map((l) => [l.id, l]));
  const existing = await loadPicks(tx, ctx.league.id);
  // Anyone already on a roster can't be drafted (addLawyerToTeam would fail
  // and leave the clock stuck), even if they got there outside the draft.
  const picked = new Set([...existing.map((p) => p.lawyerId), ...(await loadRosteredIds(tx, ctx.league.id))]);
  const positionsByTeam = new Map<string, Position[]>();
  for (const p of existing) {
    const l = byId.get(p.lawyerId);
    if (!l) continue;
    const arr = positionsByTeam.get(p.teamId) ?? [];
    arr.push(l.position);
    positionsByTeam.set(p.teamId, arr);
  }

  let draft = d;
  let made = 0;
  while (overdue(draft) && made < MAX_CATCHUP_PICKS) {
    const clock = onClockFor(draft.currentPick, ctx.teams, draft.rounds);
    if (!clock) break;
    const queue = await getQueue(tx, clock.teamId);
    const choice = chooseAutoPick({
      available: pool
        .filter((l) => !picked.has(l.id))
        .map((l) => ({ id: l.id, name: l.name, position: l.position, preseasonRank: l.rank })),
      queue,
      draftedPositions: positionsByTeam.get(clock.teamId) ?? [],
      roster: ctx.league.settings.roster,
    });
    if (!choice) {
      // The pool ran dry (lawyers were removed mid-draft): stop the clock.
      draft = await updateDraft(tx, ctx.league.id, {
        status: "paused",
        pickDeadline: null,
        pausedRemainingMs: draft.secondsPerPick * 1000,
      });
      break;
    }
    const expired = draft.pickDeadline!;
    const result = await makePickLocked(tx, draft, ctx, {
      teamId: clock.teamId,
      lawyerId: choice.id,
      userId: null,
      isAuto: true,
      now,
      madeAt: expired,
      nextDeadline: new Date(nextAutoPickDeadline(expired.getTime(), now.getTime(), draft.secondsPerPick)),
      lawyer: choice,
    });
    draft = result.draft;
    picked.add(choice.id);
    const arr = positionsByTeam.get(clock.teamId) ?? [];
    arr.push(choice.position);
    positionsByTeam.set(clock.teamId, arr);
    made++;
  }
  return { draft, picks: made };
}

/**
 * Lazily run the pick clock: auto-pick for every pick whose deadline has
 * passed. Cheap when nothing is due; safe under concurrent polling (the row
 * lock serializes callers and each re-checks the deadline). Returns the
 * number of auto-picks made.
 */
export async function advanceClock(db: DbOrTx, leagueId: string, now: Date = new Date()): Promise<number> {
  const peek = await peekDraft(db, leagueId);
  if (!peek || peek.status !== "in_progress" || !peek.pickDeadline || peek.pickDeadline.getTime() > now.getTime()) return 0;
  return withLockedDraft(db, leagueId, async (tx, d, ctx) => (await runOverdueLocked(tx, d, ctx, now)).picks);
}

/**
 * A team makes the pick on the clock. Overdue picks are auto-made first
 * (with a short grace period so a pick sent right at the buzzer counts).
 */
export async function makePick(
  db: DbOrTx,
  leagueId: string,
  teamId: string,
  lawyerId: string,
  userId: string | null,
  isAuto = false,
  now: Date = new Date(),
): Promise<PickResult> {
  return withLockedDraft(db, leagueId, async (tx, d, ctx) => {
    const { draft } = await runOverdueLocked(tx, d, ctx, new Date(now.getTime() - PICK_GRACE_MS));
    return makePickLocked(tx, draft, ctx, { teamId, lawyerId, userId, isAuto, now });
  });
}

/**
 * Commissioner makes the pick for the team on the clock. `expectedOverall`
 * guards against the clock moving between seeing the board and tapping.
 * Works while paused (the draft stays paused).
 */
export async function commissionerPick(
  db: DbOrTx,
  leagueId: string,
  lawyerId: string,
  userId: string,
  expectedOverall: number,
  now: Date = new Date(),
): Promise<PickResult> {
  return withLockedDraft(db, leagueId, async (tx, d, ctx) => {
    if (d.status !== "in_progress" && d.status !== "paused") throw new UserError("The draft isn't running.");
    if (d.currentPick !== expectedOverall) throw new UserError("The clock moved on. Check who's up and try again.");
    const clock = onClockFor(d.currentPick, ctx.teams, d.rounds);
    if (!clock) throw new UserError("The draft is over.");
    return makePickLocked(tx, d, ctx, {
      teamId: clock.teamId,
      lawyerId,
      userId,
      isAuto: false,
      now,
      allowPaused: true,
    });
  });
}

// ---------------------------------------------------------------------------
// Commissioner controls
// ---------------------------------------------------------------------------

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

async function writeOrder(tx: DbOrTx, leagueId: string, teamIds: string[]): Promise<void> {
  for (let i = 0; i < teamIds.length; i++) {
    await tx
      .update(teams)
      .set({ draftPosition: i + 1 })
      .where(and(eq(teams.id, teamIds[i]), eq(teams.leagueId, leagueId)));
  }
}

function assertOrderEditable(d: Draft, ctx: DraftCtx): void {
  if (ctx.league.status !== "setup" || d.status !== "not_started") {
    throw new UserError("The draft order is locked once the draft starts.");
  }
}

/** Start the draft (commissioner). */
export async function startDraft(db: DbOrTx, leagueId: string, now: Date = new Date()): Promise<Draft> {
  return withLockedDraft(db, leagueId, async (tx, d, ctx) => {
    if (ctx.league.status !== "setup" || d.status !== "not_started") throw new UserError("The draft has already started.");
    const n = ctx.teams.length;
    if (n < 2) throw new UserError("You need at least 2 teams to start the draft.");
    const settings = ctx.league.settings;
    const rounds = rosterSize(settings.roster);
    if (rounds < 1) throw new UserError("Set up roster spots before drafting.");
    const [{ n: poolCount }] = await tx.select({ n: count() }).from(lawyers).where(eq(lawyers.poolId, ctx.league.poolId));
    if (poolCount < rounds * n) {
      throw new UserError(`The lawyer pool needs at least ${rounds * n} lawyers for this draft (it has ${poolCount}).`);
    }
    // Leftovers from an earlier attempt would collide with the new picks.
    await tx.delete(draftPicks).where(eq(draftPicks.leagueId, leagueId));
    await writeOrder(tx, leagueId, finalDraftOrder(ctx.teams, shuffle));
    const secondsPerPick = settings.draft.secondsPerPick;
    const started = await updateDraft(tx, leagueId, {
      status: "in_progress",
      rounds,
      secondsPerPick,
      currentPick: 0,
      pickDeadline: new Date(now.getTime() + secondsPerPick * 1000),
      pausedRemainingMs: null,
      startedAt: now,
      completedAt: null,
    });
    await tx.update(leagues).set({ status: "drafting" }).where(eq(leagues.id, leagueId));
    return started;
  });
}

/** Set the draft order (commissioner, before the draft): ordered team ids → slots 1..n. */
export async function setDraftOrder(db: DbOrTx, leagueId: string, teamIds: string[]): Promise<void> {
  await withLockedDraft(db, leagueId, async (tx, d, ctx) => {
    assertOrderEditable(d, ctx);
    const ids = new Set(ctx.teams.map((t) => t.id));
    if (teamIds.length !== ids.size || new Set(teamIds).size !== ids.size || !teamIds.every((id) => ids.has(id))) {
      throw new UserError("The team list changed. Refresh and try again.");
    }
    await writeOrder(tx, leagueId, teamIds);
    await updateDraft(tx, leagueId, {});
  });
}

/** Move one team up or down in the draft order (commissioner, before the draft). */
export async function moveTeamInDraftOrder(db: DbOrTx, leagueId: string, teamId: string, delta: -1 | 1): Promise<void> {
  await withLockedDraft(db, leagueId, async (tx, d, ctx) => {
    assertOrderEditable(d, ctx);
    const order = ctx.teams.map((t) => t.id);
    const idx = order.indexOf(teamId);
    if (idx < 0) throw new UserError("That team isn't in this league.");
    await writeOrder(tx, leagueId, moveInList(order, idx, delta));
    await updateDraft(tx, leagueId, {});
  });
}

/** Shuffle the draft order (commissioner, before the draft). */
export async function randomizeDraftOrder(db: DbOrTx, leagueId: string): Promise<void> {
  await withLockedDraft(db, leagueId, async (tx, d, ctx) => {
    assertOrderEditable(d, ctx);
    await writeOrder(
      tx,
      leagueId,
      shuffle(ctx.teams.map((t) => t.id)),
    );
    await updateDraft(tx, leagueId, {});
  });
}

/** Pause the clock (commissioner). Overdue picks are made first. */
export async function pauseDraft(db: DbOrTx, leagueId: string, now: Date = new Date()): Promise<Draft> {
  return withLockedDraft(db, leagueId, async (tx, d0, ctx) => {
    const { draft: d } = await runOverdueLocked(tx, d0, ctx, now);
    if (d.status === "paused") throw new UserError("The draft is already paused.");
    if (d.status !== "in_progress") throw new UserError("The draft isn't running.");
    const remaining = d.pickDeadline ? Math.max(0, d.pickDeadline.getTime() - now.getTime()) : d.secondsPerPick * 1000;
    return updateDraft(tx, leagueId, { status: "paused", pickDeadline: null, pausedRemainingMs: remaining });
  });
}

/** Resume a paused draft (commissioner). */
export async function resumeDraft(db: DbOrTx, leagueId: string, now: Date = new Date()): Promise<Draft> {
  return withLockedDraft(db, leagueId, async (tx, d) => {
    if (d.status !== "paused") throw new UserError("The draft isn't paused.");
    const ms = resumeClockMs(d.pausedRemainingMs, d.secondsPerPick);
    return updateDraft(tx, leagueId, {
      status: "in_progress",
      pickDeadline: new Date(now.getTime() + ms),
      pausedRemainingMs: null,
    });
  });
}

/**
 * Undo the most recent pick (commissioner): removes the pick, the roster spot
 * and its activity entry, and puts that team back on a fresh clock.
 * `expectedOverall` (the pick the commissioner saw) guards against undoing an
 * auto-pick that happened in the meantime.
 */
export async function undoLastPick(
  db: DbOrTx,
  leagueId: string,
  expectedOverall: number | null = null,
  now: Date = new Date(),
): Promise<{ lawyerName: string; teamName: string }> {
  return withLockedDraft(db, leagueId, async (tx, d, ctx) => {
    if (d.status === "complete") throw new UserError("The draft is over, so picks can't be undone.");
    if (d.status !== "in_progress" && d.status !== "paused") throw new UserError("The draft hasn't started yet.");
    if (d.currentPick === 0) throw new UserError("There are no picks to undo yet.");
    const lastOverall = d.currentPick - 1;
    if (expectedOverall !== null && expectedOverall !== lastOverall) {
      throw new UserError("Another pick just came in. Check the board and try again.");
    }
    const [last] = await tx
      .select({ id: draftPicks.id, teamId: draftPicks.teamId, lawyerId: draftPicks.lawyerId, name: lawyers.name })
      .from(draftPicks)
      .innerJoin(lawyers, eq(lawyers.id, draftPicks.lawyerId))
      .where(and(eq(draftPicks.leagueId, leagueId), eq(draftPicks.overall, lastOverall)));
    if (!last) throw new UserError("Couldn't find the last pick.");
    await tx.delete(draftPicks).where(eq(draftPicks.id, last.id));
    await removeLawyerFromTeam(tx, {
      league: { id: leagueId, seasonStart: ctx.league.seasonStart, settings: ctx.league.settings },
      teamId: last.teamId,
      lawyerId: last.lawyerId,
      toWaivers: false,
      now,
    });
    // Remove the pick's activity entry (the newest draft entry for this lawyer).
    const [entry] = await tx
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.leagueId, leagueId), eq(transactions.type, "draft"), eq(transactions.lawyerId, last.lawyerId)))
      .orderBy(desc(transactions.createdAt))
      .limit(1);
    if (entry) await tx.delete(transactions).where(eq(transactions.id, entry.id));
    const full = d.secondsPerPick * 1000;
    await updateDraft(tx, leagueId, {
      currentPick: lastOverall,
      pickDeadline: d.status === "in_progress" ? new Date(now.getTime() + full) : null,
      pausedRemainingMs: d.status === "paused" ? full : null,
    });
    const team = ctx.teams.find((t) => t.id === last.teamId);
    return { lawyerName: last.name, teamName: team?.name ?? "that team" };
  });
}

// ---------------------------------------------------------------------------
// Queue (a team's own wish list for auto-pick)
// ---------------------------------------------------------------------------

async function lockForQueue(tx: DbOrTx, leagueId: string): Promise<{ draft: Draft; league: LeagueInfo }> {
  const league = await loadLeagueInfo(tx, leagueId);
  // Lock the draft row first (same lock order as picks) to avoid deadlocks.
  const draft = await lockDraftRow(tx, leagueId, league.settings);
  if (draft.status === "complete") throw new UserError("The draft is over.");
  return { draft, league };
}

async function assertTeamInLeague(tx: DbOrTx, leagueId: string, teamId: string): Promise<void> {
  const [t] = await tx
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.id, teamId), eq(teams.leagueId, leagueId)));
  if (!t) throw new UserError("That team isn't in this league.");
}

async function writeQueue(tx: DbOrTx, teamId: string, lawyerIds: string[]): Promise<void> {
  await tx.delete(draftQueue).where(eq(draftQueue.teamId, teamId));
  if (lawyerIds.length > 0) {
    await tx.insert(draftQueue).values(lawyerIds.map((lawyerId, i) => ({ teamId, lawyerId, rank: i + 1 })));
  }
}

/** Add a lawyer to the end of a team's queue. */
export async function addToQueue(db: DbOrTx, leagueId: string, teamId: string, lawyerId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const { league } = await lockForQueue(tx, leagueId);
    await assertTeamInLeague(tx, leagueId, teamId);
    const [l] = await tx
      .select({ id: lawyers.id, name: lawyers.name })
      .from(lawyers)
      .where(and(eq(lawyers.id, lawyerId), eq(lawyers.poolId, league.poolId)));
    if (!l) throw new UserError("That lawyer isn't in this league's pool.");
    const [taken] = await tx
      .select({ overall: draftPicks.overall })
      .from(draftPicks)
      .where(and(eq(draftPicks.leagueId, leagueId), eq(draftPicks.lawyerId, lawyerId)));
    if (taken) throw new UserError(`${l.name} was already drafted.`);
    const queue = await getQueue(tx, teamId);
    if (queue.includes(lawyerId)) return;
    if (queue.length >= MAX_QUEUE) throw new UserError(`Your queue is full (${MAX_QUEUE} max).`);
    await writeQueue(tx, teamId, [...queue, lawyerId]);
    await updateDraft(tx, leagueId, {});
  });
}

/** Remove a lawyer from a team's queue. */
export async function removeFromQueue(db: DbOrTx, leagueId: string, teamId: string, lawyerId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await lockForQueue(tx, leagueId);
    await assertTeamInLeague(tx, leagueId, teamId);
    const queue = await getQueue(tx, teamId);
    if (!queue.includes(lawyerId)) return;
    await writeQueue(
      tx,
      teamId,
      queue.filter((id) => id !== lawyerId),
    );
    await updateDraft(tx, leagueId, {});
  });
}

/** Move a lawyer up/down one spot (or to the top) of a team's queue. */
export async function moveInQueue(
  db: DbOrTx,
  leagueId: string,
  teamId: string,
  lawyerId: string,
  direction: "up" | "down" | "top",
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockForQueue(tx, leagueId);
    await assertTeamInLeague(tx, leagueId, teamId);
    const queue = await getQueue(tx, teamId);
    const idx = queue.indexOf(lawyerId);
    if (idx < 0) throw new UserError("That lawyer isn't in your queue.");
    const next =
      direction === "top" ? [lawyerId, ...queue.filter((id) => id !== lawyerId)] : moveInList(queue, idx, direction === "up" ? -1 : 1);
    await writeQueue(tx, teamId, next);
    await updateDraft(tx, leagueId, {});
  });
}
