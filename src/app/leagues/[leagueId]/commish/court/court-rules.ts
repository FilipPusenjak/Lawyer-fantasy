/**
 * Pure helpers for the commissioner court-data screens (case page "Court data"
 * card, pool auto-link card, the Court data page and the hub card).
 *
 * Safe on the client: no runtime imports of server modules (only types).
 */
import type { ClDocket } from "@/server/court/courtlistener";
import type { SyncSource } from "@/server/services/court-sync";
import { plural } from "@/lib/format";
import type { CaseType, Position, Side } from "@/lib/settings";

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

export const CONNECT_MESSAGE =
  "Connect CourtListener: add COURTLISTENER_TOKEN in Vercel → Settings → Environment Variables, then redeploy.";
export const FREE_LIMIT_NOTE =
  "CourtListener's free API allows about 125 requests a day (5 a minute) for the whole app, so cases are linked 10 at a time.";
export const COVERAGE_NOTE = "Filings come from CourtListener when available. Some filings never show up there.";

/** Cases per "Auto-link" click (each can use one CourtListener request). */
export const AUTO_LINK_BATCH = 10;
/** Minimum time between manual CourtListener syncs of one case. */
export const SYNC_COOLDOWN_MS = 60_000;

// ---------------------------------------------------------------------------
// Shared data shapes (server actions → client components)
// ---------------------------------------------------------------------------

/** A pool case as the court screens need it. */
export type PoolCaseRef = { id: string; caption: string; caseType: CaseType; linkedDocketId: number | null };

export type CaseSearchData = {
  results: { docket: ClDocket; linkedTo: { id: string; caption: string } | null }[];
  /** Both a docket number and caption words were searched (an AND search) — suggest clearing one when nothing matched. */
  bothFields: boolean;
};

export type SearchMode = "attorney" | "firm";

export type CourtSearchData = {
  mode: SearchMode;
  name: string;
  results: { docket: ClDocket; poolCase: PoolCaseRef | null }[];
};

export type SyncSummary = { newEntries: number; suggestions: number; error: string | null };

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

export function scotusDocketUrl(docket: string): string {
  return `https://www.supremecourt.gov/search.aspx?filename=/docket/docketfiles/html/public/${encodeURIComponent(docket)}.html`;
}

export function courtListenerDocketUrl(docketId: number): string {
  return `https://www.courtlistener.com/docket/${docketId}/`;
}

/** True for an https URL on courtlistener.com (used to accept a docket URL sent back by the client). */
export function isCourtListenerUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "https:" && (u.hostname === "www.courtlistener.com" || u.hostname === "courtlistener.com");
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Courts: CourtListener court id <-> Bluebook-style court name used in the pool
// ---------------------------------------------------------------------------

/** [CourtListener state code, Bluebook abbreviation, full name] */
const STATES: [string, string, string][] = [
  ["al", "Ala.", "Alabama"],
  ["ak", "Alaska", "Alaska"],
  ["az", "Ariz.", "Arizona"],
  ["ar", "Ark.", "Arkansas"],
  ["ca", "Cal.", "California"],
  ["co", "Colo.", "Colorado"],
  ["ct", "Conn.", "Connecticut"],
  ["de", "Del.", "Delaware"],
  ["dc", "D.C.", "District of Columbia"],
  ["fl", "Fla.", "Florida"],
  ["ga", "Ga.", "Georgia"],
  ["hi", "Haw.", "Hawaii"],
  ["id", "Idaho", "Idaho"],
  ["il", "Ill.", "Illinois"],
  ["in", "Ind.", "Indiana"],
  ["ia", "Iowa", "Iowa"],
  ["ks", "Kan.", "Kansas"],
  ["ky", "Ky.", "Kentucky"],
  ["la", "La.", "Louisiana"],
  ["me", "Me.", "Maine"],
  ["md", "Md.", "Maryland"],
  ["ma", "Mass.", "Massachusetts"],
  ["mi", "Mich.", "Michigan"],
  ["mn", "Minn.", "Minnesota"],
  ["ms", "Miss.", "Mississippi"],
  ["mo", "Mo.", "Missouri"],
  ["mt", "Mont.", "Montana"],
  ["ne", "Neb.", "Nebraska"],
  ["nv", "Nev.", "Nevada"],
  ["nh", "N.H.", "New Hampshire"],
  ["nj", "N.J.", "New Jersey"],
  ["nm", "N.M.", "New Mexico"],
  ["ny", "N.Y.", "New York"],
  ["nc", "N.C.", "North Carolina"],
  ["nd", "N.D.", "North Dakota"],
  ["oh", "Ohio", "Ohio"],
  ["ok", "Okla.", "Oklahoma"],
  ["or", "Or.", "Oregon"],
  ["pa", "Pa.", "Pennsylvania"],
  ["ri", "R.I.", "Rhode Island"],
  ["sc", "S.C.", "South Carolina"],
  ["sd", "S.D.", "South Dakota"],
  ["tn", "Tenn.", "Tennessee"],
  ["tx", "Tex.", "Texas"],
  ["ut", "Utah", "Utah"],
  ["vt", "Vt.", "Vermont"],
  ["va", "Va.", "Virginia"],
  ["wa", "Wash.", "Washington"],
  ["wv", "W. Va.", "West Virginia"],
  ["wi", "Wis.", "Wisconsin"],
  ["wy", "Wyo.", "Wyoming"],
  ["pr", "P.R.", "Puerto Rico"],
  ["vi", "V.I.", "Virgin Islands"],
  ["gu", "Guam", "Guam"],
  ["nmi", "N. Mar. I.", "Northern Mariana Islands"],
];
const STATE_BY_CODE = new Map(STATES.map(([code, abbr, name]) => [code, { abbr, name }]));
const STATE_CODE_BY_NAME = new Map(STATES.map(([code, , name]) => [name.toLowerCase(), code]));

