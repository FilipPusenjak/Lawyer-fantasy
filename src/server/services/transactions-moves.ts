/**
 * Roster moves made by a team during the season: free-agent adds, drops,
 * waiver claims (create / reorder / cancel) and lineup saves.
 *
 * Every mutation locks the league row first (SELECT … FOR UPDATE) so moves in
 * one league are serialized with each other and with waiver processing, which
 * holds the same row lock while it runs.
 *
 * No request/cookie access: callers pass the acting team (always derived from
 * the signed-in user's own team in Server Actions).
 */
import { and, asc, eq } from "drizzle-orm";
import type { DbOrTx } from "@/db";
import { lawyers, leagues, rosterSpots, teams, transactions, waiverClaims, waiverHolds } from "@/db/schema";
import { validateLineup } from "@/lib/lineup";
import { parseLeagueSettings, totalSeasonWeeks, type LeagueSettings } from "@/lib/settings";
import { editableWeek, formatDateTime, isWeekLocked, weekLockTime } from "@/lib/time";
import { UserError } from "@/server/action-result";
import { leagueClock, saveLineup } from "./lineups";
import { addLawyerToTeam, getTeamRoster, maxRosterSize, removeLawyerFromTeam } from "./roster";

// ---------------------------------------------------------------------------
// Pure rules (unit tested)
// ---------------------------------------------------------------------------

type LeagueStatus = "setup" | "drafting" | "in_season" | "playoffs" | "complete";

/** Adds, drops and claims are only allowed once the draft is done and until the season ends. */
export function movesOpen(status: LeagueStatus): boolean {
  return status === "in_season" || status === "playoffs";
}

/** Why moves are closed, in friendly words (null when they're open). */
export function movesClosedReason(status: LeagueStatus): string | null {
  switch (status) {
    case "setup":
    case "drafting":
      return "Adds and drops open after the draft.";
    case "complete":
      return "The season is over, so rosters are locked.";
    default:
      return null;
  }
}

/** A lawyer picked up as a free agent and dropped within this window skips waivers. */
export const FREE_AGENT_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Dropped lawyers go on waivers until the next waiver run, except a free-agent
 * pickup dropped within 24 hours, who goes straight back to free agency.
 */
export function dropGoesToWaivers(spot: { acquiredVia: string; acquiredAt: Date }, now: Date): boolean {
  if (spot.acquiredVia !== "free_agent") return true;
  return now.getTime() - spot.acquiredAt.getTime() >= FREE_AGENT_GRACE_MS;
}

