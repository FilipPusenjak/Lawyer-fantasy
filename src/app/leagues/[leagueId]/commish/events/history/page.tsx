import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { Button, Card, EmptyState, Input, LinkButton, Notice, Page, PageHeader, Select } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/ui-client";
import { EVENT_LABELS, EVENT_TYPES, totalSeasonWeeks, type EventType } from "@/lib/settings";
import { weekOfDate } from "@/lib/time";
import { canManagePool, getCommissionerContext } from "@/server/league-context";
import { countPending, eventCredits, finalizedWeeks, listEvents, loadCreditIndex, type EventStatus } from "@/server/services/events";
import { BackLink } from "../../pool/pool-ui";
import { setEventStatusAction } from "../actions";
import { EventFacts, EventsTabs } from "../event-ui";

export const metadata: Metadata = { title: "Event history" };

const PAGE_SIZE = 25;

function one(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
}

export default async function EventHistoryPage({ params, searchParams }: PageProps<"/leagues/[leagueId]/commish/events/history">) {
  const { leagueId } = await params;
  const ctx = await getCommissionerContext(leagueId);
  if (!(await canManagePool(ctx.user, ctx.league.poolId))) notFound();
  const poolId = ctx.league.poolId;
  const sp = await searchParams;
  const statusRaw = one(sp.status);
  const status: EventStatus | "" = statusRaw === "approved" || statusRaw === "rejected" ? statusRaw : "";
  const typeRaw = one(sp.type);
  const type = (EVENT_TYPES as readonly string[]).includes(typeRaw) ? (typeRaw as EventType) : undefined;
  const q = one(sp.q).slice(0, 100);
  const page = Math.max(1, Math.min(1000, Math.floor(Number(one(sp.page))) || 1));
  const added = Number(one(sp.added)) || 0;

  const [rows, pending, index, finalized] = await Promise.all([
    listEvents(db, poolId, {
      statuses: status ? [status] : ["approved", "rejected"],
      type,
      q,
      limit: PAGE_SIZE + 1,
      offset: (page - 1) * PAGE_SIZE,
    }),
    countPending(db, poolId),
    loadCreditIndex(db, poolId),
    finalizedWeeks(db, leagueId),
  ]);
  const hasMore = rows.length > PAGE_SIZE;
  const events = rows.slice(0, PAGE_SIZE);
  const totalWeeks = totalSeasonWeeks(ctx.settings.schedule);
  const base = `/leagues/${leagueId}/commish/events`;
  const pageHref = (p: number) => {
    const u = new URLSearchParams();
    if (status) u.set("status", status);
    if (type) u.set("type", type);
    if (q) u.set("q", q);
    if (p > 1) u.set("page", String(p));
    const s = u.toString();
    return `${base}/history${s ? `?${s}` : ""}`;
  };
  const filtered = !!(status || type || q);

  return (
    <Page className="space-y-4">
      <BackLink href={`/leagues/${leagueId}/commish`} label="Commissioner" />
      <PageHeader title="Scoring events" subtitle="Approved and rejected events. Move one back to pending to take its points away." />
      <EventsTabs leagueId={leagueId} active="history" pending={pending} />
      {added > 0 ? <Notice tone="success">{added > 1 ? `${added} events added and approved.` : "Event added and approved."}</Notice> : null}

      <form action={`${base}/history`} className="space-y-2" role="search">
        <div className="grid grid-cols-2 gap-2">
          <Select name="status" defaultValue={status} aria-label="Status">
            <option value="">Approved + rejected</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </Select>
          <Select name="type" defaultValue={type ?? ""} aria-label="Event type">
            <option value="">All types</option>
            {EVENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {EVENT_LABELS[t]}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex gap-2">
          <Input name="q" defaultValue={q} placeholder="Search summary, case, lawyer" aria-label="Search events" className="min-w-0 flex-1" />
          <Button type="submit" variant="secondary" className="shrink-0">
            Go
          </Button>
        </div>
      </form>

      {events.length === 0 ? (
        <EmptyState title={filtered ? "No matches" : "Nothing reviewed yet"}>
          {filtered ? "Try different filters." : "Approved and rejected events will show up here."}
        </EmptyState>
      ) : (
        events.map((e) => (
          <Card key={e.id} className="space-y-3">
            <EventFacts
              e={e}
              credits={eventCredits(e, index, ctx.settings.scoring)}
              week={weekOfDate(e.occurredOn, ctx.league.seasonStart)}
              totalWeeks={totalWeeks}
              finalized={finalized}
              leagueId={leagueId}
              showStatus
            />
            <ActionForm action={setEventStatusAction.bind(null, leagueId, e.id)}>
              <div className="flex gap-2">
                <SubmitButton
                  name="op"
                  value="pending"
                  variant="secondary"
                  className="flex-1"
                  confirm={e.status === "approved" ? "Move this event back to pending? Its points stop counting until it's approved again." : undefined}
                >
                  Move to pending
                </SubmitButton>
                <LinkButton href={`${base}/${e.id}`} variant="ghost" className="shrink-0">
                  Edit
                </LinkButton>
              </div>
            </ActionForm>
          </Card>
        ))
      )}

      {page > 1 || hasMore ? (
        <nav className="grid grid-cols-2 gap-2" aria-label="Pages">
          {page > 1 ? (
            <LinkButton href={pageHref(page - 1)} variant="secondary">
              ‹ Newer
            </LinkButton>
          ) : (
            <span />
          )}
          {hasMore ? (
            <LinkButton href={pageHref(page + 1)} variant="secondary">
              Older ›
            </LinkButton>
          ) : null}
        </nav>
      ) : null}
    </Page>
  );
}