const DISTRICT_LETTERS = ["n", "s", "e", "w", "c", "m"] as const;
const DISTRICT_WORDS: Record<string, string> = {
  northern: "n",
  southern: "s",
  eastern: "e",
  western: "w",
  central: "c",
  middle: "m",
};
const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh"];

const OTHER_COURTS: Record<string, string> = {
  scotus: "U.S. Supreme Court",
  cadc: "D.C. Cir.",
  cafc: "Fed. Cir.",
  cit: "Ct. Int'l Trade",
  uscfc: "Fed. Cl.",
  jpml: "J.P.M.L.",
};

function circuitName(n: number): string {
  const suffix = n === 1 ? "st" : n === 2 || n === 3 ? "d" : "th";
  return `${n}${suffix} Cir.`;
}

/** "S.D." + "N.Y." → "S.D.N.Y."; "N.D." + "Cal." → "N.D. Cal." (Bluebook closes up adjacent single capitals). */
function districtName(letter: string, stateAbbr: string): string {
  const prefix = letter ? `${letter.toUpperCase()}.D.` : "D.";
  return /^([A-Z]\.)+$/.test(stateAbbr) ? `${prefix}${stateAbbr}` : `${prefix} ${stateAbbr}`;
}

/** Bluebook-style name for a CourtListener court id ("nysd" → "S.D.N.Y."), or null if unknown. */
export function courtLabel(courtId: string): string | null {
  const id = courtId.trim().toLowerCase();
  if (OTHER_COURTS[id]) return OTHER_COURTS[id];
  const circuit = /^ca(\d{1,2})$/.exec(id);
  if (circuit) {
    const n = Number(circuit[1]);
    return n >= 1 && n <= 11 ? circuitName(n) : null;
  }
  if (!id.endsWith("d") || id.length < 3) return null;
  const rest = id.slice(0, -1);
  const single = STATE_BY_CODE.get(rest);
  if (single) return districtName("", single.abbr);
  const letter = rest.slice(-1);
  const state = STATE_BY_CODE.get(rest.slice(0, -1));
  if (state && (DISTRICT_LETTERS as readonly string[]).includes(letter)) return districtName(letter, state.abbr);
  return null;
}

export function isCircuitCourt(courtId: string | null | undefined): boolean {
  if (!courtId) return false;
  return /^ca([1-9]|1[01])$/.test(courtId) || courtId === "cadc" || courtId === "cafc";
}

