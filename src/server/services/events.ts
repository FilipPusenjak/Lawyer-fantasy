/**
 * Scoring events: create, review (approve / reject / move back to pending),
 * edit and list. Events belong to a pool and count for every league using it
 * once approved; point values come from each league's scoring settings.
 * Automatic suggestions (origin "courtlistener") can arrive incomplete (no
 * side / no lawyer yet): approval skips those until the commissioner picks
 * (see eventMissing, approveWithChoices).
 *
 * No request/cookie access (and no runtime import of "@/db"), so the seed
 * script and unit tests can import this module.
 */
import { and, asc, count, desc, eq, ilike, inArray, lte, ne, or, sql, type SQL } from "drizzle-orm";
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
// Completeness (pure) — can approving this event credit anyone?
// ---------------------------------------------------------------------------

/**
 * What an event still needs before it can be approved. Automatic suggestions
 * (court records) may arrive without a side (side couldn't be inferred) or
 * without a lawyer (e.g. "sanctioned" when the docket doesn't say who).
 */
export type EventMissing = "type" | "case" | "side" | "lawyer" | "points";

export type EventTargetFields = {
  type: string;
  caseId: string | null;
  side: Side | null;
  lawyerId: string | null;
  customPoints: number | null;
};

/**
 * Same shape rules as normalizeEventInput: lawyer-specific types need a
 * lawyer; "custom" needs points plus a lawyer or a case + side; every other
 * type needs a case + side. Unknown types need a real type picked first.
 * (Whether anyone is listed on that side yet doesn't matter: the event starts
 * scoring as soon as lawyers are added to the case.)
 */
export function eventMissing(e: EventTargetFields): EventMissing | null {
  if (!(EVENT_TYPES as readonly string[]).includes(e.type)) return "type";
  const type = e.type as EventType;
  if (LAWYER_SPECIFIC_EVENTS.has(type)) return e.lawyerId ? null : "lawyer";
  if (type === "custom") {
    if (e.customPoints === null || !Number.isFinite(e.customPoints)) return "points";
    if (e.lawyerId) return null;
  }
  if (!e.caseId) return "case";
  if (!e.side) return "side";
  return null;
}

export function isEventComplete(e: EventTargetFields): boolean {
  return eventMissing(e) === null;
}

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

  const caseId = input.caseId;
  let { side, lawyerId } = input;
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

export type ApproveSkip = {
  id: string;
  /** What the event still needs (null when `error` explains the skip instead). */
  missing: EventMissing | null;
  /** Why the commissioner's choice for this event couldn't be saved. */
  error?: string;
};

export type ApproveReport = {
  /** Approved now, in the order given. */
  approved: string[];
  /** Still pending: incomplete (wouldn't credit anyone) or the choice couldn't be applied. */
  skipped: ApproveSkip[];
  /** Not in this pool or already reviewed. */
  notPending: string[];
};

/**
 * Approve pending events that are complete (see eventMissing). Incomplete
 * ones stay pending and come back in `skipped`; ids outside the pool or
 * already reviewed come back in `notPending`.
 */
export async function approveEventsWithReport(
  db: DbOrTx,
  poolId: string,
  ids: string[],
  reviewerId: string | null,
  now: Date = new Date(),
): Promise<ApproveReport> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return { approved: [], skipped: [], notPending: [] };
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: scoringEvents.id,
        status: scoringEvents.status,
        type: scoringEvents.type,
        caseId: scoringEvents.caseId,
        side: scoringEvents.side,
        lawyerId: scoringEvents.lawyerId,
        customPoints: scoringEvents.customPoints,
      })
      .from(scoringEvents)
      .where(and(eq(scoringEvents.poolId, poolId), inArray(scoringEvents.id, unique)))
      .for("update");
    const byId = new Map(rows.map((r) => [r.id, r]));
    const report: ApproveReport = { approved: [], skipped: [], notPending: [] };
    for (const id of unique) {
      const r = byId.get(id);
      if (!r || r.status !== "pending") report.notPending.push(id);
      else {
        const missing = eventMissing(r);
        if (missing) report.skipped.push({ id, missing });
        else report.approved.push(id);
      }
    }
    if (report.approved.length > 0) {
      await tx
        .update(scoringEvents)
        .set({ status: "approved", reviewedBy: reviewerId, reviewedAt: now })
        .where(and(eq(scoringEvents.poolId, poolId), inArray(scoringEvents.id, report.approved), eq(scoringEvents.status, "pending")));
    }
    return report;
  });
}

