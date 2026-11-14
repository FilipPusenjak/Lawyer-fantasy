/**
 * Classify one CourtListener docket entry (CM/ECF docket text) into a
 * suggested scoring event, or skip it as clerical noise. Pure and explainable:
 * simple keyword rules, and every result carries a short `reason`.
 *
 * Sides are only inferred when the text says so: role words ("by Plaintiff",
 * "Defendants' motion", "by USA", "petitioner"…), a party name from the
 * caption, or the filing attorney matching one of the case's lawyers.
 * Otherwise `side` is null and the commissioner picks it.
 */
import { SIDES, type CaseType, type EventType, type Side } from "@/lib/settings";
import {
  cleanText,
  isClericalParen,
  isGovernmentParty,
  mentionsParty,
  normalizeWords,
  personLooseKey,
  personNameKey,
  removeParenGroups,
  trailingAttorney,
  type PartyNames,
} from "./text";

export type ClassifyOptions = {
  caseType?: CaseType;
  /** Party names per side, e.g. partiesFromCaption(case.caption). */
  parties?: Partial<PartyNames>;
  /** The case's lawyers per side (pool appearances), matched against the filing attorney "(Last, First)". */
  attorneys?: Partial<PartyNames>;
};

export type DocketClassification =
  | { skip: true; reason: string }
  | { skip: false; type: EventType; side: Side | null; reason: string };

type Ctx = { caseType: CaseType | undefined; parties: PartyNames; attorneys: PartyNames };

const skip = (reason: string): DocketClassification => ({ skip: true, reason });
const event = (type: EventType, side: Side | null, reason: string): DocketClassification => ({ skip: false, type, side, reason });
const other = (s: Side): Side => (s === "plaintiff" ? "defendant" : "plaintiff");

// ---------------------------------------------------------------------------
// Sides
// ---------------------------------------------------------------------------

const NON_PARTY = /\b(non ?part(y|ies)|nonpart(y|ies)|amicus|amici|interested part(y|ies)|third party|movants?|witness(es)?)\b/;
const COUNTER_P = /\b(counter ?(claim )?defendants?|counterdefendants?)\b/g;
const COUNTER_D = /\b(counter ?(claim )?(plaintiffs?|claimants?)|counterclaimants?)\b/g;
const BASIC: [RegExp, RegExp] = [/\b(plaintiffs?|relators?|prosecution|prosecutors?)\b/, /\b(defendants?|debtors?)\b/];
const APPELLATE: [RegExp, RegExp] = [/\b(appellants?|petitioners?)\b/, /\b(appellees?|respondents?)\b/];
const GOVERNMENT_WORDS = /\b(united states( of america)?|usa|u s a|government)\b/;

function roleSide(f: string, ctx: Ctx): Side | "both" | null {
  const counter = new Set<Side>();
  let s = f.replace(COUNTER_P, () => {
    counter.add("plaintiff");
    return " ";
  });
  s = s.replace(COUNTER_D, () => {
    counter.add("defendant");
    return " ";
  });
  const appellate = ctx.caseType === "appeal" || ctx.caseType === "supreme_court";
  for (const [p, d] of appellate ? [APPELLATE, BASIC] : [BASIC, APPELLATE]) {
    const hp = p.test(s);
    const hd = d.test(s);
    if (hp && hd) return "both";
    if (hp || hd) {
      const side: Side = hp ? "plaintiff" : "defendant";
      return counter.has(other(side)) ? "both" : side;
    }
  }
  if (counter.size === 1) return [...counter][0];
  return counter.size > 1 ? "both" : null;
}

/** The government's side: the side whose caption party is the U.S./an agency/a state; prosecution in criminal cases. */
function governmentSide(ctx: Ctx): Side | null {
  const p = ctx.parties.plaintiff.some(isGovernmentParty);
  const d = ctx.parties.defendant.some(isGovernmentParty);
  if (p && !d) return "plaintiff";
  if (d && !p) return "defendant";
  return ctx.caseType === "criminal" ? "plaintiff" : null;
}

/** Side named in a short fragment like "Defendant Acme Corp.", "the Government", "Live Nation Entertainment, Inc.". */
export function sideFromFragment(fragment: string, opts: ClassifyOptions = {}): Side | null {
  return sideIn(fragment, toCtx(opts));
}

