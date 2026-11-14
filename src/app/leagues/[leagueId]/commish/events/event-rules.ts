/**
 * Pure rules for the scoring-event forms (add / edit / review). Client-safe.
 */
import { plural } from "@/lib/format";
import { EVENT_LABELS, EVENT_TYPES, LAWYER_SPECIFIC_EVENTS, SIDES, type EventType, type Side } from "@/lib/settings";
import type { ApproveReport, CreditIndex, EventChoice, EventInput, EventMissing, EventOrigin, PendingGroup } from "@/server/services/events";

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

/** Event types the review queue lets the commissioner switch a suggestion to ("custom" needs points: use Edit). */
export const INLINE_TYPE_GROUPS = EVENT_GROUPS.filter((g) => !g.types.includes("custom"));

export function isEventType(type: string): type is EventType {
  return (EVENT_TYPES as readonly string[]).includes(type);
}

/** "courtlistener" covers both court sources (CourtListener dockets and the Supreme Court feed). */
export const ORIGIN_LABELS = { manual: "Manual", courtlistener: "From court records", ai: "AI suggestion" } as const;

/** What an incomplete event still needs, as an instruction. */
export const MISSING_LABELS: Record<EventMissing, string> = {
  type: "Pick an event type",
  case: "Pick the case",
  side: "Pick which side of the case this is for",
  lawyer: "Pick the lawyer this is about",
  points: "Enter the points for this custom event",
};

/** Short form for badges: "Side not picked". */
export const MISSING_SHORT: Record<EventMissing, string> = {
  type: "Type not picked",
  case: "Case not picked",
  side: "Side not picked",
  lawyer: "Lawyer not picked",
  points: "Points not set",
};
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

export type ReviewOp =
  | { op: "approve"; ids: string[] }
  | { op: "reject"; id: string }
  | { op: "save"; id: string }
  | { op: "reject-case"; caseId: string; origin: QueueOrigin | null; before: string | null };

const BAD_REQUEST = "Something was off with that request. Refresh and try again.";

/**
 * The review queue is one form: checkboxes "ids" plus buttons named "op" with
 * values "approve-selected", "approve:<id>", "reject:<id>", "save:<id>" (save
 * the card's picks without approving) or "reject-case:<caseId>" (with hidden
 * "queueOrigin" = the origin filter and "queueLoadedAt" = when the page loaded).
 */
export function parseReviewOp(form: FormLike): ParseResult<ReviewOp> {
  const op = text(form, "op");
  if (op === "approve-selected") {
    const ids = [...new Set(form.getAll("ids").map((v) => (typeof v === "string" ? id(v.trim()) : null)))].filter((v): v is string => !!v);
    if (ids.length === 0) return { ok: false, error: "Tick the events you want to approve first." };
    if (ids.length > 200) return { ok: false, error: "Approve at most 200 events at a time." };
    return { ok: true, data: { op: "approve", ids } };
  }
  const m = /^(approve|reject|save|reject-case):(.+)$/.exec(op);
  const target = m ? id(m[2]) : null;
  if (!m || !target) return { ok: false, error: BAD_REQUEST };
  switch (m[1]) {
    case "approve":
      return { ok: true, data: { op: "approve", ids: [target] } };
    case "reject":
      return { ok: true, data: { op: "reject", id: target } };
    case "save":
      return { ok: true, data: { op: "save", id: target } };
    default: {
      const loaded = text(form, "queueLoadedAt");
      const t = loaded ? Date.parse(loaded) : NaN;
      return {
        ok: true,
        data: {
          op: "reject-case",
          caseId: target,
          origin: parseQueueOrigin(text(form, "queueOrigin")),
          before: Number.isNaN(t) ? null : new Date(t).toISOString(),
        },
      };
    }
  }
}

/** Form field names for a queue card's inline picks. */
export const choiceField = {
  type: (eventId: string) => `type:${eventId}`,
  side: (eventId: string) => `side:${eventId}`,
  lawyer: (eventId: string) => `lawyer:${eventId}`,
};

/**
 * The inline picks (type / side / lawyer) submitted for these events. Blank
 * or invalid values count as "not picked". Events without any pick are left
 * out. The service checks the picks against the event and the pool.
 */
export function parseReviewChoices(form: FormLike, ids: string[]): Map<string, EventChoice> {
  const out = new Map<string, EventChoice>();
  for (const eventId of ids) {
    const choice: EventChoice = {};
    const type = text(form, choiceField.type(eventId));
    if (isEventType(type)) choice.type = type;
    const side = text(form, choiceField.side(eventId));
    if ((SIDES as readonly string[]).includes(side)) choice.side = side as Side;
    const lawyerId = id(text(form, choiceField.lawyer(eventId)));
    if (lawyerId) choice.lawyerId = lawyerId;
    if (Object.keys(choice).length > 0) out.set(eventId, choice);
  }
  return out;
}

/** The message after "Approve" / "Approve selected": what was approved, skipped, or already reviewed. */
export function approveResultMessage(report: ApproveReport): { ok: true; message: string } | { ok: false; error: string } {
  const approved = report.approved.length;
  const skipped = report.skipped.length;
  const gone = report.notPending.length;
  const requested = approved + skipped + gone;
  if (approved === 0) {
    if (requested === 1 && skipped === 1) {
      const s = report.skipped[0];
      return { ok: false, error: s.error ?? `${MISSING_LABELS[s.missing ?? "side"]}, then approve.` };
    }
    if (skipped > 0) {
      return {
        ok: false,
        error: `Nothing approved: ${plural(skipped, "event")} still ${skipped === 1 ? "needs" : "need"} a side, lawyer or type. Pick it on each card, then approve.`,
      };
    }
    return {
      ok: false,
      error: requested === 1 ? "That event was already reviewed. Refresh to see the latest." : "Those events were already reviewed. Refresh to see the latest.",
    };
  }
  const parts = [`Approved ${plural(approved, "event")}.`];
  if (skipped > 0) parts.push(`Skipped ${plural(skipped, "event")} that still ${skipped === 1 ? "needs" : "need"} a side, lawyer or type.`);
  if (gone > 0) parts.push(gone === 1 ? "1 other was already reviewed." : `${gone} others were already reviewed.`);
  return { ok: true, message: parts.join(" ") };
}

