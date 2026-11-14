/**
 * Federal court names ↔ CourtListener court ids, and docket-number
 * normalization (used to auto-link pool cases to CourtListener dockets). Pure.
 */

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
  ["gu", "Guam", "Guam"],
  ["vi", "V.I.", "Virgin Islands"],
];

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** compact Bluebook abbreviation or full name → state code ("cal" / "california" → "ca"). */
const STATE_BY_NAME = new Map<string, string>();
for (const [code, abbr, full] of STATES) {
  STATE_BY_NAME.set(compact(abbr), code);
  STATE_BY_NAME.set(compact(full), code);
}
STATE_BY_NAME.set("ore", "or");
STATE_BY_NAME.set("wisc", "wi");
STATE_BY_NAME.set("cali", "ca");

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh"];
const DIRECTIONS: Record<string, string> = { northern: "n", southern: "s", eastern: "e", western: "w", central: "c", middle: "m" };
/** CourtListener ids that don't follow the <state><dir>d pattern. */
const SPECIAL_DISTRICTS: Record<string, string> = { gu: "gud", vi: "vid" };

function districtId(state: string, dir: string | null): string {
  if (!dir && SPECIAL_DISTRICTS[state]) return SPECIAL_DISTRICTS[state];
  return `${state}${dir ?? ""}d`;
}

/**
 * CourtListener court id for a court name as written in the pool
 * ("S.D.N.Y.", "N.D. Cal.", "D.C. Cir.", "4th Cir.", "Southern District of New York",
 * "District Court, S.D. New York", "U.S. Supreme Court"). Null if unknown.
 */
export function courtIdFromText(court: string | null | undefined): string | null {
  if (!court) return null;
  const t = court.toLowerCase().replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (/supreme court of the united states|\bu\.?\s?s\.? supreme court|^supreme court$|^scotus$/.test(t)) return "scotus";

  // Courts of appeals.
  if (/\bd\.?\s?c\.?\s?cir\b|district of columbia circuit|\bcadc\b/.test(t)) return "cadc";
  if (/\bfed(eral|\.)?\s?cir(cuit|\.)?\b|\bcafc\b/.test(t)) return "cafc";
  const num = /\b(\d{1,2})(st|nd|rd|th)\s?cir/.exec(t);
  if (num && Number(num[1]) >= 1 && Number(num[1]) <= 11) return `ca${Number(num[1])}`;
  const word = new RegExp(`\\b(${ORDINALS.join("|")}) circuit\\b`).exec(t);
  if (word) return `ca${ORDINALS.indexOf(word[1]) + 1}`;

  // District courts, long form.
  const longDir = /\b(northern|southern|eastern|western|central|middle) district of ([a-z .]+)/.exec(t);
  if (longDir) {
    const st = STATE_BY_NAME.get(compact(longDir[2]));
    if (st) return districtId(st, DIRECTIONS[longDir[1]]);
  }
  const longWhole = /\bdistrict of ([a-z .]+)/.exec(t);
  if (longWhole) {
    const st = STATE_BY_NAME.get(compact(longWhole[1]));
    if (st) return districtId(st, null);
  }

  // Short form ("S.D.N.Y.", "N.D. Cal.", "D. Mass.", "District Court, S.D. New York").
  const c = compact(t.replace(/^(u\.?s\.?|united states)\s+/, "").replace(/\bdistrict court\b,?/, ""));
  const dir = /^([nsewcm])d(.+)$/.exec(c);
  if (dir) {
    const st = STATE_BY_NAME.get(dir[2]);
    if (st) return districtId(st, dir[1]);
  }
  const whole = /^d(.+)$/.exec(c);
  if (whole) {
    const st = STATE_BY_NAME.get(whole[1]);
    if (st) return districtId(st, null);
  }
  return null;
}

/** Short label for a CourtListener court id ("nysd" → "S.D.N.Y.", "cand" → "N.D. Cal.", "ca9" → "9th Cir."). */
export function courtLabel(courtId: string): string | null {
  const id = courtId.toLowerCase();
  if (id === "scotus") return "U.S. Supreme Court";
  if (id === "cadc") return "D.C. Cir.";
  if (id === "cafc") return "Fed. Cir.";
  const ca = /^ca(\d{1,2})$/.exec(id);
  if (ca) {
    const n = Number(ca[1]);
    const suffix = n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th";
    return `${n}${suffix} Cir.`;
  }
  for (const [code, abbr] of STATES) {
    const tight = /^([A-Z]\.)+$/.test(abbr.replace(/ /g, "")) && !abbr.includes(" ");
    const join = (prefix: string) => (tight ? `${prefix}${abbr}` : `${prefix} ${abbr}`);
    if (id === districtId(code, null)) return join("D.");
    for (const [, d] of Object.entries(DIRECTIONS)) {
      if (id === districtId(code, d)) return join(`${d.toUpperCase()}.D.`);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Docket numbers
// ---------------------------------------------------------------------------

export type DistrictDocket = { office: string | null; year: string; kind: string; number: number };

const DISTRICT_KINDS = new Set(["cv", "cr", "md", "mc", "mj", "po", "sw", "bk", "ap", "ml", "misc", "gj"]);

/** "1:24-cv-03973", "5:24-cr-00314-J", "18-CR-457 (AMD)", "26 Cr. 29 (AT)" → parts; null otherwise. */
export function parseDistrictDocket(s: string | null | undefined): DistrictDocket | null {
  if (!s) return null;
  const m = /(?:^|[^\d])(?:(\d{1,2})\s*:\s*)?(\d{2})\s*-?\s*([a-z]{2,4})\.?\s*-?\s*(\d{1,6})\b/i.exec(` ${s}`);
  if (!m) return null;
  const kind = m[3].toLowerCase();
  if (!DISTRICT_KINDS.has(kind)) return null;
  return { office: m[1] ? String(Number(m[1])) : null, year: m[2], kind, number: Number(m[4]) };
}

export function formatDistrictDocket(d: DistrictDocket, withOffice = true): string {
  const core = `${d.year}-${d.kind}-${String(d.number).padStart(5, "0")}`;
  return withOffice && d.office ? `${d.office}:${core}` : core;
}

/** Appellate-style "26-5028" → { year, number }. */
function parseAppellate(s: string): { year: string; number: number } | null {
  const m = /^\s*(?:no\.?\s*)?(\d{2})-(\d{1,5})\s*$/i.exec(s);
  return m ? { year: m[1], number: Number(m[2]) } : null;
}

/** True when two docket numbers name the same case number (office prefix and judge initials ignored when one side lacks them). */
export function docketNumbersMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const da = parseDistrictDocket(a);
  const db = parseDistrictDocket(b);
  if (da && db) {
    return da.year === db.year && da.kind === db.kind && da.number === db.number && (!da.office || !db.office || da.office === db.office);
  }
  const aa = parseAppellate(a);
  const ab = parseAppellate(b);
  if (aa && ab) return aa.year === ab.year && aa.number === ab.number;
  return compact(a) === compact(b) && compact(a).length > 0;
}

/** The docket number to search CourtListener for ("26 Cr. 29 (AT)" → "26-cr-00029"). */
export function docketSearchTerm(s: string): string {
  const d = parseDistrictDocket(s);
  if (d) return formatDistrictDocket(d, true);
  return s.trim().replace(/\s+/g, " ");
}
