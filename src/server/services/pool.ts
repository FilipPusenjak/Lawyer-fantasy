/**
 * Player pool management: lawyers, firms, cases and case appearances.
 *
 * Every function takes the pool id and verifies that each referenced lawyer,
 * firm, case or appearance belongs to that pool. Authorization (commissioner +
 * canManagePool) happens in the Server Actions. No request/cookie access here,
 * so the seed script can use these too.
 */
import { and, asc, count, eq, ilike, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { DbOrTx } from "@/db";
import {
  caseAppearances,
  cases,
  draftPicks,
  lawyers,
  leagues,
  rosterSpots,
  scoringEvents,
  type Case,
  type Lawyer,
} from "@/db/schema";
import { firmKey, planFirmImport } from "@/lib/firms";
import type { CaseType, Position, Side } from "@/lib/settings";
import { UserError } from "@/server/action-result";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IndividualPosition = Exclude<Position, "firm">;
export type CaseStatus = "active" | "closed";

export type LawyerInput = {
  name: string;
  position: IndividualPosition;
  /** A firm (kind "firm") in the same pool, or null. */
  firmId: string | null;
  organization: string | null;
  preseasonRank: number | null;
};

export type FirmInput = {
  name: string;
  organization: string | null;
  preseasonRank: number | null;
};

export type CaseInput = {
  caption: string;
  court: string;
  docketNumber: string | null;
  caseType: CaseType;
  status: CaseStatus;
  /** YYYY-MM-DD */
  filedOn: string | null;
  sourceUrl: string | null;
};

/** One parsed row of the lawyers CSV ("name,position,firm,organization,rank"). */
export type LawyerImportRow = {
  line: number;
  name: string;
  position: Position;
  firm: string | null;
  organization: string | null;
  rank: number | null;
};

/** One parsed row of the cases CSV ("caption,court,docket_number,case_type,source_url"). */
export type CaseImportRow = {
  line: number;
  caption: string;
  court: string;
  docketNumber: string | null;
  caseType: CaseType;
  sourceUrl: string | null;
};

/** One parsed row of the appearances CSV ("lawyer_name,docket_number_or_caption,side"). */
export type AppearanceImportRow = {
  line: number;
  lawyerName: string;
  caseRef: string;
  side: Side;
};

export type ImportProblem = { line: number; message: string };

export type PoolLawyerRow = {
  id: string;
  name: string;
  kind: "lawyer" | "firm";
  position: Position;
  firmId: string | null;
  firmName: string | null;
  organization: string | null;
  preseasonRank: number | null;
};

export type PoolCaseRow = Case & { appearanceCount: number };

export type AppearanceRow = {
  id: string;
  side: Side;
  lawyerId: string;
  name: string;
  kind: "lawyer" | "firm";
  position: Position;
};

export type LawyerCaseRow = {
  appearanceId: string;
  caseId: string;
  caption: string;
  court: string;
  docketNumber: string | null;
  caseType: CaseType;
  status: CaseStatus;
  side: Side;
};

export type LawyerUsage = {
  /** Names of leagues where a team has this lawyer. */
  rosteredIn: string[];
  /** Number of draft picks (in any league) that took this lawyer. */
  draftPicks: number;
  /** Approved scoring events that name this lawyer directly. */
  approvedEvents: number;
  /** Lineup rows (any league) that start this lawyer. Deleting them would rewrite those weeks' scores. */
  lineupStarts?: number;
  /** Approved case events this lawyer earned points from through their case appearances. */
  caseEvents?: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** "%q%" for ILIKE with %, _ and \ escaped. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function norm(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

async function assertNameAvailable(db: DbOrTx, poolId: string, name: string, exceptId?: string): Promise<void> {
  const conds: SQL[] = [eq(lawyers.poolId, poolId), sql`lower(${lawyers.name}) = ${norm(name)}`];
  if (exceptId) conds.push(ne(lawyers.id, exceptId));
  const [hit] = await db.select({ id: lawyers.id, kind: lawyers.kind }).from(lawyers).where(and(...conds)).limit(1);
  if (hit) {
    throw new UserError(
      hit.kind === "firm" ? `There's already a firm named “${name}” in this pool.` : `There's already a lawyer named “${name}” in this pool.`,
    );
  }
}

async function assertFirmInPool(db: DbOrTx, poolId: string, firmId: string): Promise<void> {
  const [f] = await db
    .select({ id: lawyers.id })
    .from(lawyers)
    .where(and(eq(lawyers.id, firmId), eq(lawyers.poolId, poolId), eq(lawyers.kind, "firm")));
  if (!f) throw new UserError("Pick a firm from this pool.");
}

async function isRosteredAnywhere(db: DbOrTx, lawyerId: string): Promise<boolean> {
  const [r] = await db.select({ id: rosterSpots.id }).from(rosterSpots).where(eq(rosterSpots.lawyerId, lawyerId)).limit(1);
  return !!r;
}

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

export async function poolCounts(db: DbOrTx, poolId: string): Promise<{ lawyers: number; firms: number; cases: number }> {
  const [kinds, [caseCount]] = await Promise.all([
    db.select({ kind: lawyers.kind, n: count() }).from(lawyers).where(eq(lawyers.poolId, poolId)).groupBy(lawyers.kind),
    db.select({ n: count() }).from(cases).where(eq(cases.poolId, poolId)),
  ]);
  return {
    lawyers: kinds.find((k) => k.kind === "lawyer")?.n ?? 0,
    firms: kinds.find((k) => k.kind === "firm")?.n ?? 0,
    cases: caseCount?.n ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Lawyers & firms
// ---------------------------------------------------------------------------

export async function listPoolLawyers(
  db: DbOrTx,
  poolId: string,
  opts: { kind: "lawyer" | "firm"; q?: string; position?: IndividualPosition; limit?: number },
): Promise<PoolLawyerRow[]> {
  const firm = alias(lawyers, "firm");
  const conds: SQL[] = [eq(lawyers.poolId, poolId), eq(lawyers.kind, opts.kind)];
  const q = opts.q?.trim();
  if (q) {
    const p = likePattern(q);
    conds.push(or(ilike(lawyers.name, p), ilike(lawyers.organization, p), ilike(firm.name, p))!);
  }
  if (opts.position) conds.push(eq(lawyers.position, opts.position));
  return db
    .select({
      id: lawyers.id,
      name: lawyers.name,
      kind: lawyers.kind,
      position: lawyers.position,
      firmId: lawyers.firmId,
      firmName: firm.name,
      organization: lawyers.organization,
      preseasonRank: lawyers.preseasonRank,
    })
    .from(lawyers)
    .leftJoin(firm, eq(firm.id, lawyers.firmId))
    .where(and(...conds))
    .orderBy(sql`${lawyers.preseasonRank} asc nulls last`, asc(lawyers.name))
    .limit(opts.limit ?? 500);
}

/** Every firm in the pool (for selects), by name. */
export async function listPoolFirms(db: DbOrTx, poolId: string): Promise<{ id: string; name: string }[]> {
  return db
    .select({ id: lawyers.id, name: lawyers.name })
    .from(lawyers)
    .where(and(eq(lawyers.poolId, poolId), eq(lawyers.kind, "firm")))
    .orderBy(asc(lawyers.name));
}

/** Every lawyer and firm in the pool (for selects): lawyers first, then firms, by name. */
export async function listLawyerOptions(
  db: DbOrTx,
  poolId: string,
): Promise<{ id: string; name: string; kind: "lawyer" | "firm"; position: Position }[]> {
  return db
    .select({ id: lawyers.id, name: lawyers.name, kind: lawyers.kind, position: lawyers.position })
    .from(lawyers)
    .where(eq(lawyers.poolId, poolId))
    .orderBy(asc(lawyers.kind), asc(lawyers.name));
}

/** firmId -> number of individual lawyers in that firm. */
export async function firmMemberCounts(db: DbOrTx, poolId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ firmId: lawyers.firmId, n: count() })
    .from(lawyers)
    .where(and(eq(lawyers.poolId, poolId), eq(lawyers.kind, "lawyer"), sql`${lawyers.firmId} is not null`))
    .groupBy(lawyers.firmId);
  return new Map(rows.filter((r) => r.firmId).map((r) => [r.firmId!, r.n]));
}

export async function firmMembers(db: DbOrTx, poolId: string, firmId: string) {
  return db
    .select({ id: lawyers.id, name: lawyers.name, position: lawyers.position })
    .from(lawyers)
    .where(and(eq(lawyers.poolId, poolId), eq(lawyers.firmId, firmId), eq(lawyers.kind, "lawyer")))
    .orderBy(asc(lawyers.name));
}

export async function getPoolLawyer(db: DbOrTx, poolId: string, lawyerId: string): Promise<Lawyer | null> {
  const [l] = await db.select().from(lawyers).where(and(eq(lawyers.id, lawyerId), eq(lawyers.poolId, poolId)));
  return l ?? null;
}

async function requirePoolLawyer(db: DbOrTx, poolId: string, lawyerId: string, kind?: "lawyer" | "firm"): Promise<Lawyer> {
  const l = await getPoolLawyer(db, poolId, lawyerId);
  if (!l || (kind && l.kind !== kind)) throw new UserError(kind === "firm" ? "That firm isn't in this pool." : "That lawyer isn't in this pool.");
  return l;
}

export async function createLawyer(db: DbOrTx, poolId: string, input: LawyerInput): Promise<Lawyer> {
  await assertNameAvailable(db, poolId, input.name);
  if (input.firmId) await assertFirmInPool(db, poolId, input.firmId);
  const [l] = await db
    .insert(lawyers)
    .values({
      poolId,
      name: input.name,
      kind: "lawyer",
      position: input.position,
      firmId: input.firmId,
      organization: input.organization,
      preseasonRank: input.preseasonRank,
    })
    .returning();
  return l;
}

export async function updateLawyer(db: DbOrTx, poolId: string, lawyerId: string, input: LawyerInput): Promise<void> {
  const existing = await requirePoolLawyer(db, poolId, lawyerId, "lawyer");
  await assertNameAvailable(db, poolId, input.name, lawyerId);
  if (input.firmId) await assertFirmInPool(db, poolId, input.firmId);
  if (input.position !== existing.position && (await isRosteredAnywhere(db, lawyerId))) {
    throw new UserError(`A team has ${existing.name} right now, so their position can't change (it would break lineups).`);
  }
  await db
    .update(lawyers)
    .set({
      name: input.name,
      position: input.position,
      firmId: input.firmId,
      organization: input.organization,
      preseasonRank: input.preseasonRank,
    })
    .where(eq(lawyers.id, lawyerId));
}

export async function createFirm(db: DbOrTx, poolId: string, input: FirmInput): Promise<Lawyer> {
  await assertNameAvailable(db, poolId, input.name);
  const [f] = await db
    .insert(lawyers)
    .values({
      poolId,
      name: input.name,
      kind: "firm",
      position: "firm",
      firmId: null,
      organization: input.organization,
      preseasonRank: input.preseasonRank,
    })
    .returning();
  return f;
}

export async function updateFirm(db: DbOrTx, poolId: string, firmId: string, input: FirmInput): Promise<void> {
  await requirePoolLawyer(db, poolId, firmId, "firm");
  await assertNameAvailable(db, poolId, input.name, firmId);
  await db
    .update(lawyers)
    .set({ name: input.name, organization: input.organization, preseasonRank: input.preseasonRank })
    .where(eq(lawyers.id, firmId));
}

/** What would block deleting a lawyer/firm. */
export async function lawyerUsage(db: DbOrTx, lawyerId: string): Promise<LawyerUsage> {
  const [rostered, [picks], [events], lineupRows, caseRows] = await Promise.all([
    db
      .selectDistinct({ name: leagues.name })
      .from(rosterSpots)
      .innerJoin(leagues, eq(leagues.id, rosterSpots.leagueId))
      .where(eq(rosterSpots.lawyerId, lawyerId)),
    db.select({ n: count() }).from(draftPicks).where(eq(draftPicks.lawyerId, lawyerId)),
    db
      .select({ n: count() })
      .from(scoringEvents)
      .where(and(eq(scoringEvents.lawyerId, lawyerId), eq(scoringEvents.status, "approved"))),
    db.execute(sql`select count(*)::int as n from lineups where starters @> ${JSON.stringify([lawyerId])}::jsonb`),
    db.execute(
      sql`select count(*)::int as n from scoring_events e
          join case_appearances a on a.case_id = e.case_id and a.side = e.side
          where a.lawyer_id = ${lawyerId} and e.status = 'approved'`,
    ),
  ]);
  const n = (r: { rows: unknown[] }) => Number((r.rows[0] as { n?: number } | undefined)?.n ?? 0);
  return {
    rosteredIn: rostered.map((r) => r.name),
    draftPicks: picks?.n ?? 0,
    approvedEvents: events?.n ?? 0,
    lineupStarts: n(lineupRows),
    caseEvents: n(caseRows),
  };
}

/** Why a lawyer/firm can't be deleted, or null if it can. */
export function deleteBlocker(name: string, usage: LawyerUsage): string | null {
  if (usage.rosteredIn.length > 0) {
    return `${name} is on a team in ${usage.rosteredIn.join(", ")}. The team has to drop them before they can be deleted.`;
  }
  if (usage.draftPicks > 0) {
    return `${name} was picked in a draft, so deleting them would break the draft board. Leave them in the pool instead.`;
  }
  if (usage.approvedEvents > 0) {
    return `${name} has approved scoring events. Move those back to pending or reject them first.`;
  }
  if ((usage.lineupStarts ?? 0) > 0 || (usage.caseEvents ?? 0) > 0) {
    return `${name} has already scored or been in a starting lineup, so deleting them would change past scores. Leave them in the pool instead.`;
  }
  return null;
}

/**
 * Delete a lawyer or firm. Blocked when a team has them, a draft picked them,
 * or approved events name them. A firm's members are unlinked from it.
 */
export async function deleteLawyer(db: DbOrTx, poolId: string, lawyerId: string): Promise<{ name: string; kind: "lawyer" | "firm" }> {
  return db.transaction(async (tx) => {
    const l = await requirePoolLawyer(tx, poolId, lawyerId);
    const blocker = deleteBlocker(l.name, await lawyerUsage(tx, lawyerId));
    if (blocker) throw new UserError(blocker);
    if (l.kind === "firm") {
      await tx.update(lawyers).set({ firmId: null }).where(and(eq(lawyers.poolId, poolId), eq(lawyers.firmId, lawyerId)));
    }
    await tx.delete(lawyers).where(eq(lawyers.id, lawyerId));
    return { name: l.name, kind: l.kind };
  });
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

export async function listPoolCases(
  db: DbOrTx,
  poolId: string,
  opts: { q?: string; status?: CaseStatus; limit?: number } = {},
): Promise<PoolCaseRow[]> {
  const conds: SQL[] = [eq(cases.poolId, poolId)];
  const q = opts.q?.trim();
  if (q) {
    const p = likePattern(q);
    conds.push(or(ilike(cases.caption, p), ilike(cases.docketNumber, p), ilike(cases.court, p))!);
  }
  if (opts.status) conds.push(eq(cases.status, opts.status));
  const rows = await db
    .select()
    .from(cases)
    .where(and(...conds))
    .orderBy(asc(cases.status), asc(cases.caption))
    .limit(opts.limit ?? 500);
  if (rows.length === 0) return [];
  const counts = await db
    .select({ caseId: caseAppearances.caseId, n: count() })
    .from(caseAppearances)
    .where(
      inArray(
        caseAppearances.caseId,
        rows.map((r) => r.id),
      ),
    )
    .groupBy(caseAppearances.caseId);
  const byCase = new Map(counts.map((c) => [c.caseId, c.n]));
  return rows.map((r) => ({ ...r, appearanceCount: byCase.get(r.id) ?? 0 }));
}

/** Compact case list for selects (active cases first). */
export async function listCaseOptions(db: DbOrTx, poolId: string) {
  return db
    .select({
      id: cases.id,
      caption: cases.caption,
      court: cases.court,
      docketNumber: cases.docketNumber,
      caseType: cases.caseType,
      status: cases.status,
    })
    .from(cases)
    .where(eq(cases.poolId, poolId))
    .orderBy(asc(cases.status), asc(cases.caption));
}

export async function getPoolCase(db: DbOrTx, poolId: string, caseId: string): Promise<Case | null> {
  const [c] = await db.select().from(cases).where(and(eq(cases.id, caseId), eq(cases.poolId, poolId)));
  return c ?? null;
}

async function requirePoolCase(db: DbOrTx, poolId: string, caseId: string): Promise<Case> {
  const c = await getPoolCase(db, poolId, caseId);
  if (!c) throw new UserError("That case isn't in this pool.");
  return c;
}

async function assertDocketAvailable(db: DbOrTx, poolId: string, input: CaseInput, exceptId?: string): Promise<void> {
  if (!input.docketNumber) return;
  const conds: SQL[] = [
    eq(cases.poolId, poolId),
    sql`lower(${cases.docketNumber}) = ${norm(input.docketNumber)}`,
    sql`lower(${cases.court}) = ${norm(input.court)}`,
  ];
  if (exceptId) conds.push(ne(cases.id, exceptId));
  const [hit] = await db.select({ caption: cases.caption }).from(cases).where(and(...conds)).limit(1);
  if (hit) throw new UserError(`Docket ${input.docketNumber} in ${input.court} is already in the pool (${hit.caption}).`);
}

export async function createCase(db: DbOrTx, poolId: string, input: CaseInput): Promise<Case> {
  await assertDocketAvailable(db, poolId, input);
  const [c] = await db.insert(cases).values({ poolId, ...input }).returning();
  return c;
}

export async function updateCase(db: DbOrTx, poolId: string, caseId: string, input: CaseInput): Promise<void> {
  await requirePoolCase(db, poolId, caseId);
  await assertDocketAvailable(db, poolId, input, caseId);
  await db.update(cases).set(input).where(eq(cases.id, caseId));
}

export async function approvedEventCount(db: DbOrTx, caseId: string): Promise<number> {
  const [r] = await db
    .select({ n: count() })
    .from(scoringEvents)
    .where(and(eq(scoringEvents.caseId, caseId), eq(scoringEvents.status, "approved")));
  return r?.n ?? 0;
}

/** Delete a case with its appearances and unapproved events. Blocked if it has approved events. */
export async function deleteCase(db: DbOrTx, poolId: string, caseId: string): Promise<{ caption: string }> {
  return db.transaction(async (tx) => {
    const c = await requirePoolCase(tx, poolId, caseId);
    const approved = await approvedEventCount(tx, caseId);
    if (approved > 0) {
      throw new UserError(
        `This case has ${approved} approved scoring event${approved === 1 ? "" : "s"}. Move them back to pending or reject them first, or mark the case closed instead.`,
      );
    }
    await tx.delete(cases).where(eq(cases.id, caseId));
    return { caption: c.caption };
  });
}

// ---------------------------------------------------------------------------
// Appearances
// ---------------------------------------------------------------------------

export async function listCaseAppearances(db: DbOrTx, caseId: string): Promise<AppearanceRow[]> {
  return db
    .select({
      id: caseAppearances.id,
      side: caseAppearances.side,
      lawyerId: lawyers.id,
      name: lawyers.name,
      kind: lawyers.kind,
      position: lawyers.position,
    })
    .from(caseAppearances)
    .innerJoin(lawyers, eq(lawyers.id, caseAppearances.lawyerId))
    .where(eq(caseAppearances.caseId, caseId))
    .orderBy(asc(caseAppearances.side), asc(lawyers.kind), asc(lawyers.name));
}

export async function listLawyerCases(db: DbOrTx, poolId: string, lawyerId: string): Promise<LawyerCaseRow[]> {
  return db
    .select({
      appearanceId: caseAppearances.id,
      caseId: cases.id,
      caption: cases.caption,
      court: cases.court,
      docketNumber: cases.docketNumber,
      caseType: cases.caseType,
      status: cases.status,
      side: caseAppearances.side,
    })
    .from(caseAppearances)
    .innerJoin(cases, eq(cases.id, caseAppearances.caseId))
    .where(and(eq(caseAppearances.lawyerId, lawyerId), eq(cases.poolId, poolId)))
    .orderBy(asc(cases.status), asc(cases.caption));
}

export async function addAppearance(
  db: DbOrTx,
  poolId: string,
  args: { caseId: string; lawyerId: string; side: Side },
): Promise<{ lawyerName: string }> {
  await requirePoolCase(db, poolId, args.caseId);
  const l = await requirePoolLawyer(db, poolId, args.lawyerId);
  const rows = await db
    .insert(caseAppearances)
    .values({ caseId: args.caseId, lawyerId: args.lawyerId, side: args.side })
    .onConflictDoNothing()
    .returning({ id: caseAppearances.id });
  if (rows.length === 0) throw new UserError(`${l.name} is already on this case. Remove them first to switch sides.`);
  return { lawyerName: l.name };
}

export async function removeAppearance(db: DbOrTx, poolId: string, appearanceId: string): Promise<{ lawyerName: string; caseId: string }> {
  const [a] = await db
    .select({ id: caseAppearances.id, caseId: caseAppearances.caseId, lawyerName: lawyers.name })
    .from(caseAppearances)
    .innerJoin(cases, eq(cases.id, caseAppearances.caseId))
    .innerJoin(lawyers, eq(lawyers.id, caseAppearances.lawyerId))
    .where(and(eq(caseAppearances.id, appearanceId), eq(cases.poolId, poolId)));
  if (!a) throw new UserError("That appearance is already gone.");
  await db.delete(caseAppearances).where(eq(caseAppearances.id, appearanceId));
  return { lawyerName: a.lawyerName, caseId: a.caseId };
}

// ---------------------------------------------------------------------------
// CSV imports (rows come from the pure parsers in commish/pool/csv.ts)
// ---------------------------------------------------------------------------

/**
 * Import lawyers (and firms). Names already in the pool are skipped. A firm
 * named in the "firm" column is created if it doesn't exist yet.
 */
export async function importLawyers(
  db: DbOrTx,
  poolId: string,
  rows: LawyerImportRow[],
): Promise<{ created: number; firmsCreated: number; skipped: string[]; problems: ImportProblem[] }> {
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: lawyers.id, name: lawyers.name, kind: lawyers.kind })
      .from(lawyers)
      .where(eq(lawyers.poolId, poolId));
    const byName = new Map(existing.map((l) => [norm(l.name), l]));
    const problems: ImportProblem[] = [];
    const skipped: string[] = [];

    // 1. Firms: explicit firm rows plus firms referenced by lawyers, matched by firmKey so two spellings
    // of one firm ("Susman Godfrey LLP" / "Susman Godfrey L.L.P.") never become two firms.
    for (const r of rows) {
      if (r.position === "firm" || !r.firm) continue;
      const hit = byName.get(norm(r.firm));
      if (hit && hit.kind !== "firm") problems.push({ line: r.line, message: `“${r.firm}” is a lawyer in the pool, not a firm.` });
    }
    if (problems.length > 0) return { created: 0, firmsCreated: 0, skipped, problems };

    const firmByKey = new Map(existing.filter((l) => l.kind === "firm").map((f) => [firmKey(f.name), f]));
    // A firm row whose exact name is already a pool lawyer is left alone (reported as skipped below).
    const planned = planFirmImport(
      existing.filter((l) => l.kind === "firm").map((f) => f.name),
      rows.filter((r) => !(r.position === "firm" && byName.has(norm(r.name)))),
    );
    const createdNames = new Set<string>();
    if (planned.length > 0) {
      const inserted = await tx
        .insert(lawyers)
        .values(
          planned.map((f) => ({
            poolId,
            name: f.name,
            kind: "firm" as const,
            position: "firm" as const,
            organization: f.organization,
            preseasonRank: f.rank,
          })),
        )
        .returning({ id: lawyers.id, name: lawyers.name, kind: lawyers.kind });
      for (const f of inserted) {
        byName.set(norm(f.name), f);
        firmByKey.set(firmKey(f.name), f);
        createdNames.add(norm(f.name));
      }
    }
    const firmsCreated = createdNames.size;

    // 2. Individual lawyers.
    const values: (typeof lawyers.$inferInsert)[] = [];
    for (const r of rows) {
      if (r.position === "firm") continue;
      if (byName.has(norm(r.name))) {
        skipped.push(r.name);
        continue;
      }
      const firmId = r.firm ? (firmByKey.get(firmKey(r.firm))?.id ?? null) : null;
      values.push({
        poolId,
        name: r.name,
        kind: "lawyer",
        position: r.position,
        firmId,
        organization: r.organization,
        preseasonRank: r.rank,
      });
    }
    // Firm rows that weren't created (already in the pool, or another spelling of a firm in this file) count as skipped.
    for (const r of rows) {
      if (r.position === "firm" && !createdNames.has(norm(r.name))) skipped.push(r.name);
    }
    if (values.length > 0) await tx.insert(lawyers).values(values);
    return { created: values.length, firmsCreated, skipped, problems };
  });
}