function sideIn(fragment: string, ctx: Ctx): Side | null {
  const f = normalizeWords(fragment);
  if (!f || NON_PARTY.test(f)) return null;
  const role = roleSide(f, ctx);
  if (role === "both") return null;
  if (role) return role;
  if (GOVERNMENT_WORDS.test(f)) {
    const g = governmentSide(ctx);
    if (g) return g;
  }
  const hits = new Set<Side>();
  for (const side of SIDES) for (const name of ctx.parties[side]) if (mentionsParty(f, name)) hits.add(side);
  return hits.size === 1 ? [...hits][0] : null;
}

function attorneySide(name: string, ctx: Ctx): Side | null {
  const key = personNameKey(name);
  const loose = personLooseKey(name);
  for (const match of [(n: string) => personNameKey(n) === key, (n: string) => personLooseKey(n) === loose]) {
    const hits = new Set<Side>();
    for (const side of SIDES) if (ctx.attorneys[side].some(match)) hits.add(side);
    if (hits.size === 1) return [...hits][0];
    if (hits.size > 1) return null;
  }
  return null;
}

function toCtx(opts: ClassifyOptions): Ctx {
  return {
    caseType: opts.caseType,
    parties: { plaintiff: opts.parties?.plaintiff ?? [], defendant: opts.parties?.defendant ?? [] },
    attorneys: { plaintiff: opts.attorneys?.plaintiff ?? [], defendant: opts.attorneys?.defendant ?? [] },
  };
}

// ---------------------------------------------------------------------------
// Document kinds and noise
// ---------------------------------------------------------------------------

type Kind =
  | "proposed"
  | "rr"
  | "order"
  | "minute"
  | "verdict"
  | "judgment"
  | "motion"
  | "brief"
  | "plea"
  | "stipulation"
  | "appeal"
  | "pleading"
  | "notice"
  | "letter"
  | "other";

const MODIFIERS =
  /^((sealed|redacted|amended|corrected|first|second|third|fourth|renewed|supplemental|emergency|joint|consent|unopposed|opposed|cross|expedited|ex parte|stipulated|agreed|revised|\*+)[\s-]+)+/;

