/**
 * CourtListener REST API v4 client (server only — the token must never reach
 * the browser). CONTRACT FILE: the exported signatures below are fixed; extra
 * helpers are additions.
 *
 * Auth: `Authorization: Token <COURTLISTENER_TOKEN>` (env var, set in Vercel).
 * Base: https://www.courtlistener.com/api/rest/v4/
 * Free-tier limits: 5 req/min, 50/hour, 125/day, shared by the whole app.
 * Error messages never contain the token.
 */
import { courtLabel } from "@/lib/court/courts";
import { cleanText, slugify } from "@/lib/court/text";

export class CourtListenerError extends Error {
  constructor(
    message: string,
    public status: number,
    /** Seconds to wait (from Retry-After) when status is 429. */
    public retryAfterSec?: number,
  ) {
    super(message);
  }
}

/** A docket as shown in search results / docket lookups. */
export type ClDocket = {
  docketId: number;
  caseName: string;
  docketNumber: string;
  /** Human court name, e.g. "District Court, S.D. New York". */
  court: string;
  /** CourtListener court id, e.g. "nysd". */
  courtId: string;
  dateFiled: string | null; // YYYY-MM-DD
  dateTerminated: string | null; // YYYY-MM-DD
  /** Absolute URL of the docket page on courtlistener.com. */
  url: string;
  /** Attorney names on the docket (may be empty when CourtListener lacks the party list). */
  attorneys: string[];
  /** Firm names on the docket (may be empty). */
  firms: string[];
  /** Party names (may be empty). */
  parties: string[];
  /** CourtListener attorney ids on the docket (search results only; for lawyers.courtlistenerAttorneyIds). */
  attorneyIds?: number[];
  /** CourtListener firm ids on the docket (search results only; for lawyers.courtlistenerFirmIds). */
  firmIds?: number[];
};

/** One docket entry (a filing/order line on the docket). */
export type ClDocketEntry = {
  entryId: number;
  entryNumber: number | null;
  dateFiled: string | null; // YYYY-MM-DD
  /** Docket text, e.g. "ORDER granting 42 Motion to Dismiss ...". */
  description: string;
  /** ISO timestamp; used as the incremental-sync cursor. */
  dateModified: string;
  /** Absolute URL to the entry on courtlistener.com (docket URL + #entry-N). */
  url: string;
};

export type ClSearchQuery = {
  /** Attorney name (searches dockets whose attorney list contains it). */
  attorney?: string;
  /** Firm name. */
  firm?: string;
  /** Free-text caption, e.g. "Apple v. Epic". */
  caseName?: string;
  /** Docket number, e.g. "1:24-cv-03973". */
  docketNumber?: string;
  /** Restrict to a CourtListener court id, e.g. "nysd". */
  courtId?: string;
};

export const COURTLISTENER_SITE = "https://www.courtlistener.com";
export const COURTLISTENER_API = `${COURTLISTENER_SITE}/api/rest/v4/`;
const TIMEOUT_MS = 20_000;

export const NOT_CONNECTED_MESSAGE =
  "CourtListener isn't connected: add COURTLISTENER_TOKEN in Vercel → Settings → Environment Variables, then redeploy.";

/** True when COURTLISTENER_TOKEN is set. */
export function courtListenerConfigured(): boolean {
  return !!process.env.COURTLISTENER_TOKEN;
}

function token(): string {
  const t = process.env.COURTLISTENER_TOKEN?.trim();
  if (!t) throw new CourtListenerError(NOT_CONNECTED_MESSAGE, 401);
  return t;
}

function scrub(s: string, secret: string): string {
  return secret ? s.split(secret).join("[token]") : s;
}

