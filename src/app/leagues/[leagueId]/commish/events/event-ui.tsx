/**
 * Server-rendered pieces shared by the scoring-event pages.
 */
import Link from "next/link";
import { Badge, Notice, Points, Tabs } from "@/components/ui";
import { fmtSigned } from "@/lib/format";
import { sideLabel } from "@/lib/settings";
import { formatDate } from "@/lib/time";
import { eventMissing, type EventCredit, type EventRow } from "@/server/services/events";
import { eventLabel, MISSING_LABELS, MISSING_SHORT, ORIGIN_LABELS, STATUS_LABELS, weekNote } from "./event-rules";

export type EventsTab = "queue" | "new" | "history";

export function EventsTabs({ leagueId, active, pending }: { leagueId: string; active: EventsTab | null; pending: number }) {
  const base = `/leagues/${leagueId}/commish/events`;
  return (
    <Tabs
      items={[
        { href: base, label: pending > 0 ? `Review (${pending})` : "Review", active: active === "queue" },
        { href: `${base}/new`, label: "Add event", active: active === "new" },
        { href: `${base}/history`, label: "History", active: active === "history" },
      ]}
    />
  );
}

export function statusTone(status: EventRow["status"]): "warn" | "pos" | "neg" {
  return status === "approved" ? "pos" : status === "rejected" ? "neg" : "warn";
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "source";
  }
}

/**
 * Neutral facts about an event plus who it credits under this league's
 * scoring. Suggestions from court records show the docket text as a quote
 * with a link to the record; incomplete events (no side / lawyer yet) say so
 * instead of listing credits.
 */
export function EventFacts({
  e,
  credits,
  week,
  totalWeeks,
  finalized,
  leagueId,
  showStatus,
  compactMissing,
}: {
  e: EventRow;
  credits: EventCredit[];
  week: number;
  totalWeeks: number;
  finalized: Set<number>;
  leagueId: string;
  showStatus?: boolean;
  /** Only badge what's missing (the review queue card shows its own picker and hint). */
  compactMissing?: boolean;
}) {
  const note = weekNote(week, totalWeeks, finalized);
  const caseHref = e.caseId ? `/leagues/${leagueId}/commish/pool/cases/${e.caseId}` : null;
  const shown = credits.slice(0, 6);
  const fromCourt = e.origin === "courtlistener";
  const missing = e.status === "pending" ? eventMissing(e) : null;
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
        <span>{formatDate(e.occurredOn)}</span>
        {week >= 1 && week <= totalWeeks ? <span>· Week {week}</span> : null}
        <Badge tone={e.origin === "manual" ? "neutral" : "accent"}>{ORIGIN_LABELS[e.origin]}</Badge>
        {showStatus ? <Badge tone={statusTone(e.status)}>{STATUS_LABELS[e.status]}</Badge> : null}
        {missing ? <Badge tone="warn">{MISSING_SHORT[missing]}</Badge> : null}
      </div>
      <p className="font-semibold">
        {eventLabel(e.type)}
        {e.type === "custom" ? <span className="text-muted"> ({fmtSigned(e.customPoints ?? 0)} pts)</span> : null}
      </p>
      <p className="break-words text-sm">
        {e.lawyerId ? <span className="font-semibold">{e.lawyerName ?? "Unknown lawyer"}</span> : null}
        {e.lawyerId && e.caseCaption ? <span className="text-muted"> · </span> : null}
        {e.caseCaption && caseHref ? (
          <Link href={caseHref} className="underline decoration-line underline-offset-2">
            {e.caseCaption}
          </Link>
        ) : null}
        {!e.lawyerId && e.side && e.caseType ? <span className="font-semibold"> · {sideLabel(e.caseType, e.side)}</span> : null}
      </p>
      {e.caseCourt ? <p className="text-xs text-muted">{[e.caseCourt, e.caseDocket].filter(Boolean).join(" · ")}</p> : null}
      {/* Summaries may hold a pasted link or long docket text; let it wrap instead of widening the page. */}
      {fromCourt ? (
        <blockquote className="break-words border-l-2 border-accent pl-3 text-sm text-muted">{e.summary}</blockquote>
      ) : (
        <p className="break-words text-sm text-muted">{e.summary}</p>
      )}
      {e.sourceUrl ? (
        <a
          href={e.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 items-center text-sm font-semibold text-accent underline"
        >
          {fromCourt ? "View record" : hostOf(e.sourceUrl)} ↗
        </a>
      ) : (
        <p className="text-xs text-muted">No source link</p>
      )}
      {missing ? (
        compactMissing ? null : (
          <p className="text-xs text-warn">{MISSING_LABELS[missing]} before approving. It scores nothing until then.</p>
        )
      ) : credits.length === 0 ? (
        <p className="text-xs text-warn">
          Nobody is listed on this side of the case yet, so it scores 0 for now.
          {caseHref ? (
            <>
              {" "}
              <Link href={caseHref} className="underline">
                Add lawyers
              </Link>
            </>
          ) : null}
        </p>
      ) : (
        <div className="flex flex-wrap gap-1">
          {shown.map((c) => (
            <span key={c.lawyerId} className="rounded-md bg-surface-2 px-1.5 py-0.5 text-xs">
              {c.name} <Points value={c.points} signed className="font-semibold" />
            </span>
          ))}
          {credits.length > shown.length ? <span className="px-1 py-0.5 text-xs text-muted">+{credits.length - shown.length} more</span> : null}
          {e.type === "filing" ? <span className="px-1 py-0.5 text-xs text-muted">(weekly filing cap applies)</span> : null}
        </div>
      )}
      {note ? <Notice tone={note.tone === "warn" ? "warn" : "info"}>{note.text}</Notice> : null}
    </div>
  );
}
