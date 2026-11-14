/**
 * U.S. Supreme Court docket feed (https://www.supremecourt.gov/RSS/Cases/JSON/<docket>.json):
 * parse the JSON and turn proceedings into suggested scoring events. Pure.
 *
 * Sides: petitioner/appellant = "plaintiff", respondent/appellee = "defendant"
 * (see sideLabel for supreme_court cases).
 */
import type { EventType, Side } from "@/lib/settings";
import { cleanText, normalizeWords, partyCore } from "./text";

export type ScotusLink = { description: string; url: string };
export type ScotusProceeding = {
  /** 0-based position in ProceedingsandOrder (chronological). */
  index: number;
  /** YYYY-MM-DD (null if the feed's date can't be read). */
  date: string | null;
  /** Proceeding text without HTML. */
  text: string;
  links: ScotusLink[];
};
export type ScotusAttorney = {
  name: string;
  side: "petitioner" | "respondent" | "other";
  organization: string | null;
  party: string | null;
  counselOfRecord: boolean;
};
export type ScotusDocket = {
  /** Canonical docket number, e.g. "25-159". */
  docket: string;
  petitionerTitle: string;
  respondentTitle: string;
  docketedDate: string | null;
  lowerCourt: string | null;
  proceedings: ScotusProceeding[];
  attorneys: ScotusAttorney[];
};

/** "25-159", " No. 25-00159 ", "25a140" → "25-159" / "25A140"; null if it isn't a Supreme Court docket number. */
export function normalizeScotusDocket(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = /^\s*(?:no\.?\s*)?(\d{2})\s*([-aA])\s*0*(\d{1,5})\s*$/i.exec(s);
  if (!m || Number(m[3]) === 0) return null;
  return `${m[1]}${m[2] === "-" ? "-" : "A"}${Number(m[3])}`;
}

export function scotusJsonUrl(docket: string): string {
  return `https://www.supremecourt.gov/RSS/Cases/JSON/${encodeURIComponent(docket)}.json`;
}

export function scotusDocketPageUrl(docket: string): string {
  return `https://www.supremecourt.gov/search.aspx?filename=/docket/docketfiles/html/public/${encodeURIComponent(docket)}.html`;
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/** "Jun 04 2025", "August 11, 2025" or "11/13/2026" → "2025-06-04"; null if unreadable. */
export function parseScotusDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  let y: number, mo: number, d: number;
  const named = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(t);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (named) {
    mo = MONTHS[named[1].toLowerCase()];
    d = Number(named[2]);
    y = Number(named[3]);
  } else if (us) {
    mo = Number(us[1]);
    d = Number(us[2]);
    y = Number(us[3]);
  } else return null;
  if (!mo || d < 1 || d > 31) return null;
  const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const check = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(check.getTime()) && check.toISOString().slice(0, 10) === iso ? iso : null;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Parse the feed JSON. Throws when it doesn't look like a docket. */
export function parseScotusDocket(json: unknown): ScotusDocket {
  if (!json || typeof json !== "object") throw new Error("Supreme Court feed: not a docket");
  const o = json as Record<string, unknown>;
  const docket = normalizeScotusDocket(str(o.CaseNumber));
  if (!docket || !Array.isArray(o.ProceedingsandOrder)) throw new Error("Supreme Court feed: not a docket");
  const proceedings: ScotusProceeding[] = (o.ProceedingsandOrder as unknown[]).map((raw, index) => {
    const p = (raw ?? {}) as Record<string, unknown>;
    const links: ScotusLink[] = Array.isArray(p.Links)
      ? (p.Links as unknown[]).flatMap((l) => {
          const r = (l ?? {}) as Record<string, unknown>;
          const url = str(r.DocumentUrl);
          return /^https?:\/\//.test(url) ? [{ description: str(r.Description), url }] : [];
        })
      : [];
    return { index, date: parseScotusDate(str(p.Date)), text: cleanText(str(p.Text)), links };
  });
  const attorneys: ScotusAttorney[] = [];
  for (const [key, side] of [
    ["Petitioner", "petitioner"],
    ["Respondent", "respondent"],
    ["Other", "other"],
  ] as const) {
    const list = o[key];
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const a = (raw ?? {}) as Record<string, unknown>;
      const name = cleanText(str(a.Attorney));
      if (!name) continue;
      attorneys.push({
        name,
        side,
        organization: cleanText(str(a.Title)) || null,
        party: cleanText(str(a.PartyName)) || null,
        counselOfRecord: a.IsCounselofRecord === true,
      });
    }
  }
  return {
    docket,
    petitionerTitle: cleanText(str(o.PetitionerTitle)),
    respondentTitle: cleanText(str(o.RespondentTitle)),
    docketedDate: parseScotusDate(str(o.DocketedDate)),
    lowerCourt: cleanText(str(o.LowerCourt)) || null,
    proceedings,
    attorneys,
  };
}

