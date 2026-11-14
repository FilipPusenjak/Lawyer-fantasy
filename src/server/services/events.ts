/**
 * Scoring events: create, review (approve / reject / move back to pending),
 * edit and list. Events belong to a pool and count for every league using it
 * once approved; point values come from each league's scoring settings.
 *
 * No request/cookie access (and no runtime import of "@/db"), so the seed
 * script and unit tests can import this module.
 */
import { and, asc, count, desc, eq, ilike, inArray, ne, or, type SQL } from "drizzle-orm";
import type { DbOrTx } from "@/db";
import { caseAppearances, cases, lawyers, scoringEvents, weekFinalizations, type ScoringEvent } from "@/db/schema";
import { eventValue, round2 } from "@/lib/scoring";
import {
  EVENT_TYPES,
  LAWYER_SPECIFIC_EVENTS,
  otherSide,
  type CaseType,
  type EventType,
  type ScoringSettings,
  type Side,
} from "@/lib/settings";
import { UserError } from "@/server/action-result";
import { likePattern } from "./pool";

export const SUMMARY_MAX = 300;
export const SOURCE_URL_MAX = 500;
export const CUSTOM_POINTS_LIMIT = 100;

export type EventStatus = "pending" | "approved" | "rejected";
export type EventOrigin = "manual" | "courtlistener" | "ai";

/**
 * What an event is about. Either a case + side (credits every lawyer/firm on
 * that side) or one lawyer (lawyer-specific types like "sanctioned"; a case may
 * be attached for context). "custom" can be either.
 */
export type EventInput = {
  type: EventType;
  caseId: string | null;
  side: Side | null;
  lawyerId: string | null;
  /** YYYY-MM-DD */
  occurredOn: string;
  summary: string;
  sourceUrl: string | null;
  /** Only for "custom". */
  customPoints: number | null;
};

export type EventRow = {
  id: string;
  type: string;
  status: EventStatus;
  origin: EventOrigin;
  occurredOn: string;
  summary: string;
  sourceUrl: string | null;
  customPoints: number | null;
  caseId: string | null;
  side: Side | null;
  lawyerId: string | null;
  caseCaption: string | null;
  caseType: CaseType | null;
  caseCourt: string | null;
  caseDocket: string | null;
  lawyerName: string | null;
  createdAt: Date;
  reviewedAt: Date | null;
};

// ---------------------------------------------------------------------------
// Credits (pure) — mirrors the targeting rules in src/lib/scoring.ts
// ---------------------------------------------------------------------------

export type CreditLawyer = { id: string; name: string; kind: "lawyer" | "firm"; firmId: string | null };
export type CreditAppearance = { caseId: string; lawyerId: string; side: Side };
export type CreditIndex = { bySide: Map<string, string[]>; lawyers: Map<string, CreditLawyer> };
export type EventCredit = { lawyerId: string; name: string; kind: "lawyer" | "firm"; points: number; viaFirm: boolean };

export function creditIndex(appearances: CreditAppearance[], poolLawyers: CreditLawyer[]): CreditIndex {
  const bySide = new Map<string, string[]>();
  for (const a of appearances) {
    const k = `${a.caseId}|${a.side}`;
    const arr = bySide.get(k);
    if (arr) arr.push(a.lawyerId);
    else bySide.set(k, [a.lawyerId]);
  }
  return { bySide, lawyers: new Map(poolLawyers.map((l) => [l.id, l])) };
}

/**
 * Who an event credits: individual lawyers get the full value; a firm gets
 * value × firmMultiplier once if it is a target itself or any targeted lawyer
 * belongs to it. Same rules as computeLawyerPoints.
 */
export function eventCreditTargets(
  event: { caseId: string | null; side: Side | null; lawyerId: string | null },
  index: CreditIndex,
): { individuals: string[]; firms: string[] } {
  let targets: string[];
  if (event.lawyerId) targets = [event.lawyerId];
  else if (event.caseId && event.side) targets = index.bySide.get(`${event.caseId}|${event.side}`) ?? [];
  else targets = [];
  const individuals = new Set<string>();
  const firms = new Set<string>();
  for (const t of targets) {
    const l = index.lawyers.get(t);
    if (!l) continue;
    if (l.kind === "firm") firms.add(l.id);
    else {
      individuals.add(l.id);
      if (l.firmId && index.lawyers.get(l.firmId)?.kind === "firm") firms.add(l.firmId);
    }
  }
  return { individuals: [...individuals], firms: [...firms] };
}

