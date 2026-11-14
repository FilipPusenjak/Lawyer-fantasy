import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { Card, EmptyState, LinkButton, Notice, Page, PageHeader } from "@/components/ui";
import { plural } from "@/lib/format";
import { totalSeasonWeeks } from "@/lib/settings";
import { weekOfDate } from "@/lib/time";
import { canManagePool, getCommissionerContext } from "@/server/league-context";
import { countPending, eventCredits, finalizedWeeks, listPending, loadCreditIndex } from "@/server/services/events";
import { BackLink } from "../pool/pool-ui";
import { reviewEventsAction } from "./actions";
import { EventFacts, EventsTabs } from "./event-ui";
import { ReviewButton, ReviewQueueForm } from "./review-form";

export const metadata: Metadata = { title: "Review queue" };

const QUEUE_LIMIT = 100;

export default async function ReviewQueuePage({ params, searchParams }: PageProps<"/leagues/[leagueId]/commish/events">) {
  const { leagueId } = await params;
  const ctx = await getCommissionerContext(leagueId);
  if (!(await canManagePool(ctx.user, ctx.league.poolId))) notFound();
  const poolId = ctx.league.poolId;
  const [events, total, index, finalized] = await Promise.all([
    listPending(db, poolId, QUEUE_LIMIT),
    countPending(db, poolId),
    loadCreditIndex(db, poolId),
    finalizedWeeks(db, leagueId),
  ]);
  const added = Number((await searchParams).added) || 0;
  const totalWeeks = totalSeasonWeeks(ctx.settings.schedule);
  const base = `/leagues/${leagueId}/commish/events`;

  return (
    <Page className="space-y-4">
      <BackLink href={`/leagues/${leagueId}/commish`} label="Commissioner" />
      <PageHeader title="Scoring events" subtitle="Check each event against its source. Points count only after approval." />
      <EventsTabs leagueId={leagueId} active="queue" pending={total} />
      {added > 0 ? <Notice tone="success">{added > 1 ? `${added} events added` : "Event added"} to the review queue.</Notice> : null}

      {events.length === 0 ? (
        <EmptyState title="All caught up">
          No events are waiting. <br />
          <LinkButton href={`${base}/new`} variant="ghost" className="mt-2">
            Add an event
          </LinkButton>
        </EmptyState>
      ) : (
        <ReviewQueueForm action={reviewEventsAction.bind(null, leagueId)} ids={events.map((e) => e.id)}>
          {total > events.length ? (
            <p className="text-sm text-muted">
              Showing the oldest {events.length} of {plural(total, "pending event")}.
            </p>
          ) : null}
          {events.map((e) => (
            <Card key={e.id} className="space-y-3">
              <div className="flex gap-2">
                <label className="-ml-2 -mt-2 flex h-11 w-11 shrink-0 items-center justify-center">
                  <input type="checkbox" name="ids" value={e.id} className="h-5 w-5 accent-brand" aria-label="Select this event" />
                </label>
                <EventFacts
                  e={e}
                  credits={eventCredits(e, index, ctx.settings.scoring)}
                  week={weekOfDate(e.occurredOn, ctx.league.seasonStart)}
                  totalWeeks={totalWeeks}
                  finalized={finalized}
                  leagueId={leagueId}
                />
              </div>
              <div className="flex gap-2">
                <ReviewButton op={`approve:${e.id}`} className="flex-1">
                  Approve
                </ReviewButton>
                <ReviewButton op={`reject:${e.id}`} variant="secondary" className="flex-1" confirm="Reject this event? It won't score.">
                  Reject
                </ReviewButton>
                <LinkButton href={`${base}/${e.id}`} variant="ghost" className="shrink-0">
                  Edit
                </LinkButton>
              </div>
            </Card>
          ))}
        </ReviewQueueForm>
      )}
    </Page>
  );
}