/**
 * Approve pending events. Ids outside the pool, already reviewed, or
 * incomplete (they wouldn't credit anyone) are left alone; use
 * approveEventsWithReport to learn which. Returns how many were approved.
 */
export async function approveEvents(
  db: DbOrTx,
  poolId: string,
  ids: string[],
  reviewerId: string | null,
  now: Date = new Date(),
): Promise<number> {
  const report = await approveEventsWithReport(db, poolId, ids, reviewerId, now);
  return report.approved.length;
}

/** The commissioner's picks for a pending event in the review queue. */
export type EventChoice = { type?: EventType; side?: Side | null; lawyerId?: string | null };

/**
 * Review queue "Approve": save each event's choices (type / side / lawyer)
 * and approve, all in one transaction. An event whose choice can't be saved
 * (still incomplete, lawyer outside the pool…) or that is still incomplete is
 * skipped and stays pending; the others are approved.
 */
export async function approveWithChoices(
  db: DbOrTx,
  args: {
    poolId: string;
    reviewerId: string | null;
    items: { id: string; choice?: EventChoice }[];
    now?: Date;
  },
): Promise<ApproveReport> {
  const now = args.now ?? new Date();
  const items = [...new Map(args.items.map((i) => [i.id, i])).values()];
  if (items.length === 0) return { approved: [], skipped: [], notPending: [] };
  return db.transaction(async (tx) => {
    const current = await tx
      .select({ id: scoringEvents.id, status: scoringEvents.status, type: scoringEvents.type, side: scoringEvents.side, lawyerId: scoringEvents.lawyerId })
      .from(scoringEvents)
      .where(and(eq(scoringEvents.poolId, args.poolId), inArray(scoringEvents.id, items.map((i) => i.id))));
    const pending = new Map(current.filter((r) => r.status === "pending").map((r) => [r.id, r]));
    const notPending: string[] = [];
    const failed: ApproveSkip[] = [];
    const ready: string[] = [];
    for (const item of items) {
      const row = pending.get(item.id);
      if (!row) {
        notPending.push(item.id);
        continue;
      }
      // Cards always submit their type select; only touch events whose picks change something.
      const choice = item.choice ? withoutUndefined(item.choice) : {};
      const changes = (Object.keys(choice) as (keyof EventChoice)[]).some((k) => choice[k] !== row[k]);
      if (changes) {
        try {
          await updateEvent(tx, args.poolId, item.id, choice, { onlyPending: true });
        } catch (e) {
          if (!(e instanceof UserError)) throw e;
          failed.push({ id: item.id, missing: null, error: e.message });
          continue;
        }
      }
      ready.push(item.id);
    }
    const report = await approveEventsWithReport(tx, args.poolId, ready, args.reviewerId, now);
    // Keep the caller's order for skipped events.
    const order = new Map(items.map((i, n) => [i.id, n]));
    const skipped = [...failed, ...report.skipped].sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    return { approved: report.approved, skipped, notPending: [...notPending, ...report.notPending] };
  });
}

function withoutUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
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

/**
 * Reject every pending event on one case (noisy dockets), optionally only one
 * origin and only events created by `createdBefore` (so suggestions that
 * arrived after the commissioner loaded the page aren't swept up unseen).
 * Returns the rejected ids.
 */