/**
 * Points an event would give each credited lawyer/firm under a league's
 * scoring (on its own: "filing" is capped at the weekly cap, but other filings
 * in the same week aren't considered). Includes 0-point credits so the
 * commissioner can see who is on that side.
 */
export function eventCredits(
  event: { type: string; customPoints: number | null; caseId: string | null; side: Side | null; lawyerId: string | null },
  index: CreditIndex,
  scoring: ScoringSettings,
): EventCredit[] {
  const value = eventValue(event, scoring);
  const raw = event.type === "filing" ? Math.max(0, Math.min(value, scoring.filingWeeklyCap)) : value;
  const { individuals, firms } = eventCreditTargets(event, index);
  const out: EventCredit[] = [];
  for (const id of individuals) {
    const l = index.lawyers.get(id)!;
    out.push({ lawyerId: id, name: l.name, kind: l.kind, points: round2(raw), viaFirm: false });
  }
  for (const id of firms) {
    const l = index.lawyers.get(id)!;
    out.push({ lawyerId: id, name: l.name, kind: l.kind, points: round2(raw * scoring.firmMultiplier), viaFirm: true });
  }
  return out;
}

export async function loadCreditIndex(db: DbOrTx, poolId: string): Promise<CreditIndex> {
  const [apps, poolLawyers] = await Promise.all([
    db
      .select({ caseId: caseAppearances.caseId, lawyerId: caseAppearances.lawyerId, side: caseAppearances.side })
      .from(caseAppearances)
      .innerJoin(cases, eq(cases.id, caseAppearances.caseId))
      .where(eq(cases.poolId, poolId)),
    db
      .select({ id: lawyers.id, name: lawyers.name, kind: lawyers.kind, firmId: lawyers.firmId })
      .from(lawyers)
      .where(eq(lawyers.poolId, poolId)),
  ]);
  return creditIndex(apps, poolLawyers);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname;
  } catch {
    return false;
  }
}

function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Normalize and check an event's shape (no DB). Throws UserError.
 * Manual events must link to a public source.
 */
export function normalizeEventInput(input: EventInput, opts: { requireSource: boolean }): EventInput {
  if (!(EVENT_TYPES as readonly string[]).includes(input.type)) throw new UserError("Pick an event type.");
  const type = input.type;
  if (!isIsoDate(input.occurredOn)) throw new UserError("Pick the date the event happened.");
  const summary = input.summary.trim().replace(/\s+/g, " ");
  if (!summary) throw new UserError("Add a short, factual summary.");
  if (summary.length > SUMMARY_MAX) throw new UserError(`Keep the summary under ${SUMMARY_MAX} characters.`);
  const sourceUrl = input.sourceUrl?.trim() || null;
  if (sourceUrl && (sourceUrl.length > SOURCE_URL_MAX || !isHttpUrl(sourceUrl))) {
    throw new UserError("The source link must start with http:// or https://.");
  }
  if (!sourceUrl && opts.requireSource) throw new UserError("Add a link to the public record (court site, docket, news story).");

  let customPoints: number | null = null;
  if (type === "custom") {
    const p = input.customPoints;
    if (p === null || !Number.isFinite(p)) throw new UserError("Enter the points for this custom event.");
    if (Math.abs(p) > CUSTOM_POINTS_LIMIT) throw new UserError(`Custom points must be between -${CUSTOM_POINTS_LIMIT} and ${CUSTOM_POINTS_LIMIT}.`);
    customPoints = round2(p);
  }

  let { caseId, side, lawyerId } = input;
  if (LAWYER_SPECIFIC_EVENTS.has(type) || (type === "custom" && lawyerId)) {
    if (!lawyerId) throw new UserError("Pick the lawyer this event is about.");
    side = null; // the case (if any) is just context
  } else {
    lawyerId = null;
    if (!caseId) throw new UserError("Pick the case.");
    if (!side) throw new UserError("Pick which side of the case this is for.");
  }
  return { type, caseId: caseId || null, side, lawyerId, occurredOn: input.occurredOn, summary, sourceUrl, customPoints };
}

