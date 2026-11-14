/**
 * Trades between two teams in a league.
 *
 * Lifecycle: proposed → accepted (commissioner review window,
 * settings.trades.reviewHours) → completed; or rejected / cancelled / vetoed /
 * failed. Rosters only change in `executeTrade`, which re-validates first.
 *
 * Every state change runs in a transaction that holds a per-league advisory
 * lock (all trade changes in a league are serialized) and then a row lock on
 * the trade, so concurrent clicks, page-view maintenance and the cron are safe.
 * Services do not check roles: callers (Server Actions) must verify that the
 * acting user owns the team they pass in, or is a commissioner for veto/approve.
 *
 * No `server-only` / cookies here, so the seed script can use these too.
 */
import { and, asc, desc, eq, inArray, isNotNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { DbOrTx } from "@/db";
import { lawyers, leagues, rosterSpots, teams, tradeItems, trades, users, type Trade } from "@/db/schema";
import { parseLeagueSettings, type LeagueSettings, type Position } from "@/lib/settings";
import { currentWeek } from "@/lib/time";
import { UserError } from "@/server/action-result";
import { leagueClock } from "./lineups";
import { addLawyerToTeam, logTransaction, maxRosterSize, removeLawyerFromTeam } from "./roster";

// ---------------------------------------------------------------------------
// Pure rules (unit tested in tests/unit/trades-rules.test.ts)
// ---------------------------------------------------------------------------

export type TradeStatus = Trade["status"];
export type LeagueStatus = "setup" | "drafting" | "in_season" | "playoffs" | "complete";

export const TRADE_MESSAGE_MAX = 280;
/** Trades still waiting on someone. */
export const OPEN_TRADE_STATUSES = ["proposed", "accepted"] as const satisfies readonly TradeStatus[];
/** Trades that are settled one way or another. */
export const CLOSED_TRADE_STATUSES = ["completed", "rejected", "cancelled", "vetoed", "failed"] as const satisfies readonly TradeStatus[];

export const TRADED_ELSEWHERE_REASON = "A lawyer in this trade was traded elsewhere.";

/** Why trades can't be proposed/accepted right now, or null when they can. */
export function tradeWindowError(args: { leagueStatus: LeagueStatus; deadlineWeek: number | null; currentWeek: number }): string | null {
  const { leagueStatus, deadlineWeek, currentWeek: week } = args;
  if (leagueStatus === "setup" || leagueStatus === "drafting") return "Trades open once the draft is done.";
  if (leagueStatus === "complete") return "The season is over, so trades are closed.";
  if (deadlineWeek !== null && week > deadlineWeek) return `The trade deadline (week ${deadlineWeek}) has passed.`;
  return null;
}

/** Trim a trade message; blank means no message. */
export function normalizeTradeMessage(raw: string | null | undefined): string | null {
  const s = (raw ?? "").replace(/\r\n/g, "\n").trim();
  return s.length > 0 ? s : null;
}

/** Basic shape checks for a proposal (no DB). Returns a user-facing error or null. */
export function validateTradeShape(args: {
  proposerTeamId: string;
  recipientTeamId: string;
  giveLawyerIds: string[];
  getLawyerIds: string[];
  message: string | null;
}): string | null {
  if (args.proposerTeamId === args.recipientTeamId) return "You can't trade with yourself.";
  if (args.giveLawyerIds.length + args.getLawyerIds.length === 0) return "Pick at least one lawyer to trade.";
  const all = [...args.giveLawyerIds, ...args.getLawyerIds];
  if (new Set(all).size !== all.length) return "Each lawyer can only be in the trade once.";
  if ((args.message ?? "").length > TRADE_MESSAGE_MAX) return `Keep your message to ${TRADE_MESSAGE_MAX} characters or less.`;
  return null;
}

/** Roster sizes after a swap: the proposer gives `giveCount` and gets `getCount`. */
export function rosterSizesAfterTrade(args: { proposerSize: number; recipientSize: number; giveCount: number; getCount: number }): {
  proposer: number;
  recipient: number;
} {
  return {
    proposer: args.proposerSize - args.giveCount + args.getCount,
    recipient: args.recipientSize - args.getCount + args.giveCount,
  };
}

type RosterSizeArgs = { proposerSize: number; recipientSize: number; giveCount: number; getCount: number; maxRoster: number };

/** Which roster (if any) would end up over the max size after the swap. */
export function rosterOverflow(args: RosterSizeArgs): { side: "proposer" | "recipient"; size: number } | null {
  const after = rosterSizesAfterTrade(args);
  if (after.proposer > args.maxRoster) return { side: "proposer", size: after.proposer };
  if (after.recipient > args.maxRoster) return { side: "recipient", size: after.recipient };
  return null;
}

/** Error when either roster would end up over the max size, else null. */
export function rosterSizeError(args: RosterSizeArgs & { proposerName: string; recipientName: string }): string | null {
  const over = rosterOverflow(args);
  if (!over) return null;
  const name = over.side === "proposer" ? args.proposerName : args.recipientName;
  return `${name} would have ${over.size} lawyers, over the ${args.maxRoster}-lawyer roster limit.`;
}

export type OwnershipItem = { lawyerId: string; lawyerName: string; fromTeamId: string; fromTeamName: string };

/** Every lawyer must still be on the team that is giving them up. */
export function ownershipError(items: OwnershipItem[], owners: Map<string, string>): string | null {
  for (const it of items) {
    if (owners.get(it.lawyerId) !== it.fromTeamId) return `${it.lawyerName} is no longer on ${it.fromTeamName}.`;
  }
  return null;
}

/** When the commissioner review window of a trade accepted at `respondedAt` ends. */
export function reviewEndsAtFor(respondedAt: Date, reviewHours: number): Date {
  return new Date(respondedAt.getTime() + reviewHours * 3_600_000);
}

type TradeParties = { status: TradeStatus; proposerTeamId: string; recipientTeamId: string; reviewEndsAt: Date | null };
export type TradeViewer = { teamId: string | null; isCommissioner: boolean };

/**
 * Offers are private between the two teams until accepted; once a trade has
 * been accepted (it has a review window) the whole league can see it.
 * Commissioners also play, so they get no peek at other teams' private offers
 * (they only review accepted trades, which are public).
 */
export function canViewTrade(trade: TradeParties, viewer: TradeViewer): boolean {
  if (viewer.teamId && (viewer.teamId === trade.proposerTeamId || viewer.teamId === trade.recipientTeamId)) return true;
  return trade.reviewEndsAt !== null;
}

export type TradeActions = { accept: boolean; reject: boolean; cancel: boolean; veto: boolean; approve: boolean };

/** Which buttons a viewer gets for a trade. The services enforce the same rules. */
export function allowedTradeActions(trade: TradeParties, viewer: TradeViewer): TradeActions {
  const isRecipient = !!viewer.teamId && viewer.teamId === trade.recipientTeamId;
  const isProposer = !!viewer.teamId && viewer.teamId === trade.proposerTeamId;
  return {
    accept: trade.status === "proposed" && isRecipient,
    reject: trade.status === "proposed" && isRecipient,
    cancel: (trade.status === "proposed" || trade.status === "accepted") && isProposer,
    veto: trade.status === "accepted" && viewer.isCommissioner,
    approve: trade.status === "accepted" && viewer.isCommissioner,
  };
}

/** "A", "A and B", "A, B and C". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Activity-log line for one team's side of a completed trade. */
export function describeTradeForTeam(args: { teamName: string; otherTeamName: string; gave: string[]; got: string[] }): string {
  if (args.gave.length > 0) return `${args.teamName} traded ${joinNames(args.gave)} to ${args.otherTeamName}.`;
  return `${args.teamName} got ${joinNames(args.got)} from ${args.otherTeamName} in a trade.`;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

type TradeLeague = { id: string; status: LeagueStatus; seasonStart: string; settings: LeagueSettings };

async function loadTradeLeague(db: DbOrTx, leagueId: string): Promise<TradeLeague> {
  const [l] = await db
    .select({ id: leagues.id, status: leagues.status, seasonStart: leagues.seasonStart, settings: leagues.settings })
    .from(leagues)
    .where(eq(leagues.id, leagueId));
  if (!l) throw new UserError("League not found.");
  return { ...l, settings: parseLeagueSettings(l.settings) };
}

function leagueWindowError(league: TradeLeague, now: Date): string | null {
  return tradeWindowError({
    leagueStatus: league.status,
    deadlineWeek: league.settings.trades.deadlineWeek,
    currentWeek: currentWeek(now, leagueClock(league)),
  });
}

/** Serialize all trade state changes within one league (held until the transaction ends). */
async function lockLeagueTrades(tx: DbOrTx, leagueId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`lf-trades:${leagueId}`}))`);
}

/** Take the league trade lock, then lock and return the trade row (must belong to `leagueId` when given). */
async function lockTrade(tx: DbOrTx, tradeId: string, leagueId?: string): Promise<Trade> {
  let lid = leagueId;
  if (!lid) {
    const [head] = await tx.select({ leagueId: trades.leagueId }).from(trades).where(eq(trades.id, tradeId));
    if (!head) throw new UserError("That trade doesn't exist.");
    lid = head.leagueId;
  }
  await lockLeagueTrades(tx, lid);
  const [trade] = await tx
    .select()
    .from(trades)
    .where(and(eq(trades.id, tradeId), eq(trades.leagueId, lid)))
    .for("update");
  if (!trade) throw new UserError("That trade doesn't exist.");
  return trade;
}

type ItemRow = { lawyerId: string; lawyerName: string; fromTeamId: string };

async function loadItems(db: DbOrTx, tradeId: string): Promise<ItemRow[]> {
  return db
    .select({ lawyerId: tradeItems.lawyerId, lawyerName: lawyers.name, fromTeamId: tradeItems.fromTeamId })
    .from(tradeItems)
    .innerJoin(lawyers, eq(lawyers.id, tradeItems.lawyerId))
    .where(eq(tradeItems.tradeId, tradeId))
    .orderBy(asc(lawyers.name));
}

async function loadTeamNames(db: DbOrTx, leagueId: string, teamIds: string[]): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(and(eq(teams.leagueId, leagueId), inArray(teams.id, teamIds)));
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function rosterCounts(db: DbOrTx, teamIds: string[]): Promise<Map<string, number>> {
  const rows = await db
    .select({ teamId: rosterSpots.teamId, n: sql<number>`count(*)::int` })
    .from(rosterSpots)
    .where(inArray(rosterSpots.teamId, teamIds))
    .groupBy(rosterSpots.teamId);
  return new Map(rows.map((r) => [r.teamId, Number(r.n)]));
}

async function lawyerOwners(db: DbOrTx, leagueId: string, lawyerIds: string[]): Promise<Map<string, string>> {
  if (lawyerIds.length === 0) return new Map();
  const rows = await db
    .select({ lawyerId: rosterSpots.lawyerId, teamId: rosterSpots.teamId })
    .from(rosterSpots)
    .where(and(eq(rosterSpots.leagueId, leagueId), inArray(rosterSpots.lawyerId, lawyerIds)));
  return new Map(rows.map((r) => [r.lawyerId, r.teamId]));
}

type StoredTradeCheck = {
  /** Can never be fixed: mark the trade failed. */
  permanent: string | null;
  /** A roster is too full right now (someone could drop a lawyer first). */
  fixable: string | null;
  overflowSide: "proposer" | "recipient" | null;
};

/**
 * Re-check a stored trade against the current rosters. `permanent` problems
 * can never be fixed (a lawyer moved, the season ended); `fixable` ones can
 * (a roster is too full right now).
 */
async function checkStoredTrade(db: DbOrTx, league: TradeLeague, trade: Trade, items: ItemRow[]): Promise<StoredTradeCheck> {
  const permanent = (msg: string | null): StoredTradeCheck => ({ permanent: msg, fixable: null, overflowSide: null });
  if (league.status !== "in_season" && league.status !== "playoffs") {
    return permanent(tradeWindowError({ leagueStatus: league.status, deadlineWeek: null, currentWeek: 0 }));
  }
  if (items.length === 0) return permanent("This trade has no lawyers in it.");
  const names = await loadTeamNames(db, league.id, [trade.proposerTeamId, trade.recipientTeamId]);
  const proposerName = names.get(trade.proposerTeamId);
  const recipientName = names.get(trade.recipientTeamId);
  if (!proposerName || !recipientName) return permanent("One of these teams is no longer in the league.");
  if (items.some((i) => i.fromTeamId !== trade.proposerTeamId && i.fromTeamId !== trade.recipientTeamId)) {
    return permanent("This trade lists a lawyer from another team.");
  }
  const owners = await lawyerOwners(
    db,
    league.id,
    items.map((i) => i.lawyerId),
  );
  const ownErr = ownershipError(
    items.map((i) => ({ ...i, fromTeamName: names.get(i.fromTeamId) ?? "their team" })),
    owners,
  );
  if (ownErr) return permanent(ownErr);
  const counts = await rosterCounts(db, [trade.proposerTeamId, trade.recipientTeamId]);
  const sizeArgs = {
    proposerName,
    recipientName,
    proposerSize: counts.get(trade.proposerTeamId) ?? 0,
    recipientSize: counts.get(trade.recipientTeamId) ?? 0,
    giveCount: items.filter((i) => i.fromTeamId === trade.proposerTeamId).length,
    getCount: items.filter((i) => i.fromTeamId === trade.recipientTeamId).length,
    maxRoster: maxRosterSize(league.settings),
  };
  return { permanent: null, fixable: rosterSizeError(sizeArgs), overflowSide: rosterOverflow(sizeArgs)?.side ?? null };
}

async function markFailed(db: DbOrTx, tradeId: string, reason: string, now: Date): Promise<void> {
  await db.update(trades).set({ status: "failed", failReason: reason, resolvedAt: now }).where(eq(trades.id, tradeId));
}

// ---------------------------------------------------------------------------
// Propose
// ---------------------------------------------------------------------------

export type ProposeTradeInput = {
  leagueId: string;
  proposerTeamId: string;
  recipientTeamId: string;
  giveLawyerIds: string[];
  getLawyerIds: string[];
  message?: string | null;
  now?: Date;
};

/** Create a trade offer. Throws UserError when it isn't allowed. */
export async function proposeTrade(db: DbOrTx, input: ProposeTradeInput): Promise<{ tradeId: string }> {
  const now = input.now ?? new Date();
  const message = normalizeTradeMessage(input.message);
  const giveLawyerIds = [...input.giveLawyerIds];
  const getLawyerIds = [...input.getLawyerIds];
  const shapeErr = validateTradeShape({
    proposerTeamId: input.proposerTeamId,
    recipientTeamId: input.recipientTeamId,
    giveLawyerIds,
    getLawyerIds,
    message,
  });
  if (shapeErr) throw new UserError(shapeErr);

  return db.transaction(async (tx) => {
    const league = await loadTradeLeague(tx, input.leagueId);
    const windowErr = leagueWindowError(league, now);
    if (windowErr) throw new UserError(windowErr);

    const names = await loadTeamNames(tx, league.id, [input.proposerTeamId, input.recipientTeamId]);
    const proposerName = names.get(input.proposerTeamId);
    const recipientName = names.get(input.recipientTeamId);
    if (!proposerName) throw new UserError("You don't have a team in this league.");
    if (!recipientName) throw new UserError("Pick a team in this league to trade with.");

    const nameRows = await tx
      .select({ id: lawyers.id, name: lawyers.name })
      .from(lawyers)
      .where(inArray(lawyers.id, [...giveLawyerIds, ...getLawyerIds]));
    const lawyerNames = new Map(nameRows.map((r) => [r.id, r.name]));
    const items: OwnershipItem[] = [
      ...giveLawyerIds.map((id) => ({
        lawyerId: id,
        lawyerName: lawyerNames.get(id) ?? "A lawyer",
        fromTeamId: input.proposerTeamId,
        fromTeamName: "your team",
      })),
      ...getLawyerIds.map((id) => ({
        lawyerId: id,
        lawyerName: lawyerNames.get(id) ?? "A lawyer",
        fromTeamId: input.recipientTeamId,
        fromTeamName: recipientName,
      })),
    ];
    const owners = await lawyerOwners(
      tx,
      league.id,
      items.map((i) => i.lawyerId),
    );
    const ownErr = ownershipError(items, owners);
    if (ownErr) throw new UserError(ownErr);

    const counts = await rosterCounts(tx, [input.proposerTeamId, input.recipientTeamId]);
    const sizeErr = rosterSizeError({
      proposerName: "Your team",
      recipientName,
      proposerSize: counts.get(input.proposerTeamId) ?? 0,
      recipientSize: counts.get(input.recipientTeamId) ?? 0,
      giveCount: giveLawyerIds.length,
      getCount: getLawyerIds.length,
      maxRoster: maxRosterSize(league.settings),
    });
    if (sizeErr) throw new UserError(sizeErr);

    const [trade] = await tx
      .insert(trades)
      .values({
        leagueId: league.id,
        proposerTeamId: input.proposerTeamId,
        recipientTeamId: input.recipientTeamId,
        status: "proposed",
        message,
        createdAt: now,
      })
      .returning({ id: trades.id });
    await tx.insert(tradeItems).values(items.map((i) => ({ tradeId: trade.id, fromTeamId: i.fromTeamId, lawyerId: i.lawyerId })));
    return { tradeId: trade.id };
  });
}

// ---------------------------------------------------------------------------
// Respond / cancel / commissioner review
// ---------------------------------------------------------------------------

export type TradeActorInput = {
  leagueId: string;
  tradeId: string;
  /** The acting team (derive from the session, never from the form). */
  teamId: string;
  /** The acting user, recorded as resolvedBy. */
  userId: string;
  now?: Date;
};

export type TradeOutcome = { status: TradeStatus; reviewEndsAt: Date | null; failReason: string | null };

/**
 * Recipient accepts an offer. Re-validates; a trade that can never work (a
 * lawyer moved, deadline passed) is marked failed and returned as such. With
 * reviewHours = 0 the trade executes immediately.
 */
export async function acceptTrade(db: DbOrTx, input: TradeActorInput): Promise<TradeOutcome> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const trade = await lockTrade(tx, input.tradeId, input.leagueId);
    if (trade.recipientTeamId !== input.teamId) throw new UserError("Only the team receiving this offer can accept it.");
    if (trade.status !== "proposed") throw new UserError("This offer is no longer open.");
    const league = await loadTradeLeague(tx, input.leagueId);

    const windowErr = leagueWindowError(league, now);
    if (windowErr) {
      await markFailed(tx, trade.id, windowErr, now);
      return { status: "failed", reviewEndsAt: null, failReason: windowErr };
    }
    const items = await loadItems(tx, trade.id);
    const check = await checkStoredTrade(tx, league, trade, items);
    if (check.permanent) {
      await markFailed(tx, trade.id, check.permanent, now);
      return { status: "failed", reviewEndsAt: null, failReason: check.permanent };
    }
    if (check.fixable) {
      throw new UserError(
        check.overflowSide === "recipient"
          ? `${check.fixable} Drop someone first, then accept.`
          : `${check.fixable} They need to drop someone before this can go through.`,
      );
    }

    const reviewEndsAt = reviewEndsAtFor(now, league.settings.trades.reviewHours);
    await tx.update(trades).set({ status: "accepted", respondedAt: now, reviewEndsAt }).where(eq(trades.id, trade.id));
    if (league.settings.trades.reviewHours === 0) {
      const res = await executeTrade(tx, trade.id, now);
      return { status: res.status, reviewEndsAt, failReason: res.failReason };
    }
    return { status: "accepted", reviewEndsAt, failReason: null };
  });
}

/** Recipient declines an offer. */
export async function rejectTrade(db: DbOrTx, input: TradeActorInput): Promise<void> {
  const now = input.now ?? new Date();
  await db.transaction(async (tx) => {
    const trade = await lockTrade(tx, input.tradeId, input.leagueId);
    if (trade.recipientTeamId !== input.teamId) throw new UserError("Only the team receiving this offer can decline it.");
    if (trade.status !== "proposed") throw new UserError("This offer is no longer open.");
    await tx
      .update(trades)
      .set({ status: "rejected", respondedAt: now, resolvedAt: now, resolvedBy: input.userId })
      .where(eq(trades.id, trade.id));
  });
}

/** Proposer withdraws an offer, or backs out during the review window. */
export async function cancelTrade(db: DbOrTx, input: TradeActorInput): Promise<void> {
  const now = input.now ?? new Date();
  await db.transaction(async (tx) => {
    const trade = await lockTrade(tx, input.tradeId, input.leagueId);
    if (trade.proposerTeamId !== input.teamId) throw new UserError("Only the team that made this offer can cancel it.");
    if (trade.status !== "proposed" && trade.status !== "accepted") throw new UserError("This trade can't be cancelled anymore.");
    await tx
      .update(trades)
      .set({ status: "cancelled", resolvedAt: now, resolvedBy: input.userId })
      .where(eq(trades.id, trade.id));
  });
}

export type CommissionerTradeInput = {
  leagueId: string;
  tradeId: string;
  /** The commissioner (the caller must verify the role). */
  userId: string;
  now?: Date;
};

/** Commissioner vetoes an accepted trade during its review window. */
export async function vetoTrade(db: DbOrTx, input: CommissionerTradeInput & { reason?: string | null }): Promise<void> {
  const now = input.now ?? new Date();
  const reason = normalizeTradeMessage(input.reason);
  if (reason && reason.length > TRADE_MESSAGE_MAX) throw new UserError(`Keep the reason to ${TRADE_MESSAGE_MAX} characters or less.`);
  await db.transaction(async (tx) => {
    const trade = await lockTrade(tx, input.tradeId, input.leagueId);
    if (trade.status !== "accepted") throw new UserError("Only trades in review can be vetoed.");
    await tx
      .update(trades)
      .set({ status: "vetoed", resolvedAt: now, resolvedBy: input.userId, failReason: reason })
      .where(eq(trades.id, trade.id));
  });
}

/** Commissioner skips the rest of the review window and executes now. */
export async function approveTradeNow(db: DbOrTx, input: CommissionerTradeInput): Promise<TradeOutcome> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const trade = await lockTrade(tx, input.tradeId, input.leagueId);
    if (trade.status !== "accepted") throw new UserError("Only trades in review can be approved.");
    const res = await executeTrade(tx, trade.id, now, { resolvedBy: input.userId });
    return { status: res.status, reviewEndsAt: trade.reviewEndsAt, failReason: res.failReason };
  });
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

/**
 * Execute an accepted trade: lock it, re-validate ownership and roster sizes,
 * then move every lawyer. Invalid trades are marked failed instead. A no-op
 * (returns the current status) when the trade is not `accepted`, so it is
 * idempotent under concurrency. Safe to call with `db` or inside a transaction
 * (it opens a savepoint).
 */
export async function executeTrade(
  db: DbOrTx,
  tradeId: string,
  now: Date = new Date(),
  opts?: { resolvedBy?: string | null },
): Promise<{ status: TradeStatus; failReason: string | null }> {
  return db.transaction(async (tx) => {
    const trade = await lockTrade(tx, tradeId);
    if (trade.status !== "accepted") return { status: trade.status, failReason: trade.failReason };
    const league = await loadTradeLeague(tx, trade.leagueId);
    const items = await loadItems(tx, trade.id);

    const check = await checkStoredTrade(tx, league, trade, items);
    const problem = check.permanent ?? check.fixable;
    if (problem) {
      await markFailed(tx, trade.id, problem, now);
      return { status: "failed", failReason: problem };
    }

    const toTeam = (fromTeamId: string) => (fromTeamId === trade.proposerTeamId ? trade.recipientTeamId : trade.proposerTeamId);
    try {
      // Savepoint: if a roster changed under us, undo the partial move and mark the trade failed.
      await tx.transaction(async (sp) => {
        for (const it of items) {
          await removeLawyerFromTeam(sp, {
            league: { id: league.id, seasonStart: league.seasonStart, settings: league.settings },
            teamId: it.fromTeamId,
            lawyerId: it.lawyerId,
            toWaivers: false,
            now,
          });
        }
        for (const it of items) {
          await addLawyerToTeam(sp, {
            leagueId: league.id,
            settings: league.settings,
            teamId: toTeam(it.fromTeamId),
            lawyerId: it.lawyerId,
            via: "trade",
          });
        }
      });
    } catch (e) {
      const reason = e instanceof UserError ? `Rosters changed before the trade went through. ${e.message}` : "Rosters changed before the trade went through.";
      if (!(e instanceof UserError)) console.error("executeTrade: move failed", e);
      await markFailed(tx, trade.id, reason, now);
      return { status: "failed", failReason: reason };
    }

    await tx
      .update(trades)
      .set({ status: "completed", resolvedAt: now, resolvedBy: opts?.resolvedBy ?? null, failReason: null })
      .where(eq(trades.id, trade.id));

    // Activity log: one line per team.
    const names = await loadTeamNames(tx, league.id, [trade.proposerTeamId, trade.recipientTeamId]);
    const sides = [
      { teamId: trade.proposerTeamId, otherId: trade.recipientTeamId },
      { teamId: trade.recipientTeamId, otherId: trade.proposerTeamId },
    ];
    for (const s of sides) {
      const gave = items.filter((i) => i.fromTeamId === s.teamId);
      const got = items.filter((i) => i.fromTeamId === s.otherId);
      await logTransaction(tx, {
        leagueId: league.id,
        teamId: s.teamId,
        type: "trade",
        lawyerId: (gave[0] ?? got[0])?.lawyerId ?? null,
        description: describeTradeForTeam({
          teamName: names.get(s.teamId) ?? "A team",
          otherTeamName: names.get(s.otherId) ?? "another team",
          gave: gave.map((i) => i.lawyerName),
          got: got.map((i) => i.lawyerName),
        }),
      });
    }

    // Any other open trade with one of these lawyers can't happen anymore.
    const moved = items.map((i) => i.lawyerId);
    await tx
      .update(trades)
      .set({ status: "failed", failReason: TRADED_ELSEWHERE_REASON, resolvedAt: now })
      .where(
        and(
          eq(trades.leagueId, league.id),
          ne(trades.id, trade.id),
          inArray(trades.status, [...OPEN_TRADE_STATUSES]),
          inArray(trades.id, tx.select({ id: tradeItems.tradeId }).from(tradeItems).where(inArray(tradeItems.lawyerId, moved))),
        ),
      );

    return { status: "completed", failReason: null };
  });
}

// ---------------------------------------------------------------------------
// Reads for pages
// ---------------------------------------------------------------------------

export type TradeLawyer = {
  id: string;
  name: string;
  kind: "lawyer" | "firm";
  position: Position;
  fromTeamId: string;
};

export type TradeView = Trade & {
  proposerName: string;
  recipientName: string;
  resolvedByName: string | null;
  /** Lawyers the proposer gives up. */
  proposerGives: TradeLawyer[];
  /** Lawyers the recipient gives up. */
  recipientGives: TradeLawyer[];
};

async function hydrateTrades(db: DbOrTx, leagueId: string, rows: Trade[]): Promise<TradeView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const resolverIds = [...new Set(rows.map((r) => r.resolvedBy).filter((x): x is string => !!x))];
  const [teamRows, itemRows, userRows] = await Promise.all([
    db.select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.leagueId, leagueId)),
    db
      .select({
        tradeId: tradeItems.tradeId,
        id: lawyers.id,
        name: lawyers.name,
        kind: lawyers.kind,
        position: lawyers.position,
        fromTeamId: tradeItems.fromTeamId,
      })
      .from(tradeItems)
      .innerJoin(lawyers, eq(lawyers.id, tradeItems.lawyerId))
      .where(inArray(tradeItems.tradeId, ids))
      .orderBy(asc(lawyers.name)),
    resolverIds.length
      ? db.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, resolverIds))
      : Promise.resolve([] as { id: string; name: string }[]),
  ]);
  const teamName = new Map(teamRows.map((t) => [t.id, t.name]));
  const userName = new Map(userRows.map((u) => [u.id, u.name]));
  const itemsByTrade = new Map<string, TradeLawyer[]>();
  for (const { tradeId, ...l } of itemRows) {
    const arr = itemsByTrade.get(tradeId) ?? [];
    arr.push(l);
    itemsByTrade.set(tradeId, arr);
  }
  return rows.map((r) => {
    const items = itemsByTrade.get(r.id) ?? [];
    return {
      ...r,
      proposerName: teamName.get(r.proposerTeamId) ?? "Former team",
      recipientName: teamName.get(r.recipientTeamId) ?? "Former team",
      resolvedByName: r.resolvedBy ? (userName.get(r.resolvedBy) ?? null) : null,
      proposerGives: items.filter((i) => i.fromTeamId === r.proposerTeamId),
      recipientGives: items.filter((i) => i.fromTeamId === r.recipientTeamId),
    };
  });
}

/** SQL version of canViewTrade. */
function visibleTo(viewer: TradeViewer): SQL | undefined {
  const conds: SQL[] = [isNotNull(trades.reviewEndsAt)];
  if (viewer.teamId) conds.push(eq(trades.proposerTeamId, viewer.teamId), eq(trades.recipientTeamId, viewer.teamId));
  return or(...conds);
}

/** Open trades (proposed + accepted) the viewer may see, oldest first. */
export async function listOpenTrades(db: DbOrTx, leagueId: string, viewer: TradeViewer): Promise<TradeView[]> {
  const rows = await db
    .select()
    .from(trades)
    .where(and(eq(trades.leagueId, leagueId), inArray(trades.status, [...OPEN_TRADE_STATUSES]), visibleTo(viewer)))
    .orderBy(asc(trades.createdAt));
  return hydrateTrades(db, leagueId, rows);
}

/** Settled trades the viewer may see, newest first. */
export async function listTradeHistory(db: DbOrTx, leagueId: string, viewer: TradeViewer, limit = 30): Promise<TradeView[]> {
  const rows = await db
    .select()
    .from(trades)
    .where(and(eq(trades.leagueId, leagueId), inArray(trades.status, [...CLOSED_TRADE_STATUSES]), visibleTo(viewer)))
    .orderBy(desc(sql`coalesce(${trades.resolvedAt}, ${trades.respondedAt}, ${trades.createdAt})`), desc(trades.createdAt))
    .limit(limit);
  return hydrateTrades(db, leagueId, rows);
}

/** One trade in a league (no visibility check; use canViewTrade). */
export async function getTradeView(db: DbOrTx, leagueId: string, tradeId: string): Promise<TradeView | null> {
  const rows = await db
    .select()
    .from(trades)
    .where(and(eq(trades.leagueId, leagueId), eq(trades.id, tradeId)));
  const [view] = await hydrateTrades(db, leagueId, rows);
  return view ?? null;
}

/**
 * Lawyers in open trades that are no longer on the team giving them up
 * (e.g. dropped since the offer was made). Used to warn on trade cards.
 */
export async function staleTradeLawyers(db: DbOrTx, leagueId: string, views: TradeView[]): Promise<Map<string, string[]>> {
  const open = views.filter((v) => v.status === "proposed" || v.status === "accepted");
  const ids = [...new Set(open.flatMap((v) => [...v.proposerGives, ...v.recipientGives].map((l) => l.id)))];
  const owners = await lawyerOwners(db, leagueId, ids);
  const out = new Map<string, string[]>();
  for (const v of open) {
    const stale = [...v.proposerGives, ...v.recipientGives].filter((l) => owners.get(l.id) !== l.fromTeamId).map((l) => l.name);
    if (stale.length) out.set(v.id, stale);
  }
  return out;
}
