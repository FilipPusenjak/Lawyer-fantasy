import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { db } from "@/db";
import { Card, cx, EmptyState, LinkButton, Notice, Page, PageHeader } from "@/components/ui";
import { plural } from "@/lib/format";
import { totalSeasonWeeks } from "@/lib/settings";
import { weekOfDate } from "@/lib/time";
import { canManagePool, getCommissionerContext } from "@/server/league-context";
import { eventCredits, finalizedWeeks, listPending, loadCreditIndex, pendingGroups } from "@/server/services/events";
import { BackLink } from "../pool/pool-ui";
import { reviewEventsAction } from "./actions";
import { appearanceOptions, parseQueueFilter, queueCounts, queueHref } from "./event-rules";
import { EventFacts, EventsTabs } from "./event-ui";
import { CaseFilter } from "./queue-filters";
import { ReviewChoices } from "./review-choices";
import { ReviewButton, ReviewQueueForm } from "./review-form";

export const metadata: Metadata = { title: "Review queue" };

const QUEUE_LIMIT = 100;

export default async function ReviewQueuePage({ params, searchParams }: PageProps<"/leagues/[leagueId]/commish/events">) {
  const { leagueId } = await params;
  const ctx = await getCommissionerContext(leagueId);
  if (!(await canManagePool(ctx.user, ctx.league.poolId))) notFound();
  const poolId = ctx.league.poolId;
  const sp = await searchParams;
  const filter = parseQueueFilter(sp);
  const loadedAt = new Date().toISOString();
  const [events, groups, index, finalized] = await Promise.all([
    listPending(db, poolId, QUEUE_LIMIT, { origin: filter.origin ?? undefined, caseId: filter.caseId ?? undefined }),
    pendingGroups(db, poolId),
    loadCreditIndex(db, poolId),
    finalizedWeeks(db, leagueId),
  ]);
  const counts = queueCounts(groups, filter);
  const added = Number(sp.added) || 0;
  const totalWeeks = totalSeasonWeeks(ctx.settings.schedule);
  const base = `/leagues/${leagueId}/commish/events`;
  const filtered = filter.origin !== null || filter.caseId !== null;
  const selectedCase = filter.caseId ? counts.cases.find((c) => c.caseId === filter.caseId) : undefined;
  const caseCount = (caseId: string) => counts.cases.find((c) => c.caseId === caseId)?.count ?? 0;

  return (
    <Page className="space-y-4">
      <BackLink href={`/leagues/${leagueId}/commish`} label="Commissioner" />
      <PageHeader title="Scoring events" subtitle="Check each event against its source. Points count only after approval." />
      <EventsTabs leagueId={leagueId} active="queue" pending={counts.allPending} />
      {added > 0 ? <Notice tone="success">{added > 1 ? `${added} events added` : "Event added"} to the review queue.</Notice> : null}

      {counts.allPending > 0 ? (
        <div className="space-y-2">
          <nav aria-label="Filter by origin" className="flex flex-wrap gap-2">
            <FilterChip href={queueHref(base, { ...filter, origin: null })} active={filter.origin === null}>
              All ({counts.origins.all})
            </FilterChip>
            <FilterChip href={queueHref(base, { ...filter, origin: "courtlistener" })} active={filter.origin === "courtlistener"}>
              From court records ({counts.origins.courtlistener})
            </FilterChip>
            <FilterChip href={queueHref(base, { ...filter, origin: "manual" })} active={filter.origin === "manual"}>
              Manual ({counts.origins.manual})
            </FilterChip>
          </nav>
          {counts.cases.length > 0 ? (
            <CaseFilter base={base} origin={filter.origin} value={filter.caseId} cases={counts.cases} total={counts.originTotal} />
          ) : null}
        </div>
      ) : null}

      {events.length === 0 ? (
        filtered && counts.allPending > 0 ? (
          <EmptyState title="Nothing here">
            No pending events match these filters.
            <br />
            <LinkButton href={base} variant="ghost" className="mt-2">
              Show everything ({counts.allPending})
            </LinkButton>
          </EmptyState>
        ) : (
          <EmptyState title="All caught up">
            No events are waiting. <br />
            <LinkButton href={`${base}/new`} variant="ghost" className="mt-2">
              Add an event
            </LinkButton>
          </EmptyState>
        )
      ) : (
        <ReviewQueueForm action={reviewEventsAction.bind(null, leagueId)} ids={events.map((e) => e.id)}>
          {selectedCase && counts.matching > 0 ? (
            <div className="space-y-2 rounded-xl border border-line p-3">
              <p className="text-sm">
                {plural(counts.matching, "pending event")} from this case
                {filter.origin === "courtlistener" ? " (court records)" : filter.origin === "manual" ? " (manual)" : ""}
              </p>
              <input type="hidden" name="queueOrigin" value={filter.origin ?? ""} />
              <input type="hidden" name="queueLoadedAt" value={loadedAt} />
              <ReviewButton
                op={`reject-case:${selectedCase.caseId}`}
                variant="secondary"
                className="w-full"
                confirm={`Reject ${counts.matching === 1 ? "the 1 pending event" : `all ${counts.matching} pending events`}${
                  filter.origin === "courtlistener" ? " (from court records)" : filter.origin === "manual" ? " (added by hand)" : ""
                } on ${selectedCase.caption}? They won't score.`}
              >
                Reject all from this case
              </ReviewButton>
            </div>
          ) : null}
          {counts.matching > events.length ? (
            <p className="text-sm text-muted">
              Showing the oldest {events.length} of {plural(counts.matching, "pending event")}.
            </p>
          ) : null}
          {counts.incomplete > 0 ? (
            <p className="text-sm text-muted">
              {counts.incomplete === 1
                ? "1 event needs a side, lawyer or type picked before it can be approved."
                : `${counts.incomplete} events need a side, lawyer or type picked before they can be approved.`}
            </p>
          ) : null}
          {events.map((e) => {
            const automatic = e.origin !== "manual";
            const sameCase = !filter.caseId && e.caseId ? caseCount(e.caseId) : 0;
            return (
              <Card key={e.id} className="space-y-3">
                <div className="flex gap-2">
                  <label className="-ml-2 -mt-2 flex h-11 w-11 shrink-0 items-center justify-center">
                    <input type="checkbox" name="ids" value={e.id} className="h-5 w-5 accent-brand" aria-label="Select this event" />
                  </label>
                  <EventFacts
                    e={e}
                    credits={e.complete ? eventCredits(e, index, ctx.settings.scoring) : []}
                    week={weekOfDate(e.occurredOn, ctx.league.seasonStart)}
                    totalWeeks={totalWeeks}
                    finalized={finalized}
                    leagueId={leagueId}
                    compactMissing
                  />
                </div>
                {/* Keyed by the saved values so the picks reset after "Save". */}
                <ReviewChoices
                  key={`${e.type}|${e.side}|${e.lawyerId}`}
                  eventId={e.id}
                  type={e.type}
                  side={e.side}
                  lawyerId={e.lawyerId}
                  caseId={e.caseId}
                  caseType={e.caseType}
                  missing={e.missing}
                  appearances={automatic || !e.complete ? appearanceOptions(index, e.caseId) : []}
                  allowTypeChange={automatic}
                />
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
                {sameCase > 1 && e.caseId ? (
                  <Link
                    href={queueHref(base, { ...filter, caseId: e.caseId })}
                    className="inline-flex min-h-11 items-center text-sm font-semibold text-brand"
                  >
                    All {sameCase} from this case ›
                  </Link>
                ) : null}
              </Card>
            );
          })}
        </ReviewQueueForm>
      )}
    </Page>
  );
}

function FilterChip({ href, active, children }: { href: string; active: boolean; children: ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cx(
        "inline-flex min-h-11 items-center rounded-full border px-3 text-sm font-semibold",
        active ? "border-brand bg-brand text-brand-ink" : "border-line bg-surface text-muted",
      )}
    >
      {children}
    </Link>
  );
}