async function assertTargetsInPool(db: DbOrTx, poolId: string, input: EventInput): Promise<void> {
  if (input.caseId) {
    const [c] = await db.select({ id: cases.id }).from(cases).where(and(eq(cases.id, input.caseId), eq(cases.poolId, poolId)));
    if (!c) throw new UserError("That case isn't in this league's player pool.");
  }
  if (input.lawyerId) {
    const [l] = await db
      .select({ id: lawyers.id })
      .from(lawyers)
      .where(and(eq(lawyers.id, input.lawyerId), eq(lawyers.poolId, poolId)));
    if (!l) throw new UserError("That lawyer isn't in this league's player pool.");
  }
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Create an event (pending, or approved right away). With `alsoRecordLoss` on
 * a case-based "verdict_win", also records a "verdict_loss" for the other side.
 * Returns the created events.
 */
export async function createEvent(
  db: DbOrTx,
  args: {
    poolId: string;
    input: EventInput;
    createdBy: string | null;
    origin?: EventOrigin;
    approve?: boolean;
    alsoRecordLoss?: boolean;
    externalRef?: string | null;
    now?: Date;
  },
): Promise<ScoringEvent[]> {
  const origin = args.origin ?? "manual";
  const input = normalizeEventInput(args.input, { requireSource: origin === "manual" });
  const now = args.now ?? new Date();
  return db.transaction(async (tx) => {
    await assertTargetsInPool(tx, args.poolId, input);
    const review = args.approve
      ? { status: "approved" as const, reviewedBy: args.createdBy, reviewedAt: now }
      : { status: "pending" as const, reviewedBy: null, reviewedAt: null };
    const base = {
      poolId: args.poolId,
      caseId: input.caseId,
      side: input.side,
      lawyerId: input.lawyerId,
      occurredOn: input.occurredOn,
      summary: input.summary,
      sourceUrl: input.sourceUrl,
      origin,
      createdBy: args.createdBy,
      ...review,
    };
    const values: (typeof scoringEvents.$inferInsert)[] = [
      { ...base, type: input.type, customPoints: input.customPoints, externalRef: args.externalRef ?? null },
    ];
    if (args.alsoRecordLoss && input.type === "verdict_win" && input.caseId && input.side) {
      values.push({ ...base, type: "verdict_loss", side: otherSide(input.side), customPoints: null, externalRef: null });
    }
    return tx.insert(scoringEvents).values(values).returning();
  });
}

/** Approve pending events (ids outside the pool or already reviewed are ignored). Returns how many were approved. */
export async function approveEvents(
  db: DbOrTx,
  poolId: string,
  ids: string[],
  reviewerId: string | null,
  now: Date = new Date(),
): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await db
    .update(scoringEvents)
    .set({ status: "approved", reviewedBy: reviewerId, reviewedAt: now })
    .where(and(eq(scoringEvents.poolId, poolId), inArray(scoringEvents.id, ids), eq(scoringEvents.status, "pending")))
    .returning({ id: scoringEvents.id });
  return rows.length;
}

/** Reject a pending event. */
export async function rejectEvent(db: DbOrTx, poolId: string, id: string, reviewerId: string | null, now: Date = new Date()): Promise<void> {
  const rows = await db
    .update(scoringEvents)
    .set({ status: "rejected", reviewedBy: reviewerId, reviewedAt: now })
    .where(and(eq(scoringEvents.poolId, poolId), eq(scoringEvents.id, id), eq(scoringEvents.status, "pending")))
    .returning({ id: scoringEvents.id });
  if (rows.length === 0) throw new UserError("That event was already reviewed. Refresh to see its status.");
}

/** Move an approved or rejected event back to the review queue. */
export async function revertEvent(db: DbOrTx, poolId: string, id: string): Promise<void> {
  const rows = await db
    .update(scoringEvents)
    .set({ status: "pending", reviewedBy: null, reviewedAt: null })
    .where(and(eq(scoringEvents.poolId, poolId), eq(scoringEvents.id, id), ne(scoringEvents.status, "pending")))
    .returning({ id: scoringEvents.id });
  if (rows.length === 0) throw new UserError("That event is already in the review queue.");
}