function caseKey(court: string, docket: string): string {
  return `${norm(court)}|${norm(docket)}`;
}

/** Import cases. Rows whose docket number (same court), or caption when there's no docket, already exists are skipped. */
export async function importCases(db: DbOrTx, poolId: string, rows: CaseImportRow[]): Promise<{ created: number; skipped: string[] }> {
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ caption: cases.caption, court: cases.court, docketNumber: cases.docketNumber })
      .from(cases)
      .where(eq(cases.poolId, poolId));
    const dockets = new Set(existing.filter((c) => c.docketNumber).map((c) => caseKey(c.court, c.docketNumber!)));
    const captions = new Set(existing.map((c) => `${norm(c.court)}|${norm(c.caption)}`));
    const skipped: string[] = [];
    const values: (typeof cases.$inferInsert)[] = [];
    for (const r of rows) {
      const dup = r.docketNumber ? dockets.has(caseKey(r.court, r.docketNumber)) : captions.has(`${norm(r.court)}|${norm(r.caption)}`);
      if (dup) {
        skipped.push(r.caption);
        continue;
      }
      if (r.docketNumber) dockets.add(caseKey(r.court, r.docketNumber));
      captions.add(`${norm(r.court)}|${norm(r.caption)}`);
      values.push({
        poolId,
        caption: r.caption,
        court: r.court,
        docketNumber: r.docketNumber,
        caseType: r.caseType,
        sourceUrl: r.sourceUrl,
      });
    }
    if (values.length > 0) await tx.insert(cases).values(values);
    return { created: values.length, skipped };
  });
}