/** Seconds from a Retry-After header (delta-seconds or HTTP date). */
export function parseRetryAfter(v: string | null, now: number = Date.now()): number | undefined {
  if (!v) return undefined;
  const n = Number(v.trim());
  if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  const at = Date.parse(v);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

function waitText(sec: number | undefined): string {
  if (sec === undefined) return "later";
  if (sec < 90) return `in ${Math.max(1, sec)} seconds`;
  if (sec < 5400) return `in about ${Math.round(sec / 60)} minutes`;
  return `in about ${Math.round(sec / 3600)} hours`;
}

/** GET a CourtListener API URL (a path under /api/rest/v4/ or a full `next` URL from a previous page). */
async function clGet(pathOrUrl: string, params?: Record<string, string | undefined>): Promise<unknown> {
  const secret = token();
  let url: URL;
  try {
    url = new URL(pathOrUrl, COURTLISTENER_API);
  } catch {
    throw new CourtListenerError("Invalid CourtListener URL", 400);
  }
  // Never send the token anywhere but the CourtListener API.
  if (!url.href.startsWith(COURTLISTENER_API)) throw new CourtListenerError("Refusing to call a non-CourtListener URL", 400);
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, v);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Token ${secret}`, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    throw new CourtListenerError(timedOut ? "CourtListener didn't respond in time. Try again later." : "Couldn't reach CourtListener. Try again later.", 503);
  }

  if (res.status === 429) {
    const sec = parseRetryAfter(res.headers.get("retry-after"));
    throw new CourtListenerError(`CourtListener's free request limit was reached. Try again ${waitText(sec)}.`, 429, sec);
  }
  if (res.status === 401 || res.status === 403) {
    throw new CourtListenerError("CourtListener rejected the API token. Check COURTLISTENER_TOKEN in Vercel.", res.status);
  }
  if (res.status === 404) throw new CourtListenerError("Not found on CourtListener.", 404);
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body?.detail === "string") detail = `: ${scrub(cleanText(body.detail), secret).slice(0, 200)}`;
    } catch {
      // ignore unreadable bodies
    }
    throw new CourtListenerError(`CourtListener error (HTTP ${res.status})${detail}`, res.status);
  }
  try {
    return await res.json();
  } catch {
    throw new CourtListenerError("CourtListener sent an unreadable response.", 502);
  }
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const asStr = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const asDate = (v: unknown): string | null => {
  const s = asStr(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
};
const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => cleanText(asStr(x))).filter(Boolean) : []);
const asId = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number(asStr(v));
  return Number.isInteger(n) && n > 0 ? n : null;
};
const asIds = (v: unknown): number[] => (Array.isArray(v) ? v.map(asId).filter((n): n is number => n !== null) : []);

/** Absolute courtlistener.com URL for a site path ("/docket/123/slug/"). */
export function siteUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${COURTLISTENER_SITE}${path.startsWith("/") ? "" : "/"}${path}`;
}

/**
 * Docket page URL. CourtListener's route is /docket/<id>/<slug>/ and the slug
 * is ignored, so a caption slug works when the real one isn't known.
 */
export function docketPageUrl(docketId: number, slugOrCaption?: string | null): string {
  const slug = slugOrCaption ? slugify(slugOrCaption) : "docket";
  return `${COURTLISTENER_SITE}/docket/${docketId}/${slug}/`;
}

/** "/docket/123/4/slug/" (a RECAP document URL) → "https://www.courtlistener.com/docket/123/slug/". */
export function docketUrlFromDocumentUrl(docketId: number, documentUrl: string): string | null {
  const m = /\/docket\/(\d+)\/[^/]+\/(?:\d+\/)?([-a-zA-Z0-9_]*)\/?$/.exec(documentUrl);
  if (!m || Number(m[1]) !== docketId) return null;
  return `${COURTLISTENER_SITE}/docket/${docketId}/${m[2] || "docket"}/`;
}

/** Entry link: "<docket url>#entry-<n>" (just the docket URL when the entry has no number). */
export function entryUrl(docketUrl: string, entryNumber: number | null): string {
  const base = docketUrl.replace(/#.*$/, "");
  return entryNumber === null ? base : `${base}#entry-${entryNumber}`;
}