function compact(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

let reverseIndex: Map<string, string> | null = null;
function courtReverseIndex(): Map<string, string> {
  if (reverseIndex) return reverseIndex;
  const m = new Map<string, string>();
  const add = (id: string) => {
    const label = courtLabel(id);
    if (label) m.set(compact(label), id);
  };
  for (const id of Object.keys(OTHER_COURTS)) add(id);
  for (let n = 1; n <= 11; n++) add(`ca${n}`);
  for (const [code] of STATES) {
    add(`${code}d`);
    for (const l of DISTRICT_LETTERS) add(`${code}${l}d`);
  }
  // Common alternate spellings.
  m.set("2ndcir", "ca2");
  m.set("3rdcir", "ca3");
  m.set("scotus", "scotus");
  m.set("supremecourt", "scotus");
  m.set("ussupremecourt", "scotus");
  m.set("supremecourtoftheunitedstates", "scotus");
  m.set("dccircuit", "cadc");
  m.set("federalcircuit", "cafc");
  reverseIndex = m;
  return m;
}

/**
 * CourtListener court id for a court name as commissioners type it
 * ("S.D.N.Y.", "N.D. Cal.", "D.C. Cir. (en banc)", "Southern District of New York",
 * "District Court, S.D. New York", "Second Circuit", "nysd"), or null.
 */
export function courtIdFromName(name: string | null | undefined): string | null {
  if (!name) return null;
  const s = name
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return null;
  const idx = courtReverseIndex();
  const key = compact(s);
  const direct = idx.get(key);
  if (direct) return direct;
  // Already a CourtListener id we know.
  if (/^[a-z0-9]+$/.test(s) && courtLabel(s)) return s;

  // "Second Circuit", "Court of Appeals for the Ninth Circuit", "D.C. Circuit", "Federal Circuit"
  const circ = /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|d\.? ?c\.?|federal|fed\.?|\d{1,2}(?:st|nd|rd|th|d)?)\s+cir(?:cuit)?\b/.exec(s);
  if (circ) {
    const w = circ[1].replace(/[\s.]/g, "");
    if (w === "dc") return "cadc";
    if (w === "federal" || w === "fed") return "cafc";
    const n = ORDINALS.indexOf(w) + 1 || Number.parseInt(w, 10);
    if (n >= 1 && n <= 11) return `ca${n}`;
  }

  // "Southern District of New York", "U.S. District Court for the District of New Jersey", "District of Columbia"
  const longForm = /(?:(northern|southern|eastern|western|central|middle) )?district of ([a-z .]+)$/.exec(s);
  if (longForm) {
    const place = longForm[2].trim();
    if (place === "columbia") return "dcd";
    const code = STATE_CODE_BY_NAME.get(place);
    if (code) return `${code}${longForm[1] ? DISTRICT_WORDS[longForm[1]] : ""}d`;
  }

  // CourtListener style: "District Court, S.D. New York", "District Court, D. New Jersey"
  const clForm = /^district court, ([nsewcm])?\.? ?d\. (.+)$/.exec(s);
  if (clForm) {
    const code = STATE_CODE_BY_NAME.get(clForm[2].trim());
    if (code) return `${code}${clForm[1] ?? ""}d`;
  }
  return null;
}

/**
 * Court filter from a form field: blank → undefined; a known court name or id
 * → its CourtListener id; any other short lowercase id is passed through.
 */
export function parseCourtInput(raw: string): { ok: true; courtId: string | undefined } | { ok: false; error: string } {
  const s = raw.trim();
  if (!s) return { ok: true, courtId: undefined };
  const id = courtIdFromName(s);
  if (id) return { ok: true, courtId: id };
  if (/^[a-z0-9]{2,12}$/i.test(s)) return { ok: true, courtId: s.toLowerCase() };
  return { ok: false, error: "Use a court like “S.D.N.Y.” or a CourtListener court id like “nysd”, or leave the court blank." };
}

// ---------------------------------------------------------------------------
// Docket numbers
// ---------------------------------------------------------------------------