/**
 * Import appearances. Lawyers are matched by exact name (any case), cases by
 * docket number first, then caption. Nothing is saved if any row can't be
 * matched; the problems are returned instead. Existing appearances are skipped.
 */
export async function importAppearances(
  db: DbOrTx,
  poolId: string,
  rows: AppearanceImportRow[],
): Promise<{ created: number; skipped: number; problems: ImportProblem[] }> {
  return db.transaction(async (tx) => {
    const [poolLawyers, poolCases, existing] = await Promise.all([
      tx.select({ id: lawyers.id, name: lawyers.name }).from(lawyers).where(eq(lawyers.poolId, poolId)),
      tx.select({ id: cases.id, caption: cases.caption, docketNumber: cases.docketNumber }).from(cases).where(eq(cases.poolId, poolId)),
      tx
        .select({ caseId: caseAppearances.caseId, lawyerId: caseAppearances.lawyerId })
        .from(caseAppearances)
        .innerJoin(cases, eq(cases.id, caseAppearances.caseId))
        .where(eq(cases.poolId, poolId)),
    ]);
    const lawyersByName = new Map<string, string[]>();
    for (const l of poolLawyers) lawyersByName.set(norm(l.name), [...(lawyersByName.get(norm(l.name)) ?? []), l.id]);
    const byDocket = new Map<string, string[]>();
    const byCaption = new Map<string, string[]>();
    for (const c of poolCases) {
      if (c.docketNumber) byDocket.set(norm(c.docketNumber), [...(byDocket.get(norm(c.docketNumber)) ?? []), c.id]);
      byCaption.set(norm(c.caption), [...(byCaption.get(norm(c.caption)) ?? []), c.id]);
    }
    const have = new Set(existing.map((e) => `${e.caseId}|${e.lawyerId}`));

    const problems: ImportProblem[] = [];
    const values: { caseId: string; lawyerId: string; side: Side }[] = [];
    let skipped = 0;
    for (const r of rows) {
      const ls = lawyersByName.get(norm(r.lawyerName)) ?? [];
      const cs = byDocket.get(norm(r.caseRef)) ?? byCaption.get(norm(r.caseRef)) ?? [];
      if (ls.length === 0) problems.push({ line: r.line, message: `No lawyer or firm named “${r.lawyerName}” in the pool.` });
      else if (ls.length > 1) problems.push({ line: r.line, message: `More than one lawyer is named “${r.lawyerName}”.` });
      if (cs.length === 0) problems.push({ line: r.line, message: `No case with docket number or caption “${r.caseRef}”.` });
      else if (cs.length > 1) problems.push({ line: r.line, message: `More than one case matches “${r.caseRef}”. Use the docket number.` });
      if (ls.length !== 1 || cs.length !== 1) continue;
      const key = `${cs[0]}|${ls[0]}`;
      if (have.has(key)) {
        skipped++;
        continue;
      }
      have.add(key);
      values.push({ caseId: cs[0], lawyerId: ls[0], side: r.side });
    }
    if (problems.length > 0) return { created: 0, skipped: 0, problems };
    if (values.length > 0) await tx.insert(caseAppearances).values(values).onConflictDoNothing();
    return { created: values.length, skipped, problems };
  });
}