// ---------------------------------------------------------------------------
// Oral argument
// ---------------------------------------------------------------------------

export type ScotusArguer = {
  /** As printed, e.g. "Robert J. McNamara" (suffixes like "Jr." kept). */
  name: string;
  /** Side argued for (petitioner = plaintiff); for an amicus, the side it supported when stated. */
  side: Side | null;
  amicus: boolean;
  /** The "For …:" label, e.g. "petitioners", "United States, as amicus curiae". */
  label: string;
};

function labelSide(s: string): Side | null {
  const n = normalizeWords(s);
  const p = /\b(petitioners?|appellants?)\b/.test(n);
  const r = /\b(respondents?|appellees?)\b/.test(n);
  if (p === r) return null;
  return p ? "plaintiff" : "defendant";
}

/**
 * Who argued, from "Argued. For petitioners: A, City.  For respondent: B, City; and C, Title, City (for United States, as amicus curiae.)".
 * Returns [] for anything that isn't an argument entry.
 */
export function parseArgument(text: string): ScotusArguer[] {
  const t = cleanText(text);
  const head = /^(re-?)?argued\b\.?\s*/i.exec(t);
  if (!head) return [];
  const body = t.slice(head[0].length);
  const labelRe = /(?:^|\s)For ([^:()]{1,120}):\s*/g;
  const marks: { label: string; start: number; end: number }[] = [];
  for (let m: RegExpExecArray | null; (m = labelRe.exec(body)); ) marks.push({ label: m[1].trim(), start: m.index, end: m.index + m[0].length });
  const out: ScotusArguer[] = [];
  marks.forEach((mark, i) => {
    const content = body.slice(mark.end, i + 1 < marks.length ? marks[i + 1].start : body.length);
    const side = labelSide(mark.label);
    const labelAmicus = /\bamic(us|i)\b/i.test(mark.label);
    for (const piece of content.split(/;\s*(?:and\s+)?/)) {
      const p = piece.trim();
      if (!p) continue;
      const parts = p.split(",").map((x) => x.trim());
      let name = parts[0];
      if (parts[1] && /^(jr|sr|ii|iii|iv)\.?$/i.test(parts[1])) name = `${name}, ${parts[1]}`;
      if (!/^[A-Z]/.test(name) || name.split(/\s+/).length < 2 || name.length > 80) continue;
      const amicus = labelAmicus || /\bamic(us|i)\b/i.test(p);
      let s = side;
      if (amicus && !s) {
        const sup = /supporting (?:the )?(petitioners?|respondents?|appellants?|appellees?)/i.exec(p);
        s = sup ? labelSide(sup[1]) : null;
      }
      out.push({ name, side: s, amicus, label: mark.label });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Proceedings → suggestions
// ---------------------------------------------------------------------------

export type ScotusSuggestion =
  | { kind: "side"; type: EventType; side: Side | null; reason: string }
  | { kind: "lawyer"; type: "scotus_argument"; lawyerName: string; side: Side | null; amicus: boolean; reason: string };

export type ScotusClassification = { skip: true; reason: string } | { skip: false; suggestions: ScotusSuggestion[] };

const sideEvent = (type: EventType, side: Side | null, reason: string): ScotusClassification => ({
  skip: false,
  suggestions: [{ kind: "side", type, side, reason }],
});
const skip = (reason: string): ScotusClassification => ({ skip: true, reason });

function titleSide(name: string, titles: { petitionerTitle?: string; respondentTitle?: string }): Side | null {
  const core = (s: string | undefined) =>
    partyCore((s ?? "").replace(/,?\s*(et al\.?|petitioners?|respondents?|appellants?|appellees?)\b.*$/i, ""));
  const n = partyCore(name.replace(/,?\s*et al\.?/i, ""));
  if (n.length < 3) return null;
  const p = core(titles.petitionerTitle);
  const r = core(titles.respondentTitle);
  const hitP = !!p && (p.startsWith(n) || n.startsWith(p));
  const hitR = !!r && (r.startsWith(n) || n.startsWith(r));
  if (hitP === hitR) return null;
  return hitP ? "plaintiff" : "defendant";
}

/**
 * One proceeding → suggestions. Arguments give one scotus_argument per named
 * arguing lawyer; decisions give appeal_won (reversed/vacated → petitioner,
 * affirmed → respondent); merits/cert-stage briefs by a party give "filing".
 * Amicus briefs, motions, extensions, distributions, letters, record notes etc. are skipped.
 */
export function classifyScotusProceeding(
  text: string,
  titles: { petitionerTitle?: string; respondentTitle?: string } = {},
): ScotusClassification {
  const t = cleanText(text);
  if (!t) return skip("Empty entry");

  if (/^(re-?)?argued\b/i.test(t)) {
    const arguers = parseArgument(t);
    if (arguers.length === 0) return skip("Argument entry without names");
    return {
      skip: false,
      suggestions: arguers.map((a) => ({
        kind: "lawyer" as const,
        type: "scotus_argument" as const,
        lawyerName: a.name,
        side: a.side,
        amicus: a.amicus,
        reason: `Argued before the Supreme Court (${a.label})`,
      })),
    };
  }

  const first = t.split(/\.\s+/)[0];
  if (/\bissued\b/i.test(first) && /^(the )?(judgment|mandate|certified copy)/i.test(t)) return skip("Judgment/mandate issued (clerical)");
  if (/dismissed as improvidently granted/i.test(t)) {
    return sideEvent("appeal_won", null, "Dismissed as improvidently granted (lower-court judgment stands): pick the side");
  }
  if (/^petition (for (a )?writ of certiorari )?granted\.?\s+(the )?judgment (is )?(vacated|reversed)/i.test(t)) {
    return sideEvent("appeal_won", "plaintiff", "Certiorari granted, judgment vacated and remanded (petitioner)");
  }
  if (/^(the )?(judgment|adjudged|decree)\b|^(affirmed|reversed|vacated)\b/i.test(t)) {
    const rev = /\b(reversed|vacated)\b/i.test(first);
    const aff = /\baffirmed\b/i.test(first);
    if (rev && aff) return sideEvent("appeal_won", null, "Mixed decision (affirmed in part, reversed/vacated in part): pick the side");
    if (rev) return sideEvent("appeal_won", "plaintiff", "Judgment reversed/vacated (petitioner wins)");
    if (aff) return sideEvent("appeal_won", "defendant", "Judgment affirmed (respondent wins)");
    return skip("Judgment entry without a decision");
  }
  if (/^petition (for (a )?writ of certiorari )?denied\b/i.test(t)) {
    return sideEvent("appeal_won", "defendant", "Certiorari denied (lower-court judgment stands)");
  }

  if (/not accepted for filing/i.test(t)) return skip("Filing not accepted");
  if (/^(brief|letter|motion)s?\b[^.]*\bamic(us|i)\b|^amicus brief|^brief amic/i.test(t)) return skip("Amicus brief");

  const filed = /\bfiled\b/i.test(t);
  if (filed) {
    const role =
      /^(?:(?:supplemental|reply|corrected|amended)\s+)?brief (?:of|for) (?:the )?(?:federal |state )?(petitioners?|respondents?|appellants?|appellees?)\b/i.exec(t) ??
      /^reply (?:brief )?(?:of|for) (?:the )?(?:federal |state )?(petitioners?|respondents?|appellants?|appellees?)\b/i.exec(t);
    if (role) {
      const side = labelSide(role[1]);
      return sideEvent("filing", side, `Brief filed (${side === "plaintiff" ? "petitioner" : "respondent"})`);
    }
    if (/^petition for (a )?writ of certiorari\b/i.test(t)) return sideEvent("filing", "plaintiff", "Petition for certiorari filed (petitioner)");
    if (/^jurisdictional statement\b/i.test(t)) return sideEvent("filing", "plaintiff", "Jurisdictional statement filed (appellant)");
    const named = /^(?:(?:supplemental|reply|corrected|amended)\s+)?(?:brief|reply) (?:of|for) (.+?)(?: in opposition)? filed\b/i.exec(t);
    if (named) {
      const side = titleSide(named[1], titles);
      if (side) return sideEvent("filing", side, `Brief filed (${side === "plaintiff" ? "petitioner" : "respondent"})`);
      return skip("Brief by someone other than the parties");
    }
  }
  return skip("Procedural docket entry");
}