/** Move one id up or down in an ordered list (no-op at the ends or when missing). */
export function reorderIds(ids: string[], id: string, direction: "up" | "down"): string[] {
  const out = [...ids];
  const i = out.indexOf(id);
  if (i < 0) return out;
  const j = direction === "up" ? i - 1 : i + 1;
  if (j < 0 || j >= out.length) return out;
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** Most pending waiver claims a team may have at once. */
export const MAX_PENDING_CLAIMS = 30;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type LockedLeague = {
  id: string;
  poolId: string;
  status: LeagueStatus;
  seasonStart: string;
  settings: LeagueSettings;
  nextWaiverRunAt: Date | null;
};

/** Lock the league row for the rest of the transaction. */
async function lockLeague(tx: DbOrTx, leagueId: string, opts: { requireMovesOpen: boolean }): Promise<LockedLeague> {
  const [row] = await tx
    .select({
      id: leagues.id,
      poolId: leagues.poolId,
      status: leagues.status,
      seasonStart: leagues.seasonStart,
      settings: leagues.settings,
      nextWaiverRunAt: leagues.nextWaiverRunAt,
    })
    .from(leagues)
    .where(eq(leagues.id, leagueId))
    .for("update");
  if (!row) throw new UserError("League not found.");
  if (opts.requireMovesOpen) {
    const reason = movesClosedReason(row.status);
    if (reason) throw new UserError(reason);
  }
  return { ...row, settings: parseLeagueSettings(row.settings) };
}

async function poolLawyer(tx: DbOrTx, poolId: string, lawyerId: string) {
  const [l] = await tx
    .select({ id: lawyers.id, name: lawyers.name })
    .from(lawyers)
    .where(and(eq(lawyers.id, lawyerId), eq(lawyers.poolId, poolId)));
  if (!l) throw new UserError("That lawyer isn't in this league's player pool.");
  return l;
}

/** Who has the lawyer (if anyone) and whether they're on waivers. */
async function availability(tx: DbOrTx, leagueId: string, lawyerId: string) {
  const [spot] = await tx
    .select({ teamId: rosterSpots.teamId, teamName: teams.name })
    .from(rosterSpots)
    .innerJoin(teams, eq(teams.id, rosterSpots.teamId))
    .where(and(eq(rosterSpots.leagueId, leagueId), eq(rosterSpots.lawyerId, lawyerId)));
  const [hold] = await tx
    .select({ lawyerId: waiverHolds.lawyerId })
    .from(waiverHolds)
    .where(and(eq(waiverHolds.leagueId, leagueId), eq(waiverHolds.lawyerId, lawyerId)));
  return { owner: spot ?? null, onWaivers: !!hold };
}

async function teamSpot(tx: DbOrTx, leagueId: string, teamId: string, lawyerId: string) {
  const [spot] = await tx
    .select({ acquiredVia: rosterSpots.acquiredVia, acquiredAt: rosterSpots.acquiredAt, name: lawyers.name })
    .from(rosterSpots)
    .innerJoin(lawyers, eq(lawyers.id, rosterSpots.lawyerId))
    .where(and(eq(rosterSpots.leagueId, leagueId), eq(rosterSpots.teamId, teamId), eq(rosterSpots.lawyerId, lawyerId)));
  return spot ?? null;
}

async function teamRosterCount(tx: DbOrTx, teamId: string): Promise<number> {
  const rows = await tx.select({ id: rosterSpots.id }).from(rosterSpots).where(eq(rosterSpots.teamId, teamId));
  return rows.length;
}

/** Pending claims that planned to drop this lawyer keep going, just without the drop. */
async function clearDropFromPendingClaims(tx: DbOrTx, teamId: string, lawyerId: string): Promise<void> {
  await tx
    .update(waiverClaims)
    .set({ dropLawyerId: null })
    .where(and(eq(waiverClaims.teamId, teamId), eq(waiverClaims.status, "pending"), eq(waiverClaims.dropLawyerId, lawyerId)));
}

/** Drop a lawyer inside an open transaction; returns where they went. */
async function dropInTx(
  tx: DbOrTx,
  league: LockedLeague,
  teamId: string,
  lawyerId: string,
  now: Date,
): Promise<{ lawyerName: string; toWaivers: boolean }> {
  const spot = await teamSpot(tx, league.id, teamId, lawyerId);
  if (!spot) throw new UserError("That lawyer isn't on your team anymore.");
  const toWaivers = dropGoesToWaivers(spot, now);
  await removeLawyerFromTeam(tx, {
    league: { id: league.id, seasonStart: league.seasonStart, settings: league.settings },
    teamId,
    lawyerId,
    toWaivers,
    now,
  });
  await clearDropFromPendingClaims(tx, teamId, lawyerId);
  return { lawyerName: spot.name, toWaivers };
}

function dropDescription(name: string, toWaivers: boolean): string {
  return toWaivers ? `Dropped ${name} (to waivers)` : `Dropped ${name} (back to free agency)`;
}

// ---------------------------------------------------------------------------
// Drops and free-agent adds
// ---------------------------------------------------------------------------

export type DropResult = { lawyerName: string; toWaivers: boolean; waiversUntil: Date | null };

/** Drop a lawyer from a team and log it. */
export async function dropLawyer(
  db: DbOrTx,
  args: { leagueId: string; teamId: string; lawyerId: string; now?: Date },
): Promise<DropResult> {
  const now = args.now ?? new Date();
  return db.transaction(async (tx) => {
    const league = await lockLeague(tx, args.leagueId, { requireMovesOpen: true });
    const res = await dropInTx(tx, league, args.teamId, args.lawyerId, now);
    await tx.insert(transactions).values({
      leagueId: league.id,
      teamId: args.teamId,
      type: "drop",
      lawyerId: args.lawyerId,
      description: dropDescription(res.lawyerName, res.toWaivers),
      createdAt: now,
    });
    return { ...res, waiversUntil: res.toWaivers ? league.nextWaiverRunAt : null };
  });
}

export type AddResult = { lawyerName: string; dropped: { lawyerName: string; toWaivers: boolean } | null };

/**
 * Add a free agent (optionally dropping someone first). Fails if the lawyer is
 * rostered or on waivers, or the roster is full and nobody is dropped.
 */
export async function addFreeAgent(
  db: DbOrTx,
  args: { leagueId: string; teamId: string; lawyerId: string; dropLawyerId: string | null; now?: Date },
): Promise<AddResult> {
  const now = args.now ?? new Date();
  if (args.dropLawyerId && args.dropLawyerId === args.lawyerId) throw new UserError("Pick a different lawyer to drop.");
  return db.transaction(async (tx) => {
    const league = await lockLeague(tx, args.leagueId, { requireMovesOpen: true });
    const lawyer = await poolLawyer(tx, league.poolId, args.lawyerId);
    const status = await availability(tx, league.id, lawyer.id);
    if (status.owner) {
      throw new UserError(
        status.owner.teamId === args.teamId ? `${lawyer.name} is already on your team.` : `${lawyer.name} is already on ${status.owner.teamName}.`,
      );
    }
    if (status.onWaivers) throw new UserError(`${lawyer.name} is on waivers. Put in a waiver claim instead.`);

    let dropped: AddResult["dropped"] = null;
    if (args.dropLawyerId) {
      dropped = await dropInTx(tx, league, args.teamId, args.dropLawyerId, now);
    } else if ((await teamRosterCount(tx, args.teamId)) >= maxRosterSize(league.settings)) {
      throw new UserError("Your roster is full. Pick a lawyer to drop.");
    }
    await addLawyerToTeam(tx, { leagueId: league.id, settings: league.settings, teamId: args.teamId, lawyerId: lawyer.id, via: "free_agent" });

    const logs: (typeof transactions.$inferInsert)[] = [];
    if (dropped && args.dropLawyerId) {
      logs.push({
        leagueId: league.id,
        teamId: args.teamId,
        type: "drop",
        lawyerId: args.dropLawyerId,
        description: dropDescription(dropped.lawyerName, dropped.toWaivers),
        createdAt: now,
      });
    }
    // 1 ms later so the add shows above the drop in the (newest first) activity log.
    logs.push({
      leagueId: league.id,
      teamId: args.teamId,
      type: "add",
      lawyerId: lawyer.id,
      description: `Added ${lawyer.name}`,
      createdAt: new Date(now.getTime() + 1),
    });
    await tx.insert(transactions).values(logs);
    return { lawyerName: lawyer.name, dropped };
  });
}

// ---------------------------------------------------------------------------
// Waiver claims
// ---------------------------------------------------------------------------

/** Put in a claim for a lawyer on waivers. It's processed at the next waiver run. */
export async function createWaiverClaim(
  db: DbOrTx,
  args: { leagueId: string; teamId: string; lawyerId: string; dropLawyerId: string | null },
): Promise<{ lawyerName: string; claimOrder: number; runsAt: Date | null }> {
  if (args.dropLawyerId && args.dropLawyerId === args.lawyerId) throw new UserError("Pick a different lawyer to drop.");
  return db.transaction(async (tx) => {
    const league = await lockLeague(tx, args.leagueId, { requireMovesOpen: true });
    const lawyer = await poolLawyer(tx, league.poolId, args.lawyerId);
    const status = await availability(tx, league.id, lawyer.id);
    if (status.owner) {
      throw new UserError(
        status.owner.teamId === args.teamId ? `${lawyer.name} is already on your team.` : `${lawyer.name} is already on ${status.owner.teamName}.`,
      );
    }
    if (!status.onWaivers) throw new UserError(`${lawyer.name} isn't on waivers. You can add them right away.`);

    const pending = await tx
      .select({ addLawyerId: waiverClaims.addLawyerId, claimOrder: waiverClaims.claimOrder })
      .from(waiverClaims)
      .where(and(eq(waiverClaims.teamId, args.teamId), eq(waiverClaims.status, "pending")));
    if (pending.some((c) => c.addLawyerId === lawyer.id)) {
      throw new UserError(`You already have a claim on ${lawyer.name}. Change it on the waivers page.`);
    }
    if (pending.length >= MAX_PENDING_CLAIMS) throw new UserError(`You can have up to ${MAX_PENDING_CLAIMS} claims at once.`);

    if (args.dropLawyerId) {
      const spot = await teamSpot(tx, league.id, args.teamId, args.dropLawyerId);
      if (!spot) throw new UserError("The lawyer you picked to drop isn't on your team.");
    } else if ((await teamRosterCount(tx, args.teamId)) >= maxRosterSize(league.settings)) {
      throw new UserError("Your roster is full. Pick a lawyer to drop if the claim goes through.");
    }

    const claimOrder = pending.reduce((m, c) => Math.max(m, c.claimOrder), 0) + 1;
    await tx.insert(waiverClaims).values({
      leagueId: league.id,
      teamId: args.teamId,
      addLawyerId: lawyer.id,
      dropLawyerId: args.dropLawyerId,
      claimOrder,
    });
    return { lawyerName: lawyer.name, claimOrder, runsAt: league.nextWaiverRunAt };
  });
}

/** The team's pending claims, in its own order. */
async function pendingClaimIds(tx: DbOrTx, leagueId: string, teamId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: waiverClaims.id })
    .from(waiverClaims)
    .where(and(eq(waiverClaims.leagueId, leagueId), eq(waiverClaims.teamId, teamId), eq(waiverClaims.status, "pending")))
    .orderBy(asc(waiverClaims.claimOrder), asc(waiverClaims.createdAt));
  return rows.map((r) => r.id);
}

