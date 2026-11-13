/**
 * Roster mutations shared by free-agent adds, waivers, trades, the draft and
 * commissioner tools. All functions expect to run inside a transaction.
 */
import { and, asc, eq } from "drizzle-orm";
import type { DbOrTx } from "@/db";
import { lawyers, rosterSpots, transactions, waiverHolds } from "@/db/schema";
import type { LeagueSettings } from "@/lib/settings";
import { rosterSize } from "@/lib/settings";
import { UserError } from "@/server/action-result";
import { removeLawyerFromUpcomingLineups } from "./lineups";

export type RosterLawyer = {
  id: string;
  name: string;
  kind: "lawyer" | "firm";
  position: "trial" | "appellate" | "prosecutor" | "defense" | "firm";
  firmId: string | null;
  organization: string | null;
  preseasonRank: number | null;
  acquiredVia: string;
  acquiredAt: Date;
};

export async function getTeamRoster(db: DbOrTx, teamId: string): Promise<RosterLawyer[]> {
  return db
    .select({
      id: lawyers.id,
      name: lawyers.name,
      kind: lawyers.kind,
      position: lawyers.position,
      firmId: lawyers.firmId,
      organization: lawyers.organization,
      preseasonRank: lawyers.preseasonRank,
      acquiredVia: rosterSpots.acquiredVia,
      acquiredAt: rosterSpots.acquiredAt,
    })
    .from(rosterSpots)
    .innerJoin(lawyers, eq(lawyers.id, rosterSpots.lawyerId))
    .where(eq(rosterSpots.teamId, teamId))
    .orderBy(asc(lawyers.name));
}

export function maxRosterSize(settings: LeagueSettings): number {
  return rosterSize(settings.roster);
}

/** Which team (if any) owns a lawyer in a league, and whether the lawyer is on waivers. */
export async function lawyerLeagueStatus(
  db: DbOrTx,
  leagueId: string,
  lawyerId: string,
): Promise<{ teamId: string | null; onWaivers: boolean }> {
  const [spot] = await db
    .select({ teamId: rosterSpots.teamId })
    .from(rosterSpots)
    .where(and(eq(rosterSpots.leagueId, leagueId), eq(rosterSpots.lawyerId, lawyerId)));
  const [hold] = await db
    .select({ lawyerId: waiverHolds.lawyerId })
    .from(waiverHolds)
    .where(and(eq(waiverHolds.leagueId, leagueId), eq(waiverHolds.lawyerId, lawyerId)));
  return { teamId: spot?.teamId ?? null, onWaivers: !!hold };
}

export async function logTransaction(
  db: DbOrTx,
  t: { leagueId: string; teamId: string | null; type: "draft" | "add" | "drop" | "waiver_add" | "trade" | "commissioner"; lawyerId: string | null; description: string },
): Promise<void> {
  await db.insert(transactions).values(t);
}

/**
 * Put a lawyer on a team. Fails if the lawyer is already rostered in the
 * league (unique index) or the roster would exceed its max size.
 */
export async function addLawyerToTeam(
  db: DbOrTx,
  args: {
    leagueId: string;
    settings: LeagueSettings;
    teamId: string;
    lawyerId: string;
    via: "draft" | "waiver" | "free_agent" | "trade" | "commissioner";
    skipSizeCheck?: boolean;
  },
): Promise<void> {
  if (!args.skipSizeCheck) {
    const current = await db.select({ id: rosterSpots.id }).from(rosterSpots).where(eq(rosterSpots.teamId, args.teamId));
    if (current.length + 1 > maxRosterSize(args.settings)) throw new UserError("Roster is full. Drop someone first.");
  }
  const existing = await db
    .select({ teamId: rosterSpots.teamId })
    .from(rosterSpots)
    .where(and(eq(rosterSpots.leagueId, args.leagueId), eq(rosterSpots.lawyerId, args.lawyerId)));
  if (existing.length > 0) throw new UserError("That lawyer is already on a roster.");
  await db.insert(rosterSpots).values({
    leagueId: args.leagueId,
    teamId: args.teamId,
    lawyerId: args.lawyerId,
    acquiredVia: args.via,
  });
  await db.delete(waiverHolds).where(and(eq(waiverHolds.leagueId, args.leagueId), eq(waiverHolds.lawyerId, args.lawyerId)));
}

/**
 * Remove a lawyer from a team, clear them from unlocked lineups, and
 * optionally place them on waivers until the next waiver run.
 */
export async function removeLawyerFromTeam(
  db: DbOrTx,
  args: {
    league: { id: string; seasonStart: string; settings: LeagueSettings };
    teamId: string;
    lawyerId: string;
    toWaivers: boolean;
    now?: Date;
  },
): Promise<void> {
  const deleted = await db
    .delete(rosterSpots)
    .where(and(eq(rosterSpots.teamId, args.teamId), eq(rosterSpots.lawyerId, args.lawyerId)))
    .returning({ id: rosterSpots.id });
  if (deleted.length === 0) throw new UserError("That lawyer is not on this roster.");
  await removeLawyerFromUpcomingLineups(db, args.league, args.teamId, args.lawyerId, args.now);
  if (args.toWaivers) {
    await db.insert(waiverHolds).values({ leagueId: args.league.id, lawyerId: args.lawyerId }).onConflictDoNothing();
  }
}
