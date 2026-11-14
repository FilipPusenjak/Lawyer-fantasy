import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { Badge, Card, CardTitle, LinkButton, ListRow, Page, PageHeader } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/ui-client";
import { plural } from "@/lib/format";
import { formatDateTime } from "@/lib/time";
import { courtListenerConfigured } from "@/server/court/courtlistener";
import { canManagePool, getCommissionerContext } from "@/server/league-context";
import { listLawyerOptions } from "@/server/services/pool";
import { BackLink } from "../pool/pool-ui";
import { addCaseFromDocketAction, addLawyerToCaseAction, linkDocketAction, searchCourtAction, testConnectionAction } from "./actions";
import { poolCourtStats } from "./court-data";
import { CourtSearch } from "./court-forms";
import { COVERAGE_NOTE } from "./court-rules";
import { ConnectNotice } from "./court-ui";

export const metadata: Metadata = { title: "Court data" };

export default async function CourtDataPage({ params }: PageProps<"/leagues/[leagueId]/commish/court">) {
  const { leagueId } = await params;
  const ctx = await getCommissionerContext(leagueId);
  if (!(await canManagePool(ctx.user, ctx.league.poolId))) notFound();
  const poolId = ctx.league.poolId;
  const tz = ctx.settings.schedule.timezone;
  const configured = courtListenerConfigured();
  const [stats, lawyers] = await Promise.all([poolCourtStats(db, poolId), configured ? listLawyerOptions(db, poolId) : Promise.resolve([])]);
  const base = `/leagues/${leagueId}/commish`;

  return (
    <Page className="space-y-4">
      <BackLink href={base} label="Commissioner" />
      <PageHeader
        title="Court data"
        subtitle="New court activity becomes suggestions in the review queue. Nothing counts until you approve it."
      />

      {configured ? (
        <CourtSearch
          searchAction={searchCourtAction.bind(null, leagueId)}
          addCaseAction={addCaseFromDocketAction.bind(null, leagueId)}
          linkAction={linkDocketAction.bind(null, leagueId)}
          addLawyerAction={addLawyerToCaseAction.bind(null, leagueId)}
          lawyers={lawyers}
          caseBase={`${base}/pool/cases`}
        />
      ) : (
        <ConnectNotice />
      )}

      <Card className="space-y-3">
        <CardTitle>Daily sync</CardTitle>
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-muted">Last sync</dt>
            <dd className="font-semibold">{stats.lastSyncedAt ? formatDateTime(stats.lastSyncedAt, tz) : "Not yet"}</dd>
          </div>
          <div>
            <dt className="text-muted">Sync errors</dt>
            <dd className={stats.errors.length > 0 ? "font-semibold text-neg" : "font-semibold"}>{stats.errors.length > 0 ? plural(stats.errors.length, "case") : "None"}</dd>
          </div>
          <div>
            <dt className="text-muted">Supreme Court</dt>
            <dd className="font-semibold">{stats.scotusTracked} tracked automatically</dd>
          </div>
          <div>
            <dt className="text-muted">CourtListener</dt>
            <dd className="font-semibold">
              {stats.linked} linked · {stats.unlinked} not
            </dd>
          </div>
        </dl>
        <p className="text-xs text-muted">Every active case syncs once a day. {COVERAGE_NOTE}</p>
        {stats.errors.length > 0 ? (
          <div>
            <p className="text-sm font-semibold">Cases with sync errors</p>
            {stats.errors.map((e) => (
              <ListRow key={e.id} href={`${base}/pool/cases/${e.id}#court-data`}>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{e.caption}</p>
                  <p className="line-clamp-2 text-sm text-neg">{e.error}</p>
                  {e.syncedAt ? <p className="text-xs text-muted">Last tried {formatDateTime(e.syncedAt, tz)}</p> : null}
                </div>
                <span className="text-muted" aria-hidden>
                  ›
                </span>
              </ListRow>
            ))}
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-2">
          <LinkButton href={`${base}/pool#court-link`} variant="secondary">
            Link cases
          </LinkButton>
          <LinkButton href={`${base}/events`} variant="secondary">
            Review queue
          </LinkButton>
        </div>
      </Card>

      <Card className="space-y-3">
        <CardTitle action={configured ? <Badge tone="pos">Token set</Badge> : <Badge tone="warn">Not connected</Badge>}>Connection</CardTitle>
        {configured ? (
          <ActionForm action={testConnectionAction.bind(null, leagueId)}>
            <p className="text-sm text-muted">Checks the token and how much of today&apos;s free quota is left. This check doesn&apos;t use the search quota.</p>
            <SubmitButton variant="secondary" className="w-full" pendingText="Testing…">
              Test connection
            </SubmitButton>
          </ActionForm>
        ) : (
          <p className="text-sm text-muted">Searching, linking and syncing CourtListener dockets need the token described above.</p>
        )}
        <p className="text-xs text-muted">The Supreme Court docket feed doesn&apos;t need a token.</p>
      </Card>
    </Page>
  );
}
