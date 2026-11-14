/**
 * Pure planning for court sync: which new docket entries / proceedings become
 * pending scoring events, and where the sync cursor moves. The DB service
 * (src/server/services/court-sync.ts) fetches, calls these, and inserts.
 */
import { otherSide, type CaseType, type EventType, type Side } from "@/lib/settings";
import { classifyDocketEntry } from "./classify";
import { classifyScotusProceeding, scotusDocketPageUrl, type ScotusProceeding } from "./scotus";
import { matchLawyerByName, partiesFromCaption, personNameKey, summarize, type NamedLawyer, type PartyNames } from "./text";

/** On a case's first sync, only activity from the last N days becomes suggestions. */
export const FIRST_SYNC_DAYS = 14;
/** Later syncs ignore entries dated more than N days ago (e.g. old documents newly added to CourtListener). */
export const STALE_DAYS = 30;
/** At most this many suggestions per case per run; the rest wait for the next run. */
export const MAX_SUGGESTIONS_PER_CASE = 15;

export type PlannedEvent = {
  externalRef: string;
  type: EventType;
  /** Null for lawyer-specific events and when the side couldn't be inferred. */
  side: Side | null;
  lawyerId: string | null;
  occurredOn: string;
  summary: string;
  sourceUrl: string | null;
  /** Why this was suggested (not stored; for logs/tests). */
  reason: string;
};

export type Plan = {
  events: PlannedEvent[];
  /** Entries/proceedings consumed (cursor moved past them). */
  newEntries: number;
  /** New cursor (null = unchanged / nothing consumed yet). */
  nextCursor: string | null;
  /** True when the per-case cap stopped the run early. */
  capped: boolean;
};

/** YYYY-MM-DD of `now` minus `days` (UTC). */
export function daysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

/** Oldest date that can still become a suggestion. */
export function suggestionCutoff(now: Date, firstSync: boolean): string {
  return daysAgo(now, firstSync ? FIRST_SYNC_DAYS : STALE_DAYS);
}