export async function rejectCaseEvents(
  db: DbOrTx,
  poolId: string,
  caseId: string,
  reviewerId: string | null,
  opts: { origin?: EventOrigin; createdBefore?: Date; now?: Date } = {},
): Promise<string[]> {
  const conds: SQL[] = [eq(scoringEvents.poolId, poolId), eq(scoringEvents.caseId, caseId), eq(scoringEvents.status, "pending")];
  if (opts.origin) conds.push(eq(scoringEvents.origin, opts.origin));
  if (opts.createdBefore) conds.push(lte(scoringEvents.createdAt, opts.createdBefore));
  const rows = await db
    .update(scoringEvents)
    .set({ status: "rejected", reviewedBy: reviewerId, reviewedAt: opts.now ?? new Date() })
    .where(and(...conds))
    .returning({ id: scoringEvents.id });
  return rows.map((r) => r.id);
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

/** Some of an event's fields; omitted (undefined) fields keep their current value. */
export type EventPatch = Partial<EventInput>;

const EVENT_INPUT_KEYS = ["type", "caseId", "side", "lawyerId", "occurredOn", "summary", "sourceUrl", "customPoints"] as const;

/** Court text can run long; an untouched summary is clipped rather than blocking a side/type change. */
function clipSummary(s: string): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > SUMMARY_MAX ? `${t.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : t;
}

/**
 * Edit an event's facts (its status doesn't change). Pass a full EventInput
 * (edit form) or a patch (review queue: e.g. `{ side }`, `{ type, lawyerId }`)
 * that is merged over the current values. The result must be a complete,
 * valid event and its case/lawyer must be in the pool. With `onlyPending`,
 * refuses events that were already reviewed. A patch that changes nothing is a
 * no-op.
 */
export async function updateEvent(
  db: DbOrTx,
  poolId: string,
  id: string,
  raw: EventInput | EventPatch,
  opts: { onlyPending?: boolean } = {},
): Promise<void> {
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        origin: scoringEvents.origin,
        status: scoringEvents.status,
        type: scoringEvents.type,
        caseId: scoringEvents.caseId,
        side: scoringEvents.side,
        lawyerId: scoringEvents.lawyerId,
        occurredOn: scoringEvents.occurredOn,
        summary: scoringEvents.summary,
        sourceUrl: scoringEvents.sourceUrl,
        customPoints: scoringEvents.customPoints,
      })
      .from(scoringEvents)
      .where(and(eq(scoringEvents.id, id), eq(scoringEvents.poolId, poolId)))
      .for("update");
    if (!existing) throw new UserError("That event isn't in this pool.");
    if (opts.onlyPending && existing.status !== "pending") throw new UserError("That event was already reviewed. Refresh to see its status.");

    const isFull = EVENT_INPUT_KEYS.every((k) => raw[k] !== undefined);
    if (!isFull && EVENT_INPUT_KEYS.every((k) => raw[k] === undefined || raw[k] === existing[k])) return;
    const merged: EventInput = isFull
      ? (raw as EventInput)
      : {
          type: (raw.type ?? existing.type) as EventType,
          caseId: raw.caseId !== undefined ? raw.caseId : existing.caseId,
          side: raw.side !== undefined ? raw.side : existing.side,
          lawyerId: raw.lawyerId !== undefined ? raw.lawyerId : existing.lawyerId,
          occurredOn: raw.occurredOn ?? existing.occurredOn,
          summary: raw.summary ?? clipSummary(existing.summary),
          sourceUrl: raw.sourceUrl !== undefined ? raw.sourceUrl : existing.sourceUrl,
          customPoints: raw.customPoints !== undefined ? raw.customPoints : existing.customPoints,
        };
    const input = normalizeEventInput(merged, { requireSource: existing.origin === "manual" });
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
  origins?: EventOrigin[];
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
  if (f.origins?.length) conds.push(inArray(scoringEvents.origin, f.origins));
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

export type PendingEventRow = EventRow & {
  /** False when approving it wouldn't credit anyone yet (see eventMissing). */
  complete: boolean;
  missing: EventMissing | null;
};

export type PendingFilter = { origin?: EventOrigin; caseId?: string };

/** Review queue: pending events in the pool, oldest first, optionally one origin and/or one case. */
export async function listPending(db: DbOrTx, poolId: string, limit = 200, filter: PendingFilter = {}): Promise<PendingEventRow[]> {
  const rows = await listEvents(db, poolId, {
    statuses: ["pending"],
    origins: filter.origin ? [filter.origin] : undefined,
    caseId: filter.caseId,
    oldestFirst: true,
    limit,
  });
  return rows.map((r) => {
    const missing = eventMissing(r);
    return { ...r, complete: missing === null, missing };
  });
}

export async function countPending(db: DbOrTx, poolId: string): Promise<number> {
  const [r] = await db
    .select({ n: count() })
    .from(scoringEvents)
    .where(and(eq(scoringEvents.poolId, poolId), eq(scoringEvents.status, "pending")));
  return r?.n ?? 0;
}

/** Pending events per origin (plus the total), e.g. for "N new suggestions from court records". */
export async function countPendingByOrigin(db: DbOrTx, poolId: string): Promise<Record<EventOrigin, number> & { total: number }> {
  const rows = await db
    .select({ origin: scoringEvents.origin, n: count() })
    .from(scoringEvents)
    .where(and(eq(scoringEvents.poolId, poolId), eq(scoringEvents.status, "pending")))
    .groupBy(scoringEvents.origin);
  const out = { manual: 0, courtlistener: 0, ai: 0, total: 0 };
  for (const r of rows) {
    out[r.origin] += r.n;
    out.total += r.n;
  }
  return out;
}

/** Pending events grouped by origin and case, for the review queue's filters and counts. */
export type PendingGroup = {
  origin: EventOrigin;
  caseId: string | null;
  caseCaption: string | null;
  caseDocket: string | null;
  count: number;
  /** How many of them still need a side / lawyer / type before they can be approved. */
  incomplete: number;
};

export async function pendingGroups(db: DbOrTx, poolId: string): Promise<PendingGroup[]> {
  const hasLawyer = sql<boolean>`(${scoringEvents.lawyerId} is not null)`;
  const hasPoints = sql<boolean>`(${scoringEvents.customPoints} is not null)`;
  const rows = await db
    .select({
      origin: scoringEvents.origin,
      caseId: scoringEvents.caseId,
      caseCaption: cases.caption,
      caseDocket: cases.docketNumber,
      type: scoringEvents.type,
      side: scoringEvents.side,
      hasLawyer,
      hasPoints,
      n: count(),
    })
    .from(scoringEvents)
    .leftJoin(cases, eq(cases.id, scoringEvents.caseId))
    .where(and(eq(scoringEvents.poolId, poolId), eq(scoringEvents.status, "pending")))
    .groupBy(scoringEvents.origin, scoringEvents.caseId, cases.caption, cases.docketNumber, scoringEvents.type, scoringEvents.side, hasLawyer, hasPoints);
  const groups = new Map<string, PendingGroup>();
  for (const r of rows) {
    const key = `${r.origin}|${r.caseId ?? ""}`;
    let g = groups.get(key);
    if (!g) {
      g = { origin: r.origin, caseId: r.caseId, caseCaption: r.caseCaption, caseDocket: r.caseDocket, count: 0, incomplete: 0 };
      groups.set(key, g);
    }
    g.count += r.n;
    // Only null-ness of the lawyer and points matters for completeness.
    const missing = eventMissing({
      type: r.type,
      caseId: r.caseId,
      side: r.side,
      lawyerId: r.hasLawyer ? "set" : null,
      customPoints: r.hasPoints ? 0 : null,
    });
    if (missing) g.incomplete += r.n;
  }
  return [...groups.values()];
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
