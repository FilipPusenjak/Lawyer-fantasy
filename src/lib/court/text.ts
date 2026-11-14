/**
 * Pure text helpers for court data (docket text, party and lawyer names).
 * Framework-free and safe on the client.
 */
import type { Side } from "@/lib/settings";

/** Max length of an event summary (same as SUMMARY_MAX in the events service). */
export const COURT_SUMMARY_MAX = 300;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/** Strip HTML tags, decode the common entities and collapse whitespace. */
export function cleanText(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_, e: string) => ENTITIES[e] ?? " ")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Remove balanced parenthesized groups for which `drop(inner)` is true
 * (handles nesting, e.g. "(Attachments: # 1 Exhibit A (Declaration))").
 */
export function removeParenGroups(s: string, drop: (inner: string) => boolean): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] !== "(") {
      out += s[i++];
      continue;
    }
    let depth = 0;
    let j = i;
    for (; j < s.length; j++) {
      if (s[j] === "(") depth++;
      else if (s[j] === ")" && --depth === 0) break;
    }
    if (j >= s.length) {
      // Unbalanced: keep the rest as is.
      out += s.slice(i);
      break;
    }
    const inner = s.slice(i + 1, j);
    if (!drop(inner)) out += s.slice(i, j + 1);
    i = j + 1;
  }
  return out.replace(/\s+/g, " ").trim();
}

/** "(Attachments: …)", "(Entered: 01/02/2024)", "(Filed on 1/2/2024)" and clerk initials like "(abc)". */
export function isClericalParen(inner: string): boolean {
  const t = inner.trim();
  return (
    /^(attachments?|entered|filed on|main document|additional attachment|text of proposed order|court only|refiled|modified on|filing fee|fee|receipt number)\b/i.test(t) ||
    /^[a-z]{1,4}\d?,?\s*$/.test(t) ||
    /^[a-z]{1,4}, ?[a-z]{0,4}$/.test(t)
  );
}