const SOURCE_URL_MAX = 500;
const safeUrl = (u: string | null | undefined): string | null => (u && /^https?:\/\//.test(u) && u.length <= SOURCE_URL_MAX ? u : null);

// ---------------------------------------------------------------------------
// Supreme Court
// ---------------------------------------------------------------------------

export type ScotusPlanInput = {
  docket: string;
  proceedings: ScotusProceeding[];
  /** Number of proceedings already seen (cases.syncCursor), null on the first sync. */
  cursor: string | null;
  now: Date;
  petitionerTitle?: string;
  respondentTitle?: string;
  /** Individual lawyers on this case (matched first, loosely). */
  caseLawyers: NamedLawyer[];
  /** Other individual lawyers in the pool (exact, unique name match only). */
  poolLawyers: NamedLawyer[];
  maxSuggestions?: number;
};

/**
 * SCOTUS cursor = count of proceedings already processed. New proceedings
 * (index ≥ cursor) become suggestions; argument entries become one
 * scotus_argument per arguing lawyer who matches a pool lawyer by name
 * (lawyers on the case first, then a unique match in the rest of the pool).
 * Arguers who aren't in the pool are skipped.
 */
export function planScotus(input: ScotusPlanInput): Plan {
  const max = input.maxSuggestions ?? MAX_SUGGESTIONS_PER_CASE;
  const parsed = input.cursor === null ? NaN : Number.parseInt(input.cursor, 10);
  const firstSync = !Number.isFinite(parsed);
  const total = input.proceedings.length;
  const start = firstSync ? 0 : Math.min(Math.max(parsed, 0), total);
  const cutoff = suggestionCutoff(input.now, firstSync);
  const events: PlannedEvent[] = [];
  let i = start;
  let capped = false;
  for (; i < total; i++) {
    const p = input.proceedings[i];
    if (!p.date || p.date < cutoff) continue;
    const c = classifyScotusProceeding(p.text, { petitionerTitle: input.petitionerTitle, respondentTitle: input.respondentTitle });
    if (c.skip) continue;
    const base = `scotus:${input.docket}:${p.index}`;
    const summary = summarize(p.text);
    const sourceUrl = safeUrl(p.links[0]?.url) ?? scotusDocketPageUrl(input.docket);
    const batch: PlannedEvent[] = [];
    const seenLawyers = new Set<string>();
    for (const s of c.suggestions) {
      if (s.kind === "side") {
        batch.push({ externalRef: base, type: s.type, side: s.side, lawyerId: null, occurredOn: p.date, summary, sourceUrl, reason: s.reason });
      } else {
        const lawyer = matchLawyerByName(s.lawyerName, input.caseLawyers, input.poolLawyers);
        if (!lawyer || seenLawyers.has(lawyer.id)) continue;
        seenLawyers.add(lawyer.id);
        batch.push({
          externalRef: `${base}:arg:${personNameKey(s.lawyerName).replace(/ /g, "-")}`,
          type: "scotus_argument",
          side: null,
          lawyerId: lawyer.id,
          occurredOn: p.date,
          summary,
          sourceUrl,
          reason: `${s.reason}: ${lawyer.name}`,
        });
      }
    }
    if (batch.length && events.length + batch.length > max) {
      capped = true;
      break;
    }
    events.push(...batch);
  }
  return { events, newEntries: i - start, nextCursor: String(i), capped };
}

// ---------------------------------------------------------------------------
// CourtListener
// ---------------------------------------------------------------------------

export type PlanEntry = {
  entryId: number;
  dateFiled: string | null;
  description: string;
  dateModified: string;
  url: string;
};

export type ClPlanInput = {
  /** Entries modified after the cursor, oldest first. */
  entries: PlanEntry[];
  /** date_modified high-water mark (cases.syncCursor), null on the first sync. */
  cursor: string | null;
  now: Date;
  caseType: CaseType;
  caption: string;
  /** Lawyer names per side on this case (for "(Last, First)" filing attorney hints). */
  attorneys?: Partial<PartyNames>;
  maxSuggestions?: number;
};

/**
 * Classify entries in date_modified order. A verdict with an explicit winner
 * also gets a pending "verdict_loss" for the other side (like the manual
 * "also record a loss" option). Stops before the entry that would exceed the
 * cap, so the remainder is picked up next run.
 */
export function planCourtListener(input: ClPlanInput): Plan {
  const max = input.maxSuggestions ?? MAX_SUGGESTIONS_PER_CASE;
  const cutoff = suggestionCutoff(input.now, input.cursor === null);
  const opts = { caseType: input.caseType, parties: partiesFromCaption(input.caption), attorneys: input.attorneys };
  const events: PlannedEvent[] = [];
  let nextCursor = input.cursor;
  let consumed = 0;
  let capped = false;
  for (const e of input.entries) {
    const occurredOn = e.dateFiled ?? e.dateModified.slice(0, 10);
    const batch: PlannedEvent[] = [];
    if (/^\d{4}-\d{2}-\d{2}$/.test(occurredOn) && occurredOn >= cutoff) {
      const c = classifyDocketEntry(e.description, opts);
      if (!c.skip) {
        const ref = `cl-entry:${e.entryId}`;
        const summary = summarize(e.description) || "Docket entry";
        const sourceUrl = safeUrl(e.url);
        batch.push({ externalRef: ref, type: c.type, side: c.side, lawyerId: null, occurredOn, summary, sourceUrl, reason: c.reason });
        if (c.type === "verdict_win" && c.side) {
          batch.push({
            externalRef: `${ref}:loss`,
            type: "verdict_loss",
            side: otherSide(c.side),
            lawyerId: null,
            occurredOn,
            summary,
            sourceUrl,
            reason: "Other side of the verdict",
          });
        }
      }
    }
    if (batch.length && events.length + batch.length > max) {
      capped = true;
      break;
    }
    events.push(...batch);
    consumed++;
    nextCursor = e.dateModified;
  }
  return { events, newEntries: consumed, nextCursor, capped };
}