/** Docket type code, e.g. "cv" from "1:24-cv-03973", "cr" from "26 Cr. 29 (AT)", or null. */
export function docketTypeCode(docketNumber: string | null | undefined): string | null {
  if (!docketNumber) return null;
  const m = /(?:^|[^0-9])(?:\d{1,2}:)?\d{2}[\s-]*([a-z]{1,4})\.?[\s-]*\d/i.exec(docketNumber);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Case type guess for a CourtListener docket: Supreme Court → supreme_court,
 * courts of appeals → appeal, otherwise from the docket type code
 * (cv/md → civil, cr/mj/po → criminal, other codes → other, none → civil).
 */
export function guessCaseType(docketNumber: string | null | undefined, courtId: string | null | undefined): CaseType {
  if (courtId === "scotus") return "supreme_court";
  if (isCircuitCourt(courtId)) return "appeal";
  const code = docketTypeCode(docketNumber);
  if (!code) return "civil";
  if (code === "cv" || code === "md") return "civil";
  if (code === "cr" || code === "mj" || code === "po") return "criminal";
  return "other";
}

/**
 * Normalized docket key for matching the same case written different ways:
 * "1:25-cr-00577", "1:25-cr-577-KPF" and "25 Cr. 577 (AT)" → "25-cr-577";
 * appellate "25-5091" → "25-5091". Null when blank.
 */
export function docketKey(docketNumber: string | null | undefined): string | null {
  if (!docketNumber) return null;
  const s = docketNumber.toLowerCase().replace(/\([^)]*\)/g, " ").trim();
  if (!s) return null;
  const district = /(?:^|[^0-9])(?:\d{1,2}:)?(\d{2})[\s-]*([a-z]{1,4})\.?[\s-]*0*(\d{1,6})/.exec(s);
  if (district) return `${district[1]}-${district[2]}-${district[3]}`;
  const appellate = /^(\d{2})-0*(\d{1,6})\b/.exec(s);
  if (appellate) return `${appellate[1]}-${appellate[2]}`;
  return compact(s) || null;
}

