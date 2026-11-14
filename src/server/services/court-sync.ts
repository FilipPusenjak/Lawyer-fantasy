/**
 * Court data sync (Phase 2). CONTRACT FILE: the exported signatures below are
 * fixed; extra helpers are additions.
 *
 * Sources:
 * - U.S. Supreme Court cases (case_type supreme_court, docket like "25-159"):
 *   https://www.supremecourt.gov/RSS/Cases/JSON/<docket>.json (no token, no quota).
 * - Other federal cases with cases.courtlistenerDocketId: CourtListener v4
 *   docket entries (token required; shared free quota).
 *
 * New court activity becomes PENDING scoring events (origin "courtlistener"
 * for both sources, externalRef unique per pool, e.g. "cl-entry:123" or
 * "scotus:25-159:7") with a suggested type and, when it can be inferred, a
 * side or a specific lawyer. Nothing counts until the commissioner approves.
 *
 * Rules (see src/lib/court/sync-plan.ts):
 * - Cursor: SCOTUS = number of proceedings already seen; CourtListener = the
 *   last date_modified seen (first sync starts 14 days back).
 * - First sync of a case only suggests activity from the last 14 days (the
 *   cursor still moves past older entries); later syncs ignore entries dated
 *   more than 30 days ago (old documents newly added to CourtListener).
 * - At most 15 suggestions per case per run; the rest wait for the next run.
 * - Inserts use ON CONFLICT (pool_id, external_ref) DO NOTHING, so re-syncs
 *   never duplicate suggestions.
 * - Supreme Court arguments: one lawyer-specific scotus_argument per arguing
 *   lawyer who matches a pool lawyer by name (lawyers on the case first, then a
 *   unique exact match anywhere in the pool). Arguers not in the pool are
 *   skipped (no lawyer-less argument suggestions).
 * - CourtListener "sanctioned" suggestions have no lawyer (the commissioner
 *   picks one); verdicts with an explicit winner also get a pending
 *   verdict_loss for the other side.
 * - Demo pools (pools.is_demo) are fictional and never sync.
 *
 * No runtime import of "@/db" (the seed script and tests can import this).
 */
import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { DbOrTx } from "@/db";
import { caseAppearances, cases, lawyers, leagues, pools, scoringEvents, type Case } from "@/db/schema";
import { courtIdFromText, docketNumbersMatch, docketSearchTerm } from "@/lib/court/courts";
import { normalizeScotusDocket, parseScotusDocket, scotusJsonUrl, type ScotusDocket } from "@/lib/court/scotus";
import { courtListenerCandidates, FIRST_SYNC_DAYS, planCourtListener, planScotus, type AiVerdicts, type PlannedEvent } from "@/lib/court/sync-plan";
import { isGovernmentParty, partiesFromCaption, partyCore, type NamedLawyer, type PartyNames } from "@/lib/court/text";
import { UserError } from "@/server/action-result";
import { AI_MAX_ENTRIES, AiClassifyError, aiConfigured, classifyEntriesWithClaude, type AiClient } from "@/server/court/ai-classify";
import {
  CourtListenerError,
  COURTLISTENER_SITE,
  courtListenerConfigured,
  fetchDocketEntries,
  NOT_CONNECTED_MESSAGE,
  searchDockets,
  type ClDocket,
} from "@/server/court/courtlistener";

export type SyncSource = "scotus" | "courtlistener";

export type SyncResult = {
  caseId: string;
  caption: string;
  source: SyncSource;
  /** New docket entries / proceedings seen this run. */
  newEntries: number;
  /** Pending scoring events created this run. */
  suggestions: number;
  error?: string;
  /** Phase 3: entries Claude sorted this run, or why the keyword rules were used instead. */
  claude?: { sorted: number; error?: string };
};

/** cases.syncError marker for cases autoLinkPoolCases couldn't match (skipped by later auto-link runs; cleared by linkCaseToDocket). */
export const AUTO_LINK_NOT_FOUND = "Not found on CourtListener";

