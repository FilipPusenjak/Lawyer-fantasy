/**
 * Pure rules for the scoring-event forms (add / edit / review). Client-safe.
 */
import { EVENT_LABELS, EVENT_TYPES, LAWYER_SPECIFIC_EVENTS, SIDES, type EventType, type Side } from "@/lib/settings";
import type { EventInput } from "@/server/services/events";

export type FormLike = { get(name: string): FormDataEntryValue | null; getAll(name: string): FormDataEntryValue[] };
export type ParseResult<T> = { ok: true; data: T } | { ok: false; error: string };

export const SUMMARY_MAX = 300;
export const SUMMARY_HINT = "State the facts only, e.g. “Court granted defendant's motion to dismiss.”";

/** Event types grouped for the type select. */
export const EVENT_GROUPS: { label: string; types: EventType[] }[] = [
  {
    label: "Case outcomes",
    types: [
      "verdict_win",
      "verdict_loss",
      "dismissed_favorable",
      "summary_judgment_won",
      "settlement_favorable",
      "appeal_won",
      "win_reversed",
      "guilty_plea",
      "plea_reduced",
    ],
  },
  { label: "Motions", types: ["motion_granted", "motion_denied"] },
  { label: "Filings", types: ["filing"] },
  { label: "About one lawyer", types: ["sanctioned", "scotus_argument"] },
  { label: "Custom", types: ["custom"] },
];

export type TargetKind = "side" | "lawyer" | "either";

/** What an event type is attached to: a side of a case, one lawyer, or (custom) either. */
export function targetKind(type: string): TargetKind {
  if (LAWYER_SPECIFIC_EVENTS.has(type as EventType)) return "lawyer";
  if (type === "custom") return "either";
  return "side";
}

export const ORIGIN_LABELS = { manual: "Manual", courtlistener: "CourtListener", ai: "AI suggestion" } as const;
export const STATUS_LABELS = { pending: "Pending", approved: "Approved", rejected: "Rejected" } as const;

function text(form: FormLike, name: string): string {
  const v = form.get(name);
  return typeof v === "string" ? v.trim() : "";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (s: string) => (UUID_RE.test(s) ? s : null);

export type EventFormData = { input: EventInput; approveNow: boolean; alsoRecordLoss: boolean };

/**
 * Parse the add/edit event form. Field names: type, target ("side" | "lawyer",
 * custom only), caseId, side, lawyerId, occurredOn, summary, sourceUrl,
 * customPoints, approveNow, alsoRecordLoss. Pool membership is checked by the
 * service; this only checks shape.
 */
export function parseEventForm(form: FormLike, opts: { requireSource: boolean }): ParseResult<EventFormData> {
  const type = text(form, "type");
  if (!(EVENT_TYPES as readonly string[]).includes(type)) return { ok: false, error: "Pick an event type." };
  const kind = targetKind(type);
  const target: "side" | "lawyer" = kind === "either" ? (text(form, "target") === "lawyer" ? "lawyer" : "side") : kind;

  const caseRaw = text(form, "caseId");
  const caseId = caseRaw ? id(caseRaw) : null;
  if (caseRaw && !caseId) return { ok: false, error: "Pick the case again." };
  let lawyerId: string | null = null;
  let side: Side | null = null;
  if (target === "lawyer") {
    lawyerId = id(text(form, "lawyerId"));
    if (!lawyerId) return { ok: false, error: "Pick the lawyer this event is about." };
  } else {
    if (!caseId) return { ok: false, error: "Pick the case." };
    const sideRaw = text(form, "side");
    if (!(SIDES as readonly string[]).includes(sideRaw)) return { ok: false, error: "Pick which side of the case this is for." };
    side = sideRaw as Side;
  }

  const occurredOn = text(form, "occurredOn");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(occurredOn)) return { ok: false, error: "Pick the date the event happened." };

  const summary = text(form, "summary").replace(/\s+/g, " ");
  if (!summary) return { ok: false, error: "Add a short, factual summary." };
  if (summary.length > SUMMARY_MAX) return { ok: false, error: `Keep the summary under ${SUMMARY_MAX} characters.` };

  const sourceUrl = text(form, "sourceUrl") || null;
  if (sourceUrl && !/^https?:\/\/\S+$/i.test(sourceUrl)) return { ok: false, error: "The source link must start with http:// or https://." };
  if (!sourceUrl && opts.requireSource) return { ok: false, error: "Add a link to the public record (court site, docket, news story)." };

  let customPoints: number | null = null;
  if (type === "custom") {
    const raw = text(form, "customPoints");
    const n = Number(raw);
    if (raw === "" || !Number.isFinite(n)) return { ok: false, error: "Enter the points for this custom event." };
    if (Math.abs(n) > 100) return { ok: false, error: "Custom points must be between -100 and 100." };
    customPoints = Math.round(n * 100) / 100;
  }

  return {
    ok: true,
    data: {
      input: { type: type as EventType, caseId, side, lawyerId, occurredOn, summary, sourceUrl, customPoints },
      approveNow: form.get("approveNow") !== null,
      alsoRecordLoss: type === "verdict_win" && target === "side" && form.get("alsoRecordLoss") !== null,
    },
  };
}

export type ReviewOp = { op: "approve"; ids: string[] } | { op: "reject"; id: string };

/**
 * The review queue is one form: checkboxes "ids" plus buttons named "op" with
 * values "approve-selected", "approve:<id>" or "reject:<id>".
 */
export function parseReviewOp(form: FormLike): ParseResult<ReviewOp> {
  const op = text(form, "op");
  if (op === "approve-selected") {
    const ids = [...new Set(form.getAll("ids").map((v) => (typeof v === "string" ? id(v.trim()) : null)))].filter((v): v is string => !!v);
    if (ids.length === 0) return { ok: false, error: "Tick the events you want to approve first." };
    if (ids.length > 200) return { ok: false, error: "Approve at most 200 events at a time." };
    return { ok: true, data: { op: "approve", ids } };
  }
  const m = /^(approve|reject):(.+)$/.exec(op);
  const target = m ? id(m[2]) : null;
  if (!m || !target) return { ok: false, error: "Something was off with that request. Refresh and try again." };
  return m[1] === "approve" ? { ok: true, data: { op: "approve", ids: [target] } } : { ok: true, data: { op: "reject", id: target } };
}

/** "Trial verdict won" etc., tolerant of unknown types from future phases. */
export function eventLabel(type: string): string {
  return (EVENT_LABELS as Record<string, string>)[type] ?? type;
}

export type CreditSummary = { names: string[]; more: number };

/** Up to `max` credit labels like "Avery Example +10", then "+N more". */
export function summarizeCredits(credits: { name: string; points: number }[], max = 6, fmt: (n: number) => string = String): CreditSummary {
  const names = credits.slice(0, max).map((c) => `${c.name} ${c.points > 0 ? "+" : ""}${fmt(c.points)}`);
  return { names, more: Math.max(0, credits.length - max) };
}

/** Where an event falls for this league: "finalized" weeks need reopening; outside the season it scores nothing. */
export function weekNote(week: number, totalWeeks: number, finalized: Set<number>): { tone: "warn" | "info"; text: string } | null {
  if (week < 1) return { tone: "info", text: "Before this league's season starts, so it won't score here." };
  if (week > totalWeeks) return { tone: "info", text: "After this league's season ends, so it won't score here." };
  if (finalized.has(week)) return { tone: "warn", text: `Week ${week} is already finalized here, so this won't count unless week ${week} is reopened.` };
  return null;
}
