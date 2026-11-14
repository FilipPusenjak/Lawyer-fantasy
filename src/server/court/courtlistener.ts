/**
 * CourtListener REST API v4 client (server only — the token must never reach
 * the browser). CONTRACT FILE: signatures are fixed; the implementation is
 * filled in by the court-data core work.
 *
 * Auth: `Authorization: Token <COURTLISTENER_TOKEN>` (env var, set in Vercel).
 * Base: https://www.courtlistener.com/api/rest/v4/
 * Free-tier limits: 5 req/min, 50/hour, 125/day, shared by the whole app.
 */

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

/** True when COURTLISTENER_TOKEN is set. */
export function courtListenerConfigured(): boolean {
  return !!process.env.COURTLISTENER_TOKEN;
}

/** Search federal dockets (RECAP). One API request (first page only). */
export async function searchDockets(query: ClSearchQuery): Promise<ClDocket[]> {
  void query;
  throw new CourtListenerError("Not implemented", 501);
}

/** Fetch one docket by CourtListener id. One API request. */
export async function getDocket(docketId: number): Promise<ClDocket | null> {
  void docketId;
  throw new CourtListenerError("Not implemented", 501);
}

/**
 * Docket entries modified after `sinceIso` (all entries when null), oldest
 * first, at most `maxPages` API requests (20 entries per page).
 */
export async function listDocketEntries(docketId: number, sinceIso: string | null, maxPages = 2): Promise<ClDocketEntry[]> {
  void docketId;
  void sinceIso;
  void maxPages;
  throw new CourtListenerError("Not implemented", 501);
}

/** Check the token and report remaining quota (uses the separate api-usage throttle). */
export async function checkConnection(): Promise<{ ok: boolean; detail: string }> {
  return { ok: false, detail: "Not implemented" };
}