// ---------------------------------------------------------------------------
// Review queue filters
// ---------------------------------------------------------------------------

/** Origin filter values (null = all origins). */
export type QueueOrigin = Extract<EventOrigin, "courtlistener" | "manual">;
export type QueueFilter = { origin: QueueOrigin | null; caseId: string | null };

export function parseQueueOrigin(v: string | undefined | null): QueueOrigin | null {
  return v === "courtlistener" || v === "manual" ? v : null;
}

type SearchParamValue = string | string[] | undefined;

/** ?origin=courtlistener|manual&case=<uuid>; anything else means "all". */
export function parseQueueFilter(sp: Record<string, SearchParamValue>): QueueFilter {
  const one = (v: SearchParamValue) => (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
  return { origin: parseQueueOrigin(one(sp.origin)), caseId: id(one(sp.case)) };
}

/** Review queue URL for a filter. */
export function queueHref(base: string, f: QueueFilter): string {
  const u = new URLSearchParams();
  if (f.origin) u.set("origin", f.origin);
  if (f.caseId) u.set("case", f.caseId);
  const q = u.toString();
  return q ? `${base}?${q}` : base;
}

export type QueueCaseCount = { caseId: string; caption: string; docket: string | null; count: number };

export type QueueCounts = {
  /** Every pending event in the pool (the Review tab count). */
  allPending: number;
  /** Origin chip counts within the selected case (if any). */
  origins: { all: number; courtlistener: number; manual: number };
  /** Cases with pending events matching the origin filter, busiest first (the selected case is always listed). */
  cases: QueueCaseCount[];
  /** Events matching the origin filter across all cases (the "All cases" option). */
  originTotal: number;
  /** Events matching both filters, and how many of those are incomplete. */
  matching: number;
  incomplete: number;
};

/** Counts for the queue's filter chips and case select. */
export function queueCounts(groups: PendingGroup[], f: QueueFilter): QueueCounts {
  const inCase = (g: PendingGroup) => !f.caseId || g.caseId === f.caseId;
  const inOrigin = (g: PendingGroup) => !f.origin || g.origin === f.origin;
  const sum = (gs: PendingGroup[], pick: (g: PendingGroup) => number = (g) => g.count) => gs.reduce((n, g) => n + pick(g), 0);

  const caseGroups = groups.filter(inCase);
  const matching = caseGroups.filter(inOrigin);
  const byCase = new Map<string, QueueCaseCount>();
  for (const g of groups) {
    if (!g.caseId || (!inOrigin(g) && g.caseId !== f.caseId)) continue;
    let c = byCase.get(g.caseId);
    if (!c) {
      c = { caseId: g.caseId, caption: g.caseCaption ?? "Unknown case", docket: g.caseDocket, count: 0 };
      byCase.set(g.caseId, c);
    }
    if (inOrigin(g)) c.count += g.count;
  }
  const cases = [...byCase.values()].sort((a, b) => b.count - a.count || a.caption.localeCompare(b.caption));
  return {
    allPending: sum(groups),
    origins: {
      all: sum(caseGroups),
      courtlistener: sum(caseGroups.filter((g) => g.origin === "courtlistener")),
      manual: sum(caseGroups.filter((g) => g.origin === "manual")),
    },
    cases,
    originTotal: sum(groups.filter(inOrigin)),
    matching: sum(matching),
    incomplete: sum(matching, (g) => g.incomplete),
  };
}

/** Who appears on a case (both sides), for the "who is this about?" picker. */
export type AppearanceOption = { lawyerId: string; name: string; kind: "lawyer" | "firm"; side: Side };

export function appearanceOptions(index: CreditIndex, caseId: string | null): AppearanceOption[] {
  if (!caseId) return [];
  const out: AppearanceOption[] = [];
  for (const side of SIDES) {
    for (const lawyerId of index.bySide.get(`${caseId}|${side}`) ?? []) {
      const l = index.lawyers.get(lawyerId);
      if (l) out.push({ lawyerId, name: l.name, kind: l.kind, side });
    }
  }
  return out.sort((a, b) => (a.side === b.side ? a.name.localeCompare(b.name) : a.side === "plaintiff" ? -1 : 1));
}

/** "Trial verdict won" etc., tolerant of unknown types from future phases. */
export function eventLabel(type: string): string {
  return (EVENT_LABELS as Record<string, string>)[type] ?? type;
}

/** Where an event falls for this league: "finalized" weeks need reopening; outside the season it scores nothing. */
export function weekNote(week: number, totalWeeks: number, finalized: Set<number>): { tone: "warn" | "info"; text: string } | null {
  if (week < 1) return { tone: "info", text: "Before this league's season starts, so it won't score here." };
  if (week > totalWeeks) return { tone: "info", text: "After this league's season ends, so it won't score here." };
  if (finalized.has(week)) return { tone: "warn", text: `Week ${week} is already finalized here, so this won't count unless week ${week} is reopened.` };
  return null;
}
