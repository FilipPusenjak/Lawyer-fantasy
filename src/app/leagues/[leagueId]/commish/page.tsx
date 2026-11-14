import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { count, eq } from "drizzle-orm";
import { db } from "@/db";
import { leagueMembers } from "@/db/schema";
import { Badge, Card, CardTitle, ListRow, Notice, Page, PageHeader } from "@/components/ui";
import { plural } from "@/lib/format";
import { formatDateTime } from "@/lib/time";
import { courtListenerConfigured } from "@/server/court/courtlistener";
import { getCommissionerContext } from "@/server/league-context";
import { countPending } from "@/server/services/events";
import { poolCounts } from "@/server/services/pool";
import { getWeekStatuses } from "@/server/services/results";
import { LEAGUE_STATUS_LABELS } from "@/app/leagues/new/league-rules";
import { poolCourtStats } from "./court/court-data";

export const metadata: Metadata = { title: "Commissioner" };

function HubRow({ href, label, hint, badge }: { href: string; label: string; hint: string; badge?: ReactNode }) {
  return (
    <ListRow href={href}>
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{label}</p>
        <p className="text-sm text-muted">{hint}</p>
      </div>
      {badge}
      <span className="text-muted" aria-hidden>
        ›
      </span>
    </ListRow>
  );
}

function draftHint(status: string): string {
  if (status === "setup") return "Set the order and start the draft";
  if (status === "drafting") return "The draft is live";
  return "Draft board and results";
}

export default async function CommissionerHubPage({ params }: PageProps<"/leagues/[leagueId]/commish">) {
  const { leagueId } = await params;
  const ctx = await getCommissionerContext(leagueId);
  const poolId = ctx.league.poolId;
  const base = `/leagues/${leagueId}`;

  const [pending, counts, [members], weeks, court] = await Promise.all([
    countPending(db, poolId),
    poolCounts(db, poolId),
    db.select({ n: count() }).from(leagueMembers).where(eq(leagueMembers.leagueId, leagueId)),
    getWeekStatuses(db, leagueId),
    poolCourtStats(db, poolId),
  ]);
  const readyToFinalize = weeks.some((r) => r.canFinalize);
  const clConnected = courtListenerConfigured();
  const tz = ctx.settings.schedule.timezone;

  return (
    <Page className="space-y-4">
      <Link href={`${base}/more`} className="inline-flex min-h-11 items-center text-sm font-semibold text-brand">
        ‹ League
      </Link>
      <PageHeader title="Commissioner" subtitle={`${ctx.league.name} · ${LEAGUE_STATUS_LABELS[ctx.league.status]}`} />

      <Notice>
        <p className="font-semibold">You&apos;re the referee.</p>
        <p className="mt-1">
          Approve scoring events only when a public record backs them up (a court docket, court website or news report). Points count only
          after you approve. Keep summaries to the facts.
        </p>
      </Notice>

      <Card>
        <CardTitle>Scoring</CardTitle>
        <HubRow
          href={`${base}/commish/events`}
          label="Review queue"
          hint={pending > 0 ? `${plural(pending, "event")} waiting for review` : "All caught up"}
          badge={pending > 0 ? <Badge tone="warn">{pending}</Badge> : null}
        />
        <HubRow href={`${base}/commish/events/new`} label="Add scoring event" hint="Record a ruling, verdict or filing from a public record" />
        <HubRow href={`${base}/commish/events/history`} label="Event history" hint="Approved and rejected events" />
      </Card>

      <Card>
        <CardTitle>Court data</CardTitle>
        <HubRow
          href={`${base}/commish/court`}
          label="Court data"
          hint={`Supreme Court: ${court.scotusTracked} tracked automatically · ${
            court.lastSyncedAt ? `last sync ${formatDateTime(court.lastSyncedAt, tz)}` : "not synced yet"
          }`}
          badge={court.errors.length > 0 ? <Badge tone="warn">{plural(court.errors.length, "error")}</Badge> : null}
        />
        <HubRow
          href={`${base}/commish/pool#court-link`}
          label="Link cases to CourtListener"
          hint={
            clConnected
              ? `Connected · ${court.linked} linked · ${court.unlinked} not linked`
              : `Not connected · ${court.linked} linked · ${court.unlinked} not linked`
          }
          badge={!clConnected ? <Badge>Off</Badge> : court.unlinked > 0 ? <Badge tone="brand">{court.unlinked}</Badge> : null}
        />
        {court.errors.length > 0 ? (
          <p className="pt-2 text-xs text-muted">
            Sync errors: {court.errors.slice(0, 3).map((e) => e.caption).join(", ")}
            {court.errors.length > 3 ? ` and ${court.errors.length - 3} more` : ""}
          </p>
        ) : null}
      </Card>

      <Card>
        <CardTitle>Season</CardTitle>
        <HubRow
          href={`${base}/commish/weeks`}
          label="Weeks & results"
          hint="Finalize weeks; playoffs start automatically"
          badge={readyToFinalize ? <Badge tone="brand">Ready</Badge> : null}
        />
        <HubRow href={`${base}/draft`} label="Draft room" hint={draftHint(ctx.league.status)} />
      </Card>

      <Card>
        <CardTitle>League</CardTitle>
        <HubRow
          href={`${base}/commish/pool`}
          label="Player pool"
          hint={`${plural(counts.lawyers, "lawyer")} · ${plural(counts.firms, "firm")} · ${plural(counts.cases, "case")}`}
        />
        <HubRow
          href={`${base}/commish/members`}
          label="Members & invite code"
          hint={`${plural(members?.n ?? 0, "member")} · code ${ctx.league.inviteCode}`}
        />
        <HubRow href={`${base}/commish/settings`} label="League settings" hint="Roster, scoring, schedule, draft, waivers, trades" />
      </Card>
    </Page>
  );
}
