/**
 * Read helpers for the lawyer pool as seen from one league: who owns whom,
 * who is on waivers, lawyer cases and scoring events, and waiver claims.
 * No request/cookie access so scripts can reuse them.
 */
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { DbOrTx } from "@/db";
import {
  caseAppearances,
  cases,
  lawyers,
  rosterSpots,
  scoringEvents,
  teams,
  users,
  waiverClaims,
  waiverHolds,
} from "@/db/schema";
import type { CaseType, Position, Side } from "@/lib/settings";

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

export type LeagueAvailability =
  | { kind: "rostered"; teamId: string; teamName: string; acquiredVia: string; acquiredAt: Date }
  | { kind: "waivers" }
  | { kind: "free_agent" };

export type AvailabilityMap = {
  get(lawyerId: string): LeagueAvailability;
};

/** Every lawyer's status in a league: rostered (by whom), on waivers, or a free agent. */
export async function loadAvailability(db: DbOrTx, leagueId: string): Promise<AvailabilityMap> {
  const [spots, holds] = await Promise.all([
    db
      .select({
        lawyerId: rosterSpots.lawyerId,
        teamId: rosterSpots.teamId,
        teamName: teams.name,
        acquiredVia: rosterSpots.acquiredVia,
        acquiredAt: rosterSpots.acquiredAt,
      })
      .from(rosterSpots)
      .innerJoin(teams, eq(teams.id, rosterSpots.teamId))
      .where(eq(rosterSpots.leagueId, leagueId)),
    db.select({ lawyerId: waiverHolds.lawyerId }).from(waiverHolds).where(eq(waiverHolds.leagueId, leagueId)),
  ]);
  const map = new Map<string, LeagueAvailability>();
  for (const h of holds) map.set(h.lawyerId, { kind: "waivers" });
  // A rostered lawyer never keeps a hold, but rostered wins just in case.
  for (const s of spots) {
    map.set(s.lawyerId, { kind: "rostered", teamId: s.teamId, teamName: s.teamName, acquiredVia: s.acquiredVia, acquiredAt: s.acquiredAt });
  }
  const freeAgent: LeagueAvailability = { kind: "free_agent" };
  return { get: (id) => map.get(id) ?? freeAgent };
}

// ---------------------------------------------------------------------------
// Lawyers, cases and events
// ---------------------------------------------------------------------------

export type PoolLawyerDetail = {
  id: string;
  poolId: string;
  name: string;
  kind: "lawyer" | "firm";
  position: Position;
  firmId: string | null;
  organization: string | null;
  preseasonRank: number | null;
};

/** A lawyer, only if it belongs to the given pool. */
export async function getPoolLawyer(db: DbOrTx, poolId: string, lawyerId: string): Promise<PoolLawyerDetail | null> {
  const [l] = await db
    .select({
      id: lawyers.id,
      poolId: lawyers.poolId,
      name: lawyers.name,
      kind: lawyers.kind,
      position: lawyers.position,
      firmId: lawyers.firmId,
      organization: lawyers.organization,
      preseasonRank: lawyers.preseasonRank,
    })
    .from(lawyers)
    .where(and(eq(lawyers.id, lawyerId), eq(lawyers.poolId, poolId)));
  return l ?? null;
}

export type LawyerCase = {
  id: string;
  caption: string;
  court: string;
  docketNumber: string | null;
  caseType: CaseType;
  status: "active" | "closed";
  filedOn: string | null;
  sourceUrl: string | null;
  /** Which of the requested lawyers appear on the case, and on which side. */
  appearances: { lawyerId: string; lawyerName: string; side: Side }[];
};

/** Cases where any of the given lawyers appear (for a firm, pass the firm and its lawyers). */
export async function loadLawyerCases(db: DbOrTx, poolId: string, lawyerIds: string[]): Promise<LawyerCase[]> {
  if (lawyerIds.length === 0) return [];
  const rows = await db
    .select({
      id: cases.id,
      caption: cases.caption,
      court: cases.court,
      docketNumber: cases.docketNumber,
      caseType: cases.caseType,
      status: cases.status,
      filedOn: cases.filedOn,
      sourceUrl: cases.sourceUrl,
      lawyerId: caseAppearances.lawyerId,
      lawyerName: lawyers.name,
      side: caseAppearances.side,
    })
    .from(caseAppearances)
    .innerJoin(cases, eq(cases.id, caseAppearances.caseId))
    .innerJoin(lawyers, eq(lawyers.id, caseAppearances.lawyerId))
    .where(and(eq(cases.poolId, poolId), inArray(caseAppearances.lawyerId, lawyerIds)));
  const byCase = new Map<string, LawyerCase>();
  for (const r of rows) {
    let c = byCase.get(r.id);
    if (!c) {
      c = {
        id: r.id,
        caption: r.caption,
        court: r.court,
        docketNumber: r.docketNumber,
        caseType: r.caseType,
        status: r.status,
        filedOn: r.filedOn,
        sourceUrl: r.sourceUrl,
        appearances: [],
      };
      byCase.set(r.id, c);
    }
    c.appearances.push({ lawyerId: r.lawyerId, lawyerName: r.lawyerName, side: r.side });
  }
  const out = [...byCase.values()];
  for (const c of out) c.appearances.sort((a, b) => a.lawyerName.localeCompare(b.lawyerName));
  // Active first, then most recently filed, then caption.
  return out.sort(
    (a, b) =>
      Number(a.status === "closed") - Number(b.status === "closed") ||
      (b.filedOn ?? "").localeCompare(a.filedOn ?? "") ||
      a.caption.localeCompare(b.caption),
  );
}