function leading(l: string): string {
  return l.replace(/^[\s*#[\]()-]+/, "");
}

function docKind(l: string): Kind {
  const raw = leading(l);
  if (/^\[?proposed\]?\s/.test(raw)) return "proposed";
  const s = raw.replace(MODIFIERS, "");
  if (/^(report and recommendations?|findings and recommendations?)\b/.test(s)) return "rr";
  if (
    /^(memorandum (opinion|order|decision)|memorandum (and|&) (order|opinion)|opinion|decision|ruling|order|minute order|text( only)? order|electronic order|paperless order|endorsed (letter|order)|memo(randum)? endorse(d|ment)|so ordered|bench ruling|oral order)\b/.test(
      s,
    )
  )
    return "order";
  if (/^(minute entry|minutes|minute|proceedings|clerk'?s minutes)\b/.test(s)) return "minute";
  if (
    /^(motion|status|pretrial|pre-trial|sentencing|scheduling|telephone|telephonic|discovery|initial|settlement|oral argument|evidentiary|change of plea|plea|jury|bench|show cause|daubert)( (?!to\b|for\b)\w+){0,2} (hearing|conference|trial|argument)\b/.test(
      s,
    )
  )
    return "minute";
  if (/^(jury )?verdict\b/.test(s)) return "verdict";
  if (/^(clerk'?s )?(final |default |partial |amended )?judgments?\b/.test(s)) return "judgment";
  if (/^(letter[ -])?motions?\b|^notice of (cross[ -])?motion\b|^(application|request)\b/.test(s)) return "motion";
  if (
    /^(brief|memorandum|response|reply|opposition|objections?|sur[ -]?reply|surreply|rebuttal|trial brief|(post|pre)[ -]?trial brief|proposed findings|supplement)\b/.test(
      s,
    )
  )
    return "brief";
  if (/^(plea agreement|plea)\b/.test(s)) return "plea";
  if (/^(stipulations?|notice of (voluntary )?dismissal|notice of settlement|voluntary dismissal|consent (judgment|decree)|settlement agreement)\b/.test(s))
    return "stipulation";
  if (/^notice of (cross[ -])?appeal\b/.test(s)) return "appeal";
  if (
    /^(complaint|counterclaims?|crossclaims?|cross[- ]claims?|third[ -]party complaint|petition for (a )?writ of habeas|indictment|superseding indictment|information|superseding information|answer)\b/.test(
      s,
    )
  )
    return "pleading";
  if (/^notice\b/.test(s)) return "notice";
  if (/^letter\b/.test(s)) return "letter";
  return "other";
}

/** Clerical entries, recognized by their leading words (plus pro hac vice anywhere). */
const NOISE: [RegExp, string][] = [
  [/pro hac vice|\badmission to practice\b|\badmitted to practice\b/, "Pro hac vice / admission"],
  [
    /^(notice of )?(attorney )?appearance\b|^notice of (change of (address|attorney|firm)|withdrawal|substitution|attorney|designation)/,
    "Notice of appearance or change of counsel",
  ],
  [
    /^(official |notice of (filing of )?(official )?)?transcripts?\b|\btranscript of proceedings\b|^redaction request|^notice of intent to request redaction|^(court reporter|reporter'?s)/,
    "Transcript",
  ],
  [/^(certificate|proof|affidavit|declaration|acknowledg\w*) of (service|compliance|mailing|interested|counsel)/, "Certificate of service"],
  [/^(summons|alias summons|waiver of service|service of process|return of service)|\bsummons (returned|issued)\b/, "Summons / service"],
  [
    /^(docketing statement|civil cover sheet|corporate disclosure|disclosure statement|rule 7\.1|certificate of interested|notice of related case|related case|statement of related|financial interest|notice of interested)/,
    "Disclosure / docketing statement",
  ],
  [
    /^(case (opened|assigned|reassigned|referred|transferred|unsealed|designated)|(re)?assign|referral|magistrate judge|consent to (proceed|jurisdiction|magistrate)|declin\w* (to )?consent|judge update)/,
    "Case administration",
  ],
  [
    /^(clerk'?s? (notice|entry|certificate)|remark|quality control|mail returned|receipt|payment|filing fee|fee (paid|status)|pacer|electronic (notice|filing)|ecf|notice of (electronic|docket correction|deficiency|filing error|hearing|compliance)|docket (annotation|correction|text)|errata|erratum)/,
    "Clerk's note",
  ],
  [
    /^(scheduling|case management|pretrial|pre-trial|discovery|amended scheduling) (order|conference order)|^order (setting|resetting|scheduling|rescheduling|continuing|adjourning|regarding scheduling|re scheduling)|^(set|reset)( ?\/ ?reset)? (deadlines?|hearings?|scheduling|motion)|^set\/reset|^(deadlines?|hearings?) (set|reset)/,
    "Scheduling",
  ],
  [
    /^(joint )?(status|progress) report|^(joint )?(rule 26|26\(f\)|discovery plan|case management (statement|report))|^initial disclosures?/,
    "Status report",
  ],
  [
    /^(exhibits?|attachments?|declarations?|affidavits?|appendix|index of exhibits|exhibit list|witness list|sealed (document|envelope)|lodged|lodging|notice of lodging|conventional filing)\b/,
    "Exhibit or supporting declaration",
  ],
  [
    /^(arrest warrant|warrant|cja|criminal justice act|arraignment|initial appearance|detention|order of detention|order setting conditions|appearance bond|bond|waiver of (indictment|detention|personal appearance)|speedy trial|order (excluding|to exclude) time|excludable delay|pretrial services|presentence|psr|rule 5|financial affidavit|order appointing (counsel|federal public defender))/,
    "Criminal case administration",
  ],
  [/^(mandate|record on appeal|appeal (remark|record)|usca|transmission|certified copy|notice of docketing|appeal (filing )?fee|transcript designation)/, "Appeals administration"],
  [/^(subpoena|writ of|notice of (deposition|service|subpoena))/, "Subpoena / writ"],
];

/** Motions (and orders on them) about scheduling, sealing, counsel, extensions… — not scored. */
const PROCEDURAL =
  /\b(extension of time|extend (the )?(time|deadline)|extending (the )?(time|deadline)|enlarge(ment of)? time|page limits?|excess pages|exceed (the )?page|oversized|leave to file (excess|oversized|under seal|a sur ?reply|surreply|reply|amicus|supplemental|a supplemental|document|notice|exhibit|a brief|brief)|under seal|to seal\b|sealing|seal (documents?|exhibits?)|redact\w*|withdraw (as|the appearance)|withdrawal of (attorney|counsel|appearance)|substitut\w* (of )?(attorney|counsel)|adjourn\w*|continu(e|ance)\b|reschedul\w*|postpone\w*|appear (remotely|by (phone|telephone|video))|telephonic|video ?conference|electronic (devices|equipment)|bring (in )?(electronic|equipment)|briefing schedule|scheduling|conference|stay of discovery|appointment of counsel|appoint counsel|in forma pauperis|leave to proceed|joinder|join in|to join\b|leave to appear|appearance|permission to travel|to travel|modify (conditions|bond)|unseal\w*|alternative service|service of process|consolidat\w*|related case|transcripts?|mediation|deadline|judicial notice)\b/;

// ---------------------------------------------------------------------------
// Fragments: who filed / who moved
// ---------------------------------------------------------------------------

const STOP_BEFORE_BY = new Set([
  "signed",
  "entered",
  "ordered",
  "issued",
  "granted",
  "denied",
  "reviewed",
  "barred",
  "caused",
  "required",
  "imposed",
  "set",
  "adopted",
  "executed",
  "served",
  "held",
  "presided",
  "approved",
  "recommended",
  "made",
  "represented",
  "followed",
  "supported",
  "accompanied",
  "governed",
  "authorized",
  "permitted",
  "prohibited",
  "referred",
  "assigned",
  "joined",
  "precluded",
  "affected",
  "raised",
  "decided",
  "stayed",
  "reassigned",
  "submitted",
  "conducted",
]);

const ABBREVIATIONS = new Set(["inc", "corp", "ltd", "llc", "llp", "co", "jr", "sr", "no", "st", "dept", "assn", "bros", "intl", "natl", "mr", "ms", "dr"]);

/** A filer/mover fragment ends at "as to", "re", "(", ";" or a sentence break (not "U.S. Department" or "Inc. and"). */
function cutFragment(s: string): string {
  let end = s.length;
  const stop = /\s(as to|re:?|regarding|in support|in opposition|responding to|pursuant to|on behalf of|with respect to)\s|;|\(/.exec(s);
  if (stop) end = stop.index;
  const sentence = /\.\s+(?=[a-z]{4,}\s)/g;
  for (let m: RegExpExecArray | null; (m = sentence.exec(s)) && m.index < end; ) {
    const word = /([a-z]+)$/.exec(s.slice(0, m.index))?.[1] ?? "";
    if (word.length >= 3 && !ABBREVIATIONS.has(word)) {
      end = m.index;
      break;
    }
  }
  return s.slice(0, end).slice(0, 160).trim();
}

/** The filer of a motion/brief: last "filed by X", else "by X", else "motion of X". */
function filerFragment(l: string): { fragment: string | null; rest: string } {
  const fi = l.lastIndexOf("filed by ");
  if (fi >= 0) {
    const start = l.lastIndexOf("document filed by ") === fi - 9 ? fi - 9 : fi;
    return { fragment: cutFragment(l.slice(fi + 9)), rest: l.slice(0, start) };
  }
  const byRe = /(\S+)\s+by\s+/g;
  for (let m: RegExpExecArray | null; (m = byRe.exec(l)); ) {
    if (STOP_BEFORE_BY.has(m[1].replace(/[^a-z]/g, ""))) continue;
    return { fragment: cutFragment(l.slice(m.index + m[0].length)), rest: l.slice(0, m.index + m[1].length) };
  }
  const of = /^(?:\S+\s+){0,3}?(?:motion|application|request)s?\s+of\s+(.+?)\s+(?:to|for|requesting|seeking)\b/.exec(leading(l));
  if (of) return { fragment: cutFragment(of[1]), rest: l.replace(of[1], " ") };
  return { fragment: null, rest: l };
}

// ---------------------------------------------------------------------------
// Rulings on motions
// ---------------------------------------------------------------------------

const DECISION = /\b(granting|grants|grant|granted|denying|denies|deny|denied)\b/g;
const MOTION_WORD = /\b(motions?|applications?|requests?|petitions?|objections?)\b/;

type Ruling = { granted: boolean; partial: boolean; phrase: string; mover: Side | null };

function cutPhrase(s: string): string {
  const stop =
    /;|\bsigned by\b|\bso ordered\b|\bit is (further )?ordered\b|\b(and |, )?(granting|denying|grants|denies)\b|\bas (moot|follows)\b|\bfor the reasons\b|\.\s+(the|it|this|plaintiffs?|defendants?|signed|ordered|entered|see|accordingly|a|an|in|for)\b/.exec(
      s,
    );
  return (stop ? s.slice(0, stop.index) : s).slice(0, 250);
}

/** The clause that ends right before a passive "granted"/"denied" (after the last ";" or ":" — not "re:"). */
function clauseBefore(s: string): string {
  let i = s.lastIndexOf(";");
  const colon = /:/g;
  for (let m: RegExpExecArray | null; (m = colon.exec(s)); ) {
    if (!/\bre$/.test(s.slice(0, m.index))) i = Math.max(i, m.index);
  }
  return s.slice(i + 1).slice(-250);
}

function moverFromPhrase(phrase: string, ctx: Ctx): Side | null {
  const mi = phrase.search(MOTION_WORD);
  if (mi < 0) return null;
  const preRaw = phrase.slice(0, mi);
  const pre = preRaw.split(/[.;:]\s/).pop()!.slice(-80);
  const post = phrase.slice(mi);
  const sides = new Set<Side>();
  const s1 = pre.trim() ? sideIn(pre, ctx) : null;
  if (s1) sides.add(s1);
  let frag: string | null = null;
  const fb = /\bfiled by\s+(.+)$/.exec(post);
  if (fb) frag = fb[1];
  else {
    const byRe = /(\S+)\s+by\s+(.+)$/.exec(post);
    if (byRe && !STOP_BEFORE_BY.has(byRe[1].replace(/[^a-z]/g, ""))) frag = byRe[2];
    else {
      const of = /^(?:motions?|applications?|requests?|petitions?)\s+of\s+(.+?)(?:\s+(?:to|for|requesting|seeking|that)\b|$)/.exec(post);
      if (of) frag = of[1];
    }
  }
  if (frag) {
    const s2 = sideIn(cutFragment(frag), ctx);
    if (s2) sides.add(s2);
  }
  return sides.size === 1 ? [...sides][0] : null;
}

/** The part of a motion phrase that describes the motion (before "filed by"/"by X"). */
function motionDescription(phrase: string): string {
  const fb = phrase.search(/\b(filed )?by\s/);
  return fb >= 0 ? phrase.slice(0, fb) : phrase;
}

function isBareMotionPhrase(desc: string): boolean {
  return normalizeWords(desc)
    .split(" ")
    .filter((w) => w && !/^(the|a|an|its|their|this|that|said|\d+|motions?|applications?|requests?|petitions?|objections?|is|are|be|hereby|letter|ecf|no|dkt)$/.test(w))
    .length === 0;
}

/** First ruling on a non-procedural motion in an order (null if none). */
function findRuling(l: string, ctx: Ctx): Ruling | null {
  DECISION.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = DECISION.exec(l)); ) {
    const word = m[1];
    const granted = word.startsWith("grant");
    const after = l.slice(m.index + m[0].length);
    let partial = false;
    let phrase: string;
    if (!word.endsWith("ed")) {
      let rest = after;
      const pm = /^\s+in part(\s+and\s+(granting|denying|grants|denies)\s+in part)?/.exec(rest);
      if (pm) {
        partial = true;
        rest = rest.slice(pm[0].length);
      }
      if (/^\s+(as moot|without prejudice as moot)\b/.test(rest)) continue;
      phrase = cutPhrase(rest);
    } else {
      if (/^\s+(as moot|without prejudice as moot)\b/.test(after)) continue;
      phrase = clauseBefore(l.slice(0, m.index));
      if (/^\s+in part\b/.test(after) || /\b(granted|denied) in part\b/.test(phrase)) partial = true;
    }
    if (!MOTION_WORD.test(phrase)) continue;
    const desc = motionDescription(phrase);
    if (PROCEDURAL.test(desc) || (isBareMotionPhrase(desc) && PROCEDURAL.test(l))) continue;
    return { granted, partial, phrase, mover: moverFromPhrase(phrase, ctx) };
  }
  return null;
}

function sideNote(side: Side | null, who: string): string {
  return side ? `${who}: ${side}` : `${who} not identified`;
}

function fromRuling(r: Ruling, l: string, ctx: Ctx): DocketClassification {
  const p = r.phrase;
  const mover = r.mover;
  const moverNote = sideNote(mover, "moving party");
  if (/summary judgment/.test(p)) {
    if (!r.granted) return event("motion_denied", mover, `Order denying a summary judgment motion (${moverNote})`);
    if (r.partial || /partial summary judgment/.test(p)) {
      return event("motion_granted", mover, `Order granting partial summary judgment (${moverNote})`);
    }
    return event("summary_judgment_won", mover, `Order granting summary judgment (${moverNote})`);
  }
  if (/\bdismiss/.test(p)) {
    if (r.granted && mover === "plaintiff" && !/counter ?claim/.test(p)) {
      if (ctx.caseType === "criminal") return skip("Government motion to dismiss counts (not scored)");
      return event("settlement_favorable", null, "Voluntary dismissal on the plaintiff's motion (often follows a settlement; check)");
    }
    if (!r.granted) return event("motion_denied", mover, `Order denying a motion to dismiss (${moverNote})`);
    if (!r.partial && /\bwith prejudice\b/.test(l) && !/\bwithout prejudice\b/.test(l)) {
      return event("dismissed_favorable", mover, `Dismissed with prejudice on a motion to dismiss (${moverNote})`);
    }
    return event("motion_granted", mover, `Order granting${r.partial ? " in part" : ""} a motion to dismiss (${moverNote})`);
  }
  if (r.granted) return event("motion_granted", mover, `Order granting${r.partial ? " in part" : ""} a motion (${moverNote})`);
  return event("motion_denied", mover, `Order denying a motion (${moverNote})`);
}

// ---------------------------------------------------------------------------
// Specific outcomes
// ---------------------------------------------------------------------------

function sanctions(l: string, ctx: Ctx): DocketClassification | null {
  if (!/\bsanction/.test(l)) return null;
  const r = findRuling(l, ctx);
  if (r && /sanction/.test(r.phrase)) {
    if (!r.granted) return event("motion_denied", r.mover, `Order denying a motion for sanctions (${sideNote(r.mover, "moving party")})`);
    return event("sanctioned", null, "Order granting sanctions (pick the sanctioned lawyer)");
  }
  const imposed = /\b(imposing|hereby impose[sd]?)\b[^.;]{0,60}\bsanctions?\b|\bsanctions?\b[^.;]{0,20}\b(are|is)\s+(hereby\s+)?(imposed|awarded|granted)\b|\bsanctioning\b|\b(is|are) (hereby )?sanctioned\b/;
  if (/\bshow cause\b|\bshould not be (imposed|sanctioned)\b/.test(l) && !imposed.test(l)) return skip("Show-cause order (no sanction imposed yet)");
  if (imposed.test(l) || /\b(impos\w+|award\w*)\b[^.;]{0,60}\bsanctions?\b/.test(l)) {
    return event("sanctioned", null, "Order imposing sanctions (pick the sanctioned lawyer)");
  }
  return null;
}

const SETTLED = /\bcase (has been |is )?settled\b|\b(have|has) settled\b|\bsettlement (was |has been )?reached\b|\breached (a )?settlement\b/;
const SETTLEMENT_EXCLUDE = /settlement (conference|status|report|negotiations?|discussions?|week)|\bmediat|enforce (the )?settlement|early neutral|settlement judge/;
const SETTLEMENT =
  /\bstipulat\w*[^.;]{0,60}\bdismiss|\bnotice of (voluntary )?dismissal\b|\bvoluntar\w* dismiss|\bnotice of settlement\b|\bsettlement agreement\b|\bconsent (judgment|decree)\b|\b(approv\w*|approval of)\b[^.;]{0,60}\bsettlement\b|\bsettlement\b[^.;]{0,40}\bapprov|\bdismiss\w*[^.;]{0,80}\b(settle\w*|stipulation)\b|\b(settle\w*|stipulation)\b[^.;]{0,80}\bdismiss/;

const NOT_SETTLED = /\bno settlement\b|\bnot (been )?settled\b|\bdid not settle\b|\bunable to (reach|settle)\b|\bimpasse\b/;

function settlement(l: string): DocketClassification | null {
  if (NOT_SETTLED.test(l)) return null;
  if (SETTLED.test(l) || (!SETTLEMENT_EXCLUDE.test(l) && SETTLEMENT.test(l))) {
    const what = /consent (judgment|decree)/.test(l)
      ? "Consent judgment"
      : /stipulat/.test(l)
        ? "Stipulated dismissal"
        : /voluntar/.test(l)
          ? "Voluntary dismissal (often follows a settlement; check)"
          : "Settlement";
    return event("settlement_favorable", null, `${what} (pick the side it favors)`);
  }
  return null;
}

/** A minute entry that records a verdict (not just "deliberations continue"). */
const VERDICT_REACHED =
  /\bjury verdict\b|\bverdict (was |is |has been )?(reached|returned|rendered|entered|read|received|announced|recorded)\b|\bverdict:|\bverdict of\b|\bverdict (for|in favor)\b|\bverdicts? (of )?(not )?guilty\b/;

function verdict(l: string, ctx: Ctx): DocketClassification {
  const notGuilty = /\bnot guilty\b|\bacquit/.test(l);
  const guilty = /\bguilty\b/.test(l.replace(/\bnot guilty\b/g, ""));
  if (notGuilty && guilty) return event("filing", null, "Mixed verdict (guilty on some counts, not guilty on others): pick the outcome");
  if (guilty) return event("verdict_win", governmentSide(ctx) ?? "plaintiff", "Guilty verdict (prosecution)");
  if (notGuilty) return event("verdict_win", "defendant", "Not-guilty verdict (defense)");
  const sides = new Set<Side>();
  const favRe = /\b(?:in favor of|for)\s+(?:the\s+)?(.+?)(?=\s+against\b|\s+on\b|[;.(]|$)/g;
  for (let m: RegExpExecArray | null; (m = favRe.exec(l)); ) {
    const s = sideIn(m[1].slice(0, 120), ctx);
    if (s) sides.add(s);
  }
  const ag = /\bagainst\s+(?:the\s+)?(.+?)(?=[;.(]|\s+on\b|$)/.exec(l);
  if (ag) {
    const s = sideIn(ag[1].slice(0, 120), ctx);
    if (s) sides.add(other(s));
  }
  if (sides.size === 1) {
    const side = [...sides][0];
    return event("verdict_win", side, `Verdict for the ${side}`);
  }
  if (sides.size > 1) return event("filing", null, "Mixed verdict: pick the outcome");
  return event("filing", null, "Verdict entered, but the docket text doesn't say who won: check and pick the outcome");
}

function plea(l: string): DocketClassification | null {
  if (/\bwithdraw\w*\s+(his |her |their |the |a |its )?(guilty )?plea\b/.test(l)) return null;
  const scheduled =
    /change of plea hearing (is )?(set|reset|scheduled|continued|rescheduled|adjourned)\b|\b(set|reset|setting|resetting|scheduling|continuing|rescheduling)\b[^.;]{0,60}\b(change of plea|plea hearing)/.test(
      l,
    ) && !/\bheld\b/.test(l);
  if (scheduled) return skip("Plea hearing scheduled");
  const withoutNot = l.replace(/\bnot guilty\b/g, "");
  if (
    /\bplea agreement\b/.test(l) ||
    /\bchange of plea\b[^.]*\bheld\b/.test(l) ||
    /\bguilty plea\b|\bplea of guilty\b|\bpleads? guilty\b|\bpleaded guilty\b|\bpled guilty\b/.test(withoutNot) ||
    (/\bplea\b/.test(l) && /\bguilty\b/.test(withoutNot))
  ) {
    return event("guilty_plea", "plaintiff", "Guilty plea / plea agreement (prosecution)");
  }
  if (/\bnot guilty\b/.test(l) && /\bplea\b/.test(l)) return skip("Not-guilty plea at arraignment");
  return null;
}

function dismissalOrder(l: string): DocketClassification | null {
  if (/\bdismiss(ed|ing|al)\b/.test(l) && /\bwith prejudice\b/.test(l) && !/\bwithout prejudice\b/.test(l)) {
    const side: Side = /counter ?claim/.test(l) ? "plaintiff" : "defendant";
    return event("dismissed_favorable", side, side === "plaintiff" ? "Counterclaims dismissed with prejudice" : "Dismissed with prejudice");
  }
  return null;
}

function judgment(l: string, ctx: Ctx): DocketClassification {
  if (ctx.caseType === "criminal" || /judgment (in a criminal case|as to)|imprisonment|probation|sentenc|supervised release/.test(l)) {
    return skip("Criminal judgment / sentence (score the plea or verdict instead)");
  }
  const settled = settlement(l);
  if (settled) return settled;
  const sides = new Set<Side>();
  const fav = /\bin favor of\s+(?:the\s+)?(.+?)(?=\s+against\b|[;.(]|$)/.exec(l);
  if (fav) {
    const s = sideIn(fav[1].slice(0, 120), ctx);
    if (s) sides.add(s);
  }
  const ag = /\bagainst\s+(?:the\s+)?(.+?)(?=[;.(]|$)/.exec(l);
  if (ag) {
    const s = sideIn(ag[1].slice(0, 120), ctx);
    if (s) sides.add(other(s));
  }
  const side = sides.size === 1 ? [...sides][0] : null;
  const type: EventType | null = /summary judgment/.test(l)
    ? "summary_judgment_won"
    : /\bjury\b|\bverdict\b/.test(l)
      ? "verdict_win"
      : /\bdismiss/.test(l)
        ? "dismissed_favorable"
        : null;
  if (side && type) return event(type, side, `Judgment for the ${side}`);
  return event(
    "filing",
    null,
    side ? `Judgment entered for the ${side}: pick the outcome type` : "Judgment entered: check the outcome and pick the type and side",
  );
}

function filing(l: string, kind: Kind, ctx: Ctx, attorney: string | null): DocketClassification {
  const { fragment, rest } = filerFragment(l);
  if (PROCEDURAL.test(rest)) return skip("Procedural filing (scheduling, extensions, sealing, counsel…)");
  let side = fragment ? sideIn(fragment, ctx) : null;
  let via = "filer";
  if (!side && attorney) {
    side = attorneySide(attorney, ctx);
    via = "filing attorney";
  }
  if (!side && kind === "pleading") {
    if (/^(superseding )?(indictment|information)\b/.test(leading(l).replace(MODIFIERS, ""))) side = governmentSide(ctx) ?? "plaintiff";
    else if (/^(complaint|third[ -]party complaint)\b/.test(leading(l).replace(MODIFIERS, ""))) side = "plaintiff";
    via = "pleading type";
  }
  const label: Record<string, string> = { motion: "motion", brief: "brief", appeal: "notice of appeal", pleading: "pleading" };
  return event("filing", side, `Substantive filing (${label[kind] ?? "filing"}; ${side ? `${via}: ${side}` : "filer not identified"})`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Clean docket text for classification: no HTML, attachment lists, "(Entered: …)" stamps or trailing "(Last, First)". */
function prepare(description: string): { l: string; attorney: string | null } {
  const raw = cleanText(description);
  const attorney = trailingAttorney(raw);
  let t = removeParenGroups(raw, isClericalParen);
  if (attorney) t = t.replace(/\([A-Z][^()]{0,60}, [A-Z][^()]{0,40}\)\s*$/, "").trim();
  return { l: t.toLowerCase(), attorney };
}

export function classifyDocketEntry(description: string, opts: ClassifyOptions = {}): DocketClassification {
  const ctx = toCtx(opts);
  const { l, attorney } = prepare(description);
  if (!l) return skip("No docket text");
  const kind = docKind(l);
  if (kind === "proposed") return skip("Proposed order or filing");
  const start = leading(l);
  for (const [re, why] of NOISE) if (re.test(start)) return skip(why);

  switch (kind) {
    case "rr":
      return skip("Magistrate judge's recommendation (not a final ruling)");
    case "verdict":
      return verdict(l, ctx);
    case "plea":
      return plea(l) ?? skip("Plea paperwork");
    case "stipulation":
      return settlement(l) ?? skip("Stipulation (procedural)");
    case "judgment":
      return judgment(l, ctx);
    case "motion": {
      const s = /\benforce\b/.test(l) ? null : settlement(l);
      return s ?? filing(l, kind, ctx, attorney);
    }
    case "brief":
    case "appeal":
    case "pleading":
      return filing(l, kind, ctx, attorney);
    case "minute": {
      const out =
        sanctions(l, ctx) ??
        (VERDICT_REACHED.test(l) ? verdict(l, ctx) : null) ??
        plea(l) ??
        settlement(l) ??
        (() => {
          const r = findRuling(l, ctx);
          return r ? fromRuling(r, l, ctx) : null;
        })();
      return out ?? skip("Minute entry (no ruling)");
    }
    case "order": {
      const out =
        sanctions(l, ctx) ??
        settlement(l) ??
        (() => {
          const r = findRuling(l, ctx);
          return r ? fromRuling(r, l, ctx) : null;
        })() ??
        dismissalOrder(l) ??
        plea(l);
      return out ?? skip("Order without a ruling on a substantive motion");
    }
    default:
      return skip("Not a ruling or substantive filing");
  }
}