/** "(Gass, Andrew)" at the end of CM/ECF docket text names the filing attorney. */
export function trailingAttorney(s: string): string | null {
  const stripped = removeParenGroups(cleanText(s), (inner) => {
    const t = inner.trim();
    return /^(entered|filed on|modified on)\b/i.test(t) || /^[a-z]{1,4}\d?,?\s*[a-z]{0,4}$/.test(t);
  });
  const m = /\(([A-Z][A-Za-z'’\-]+(?: [A-Z][A-Za-z'’\-]+)?), ([A-Z][A-Za-z.'’\- ]{1,40})\)\s*$/.exec(stripped);
  if (!m) return null;
  return `${m[2].trim()} ${m[1].trim()}`;
}

/** Neutral, trimmed summary text (≤ 300 chars): no HTML, attachments list or "(Entered: …)" stamps. */
export function summarize(s: string | null | undefined, max = COURT_SUMMARY_MAX): string {
  const t = removeParenGroups(cleanText(s), isClericalParen);
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

/** Lowercase, strip accents and punctuation, collapse spaces: "Défendant's  Motion" → "defendant s motion". */
export function normalizeWords(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v", "esq", "esquire", "phd", "md"]);

/**
 * Comparable key for a person's name: first + last word, ignoring middle
 * names/initials, suffixes (Jr., III) and punctuation.
 * "D. John Sauer" → "john sauer"; "Robert James McNamara" and "Robert J. McNamara" → "robert mcnamara".
 */
export function personNameKey(name: string): string {
  const words = normalizeWords(name.replace(/,/g, " "))
    .split(" ")
    .filter((w) => w && !NAME_SUFFIXES.has(w));
  const full = words.filter((w) => w.length > 1);
  const use = full.length ? full : words;
  if (use.length === 0) return "";
  if (use.length === 1) return use[0];
  return `${use[0]} ${use[use.length - 1]}`;
}

/** Last name and first initial, for a looser match among a case's own lawyers ("Jeff Ifrah" ~ "Jeffrey Ifrah"). */
export function personLooseKey(name: string): string {
  const key = personNameKey(name);
  const parts = key.split(" ");
  if (parts.length < 2) return key;
  return `${parts[0][0]} ${parts[parts.length - 1]}`;
}

export type NamedLawyer = { id: string; name: string };

/**
 * Find the lawyer a court record names. Exact key match among `preferred`
 * (e.g. lawyers on the case) first, then a unique loose match (same last name
 * and first initial) among `preferred`, then a unique exact match in `others`
 * (the rest of the pool). Null when nothing matches or the match is ambiguous.
 */
export function matchLawyerByName<T extends NamedLawyer>(name: string, preferred: T[], others: T[] = []): T | null {
  const key = personNameKey(name);
  if (!key || !key.includes(" ")) return null;
  const exact = preferred.filter((l) => personNameKey(l.name) === key);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const loose = personLooseKey(name);
  const looseHits = preferred.filter((l) => personLooseKey(l.name) === loose);
  if (looseHits.length === 1) return looseHits[0];
  if (looseHits.length > 1) return null;
  const poolHits = others.filter((l) => personNameKey(l.name) === key);
  return poolHits.length === 1 ? poolHits[0] : null;
}

// ---------------------------------------------------------------------------
// Parties
// ---------------------------------------------------------------------------

export type PartyNames = Record<Side, string[]>;

/**
 * Party names from a caption: "United States v. Live Nation Entertainment, Inc."
 * → plaintiff ["United States"], defendant ["Live Nation Entertainment, Inc."].
 * "In re …" captions have no sides.
 */
export function partiesFromCaption(caption: string): PartyNames {
  const out: PartyNames = { plaintiff: [], defendant: [] };
  const c = cleanText(caption);
  if (/^in re\b|^in the matter of\b|^ex parte\b/i.test(c)) return out;
  const m = /^(.+?)\s+v(?:s)?\.?\s+(.+)$/i.exec(c);
  if (!m) return out;
  const split = (s: string) =>
    s
      .replace(/,?\s+et al\.?/gi, "")
      .split(/\s+and\s+/i)
      .map((x) => x.trim().replace(/[,.;]+$/, ""))
      .filter((x) => x.length > 0);
  out.plaintiff = split(m[1]);
  out.defendant = split(m[2]);
  return out;
}

const ENTITY_SUFFIXES = new Set([
  "the",
  "inc",
  "incorporated",
  "llc",
  "l",
  "c",
  "corp",
  "corporation",
  "co",
  "company",
  "ltd",
  "limited",
  "lp",
  "llp",
  "pllc",
  "pc",
  "plc",
  "na",
  "n",
  "a",
  "sa",
  "ag",
  "dba",
  "et",
  "al",
]);

/** Distinctive words of a party name: "Live Nation Entertainment, Inc." → "live nation entertainment". */
export function partyCore(name: string): string {
  const words = normalizeWords(name).split(" ").filter(Boolean);
  while (words.length && ENTITY_SUFFIXES.has(words[0])) words.shift();
  while (words.length && ENTITY_SUFFIXES.has(words[words.length - 1])) words.pop();
  return words.join(" ");
}

/** True when the normalized fragment mentions the party (whole words). */
export function mentionsParty(normalizedFragment: string, partyName: string): boolean {
  const core = partyCore(partyName);
  if (core.length < 3) return false;
  const hay = ` ${normalizedFragment} `;
  if (hay.includes(` ${core} `)) return true;
  const words = core.split(" ");
  if (words.length >= 3) {
    const short = words.slice(0, 2).join(" ");
    if (short.length >= 6 && hay.includes(` ${short} `)) return true;
  }
  return false;
}

/** Party names that refer to the government (U.S., an agency, a state). */
export function isGovernmentParty(name: string): boolean {
  const n = normalizeWords(name);
  return (
    /^(the )?(united states|usa|u s a|u s|us|government|people of|state of|commonwealth of|department of|federal trade commission|securities and exchange commission|national labor relations board|consumer financial protection bureau|equal employment opportunity commission|federal communications commission)\b/.test(
      n,
    ) || /^(ftc|sec|doj|fcc|nlrb|eeoc|cfpb)$/.test(n)
  );
}

/** Lowercase URL-ish slug of a caption ("United States v. Apple Inc." → "united-states-v-apple-inc"). */
export function slugify(s: string): string {
  return normalizeWords(s).replace(/ /g, "-").slice(0, 80) || "docket";
}