/** Quote a value for the search `q` syntax. */
export function quoteTerm(s: string): string {
  const clean = s.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  return `"${clean.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const CAPTION_STOP = new Set(["v", "vs", "in", "re", "the", "of", "and", "et", "al", "inc", "llc", "corp", "co", "ltd"]);

/** The `q` string for a docket search, e.g. attorney:"Jane Roe" AND caseName:("apple" AND "epic") AND court_id:"nysd". */
export function buildSearchQ(query: ClSearchQuery): string {
  const terms: string[] = [];
  if (query.attorney?.trim()) terms.push(`attorney:${quoteTerm(query.attorney)}`);
  if (query.firm?.trim()) terms.push(`firm:${quoteTerm(query.firm)}`);
  if (query.caseName?.trim()) {
    const words = query.caseName
      .split(/\s+/)
      .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
      .filter((w) => w && !CAPTION_STOP.has(w.toLowerCase()))
      .slice(0, 8);
    if (words.length) terms.push(`caseName:(${words.map(quoteTerm).join(" AND ")})`);
  }
  if (query.docketNumber?.trim()) terms.push(`docketNumber:${quoteTerm(query.docketNumber)}`);
  if (query.courtId?.trim()) terms.push(`court_id:${quoteTerm(query.courtId.toLowerCase())}`);
  return terms.join(" AND ");
}

export function mapSearchResult(r: unknown): ClDocket | null {
  const o = asObj(r);
  const docketId = asId(o.docket_id);
  if (!docketId) return null;
  const courtId = asStr(o.court_id);
  const abs = asStr(o.docket_absolute_url);
  return {
    docketId,
    caseName: cleanText(asStr(o.caseName)) || cleanText(asStr(o.caseNameFull)),
    docketNumber: cleanText(asStr(o.docketNumber)),
    court: cleanText(asStr(o.court)) || courtLabel(courtId) || courtId,
    courtId,
    dateFiled: asDate(o.dateFiled),
    dateTerminated: asDate(o.dateTerminated),
    url: abs ? siteUrl(abs) : docketPageUrl(docketId, asStr(o.caseName)),
    attorneys: asStrings(o.attorney),
    firms: asStrings(o.firm),
    parties: asStrings(o.party),
    attorneyIds: asIds(o.attorney_id),
    firmIds: asIds(o.firm_id),
  };
}

export function mapDocket(r: unknown): ClDocket | null {
  const o = asObj(r);
  const docketId = asId(o.id);
  if (!docketId) return null;
  const caseName = cleanText(asStr(o.case_name)) || cleanText(asStr(o.case_name_full)) || cleanText(asStr(o.case_name_short));
  const courtId = asStr(o.court_id) || (/\/courts\/([^/]+)\/?$/.exec(asStr(o.court))?.[1] ?? "");
  const abs = asStr(o.absolute_url);
  return {
    docketId,
    caseName,
    docketNumber: cleanText(asStr(o.docket_number)),
    court: courtLabel(courtId) ?? courtId,
    courtId,
    dateFiled: asDate(o.date_filed),
    dateTerminated: asDate(o.date_terminated),
    url: abs ? siteUrl(abs) : docketPageUrl(docketId, caseName),
    attorneys: [],
    firms: [],
    parties: [],
  };
}

/** Map one /docket-entries/ result. `docketUrl` is used for the entry link when no document URL reveals the docket's slug. */
export function mapDocketEntry(r: unknown, docketId: number, docketUrl: string | null): ClDocketEntry | null {
  const o = asObj(r);
  const entryId = asId(o.id);
  if (!entryId) return null;
  const docs = Array.isArray(o.recap_documents) ? o.recap_documents.map(asObj) : [];
  const fromDoc = docs.map((d) => docketUrlFromDocumentUrl(docketId, asStr(d.absolute_url))).find((u): u is string => !!u) ?? null;
  const entryNumber = typeof o.entry_number === "number" && Number.isInteger(o.entry_number) ? o.entry_number : null;
  const description = cleanText(asStr(o.description)) || cleanText(asStr(docs[0]?.description));
  return {
    entryId,
    entryNumber,
    dateFiled: asDate(o.date_filed),
    description,
    dateModified: asStr(o.date_modified),
    url: entryUrl(docketUrl ?? fromDoc ?? docketPageUrl(docketId), entryNumber),
  };
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

/** Search federal dockets (RECAP). One API request (first page only). */
export async function searchDockets(query: ClSearchQuery): Promise<ClDocket[]> {
  const q = buildSearchQ(query);
  if (!q) throw new CourtListenerError("Enter a name, caption or docket number to search for.", 400);
  const data = asObj(await clGet("search/", { type: "d", q }));
  const results = Array.isArray(data.results) ? data.results : [];
  return results.map(mapSearchResult).filter((d): d is ClDocket => d !== null);
}

const DOCKET_FIELDS = "id,case_name,case_name_short,case_name_full,docket_number,court_id,date_filed,date_terminated,absolute_url";

/** Fetch one docket by CourtListener id. One API request. */
export async function getDocket(docketId: number): Promise<ClDocket | null> {
  if (!Number.isInteger(docketId) || docketId <= 0) return null;
  try {
    return mapDocket(await clGet(`dockets/${docketId}/`, { fields: DOCKET_FIELDS }));
  } catch (e) {
    if (e instanceof CourtListenerError && e.status === 404) return null;
    throw e;
  }
}

export type DocketEntriesPage = {
  entries: ClDocketEntry[];
  /** API requests made. */
  requests: number;
  /** More entries remain after the last page fetched. */
  hasMore: boolean;
};

/**
 * Docket entries modified after `sinceIso` (all when null), oldest first, at
 * most `maxPages` requests (20 entries per page). Pass `docketUrl` (e.g. the
 * case's CourtListener link) to build entry links without an extra request.
 */
export async function fetchDocketEntries(
  docketId: number,
  opts: { sinceIso?: string | null; maxPages?: number; docketUrl?: string | null } = {},
): Promise<DocketEntriesPage> {
  const maxPages = Math.max(1, Math.floor(opts.maxPages ?? 2));
  const params: Record<string, string | undefined> = {
    docket: String(docketId),
    order_by: "date_modified",
    omit: "recap_documents__plain_text",
    date_modified__gt: opts.sinceIso ?? undefined,
  };
  const entries: ClDocketEntry[] = [];
  let next: string | null = "docket-entries/";
  let requests = 0;
  while (next && requests < maxPages) {
    const data = asObj(await clGet(next, requests === 0 ? params : undefined));
    requests++;
    for (const r of Array.isArray(data.results) ? data.results : []) {
      const e = mapDocketEntry(r, docketId, opts.docketUrl ?? null);
      if (e) entries.push(e);
    }
    next = typeof data.next === "string" && data.next ? data.next : null;
  }
  return { entries, requests, hasMore: next !== null };
}

/**
 * Docket entries modified after `sinceIso` (all entries when null), oldest
 * first, at most `maxPages` API requests (20 entries per page).
 */
export async function listDocketEntries(docketId: number, sinceIso: string | null, maxPages = 2): Promise<ClDocketEntry[]> {
  return (await fetchDocketEntries(docketId, { sinceIso, maxPages })).entries;
}

export type ClUsageRow = { scope: string; rate: string; used: number; limit: number; remaining: number; windowSeconds: number; resetAt: string | null };

/** Current API usage rows from /api-usage/ (separate throttle; doesn't use the main quota). */
export async function apiUsage(): Promise<ClUsageRow[]> {
  const data = asObj(await clGet("api-usage/"));
  const rows = Array.isArray(data.current_usage) ? data.current_usage.map(asObj) : [];
  return rows.map((r) => ({
    scope: asStr(r.scope),
    rate: asStr(r.rate),
    used: Number(r.used) || 0,
    limit: Number(r.limit) || 0,
    remaining: Number(r.remaining) || 0,
    windowSeconds: Number(r.window_seconds) || 0,
    resetAt: asStr(r.reset_at) || null,
  }));
}

function windowName(sec: number): string {
  if (sec <= 60) return "this minute";
  if (sec <= 3600) return "this hour";
  if (sec <= 86_400) return "today";
  return `per ${Math.round(sec / 86_400)} days`;
}

/** Check the token and report remaining quota (uses the separate api-usage throttle). */
export async function checkConnection(): Promise<{ ok: boolean; detail: string }> {
  if (!courtListenerConfigured()) return { ok: false, detail: NOT_CONNECTED_MESSAGE };
  try {
    const rows = (await apiUsage()).filter((r) => r.scope === "user" && r.limit > 0).sort((a, b) => a.windowSeconds - b.windowSeconds);
    const quota = rows.map((r) => `${r.remaining} of ${r.limit} ${windowName(r.windowSeconds)}`).join(", ");
    return { ok: true, detail: quota ? `Connected. Requests left: ${quota}.` : "Connected." };
  } catch (e) {
    return { ok: false, detail: e instanceof CourtListenerError ? e.message : "Couldn't check the CourtListener connection." };
  }
}
