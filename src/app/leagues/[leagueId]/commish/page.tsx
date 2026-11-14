import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { count, eq } from "drizzle-orm";
import { db } from "@/db";
import { leagueMembers } from "@/db/schema";
import { Badge, Card, CardTitle, ListRow, Notice, Page, PageHeader } from "@/components/ui";
import { plural } from "@/lib/format";
import { getCommissionerContext } from "@/server/league-context";
import { countPending } from "@/server/services/events";
import { poolCounts } from "@/server/services/pool";
import { getWeekStatuses } from "@/server/services/results";
import { LEAGUE_STATUS_LABELS } from "@/app/leagues/new/league-rules";

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

  const [pending, counts, [members], weeks] = await Promise.all([
    countPending(db, poolId),
    poolCounts(db, poolId),
    db.select({ n: count() }).from(leagueMembers).where(eq(leagueMembers.leagueId, leagueId)),
    getWeekStatuses(db, leagueId),
  ]);
  const readyToFinalize = weeks.some((r) => r.canFinalize);

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