async function writeClaimOrder(tx: DbOrTx, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i++) {
    await tx.update(waiverClaims).set({ claimOrder: i + 1 }).where(eq(waiverClaims.id, ids[i]));
  }
}

/** Move one of a team's pending claims up or down its list. */
export async function moveWaiverClaim(
  db: DbOrTx,
  args: { leagueId: string; teamId: string; claimId: string; direction: "up" | "down" },
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockLeague(tx, args.leagueId, { requireMovesOpen: false });
    const ids = await pendingClaimIds(tx, args.leagueId, args.teamId);
    if (!ids.includes(args.claimId)) throw new UserError("That claim was already processed or cancelled.");
    await writeClaimOrder(tx, reorderIds(ids, args.claimId, args.direction));
  });
}

/** Cancel one of a team's pending claims. */
export async function cancelWaiverClaim(db: DbOrTx, args: { leagueId: string; teamId: string; claimId: string }): Promise<void> {
  await db.transaction(async (tx) => {
    await lockLeague(tx, args.leagueId, { requireMovesOpen: false });
    const done = await tx
      .update(waiverClaims)
      .set({ status: "cancelled" })
      .where(
        and(
          eq(waiverClaims.id, args.claimId),
          eq(waiverClaims.leagueId, args.leagueId),
          eq(waiverClaims.teamId, args.teamId),
          eq(waiverClaims.status, "pending"),
        ),
      )
      .returning({ id: waiverClaims.id });
    if (done.length === 0) throw new UserError("That claim was already processed or cancelled.");
    await writeClaimOrder(tx, await pendingClaimIds(tx, args.leagueId, args.teamId));
  });
}

