/**
 * Server-rendered court-data pieces: the case page "Court data" card, the pool
 * page "Link cases to CourtListener" card and small shared bits. Nothing here
 * calls CourtListener; calls only happen in Server Actions the commissioner submits.
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { Card, CardTitle, Notice } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/ui-client";
import type { Case } from "@/db/schema";
import { formatDateTime } from "@/lib/time";
import { courtListenerConfigured } from "@/server/court/courtlistener";
import { scotusDocketFromCase, syncSourceForCase } from "@/server/services/court-sync";
import { autoLinkAction, findCaseDocketsAction, linkDocketAction, syncCaseAction, unlinkDocketAction } from "./actions";
import { CaseDocketSearch, SyncNowForm } from "./court-forms";
import {
  AUTO_LINK_BATCH,
  cleanDocketForSearch,
  CONNECT_MESSAGE,
  courtIdFromName,
  courtLabel,
  courtListenerDocketUrl,
  COVERAGE_NOTE,
  FREE_LIMIT_NOTE,
  scotusDocketUrl,
  type CourtStats,
} from "./court-rules";

export function ConnectNotice() {
  return (
    <Notice tone="warn">
      <p className="font-semibold">CourtListener isn&apos;t connected yet.</p>
      <p className="mt-1">{CONNECT_MESSAGE}</p>
      <p className="mt-1 text-muted">A free CourtListener account comes with an API token. Supreme Court cases sync without one.</p>
    </Notice>
  );
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center text-sm font-semibold text-accent underline">
      {children}
    </a>
  );
}

export function SyncStatus({ syncedAt, syncError, timeZone }: { syncedAt: Date | null; syncError: string | null; timeZone: string }) {
  return (
    <div className="space-y-2 text-sm">
      <p className="text-muted">{syncedAt ? `Last synced ${formatDateTime(syncedAt, timeZone)}` : "Not synced yet."}</p>
      {syncError ? <Notice tone="error">Last sync failed: {syncError}</Notice> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Case page
// ---------------------------------------------------------------------------

/** "Court data" card on a pool case page. */
export function CaseCourtCard({ leagueId, c, timeZone }: { leagueId: string; c: Case; timeZone: string }) {
  const configured = courtListenerConfigured();
  const reviewHref = `/leagues/${leagueId}/commish/events`;
  const closedNote =
    c.status === "closed" ? <p className="text-xs text-muted">This case is marked closed, so the daily sync skips it.</p> : null;

  if (syncSourceForCase(c) === "scotus") {
    const docket = scotusDocketFromCase(c) ?? c.docketNumber?.trim() ?? "";
    return (
      <Card id="court-data" className="space-y-2">
        <CardTitle>Court data</CardTitle>
        <p className="text-sm">Tracked automatically from the Supreme Court docket. New entries become suggestions in the review queue.</p>
        {docket ? <ExternalLink href={scotusDocketUrl(docket)}>Supreme Court docket {docket} ↗</ExternalLink> : null}
        <SyncStatus syncedAt={c.syncedAt} syncError={c.syncError} timeZone={timeZone} />
        {closedNote}
        <SyncNowForm action={syncCaseAction.bind(null, leagueId, c.id)} reviewHref={reviewHref} />
      </Card>
    );
  }

  if (c.courtlistenerDocketId != null) {
    return (
      <Card id="court-data" className="space-y-2">
        <CardTitle>Court data</CardTitle>
        <p className="text-sm">
          Linked to CourtListener docket #{c.courtlistenerDocketId}. New filings become suggestions in the review queue. {COVERAGE_NOTE}
        </p>
        <ExternalLink href={courtListenerDocketUrl(c.courtlistenerDocketId)}>View docket on CourtListener ↗</ExternalLink>
        <SyncStatus syncedAt={c.syncedAt} syncError={c.syncError} timeZone={timeZone} />
        {closedNote}
        {configured ? <SyncNowForm action={syncCaseAction.bind(null, leagueId, c.id)} reviewHref={reviewHref} /> : <ConnectNotice />}
        <ActionForm action={unlinkDocketAction.bind(null, leagueId, c.id)}>
          <SubmitButton
            variant="ghost"
            className="w-full"
            pendingText="Unlinking…"
            confirm="Unlink this case from CourtListener? Suggestions already in the review queue stay there."
          >
            Unlink
          </SubmitButton>
        </ActionForm>
      </Card>
    );
  }

  if (c.caseType === "supreme_court") {
    return (
      <Card id="court-data" className="space-y-2">
        <CardTitle>Court data</CardTitle>
        <p className="text-sm text-muted">
          Supreme Court cases sync automatically from supremecourt.gov when the docket number looks like “25-159”. Fix the docket number under
          “Edit case details” to start tracking this case.
        </p>
      </Card>
    );
  }

  const courtId = courtIdFromName(c.court);
  return (
    <Card id="court-data" className="space-y-3">
      <CardTitle>Court data</CardTitle>
      <p className="text-sm text-muted">
        Link this case to its CourtListener docket so new filings show up as suggestions in the review queue. {COVERAGE_NOTE}
      </p>
      {configured ? (
        <CaseDocketSearch
          caseId={c.id}
          action={findCaseDocketsAction.bind(null, leagueId, c.id)}
          linkAction={linkDocketAction.bind(null, leagueId)}
          defaults={{ docketNumber: cleanDocketForSearch(c.docketNumber), caseName: c.caption, court: courtId ?? "" }}
          courtHint={courtId ? `Optional. “${courtId}” is ${courtLabel(courtId)}.` : "Optional, e.g. “nysd” for S.D.N.Y."}
        />
      ) : (
        <ConnectNotice />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Pool page
// ---------------------------------------------------------------------------

/** "Link cases to CourtListener" card on the pool page. */
export function PoolCourtCard({ leagueId, stats }: { leagueId: string; stats: CourtStats }) {
  const configured = courtListenerConfigured();
  return (
    <Card id="court-link" className="scroll-mt-4 space-y-3">
      <CardTitle>Link cases to CourtListener</CardTitle>
      <ul className="space-y-1 text-sm">
        <li>
          <span className="font-semibold tabular-nums">{stats.linked}</span> linked to CourtListener
        </li>
        <li>
          <span className="font-semibold tabular-nums">{stats.unlinked}</span> active federal {stats.unlinked === 1 ? "case" : "cases"} not linked yet
        </li>
        <li>
          <span className="font-semibold tabular-nums">{stats.scotusTracked}</span> Supreme Court {stats.scotusTracked === 1 ? "case" : "cases"} tracked
          automatically
        </li>
        {stats.scotusNeedsDocket > 0 ? (
          <li className="text-warn">
            <span className="font-semibold tabular-nums">{stats.scotusNeedsDocket}</span> Supreme Court{" "}
            {stats.scotusNeedsDocket === 1 ? "case needs" : "cases need"} a docket number like “25-159”
          </li>
        ) : null}
      </ul>
      {!configured ? (
        <ConnectNotice />
      ) : stats.unlinked > 0 ? (
        <ActionForm action={autoLinkAction.bind(null, leagueId)}>
          <SubmitButton className="w-full" pendingText="Linking… this can take a minute">
            Auto-link next {AUTO_LINK_BATCH}
          </SubmitButton>
        </ActionForm>
      ) : (
        <p className="text-sm text-muted">Every active federal case is linked.</p>
      )}
      <p className="text-xs text-muted">{FREE_LIMIT_NOTE}</p>
      <Link href={`/leagues/${leagueId}/commish/court`} className="inline-flex min-h-11 items-center text-sm font-semibold text-brand">
        Court data: search by lawyer or firm ›
      </Link>
    </Card>
  );
}