/** Edit an event's facts (its status doesn't change). */
export async function updateEvent(db: DbOrTx, poolId: string, id: string, raw: EventInput): Promise<void> {
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ origin: scoringEvents.origin })
      .from(scoringEvents)
      .where(and(eq(scoringEvents.id, id), eq(scoringEvents.poolId, poolId)));
    if (!existing) throw new UserError("That event isn't in this pool.");
    const input = normalizeEventInput(raw, { requireSource: existing.origin === "manual" });
    await assertTargetsInPool(tx, poolId, input);
    await tx
      .update(scoringEvents)
      .set({
        type: input.type,
        caseId: input.caseId,
        side: input.side,
        lawyerId: input.lawyerId,
        occurredOn: input.occurredOn,
        summary: input.summary,
        sourceUrl: input.sourceUrl,
        customPoints: input.customPoints,
      })
      .where(eq(scoringEvents.id, id));
  });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const eventColumns = {
  id: scoringEvents.id,
  type: scoringEvents.type,
  status: scoringEvents.status,
  origin: scoringEvents.origin,
  occurredOn: scoringEvents.occurredOn,
  summary: scoringEvents.summary,
  sourceUrl: scoringEvents.sourceUrl,
  customPoints: scoringEvents.customPoints,
  caseId: scoringEvents.caseId,
  side: scoringEvents.side,
  lawyerId: scoringEvents.lawyerId,
  caseCaption: cases.caption,
  caseType: cases.caseType,
  caseCourt: cases.court,
  caseDocket: cases.docketNumber,
  lawyerName: lawyers.name,
  createdAt: scoringEvents.createdAt,
  reviewedAt: scoringEvents.reviewedAt,
};

export type EventFilter = {
  statuses?: EventStatus[];
  type?: EventType;
  q?: string;
  caseId?: string;
  /** Oldest first (review queue) instead of newest first. */
  oldestFirst?: boolean;
  limit?: number;
  offset?: number;
};

export async function listEvents(db: DbOrTx, poolId: string, f: EventFilter = {}): Promise<EventRow[]> {
  const conds: SQL[] = [eq(scoringEvents.poolId, poolId)];
  if (f.statuses?.length) conds.push(inArray(scoringEvents.status, f.statuses));
  if (f.type) conds.push(eq(scoringEvents.type, f.type));
  if (f.caseId) conds.push(eq(scoringEvents.caseId, f.caseId));
  const q = f.q?.trim();
  if (q) {
    const p = likePattern(q);
    conds.push(or(ilike(scoringEvents.summary, p), ilike(cases.caption, p), ilike(cases.docketNumber, p), ilike(lawyers.name, p))!);
  }
  const order = f.oldestFirst
    ? [asc(scoringEvents.occurredOn), asc(scoringEvents.createdAt), asc(scoringEvents.id)]
    : [desc(scoringEvents.occurredOn), desc(scoringEvents.createdAt), desc(scoringEvents.id)];
  return db
    .select(eventColumns)
    .from(scoringEvents)
    .leftJoin(cases, eq(cases.id, scoringEvents.caseId))
    .leftJoin(lawyers, eq(lawyers.id, scoringEvents.lawyerId))
    .where(and(...conds))
    .orderBy(...order)
    .limit(f.limit ?? 200)
    .offset(f.offset ?? 0);
}

/** Review queue: pending events in the pool, oldest first. */
export async function listPending(db: DbOrTx, poolId: string, limit = 200): Promise<EventRow[]> {
  return listEvents(db, poolId, { statuses: ["pending"], oldestFirst: true, limit });
}

export async function countPending(db: DbOrTx, poolId: string): Promise<number> {
  const [r] = await db
    .select({ n: count() })
    .from(scoringEvents)
    .where(and(eq(scoringEvents.poolId, poolId), eq(scoringEvents.status, "pending")));
  return r?.n ?? 0;
}

export async function getPoolEvent(db: DbOrTx, poolId: string, id: string): Promise<EventRow | null> {
  const [row] = await db
    .select(eventColumns)
    .from(scoringEvents)
    .leftJoin(cases, eq(cases.id, scoringEvents.caseId))
    .leftJoin(lawyers, eq(lawyers.id, scoringEvents.lawyerId))
    .where(and(eq(scoringEvents.id, id), eq(scoringEvents.poolId, poolId)));
  return row ?? null;
}

/** Weeks this league has finalized (late approvals in these weeks don't count until reopened). */
export async function finalizedWeeks(db: DbOrTx, leagueId: string): Promise<Set<number>> {
  const rows = await db.select({ week: weekFinalizations.week }).from(weekFinalizations).where(eq(weekFinalizations.leagueId, leagueId));
  return new Set(rows.map((r) => r.week));
}