// ---------------------------------------------------------------------------
// Lineups
// ---------------------------------------------------------------------------

/**
 * Save a team's starters for a week. Only the current editable week (the
 * earliest week whose lock time is still ahead) can be changed.
 */
export async function setTeamLineup(
  db: DbOrTx,
  args: { leagueId: string; teamId: string; week: number; starters: (string | null)[]; now?: Date },
): Promise<void> {
  const now = args.now ?? new Date();
  // Serialize with drops, adds, waivers and trades (they all lock the league
  // row) so a lawyer who is leaving the roster can't be saved as a starter.
  return db.transaction(async (tx) => {
  const league = await lockLeague(tx, args.leagueId, { requireMovesOpen: false });
  if (league.status === "setup" || league.status === "drafting") throw new UserError("Lineups open after the draft.");
  if (league.status === "complete") throw new UserError("The season is over, so lineups are locked.");
  const settings = league.settings;
  const clock = leagueClock({ seasonStart: league.seasonStart, settings });
  if (args.week < 1 || args.week > totalSeasonWeeks(settings.schedule)) throw new UserError("That week isn't part of the season.");
  if (isWeekLocked(args.week, now, clock)) {
    const at = formatDateTime(weekLockTime(args.week, clock.seasonStart, clock.lockTime, clock.timeZone), clock.timeZone);
    throw new UserError(`Week ${args.week} lineups locked ${at}. Refresh to set next week's lineup.`);
  }
  const editable = editableWeek(now, clock);
  if (args.week !== editable) throw new UserError(`Right now you can set your lineup for week ${editable}.`);

  const roster = await getTeamRoster(tx, args.teamId);
  const error = validateLineup(args.starters, settings.roster, roster);
  if (error) throw new UserError(error);
  await saveLineup(tx, args.teamId, args.week, args.starters);
  });
}