export type EventDetail = {
  id: string;
  type: string;
  occurredOn: string;
  summary: string;
  sourceUrl: string | null;
  caseId: string | null;
  caseCaption: string | null;
  caseSourceUrl: string | null;
};

/** Scoring events by id (limited to one pool), with their case caption. */
export async function loadEventDetails(db: DbOrTx, poolId: string, eventIds: string[]): Promise<Map<string, EventDetail>> {
  if (eventIds.length === 0) return new Map();
  const rows = await db
    .select({
      id: scoringEvents.id,
      type: scoringEvents.type,
      occurredOn: scoringEvents.occurredOn,
      summary: scoringEvents.summary,
      sourceUrl: scoringEvents.sourceUrl,
      caseId: scoringEvents.caseId,
      caseCaption: cases.caption,
      caseSourceUrl: cases.sourceUrl,
    })
    .from(scoringEvents)
    .leftJoin(cases, eq(cases.id, scoringEvents.caseId))
    .where(and(eq(scoringEvents.poolId, poolId), inArray(scoringEvents.id, eventIds)));
  return new Map(rows.map((r) => [r.id, r]));
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

export type LeagueTeamInfo = {
  id: string;
  name: string;
  ownerId: string;
  ownerName: string;
  waiverPriority: number | null;
  createdAt: Date;
};

export async function loadLeagueTeams(db: DbOrTx, leagueId: string): Promise<LeagueTeamInfo[]> {
  return db
    .select({
      id: teams.id,
      name: teams.name,
      ownerId: teams.ownerId,
      ownerName: users.displayName,
      waiverPriority: teams.waiverPriority,
      createdAt: teams.createdAt,
    })
    .from(teams)
    .innerJoin(users, eq(users.id, teams.ownerId))
    .where(eq(teams.leagueId, leagueId))
    .orderBy(asc(teams.name));
}

// ---------------------------------------------------------------------------
// Waiver claims
// ---------------------------------------------------------------------------

export type ClaimView = {
  id: string;
  claimOrder: number;
  status: "pending" | "won" | "lost" | "cancelled";
  addLawyerId: string;
  addName: string;
  addPosition: Position;
  dropLawyerId: string | null;
  dropName: string | null;
  createdAt: Date;
  processedAt: Date | null;
};

const dropLawyer = alias(lawyers, "drop_lawyer");

function claimSelect(db: DbOrTx) {
  return db
    .select({
      id: waiverClaims.id,
      claimOrder: waiverClaims.claimOrder,
      status: waiverClaims.status,
      addLawyerId: waiverClaims.addLawyerId,
      addName: lawyers.name,
      addPosition: lawyers.position,
      dropLawyerId: waiverClaims.dropLawyerId,
      dropName: dropLawyer.name,
      createdAt: waiverClaims.createdAt,
      processedAt: waiverClaims.processedAt,
    })
    .from(waiverClaims)
    .innerJoin(lawyers, eq(lawyers.id, waiverClaims.addLawyerId))
    .leftJoin(dropLawyer, eq(dropLawyer.id, waiverClaims.dropLawyerId));
}

/** A team's pending claims in its own order (1 = most wanted). */
export async function loadPendingClaims(db: DbOrTx, leagueId: string, teamId: string): Promise<ClaimView[]> {
  return claimSelect(db)
    .where(and(eq(waiverClaims.leagueId, leagueId), eq(waiverClaims.teamId, teamId), eq(waiverClaims.status, "pending")))
    .orderBy(asc(waiverClaims.claimOrder), asc(waiverClaims.createdAt));
}

/** A team's most recently processed claims (won or lost), newest first. */
export async function loadProcessedClaims(db: DbOrTx, leagueId: string, teamId: string, limit = 20): Promise<ClaimView[]> {
  return claimSelect(db)
    .where(
      and(eq(waiverClaims.leagueId, leagueId), eq(waiverClaims.teamId, teamId), inArray(waiverClaims.status, ["won", "lost"])),
    )
    .orderBy(desc(waiverClaims.processedAt), asc(waiverClaims.claimOrder))
    .limit(limit);
}

/** Lawyer ids a team has pending claims on (for "Claimed" markers). */
export async function loadPendingClaimLawyerIds(db: DbOrTx, teamId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ id: waiverClaims.addLawyerId, order: waiverClaims.claimOrder })
    .from(waiverClaims)
    .where(and(eq(waiverClaims.teamId, teamId), eq(waiverClaims.status, "pending")));
  return new Map(rows.map((r) => [r.id, r.order]));
}