/** Docket number with judge initials and parentheticals dropped, for prefilling a search ("5:24-cr-00314-J" → "5:24-cr-00314"). */
export function cleanDocketForSearch(docketNumber: string | null | undefined): string {
  if (!docketNumber) return "";
  return docketNumber
    .replace(/\([^)]*\)/g, " ")
    .replace(/(\d)-[A-Za-z]{1,4}(?:-[A-Za-z]{1,4})*\s*$/, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

type MatchableCase = {
  id: string;
  caption: string;
  caseType: CaseType;
  court: string;
  docketNumber: string | null;
  courtlistenerDocketId: number | null;
};

/**
 * The pool case for a CourtListener docket: one already linked to it, else one
 * with the same docket number (normalized) in the same court (when the pool
 * case's court name can be mapped to a CourtListener court id).
 */
export function findPoolMatch(docket: Pick<ClDocket, "docketId" | "docketNumber" | "courtId">, poolCases: MatchableCase[]): PoolCaseRef | null {
  const ref = (c: MatchableCase): PoolCaseRef => ({ id: c.id, caption: c.caption, caseType: c.caseType, linkedDocketId: c.courtlistenerDocketId });
  const linked = poolCases.find((c) => c.courtlistenerDocketId === docket.docketId);
  if (linked) return ref(linked);
  const key = docketKey(docket.docketNumber);
  if (!key) return null;
  const hit = poolCases.find((c) => {
    if (docketKey(c.docketNumber) !== key) return false;
    const courtId = courtIdFromName(c.court);
    return !courtId || !docket.courtId || courtId === docket.courtId;
  });
  return hit ? ref(hit) : null;
}

// ---------------------------------------------------------------------------
// Names (search result highlighting, prefill)
// ---------------------------------------------------------------------------

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Every word of the query starts some word of the name ("Jane Doe" matches "Doe, Jane A."). */
export function nameMatches(name: string, query: string): boolean {
  const q = tokens(query);
  if (q.length === 0) return false;
  const n = tokens(name);
  return q.every((t) => n.some((w) => w.startsWith(t)));
}

/** Names with the ones matching the query first (order otherwise kept), de-duplicated. */
export function matchNames(names: string[], query: string): { name: string; matched: boolean }[] {
  const seen = new Set<string>();
  const out: { name: string; matched: boolean }[] = [];
  for (const raw of names) {
    const name = raw.trim().replace(/\s+/g, " ");
    const k = name.toLowerCase();
    if (!name || seen.has(k)) continue;
    seen.add(k);
    out.push({ name, matched: nameMatches(name, query) });
  }
  return [...out.filter((n) => n.matched), ...out.filter((n) => !n.matched)];
}

/** First `max` names plus how many more there are. */
export function previewNames<T>(names: T[], max = 3): { shown: T[]; more: number } {
  return { shown: names.slice(0, max), more: Math.max(0, names.length - max) };
}

export function normName(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Default position for a new lawyer added to a case of this type ("" = make the commissioner pick). */
export function guessPosition(caseType: CaseType, side: Side | null = null): Exclude<Position, "firm"> | "" {
  if (caseType === "appeal" || caseType === "supreme_court") return "appellate";
  if (caseType === "criminal") return side === "plaintiff" ? "prosecutor" : side === "defendant" ? "defense" : "";
  return "trial";
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** "In 3 minutes" / "in about 2 hours" from a Retry-After value. */
export function retryWait(retryAfterSec: number | undefined | null): string | null {
  if (typeof retryAfterSec !== "number" || !Number.isFinite(retryAfterSec) || retryAfterSec <= 0) return null;
  const minutes = Math.max(1, Math.ceil(retryAfterSec / 60));
  if (minutes <= 90) return `in ${plural(minutes, "minute")}`;
  return `in about ${plural(Math.round(minutes / 60), "hour")}`;
}

/**
 * Friendly text for an error thrown by the CourtListener client (anything with
 * a numeric `status`, like CourtListenerError), or null for other errors.
 * Never echoes the raw message (it could contain API details).
 */
export function courtErrorMessage(e: unknown): string | null {
  if (!(e instanceof Error)) return null;
  const status = (e as { status?: unknown }).status;
  if (typeof status !== "number") return null;
  if (status === 429) {
    const wait = retryWait((e as { retryAfterSec?: number }).retryAfterSec);
    return `CourtListener's free limit was reached — try again ${wait ?? "later"}.`;
  }
  if (status === 401 || status === 403) {
    return "CourtListener didn't accept the API token. Check COURTLISTENER_TOKEN in Vercel → Settings → Environment Variables.";
  }
  if (status === 400) return "CourtListener couldn't run that search. Try fewer or simpler words.";
  if (status === 404) return "CourtListener doesn't have that docket.";
  if (status === 501) return "Court data isn't switched on yet. Try again after the next update.";
  if (status >= 500) return "CourtListener is having trouble right now. Try again in a few minutes.";
  return "CourtListener didn't answer as expected. Try again in a few minutes.";
}

export function syncResultMessage(r: { newEntries: number; suggestions: number }): string {
  return `${plural(r.newEntries, "new filing")}, ${plural(r.suggestions, "suggestion")} added.`;
}

/** "A, B, C and 2 more" */
export function listWithMore(items: string[], max = 3): string {
  const { shown, more } = previewNames(items, max);
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}

// ---------------------------------------------------------------------------
// Pool court-data stats
// ---------------------------------------------------------------------------

export type CourtCaseRow = {
  id: string;
  caption: string;
  caseType: CaseType;
  status: "active" | "closed";
  court: string;
  docketNumber: string | null;
  courtlistenerDocketId: number | null;
  syncedAt: Date | null;
  syncError: string | null;
};

export type CourtStats = {
  /** Active cases synced from the Supreme Court docket feed. */
  scotusTracked: number;
  /** Active Supreme Court cases whose docket number isn't in the "25-159" form (so they can't sync). */
  scotusNeedsDocket: number;
  /** Active non-Supreme Court cases linked to a CourtListener docket. */
  linked: number;
  /** Active non-Supreme Court cases not linked yet. */
  unlinked: number;
  /** Most recent sync of any case in the pool. */
  lastSyncedAt: Date | null;
  /** Active cases whose last sync failed. */
  errors: { id: string; caption: string; error: string; syncedAt: Date | null }[];
};

export function courtStats(rows: CourtCaseRow[], sourceFor: (c: CourtCaseRow) => SyncSource | null): CourtStats {
  const s: CourtStats = { scotusTracked: 0, scotusNeedsDocket: 0, linked: 0, unlinked: 0, lastSyncedAt: null, errors: [] };
  for (const c of rows) {
    if (c.syncedAt && (!s.lastSyncedAt || c.syncedAt.getTime() > s.lastSyncedAt.getTime())) s.lastSyncedAt = c.syncedAt;
    if (c.status !== "active") continue;
    if (c.syncError) s.errors.push({ id: c.id, caption: c.caption, error: c.syncError, syncedAt: c.syncedAt });
    if (sourceFor(c) === "scotus") s.scotusTracked++;
    else if (c.courtlistenerDocketId != null) s.linked++;
    else if (c.caseType === "supreme_court") s.scotusNeedsDocket++;
    else s.unlinked++;
  }
  return s;
}