const ACTIVE_LEAGUE_STATUSES = ["drafting", "in_season", "playoffs"] as const;
/** CourtListener free tier: requests per rolling minute. */
const CL_PER_MINUTE = 5;
const CL_PAGES_PER_CASE = 2;
/** Unlinked federal cases the daily run tries to auto-link per pool. */
const AUTO_LINK_PER_POOL = 5;
const FETCH_TIMEOUT_MS = 20_000;
/** Phase 3: Claude requests per daily run (one per case with new activity); caps cost at about $1 a day. */
const CLAUDE_CALLS_PER_RUN = 10;

/** "25-159" when the case is a Supreme Court case with a docket number in that form, else null. */
export function scotusDocketFromCase(c: { caseType: string; docketNumber: string | null }): string | null {
  return c.caseType === "supreme_court" ? normalizeScotusDocket(c.docketNumber) : null;
}

/** Which source a case syncs from, or null if it can't sync (not linked / not SCOTUS). */
export function syncSourceForCase(c: { caseType: string; docketNumber: string | null; courtlistenerDocketId: number | null }): SyncSource | null {
  if (scotusDocketFromCase(c)) return "scotus";
  if (c.courtlistenerDocketId !== null && c.courtlistenerDocketId !== undefined) return "courtlistener";
  return null;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/** Fetch and parse a Supreme Court docket from the public JSON feed. Null when the docket doesn't exist. */
export async function fetchScotusDocket(docket: string): Promise<ScotusDocket | null> {
  let res: Response;
  try {
    res = await fetch(scotusJsonUrl(docket), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    throw new Error("Couldn't reach supremecourt.gov. Will retry on the next sync.");
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`supremecourt.gov error (HTTP ${res.status}). Will retry on the next sync.`);
  const body = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(body.replace(/^﻿/, ""));
  } catch {
    // The site answers unknown dockets with an HTML page.
    return null;
  }
  return parseScotusDocket(json);
}

// ---------------------------------------------------------------------------
// One case
// ---------------------------------------------------------------------------

type CaseLawyer = { id: string; name: string; kind: "lawyer" | "firm"; side: "plaintiff" | "defendant" };
type Internal = { result: SyncResult; requests: number; rateLimited: boolean };

async function caseLawyers(db: DbOrTx, caseId: string): Promise<CaseLawyer[]> {
  return db
    .select({ id: lawyers.id, name: lawyers.name, kind: lawyers.kind, side: caseAppearances.side })
    .from(caseAppearances)
    .innerJoin(lawyers, eq(lawyers.id, caseAppearances.lawyerId))
    .where(eq(caseAppearances.caseId, caseId));
}

async function insertPlanned(db: DbOrTx, c: Case, events: PlannedEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  const rows = await db
    .insert(scoringEvents)
    .values(
      events.map((e) => ({
        poolId: c.poolId,
        caseId: c.id,
        side: e.side,
        lawyerId: e.lawyerId,
        type: e.type,
        occurredOn: e.occurredOn,
        summary: e.summary,
        sourceUrl: e.sourceUrl,
        status: "pending" as const,
        origin: "courtlistener" as const,
        externalRef: e.externalRef,
        suggestionNote: e.reason || null,
        suggestionConfidence: e.confidence ?? null,
        suggestionModel: e.model ?? null,
        createdBy: null,
      })),
    )
    .onConflictDoNothing({ target: [scoringEvents.poolId, scoringEvents.externalRef] })
    .returning({ id: scoringEvents.id });
  return rows.length;
}

function errorText(e: unknown): string {
  if (e instanceof CourtListenerError || e instanceof UserError) return e.message;
  if (e instanceof Error && /supremecourt\.gov|Supreme Court feed/.test(e.message)) return e.message;
  return "Sync failed unexpectedly. Will retry on the next sync.";
}

async function syncScotus(db: DbOrTx, c: Case, docket: string, now: Date, notBefore: string | null): Promise<Internal> {
  const base: SyncResult = { caseId: c.id, caption: c.caption, source: "scotus", newEntries: 0, suggestions: 0 };
  try {
    const feed = await fetchScotusDocket(docket);
    if (!feed) {
      const error = `Supreme Court docket ${docket} wasn't found on supremecourt.gov. Check the docket number.`;
      await db.update(cases).set({ syncedAt: now, syncError: error }).where(eq(cases.id, c.id));
      return { result: { ...base, error }, requests: 0, rateLimited: false };
    }
    const onCase = await caseLawyers(db, c.id);
    const caseIndividuals: NamedLawyer[] = onCase.filter((l) => l.kind === "lawyer");
    const onCaseIds = new Set(caseIndividuals.map((l) => l.id));
    const poolIndividuals = (
      await db
        .select({ id: lawyers.id, name: lawyers.name })
        .from(lawyers)
        .where(and(eq(lawyers.poolId, c.poolId), eq(lawyers.kind, "lawyer")))
    ).filter((l) => !onCaseIds.has(l.id));
    const plan = planScotus({
      docket,
      proceedings: feed.proceedings,
      cursor: c.syncCursor,
      now,
      petitionerTitle: feed.petitionerTitle,
      respondentTitle: feed.respondentTitle,
      caseLawyers: caseIndividuals,
      poolLawyers: poolIndividuals,
      notBefore,
    });
    const suggestions = await insertPlanned(db, c, plan.events);
    await db.update(cases).set({ syncedAt: now, syncCursor: plan.nextCursor, syncError: null }).where(eq(cases.id, c.id));
    return { result: { ...base, newEntries: plan.newEntries, suggestions }, requests: 0, rateLimited: false };
  } catch (e) {
    console.error(`[court-sync] Supreme Court sync failed for case ${c.id}`, e);
    const error = errorText(e);
    await db.update(cases).set({ syncedAt: now, syncError: error }).where(eq(cases.id, c.id));
    return { result: { ...base, error }, requests: 0, rateLimited: false };
  }
}

/** The case's CourtListener docket page when its source link is one (keeps the real slug for entry links). */
function knownDocketUrl(c: Case): string | null {
  const id = c.courtlistenerDocketId;
  if (!c.sourceUrl || !id) return null;
  const m = /^https:\/\/(?:www\.)?courtlistener\.com\/docket\/(\d+)\/([-a-zA-Z0-9_]*)\/?(?:[?#].*)?$/.exec(c.sourceUrl);
  return m && Number(m[1]) === id ? `${COURTLISTENER_SITE}/docket/${id}/${m[2] || "docket"}/` : null;
}

/** Phase 3: Claude budget for one run (requests and deadline). Tests pass a fake client. */
export type ClaudeBudget = { maxCalls: number; calls: number; deadline: number; client?: AiClient };
/** Don't start a Claude request with less time than this left before the run's deadline. */
const CLAUDE_MIN_TIME_LEFT_MS = 60_000;
const CLAUDE_TIMEOUT_MS = 75_000;

export function claudeBudget(maxCalls: number, deadline = Number.POSITIVE_INFINITY, client?: AiClient): ClaudeBudget {
  return { maxCalls: Math.max(0, Math.floor(maxCalls)), calls: 0, deadline, client };
}

/**
 * Ask Claude to sort this run's candidate entries. Returns null verdicts (so
 * the keyword rules are used) when Claude isn't connected, the run's Claude
 * budget or time is used up, or the request fails.
 */
async function sortWithClaude(
  c: Case,
  onCase: CaseLawyer[],
  candidates: { entryId: number; dateFiled: string | null; dateModified: string; description: string }[],
  budget: ClaudeBudget | null,
): Promise<{ ai: AiVerdicts | null; claude?: SyncResult["claude"] }> {
  if (!budget || candidates.length === 0 || (!budget.client && !aiConfigured())) return { ai: null };
  if (budget.calls >= budget.maxCalls) {
    return { ai: null, claude: { sorted: 0, error: "Claude's limit for this run was reached; keyword rules were used." } };
  }
  const left = budget.deadline - Date.now();
  if (left < CLAUDE_MIN_TIME_LEFT_MS) return { ai: null, claude: { sorted: 0, error: "Not enough time left in this run for Claude; keyword rules were used." } };
  budget.calls++;
  try {
    const ai = await classifyEntriesWithClaude(
      {
        caption: c.caption,
        court: c.court,
        docketNumber: c.docketNumber,
        caseType: c.caseType,
        lawyers: onCase.map((l) => ({ id: l.id, name: l.name, side: l.side, kind: l.kind })),
      },
      candidates.slice(0, AI_MAX_ENTRIES).map((e) => ({ entryId: e.entryId, date: e.dateFiled ?? e.dateModified.slice(0, 10), text: e.description })),
      { client: budget.client, timeoutMs: Math.min(CLAUDE_TIMEOUT_MS, left - 15_000), maxRetries: Number.isFinite(budget.deadline) ? 0 : 1 },
    );
    return { ai, claude: { sorted: ai.byEntry.size } };
  } catch (e) {
    const error = e instanceof AiClassifyError ? e.message : "Claude couldn't sort these entries; keyword rules were used.";
    console.error(`[court-sync] Claude sorting failed for case ${c.id}: ${error}`);
    return { ai: null, claude: { sorted: 0, error } };
  }
}

async function syncCourtListener(
  db: DbOrTx,
  c: Case,
  now: Date,
  maxPages: number,
  notBefore: string | null,
  claude: ClaudeBudget | null = null,
): Promise<Internal> {
  const base: SyncResult = { caseId: c.id, caption: c.caption, source: "courtlistener", newEntries: 0, suggestions: 0 };
  const docketId = c.courtlistenerDocketId;
  if (!docketId) return { result: { ...base, error: "This case isn't linked to a CourtListener docket." }, requests: 0, rateLimited: false };
  if (!courtListenerConfigured()) return { result: { ...base, error: NOT_CONNECTED_MESSAGE }, requests: 0, rateLimited: false };

  // First sync: only look 14 days back (the plan also limits suggestions to that window).
  const since = c.syncCursor ?? new Date(now.getTime() - FIRST_SYNC_DAYS * 86_400_000).toISOString();
  let requests = 0;
  try {
    const page = await fetchDocketEntries(docketId, { sinceIso: since, maxPages, docketUrl: knownDocketUrl(c) });
    requests = page.requests;
    const onCase = await caseLawyers(db, c.id);
    const attorneys: PartyNames = { plaintiff: [], defendant: [] };
    for (const l of onCase) if (l.kind === "lawyer") attorneys[l.side].push(l.name);
    const candidates = courtListenerCandidates({ entries: page.entries, cursor: c.syncCursor, now, notBefore });
    const { ai, claude: claudeInfo } = await sortWithClaude(c, onCase, candidates, claude);
    const plan = planCourtListener({
      entries: page.entries,
      cursor: c.syncCursor,
      now,
      caseType: c.caseType,
      caption: c.caption,
      attorneys,
      notBefore,
      ai,
    });
    const suggestions = await insertPlanned(db, c, plan.events);
    await db
      .update(cases)
      .set({ syncedAt: now, syncCursor: plan.nextCursor ?? since, syncError: null })
      .where(eq(cases.id, c.id));
    return {
      result: { ...base, newEntries: plan.newEntries, suggestions, ...(claudeInfo ? { claude: claudeInfo } : {}) },
      requests,
      rateLimited: false,
    };
  } catch (e) {
    const rateLimited = e instanceof CourtListenerError && e.status === 429;
    if (!rateLimited) console.error(`[court-sync] CourtListener sync failed for case ${c.id}`, e instanceof Error ? e.message : e);
    let error = errorText(e);
    if (e instanceof CourtListenerError && e.status === 404) error = "The linked CourtListener docket wasn't found. Check the link.";
    if (e instanceof CourtListenerError && requests === 0) requests = 1; // the failed request still counts against the quota
    // A rate-limited case keeps its place in line (syncedAt unchanged).
    await db
      .update(cases)
      .set(rateLimited ? { syncError: error } : { syncedAt: now, syncError: error })
      .where(eq(cases.id, c.id));
    return { result: { ...base, error }, requests, rateLimited };
  }
}

async function syncLoaded(
  db: DbOrTx,
  c: Case,
  now: Date,
  notBefore: string | null,
  maxPages = CL_PAGES_PER_CASE,
  claude: ClaudeBudget | null = null,
): Promise<Internal> {
  const docket = scotusDocketFromCase(c);
  if (docket) return syncScotus(db, c, docket, now, notBefore);
  if (c.courtlistenerDocketId) return syncCourtListener(db, c, now, maxPages, notBefore, claude);
  return {
    result: {
      caseId: c.id,
      caption: c.caption,
      source: c.caseType === "supreme_court" ? "scotus" : "courtlistener",
      newEntries: 0,
      suggestions: 0,
      error:
        c.caseType === "supreme_court"
          ? "Add the Supreme Court docket number (like 25-159) to sync this case."
          : "Link this case to a CourtListener docket to sync it.",
    },
    requests: 0,
    rateLimited: false,
  };
}

export const DEMO_POOL_MESSAGE = "Demo pool cases are fictional, so they don't sync court data.";

/** Leagues whose pools sync (a pool in "setup" syncs too, so cursors are current when the season starts). */
const SYNC_LEAGUE_STATUSES = ["setup", ...ACTIVE_LEAGUE_STATUSES] as const;

/**
 * Per pool: the earliest season start (YYYY-MM-DD) among its leagues that are
 * not complete. Activity before it could never score in any of them, so it is
 * consumed without suggestions. Demo pools are left out.
 */
async function poolFloors(db: DbOrTx, poolId?: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ poolId: leagues.poolId, start: sql<string>`min(${leagues.seasonStart})::text` })
    .from(leagues)
    .innerJoin(pools, eq(pools.id, leagues.poolId))
    .where(and(inArray(leagues.status, [...SYNC_LEAGUE_STATUSES]), eq(pools.isDemo, false), poolId ? eq(leagues.poolId, poolId) : undefined))
    .groupBy(leagues.poolId);
  return new Map(rows.map((r) => [r.poolId, r.start]));
}

/** Pull new activity for one case and create pending suggestions (Claude sorts CourtListener entries when connected). */
export async function syncCase(db: DbOrTx, caseId: string, now: Date = new Date(), opts: { claude?: ClaudeBudget | null } = {}): Promise<SyncResult> {
  const [row] = await db.select({ c: cases, isDemo: pools.isDemo }).from(cases).innerJoin(pools, eq(pools.id, cases.poolId)).where(eq(cases.id, caseId));
  if (!row) throw new UserError("That case doesn't exist.");
  const c = row.c;
  if (row.isDemo) {
    const source = syncSourceForCase(c) ?? (c.caseType === "supreme_court" ? "scotus" : "courtlistener");
    return { caseId: c.id, caption: c.caption, source, newEntries: 0, suggestions: 0, error: DEMO_POOL_MESSAGE };
  }
  const floor = (await poolFloors(db, c.poolId)).get(c.poolId) ?? null;
  const claude = opts.claude === undefined ? claudeBudget(1) : opts.claude;
  return (await syncLoaded(db, c, now, floor, CL_PAGES_PER_CASE, claude)).result;
}

// ---------------------------------------------------------------------------
// Daily run
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Rolling one-minute request window (CourtListener allows 5 requests a minute). */
export class RateWindow {
  private stamps: number[] = [];
  constructor(
    private perMinute: number,
    private clock: () => number = Date.now,
  ) {}
  /** Ms to wait before `n` more requests fit in the window. */
  waitFor(n: number): number {
    const now = this.clock();
    this.stamps = this.stamps.filter((t) => t > now - 60_000);
    const over = this.stamps.length + n - this.perMinute;
    if (over <= 0) return 0;
    const oldest = [...this.stamps].sort((a, b) => a - b)[over - 1];
    return oldest === undefined ? 0 : oldest + 60_000 - now + 1_000;
  }
  record(n: number): void {
    const now = this.clock();
    for (let i = 0; i < n; i++) this.stamps.push(now);
  }
}

/** Shared CourtListener budget for one run: request cap, 5/min pacing, deadline. */
type Budget = { maxCalls: number; calls: number; window: RateWindow; deadline: number; stopped: boolean };

/** Wait until up to `want` requests fit; returns how many may be made now (0 = stop CourtListener work). */
async function takeBudget(b: Budget, want: number): Promise<number> {
  const n = Math.min(want, b.maxCalls - b.calls);
  if (b.stopped || n <= 0 || Date.now() >= b.deadline) return 0;
  const wait = b.window.waitFor(n);
  if (wait > 0) {
    if (Date.now() + wait + FETCH_TIMEOUT_MS * n >= b.deadline) {
      b.stopped = true;
      return 0;
    }
    await sleep(wait);
  }
  return n;
}

function spend(b: Budget, n: number): void {
  b.calls += n;
  b.window.record(n);
}

export type AutoLinkRun = { poolId: string; linked: number; notFound: number; remaining: number; error?: string };

/**
 * Daily run (cron): sync every active case in every pool used by a league that
 * is drafting/in season/in playoffs — or still in setup — (demo pools excluded).
 * Supreme Court cases all sync; CourtListener cases are synced
 * least-recently-synced first, stopping at `maxCourtListenerCalls` API requests
 * or `deadlineMs` (epoch ms), so a run fits the free quota and Vercel's
 * function time limit.
 *
 * Also (additions): first auto-links up to `autoLinkPerPool` (default 5)
 * unlinked federal cases per pool, using at most half of the request budget;
 * activity dated before the earliest season start of a pool's leagues only
 * moves cursors (no suggestions); requests are paced at 5 per minute and a 429
 * stops CourtListener work for the run.
 */
export async function runCourtSync(
  db: DbOrTx,
  now: Date = new Date(),
  opts: { maxCourtListenerCalls?: number; deadlineMs?: number; autoLinkPerPool?: number; maxClaudeCalls?: number; claudeClient?: AiClient } = {},
): Promise<{ results: SyncResult[]; skipped: number; autoLinked: AutoLinkRun[] }> {
  const budget: Budget = {
    maxCalls: Math.max(0, opts.maxCourtListenerCalls ?? 20),
    calls: 0,
    window: new RateWindow(CL_PER_MINUTE),
    deadline: opts.deadlineMs ?? Number.POSITIVE_INFINITY,
    stopped: false,
  };
  const claude = claudeBudget(opts.maxClaudeCalls ?? CLAUDE_CALLS_PER_RUN, budget.deadline, opts.claudeClient);
  const floors = await poolFloors(db);
  const poolIds = [...floors.keys()];
  if (poolIds.length === 0) return { results: [], skipped: 0, autoLinked: [] };
  const configured = courtListenerConfigured();

  // 1. Auto-link a few unlinked federal cases per pool (half the budget at most).
  const autoLinked: AutoLinkRun[] = [];
  const perPool = Math.max(0, Math.floor(opts.autoLinkPerPool ?? AUTO_LINK_PER_POOL));
  const linkCap = Math.floor(budget.maxCalls / 2);
  if (configured && perPool > 0) {
    for (const poolId of poolIds) {
      const left = linkCap - budget.calls;
      if (left <= 0 || budget.stopped || Date.now() >= budget.deadline) break;
      const run = await autoLinkInternal(db, poolId, {
        max: Math.min(perPool, left),
        throwOnFirstError: false,
        before: async () => (await takeBudget(budget, 1)) === 1,
        after: () => spend(budget, 1),
      });
      if (run.stopRun) budget.stopped = true;
      if (run.linked.length || run.notFound.length || run.error) {
        autoLinked.push({ poolId, linked: run.linked.length, notFound: run.notFound.length, remaining: run.remaining, error: run.error });
      }
    }
  }

  // 2. Sync (cases loaded after linking, so newly linked cases get their first sync).
  const rows = await db
    .select()
    .from(cases)
    .where(and(inArray(cases.poolId, poolIds), eq(cases.status, "active")))
    .orderBy(sql`${cases.syncedAt} asc nulls first`, asc(cases.createdAt), asc(cases.id));
  const scotus = rows.filter((c) => syncSourceForCase(c) === "scotus");
  const linked = rows.filter((c) => syncSourceForCase(c) === "courtlistener");
  const results: SyncResult[] = [];
  let skipped = 0;

  for (const [i, c] of scotus.entries()) {
    if (Date.now() >= budget.deadline) {
      skipped++;
      continue;
    }
    if (i > 0) await sleep(250); // be polite to supremecourt.gov
    results.push((await syncLoaded(db, c, now, floors.get(c.poolId) ?? null)).result);
  }

  if (!configured) return { results, skipped: skipped + linked.length, autoLinked };

  for (const c of linked) {
    const pages = await takeBudget(budget, CL_PAGES_PER_CASE);
    if (pages <= 0) {
      skipped++;
      continue;
    }
    const r = await syncLoaded(db, c, now, floors.get(c.poolId) ?? null, pages, claude);
    spend(budget, r.requests);
    results.push(r.result);
    if (r.rateLimited) budget.stopped = true; // respect 429: no more CourtListener work this run
  }
  return { results, skipped, autoLinked };
}

// ---------------------------------------------------------------------------
// Linking
// ---------------------------------------------------------------------------

/** Link (or unlink with null) a pool case to a CourtListener docket. Verifies the case is in the pool. */
export async function linkCaseToDocket(db: DbOrTx, poolId: string, caseId: string, docketId: number | null): Promise<void> {
  if (docketId !== null && (!Number.isInteger(docketId) || docketId <= 0)) throw new UserError("Pick a CourtListener docket.");
  const [c] = await db.select().from(cases).where(and(eq(cases.id, caseId), eq(cases.poolId, poolId)));
  if (!c) throw new UserError("That case isn't in this league's player pool.");
  if (docketId !== null) {
    const [dup] = await db
      .select({ caption: cases.caption })
      .from(cases)
      .where(and(eq(cases.poolId, poolId), eq(cases.courtlistenerDocketId, docketId), ne(cases.id, caseId)));
    if (dup) throw new UserError(`That docket is already linked to ${dup.caption}.`);
  }
  if (c.courtlistenerDocketId === docketId) {
    if (c.syncError === AUTO_LINK_NOT_FOUND) await db.update(cases).set({ syncError: null }).where(eq(cases.id, caseId));
    return;
  }
  // Supreme Court cases keep syncing from supremecourt.gov, so their cursor stays.
  const resetSync = !scotusDocketFromCase(c);
  await db
    .update(cases)
    .set(resetSync ? { courtlistenerDocketId: docketId, syncCursor: null, syncedAt: null, syncError: null } : { courtlistenerDocketId: docketId })
    .where(eq(cases.id, caseId));
}

const CAPTION_NOISE = new Set([
  "united",
  "states",
  "america",
  "federal",
  "trade",
  "commission",
  "department",
  "people",
  "state",
  "government",
  "corporation",
  "company",
  "litigation",
  "antitrust",
  "securities",
  "matter",
]);

/** One or two distinctive caption words to narrow a docket-number search when the court is unknown. */
export function captionKeywords(caption: string): string | undefined {
  const parties = partiesFromCaption(caption);
  const ordered = [...parties.plaintiff.filter((p) => !isGovernmentParty(p)), ...parties.defendant.filter((p) => !isGovernmentParty(p))];
  const source = ordered.length ? ordered : [caption.replace(/^in re\s+/i, "")];
  for (const name of source) {
    const words = partyCore(name)
      .split(" ")
      .filter((w) => w.length >= 4 && !CAPTION_NOISE.has(w) && !/^\d+$/.test(w));
    if (words.length) return words.slice(0, 2).join(" ");
  }
  return undefined;
}

/** Dockets from a search that are the case (same docket number, same court when known). */
export function matchingDockets(c: { docketNumber: string; court: string }, results: ClDocket[]): ClDocket[] {
  const courtId = courtIdFromText(c.court);
  const seen = new Set<number>();
  return results.filter((r) => {
    if (seen.has(r.docketId)) return false;
    seen.add(r.docketId);
    return docketNumbersMatch(c.docketNumber, r.docketNumber) && (!courtId || r.courtId === courtId);
  });
}

type AutoLinkResult = { linked: { caseId: string; docketId: number }[]; notFound: string[]; remaining: number };

/**
 * Auto-link with optional budget hooks (the daily run paces requests and
 * shares its request cap). `before` returning false stops before the next
 * request; `after` is called once per request made.
 */
async function autoLinkInternal(
  db: DbOrTx,
  poolId: string,
  opts: { max: number; throwOnFirstError: boolean; before?: () => Promise<boolean>; after?: () => void },
): Promise<AutoLinkResult & { stopRun: boolean; error?: string }> {
  const candidates = await db
    .select({ id: cases.id, caption: cases.caption, court: cases.court, docketNumber: cases.docketNumber })
    .from(cases)
    .where(
      and(
        eq(cases.poolId, poolId),
        eq(cases.status, "active"),
        isNull(cases.courtlistenerDocketId),
        ne(cases.caseType, "supreme_court"),
        sql`coalesce(trim(${cases.docketNumber}), '') <> ''`,
        or(isNull(cases.syncError), ne(cases.syncError, AUTO_LINK_NOT_FOUND)),
      ),
    )
    .orderBy(asc(cases.createdAt), asc(cases.id));
  if (candidates.length > 0 && opts.max > 0 && !courtListenerConfigured()) {
    if (opts.throwOnFirstError) throw new CourtListenerError(NOT_CONNECTED_MESSAGE, 401);
    return { linked: [], notFound: [], remaining: candidates.length, stopRun: true, error: NOT_CONNECTED_MESSAGE };
  }

  const taken = new Set(
    (
      await db
        .select({ docketId: cases.courtlistenerDocketId })
        .from(cases)
        .where(and(eq(cases.poolId, poolId), sql`${cases.courtlistenerDocketId} is not null`))
    ).map((r) => r.docketId),
  );
  const linked: { caseId: string; docketId: number }[] = [];
  const notFound: string[] = [];
  let tried = 0;
  let stopRun = false;
  let error: string | undefined;
  const markNotFound = async (c: { id: string; caption: string }) => {
    notFound.push(c.caption);
    await db.update(cases).set({ syncError: AUTO_LINK_NOT_FOUND }).where(eq(cases.id, c.id));
  };
  for (const c of candidates) {
    if (tried >= opts.max) break;
    if (opts.before && !(await opts.before())) break;
    const docketNumber = c.docketNumber!.trim();
    const courtId = courtIdFromText(c.court);
    let results: ClDocket[];
    try {
      results = await searchDockets({
        docketNumber: docketSearchTerm(docketNumber),
        courtId: courtId ?? undefined,
        caseName: courtId ? undefined : captionKeywords(c.caption),
      });
    } catch (e) {
      opts.after?.();
      const status = e instanceof CourtListenerError ? e.status : 0;
      if (status === 400) {
        // CourtListener rejected this case's query: it can't be auto-linked.
        tried++;
        await markNotFound(c);
        continue;
      }
      if (opts.throwOnFirstError && tried === 0) throw e;
      // Rate limit, bad token or outage: keep what was done; the rest stays in `remaining`.
      stopRun = status === 429 || status === 401 || status === 403;
      error = errorText(e);
      break;
    }
    opts.after?.();
    tried++;
    const matches = matchingDockets({ docketNumber, court: c.court }, results).filter((r) => !taken.has(r.docketId));
    if (matches.length === 1) {
      const docketId = matches[0].docketId;
      await db
        .update(cases)
        .set({ courtlistenerDocketId: docketId, syncCursor: null, syncedAt: null, syncError: null })
        .where(eq(cases.id, c.id));
      taken.add(docketId);
      linked.push({ caseId: c.id, docketId });
    } else {
      await markNotFound(c);
    }
  }
  return { linked, notFound, remaining: candidates.length - tried, stopRun, error };
}

/**
 * Try to link unlinked federal (non-SCOTUS) pool cases to CourtListener dockets
 * by docket number (+ court when known). Uses at most `max` API requests.
 *
 * Links only an unambiguous match. Cases without one are marked
 * (cases.syncError = AUTO_LINK_NOT_FOUND) and skipped by later runs (link them
 * by hand; linkCaseToDocket clears the mark). `notFound` lists their captions;
 * `remaining` counts unlinked, unmarked cases not tried yet (max reached or
 * rate limit). Throws UserError for demo pools, and CourtListenerError when
 * not connected or when the very first request fails.
 */
export async function autoLinkPoolCases(
  db: DbOrTx,
  poolId: string,
  opts: { max?: number } = {},
): Promise<{ linked: { caseId: string; docketId: number }[]; notFound: string[]; remaining: number }> {
  const max = Math.max(0, Math.floor(opts.max ?? CL_PER_MINUTE));
  const [pool] = await db.select({ isDemo: pools.isDemo }).from(pools).where(eq(pools.id, poolId));
  if (!pool) throw new UserError("That player pool doesn't exist.");
  if (pool.isDemo) throw new UserError(DEMO_POOL_MESSAGE);
  const { linked, notFound, remaining } = await autoLinkInternal(db, poolId, { max, throwOnFirstError: true });
  return { linked, notFound, remaining };
}
