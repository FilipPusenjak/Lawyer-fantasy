import type { Metadata } from "next";
import type { ReactNode } from "react";
import { db } from "@/db";
import { CardTitle, EmptyState, LinkButton, Notice, Page, PageHeader } from "@/components/ui";
import { isUuid } from "@/lib/format";
import { currentWeek } from "@/lib/time";
import { getLeagueContext } from "@/server/league-context";
import { leagueClock } from "@/server/services/lineups";
import { getScoreboard } from "@/server/services/scores";
import {
  listOpenTrades,
  listTradeHistory,
  staleTradeLawyers,
  tradeWindowError,
  type TradeView,
  type TradeViewer,
} from "@/server/services/trades";
import { TradeCard } from "./trade-card";
import { firstParam, newTradeHref, reviewText, tradeDeadlineText } from "./trade-labels";

export const metadata: Metadata = { title: "Trades" };

const HISTORY_LIMIT = 30;

export default async function TradesPage({ params, searchParams }: PageProps<"/leagues/[leagueId]/trades">) {
  const { leagueId } = await params;
  const sp = await searchParams;
  const ctx = await getLeagueContext(leagueId);
  const { league, settings } = ctx;
  const tz = settings.schedule.timezone;
  const viewer: TradeViewer = { teamId: ctx.team?.id ?? null, isCommissioner: ctx.isCommissioner };

  const week = currentWeek(new Date(), leagueClock({ seasonStart: league.seasonStart, settings }));
  const windowArgs = { leagueStatus: league.status, deadlineWeek: settings.trades.deadlineWeek, currentWeek: week };
  const canPropose = !!ctx.team && tradeWindowError(windowArgs) === null;

  const [open, history] = await Promise.all([
    listOpenTrades(db, leagueId, viewer),
    listTradeHistory(db, leagueId, viewer, HISTORY_LIMIT),
  ]);
  const [stale, scoreboard] = await Promise.all([
    staleTradeLawyers(db, leagueId, open),
    open.length + history.length > 0 ? getScoreboard(leagueId) : Promise.resolve(null),
  ]);
  const points = (lawyerId: string) => scoreboard?.lawyerTotal(lawyerId) ?? 0;

  const myId = ctx.team?.id;
  const offersToMe = open.filter((t) => t.status === "proposed" && t.recipientTeamId === myId);
  const myOffers = open.filter((t) => t.status === "proposed" && t.proposerTeamId === myId);
  const inReview = open.filter((t) => t.status === "accepted");

  const sentId = firstParam(sp.sent);
  const sent = sentId && isUuid(sentId) ? myOffers.find((t) => t.id === sentId) : undefined;

  const card = (t: TradeView) => (
    <TradeCard key={t.id} trade={t} leagueId={leagueId} viewer={viewer} points={points} timeZone={tz} stale={stale.get(t.id)} />
  );

  return (
    <Page className="space-y-5">
      <PageHeader
        title="Trades"
        subtitle={tradeDeadlineText({ ...windowArgs, seasonStart: league.seasonStart })}
        action={canPropose ? <LinkButton href={newTradeHref(leagueId)}>New offer</LinkButton> : undefined}
      />

      {sent ? <Notice tone="success">Offer sent to {sent.recipientName}! They can accept or decline it.</Notice> : null}
      {!ctx.team ? <Notice>You don&apos;t have a team in this league, so you can&apos;t trade.</Notice> : null}

      <Section title="Offers to you" count={offersToMe.length}>
        {offersToMe.length ? offersToMe.map(card) : <EmptyState title="No offers right now." />}
      </Section>

      <Section title="Your offers" count={myOffers.length}>
        {myOffers.length ? (
          myOffers.map(card)
        ) : (
          <EmptyState title="You haven't sent any offers.">
            {canPropose ? "Tap New offer to build one." : null}
          </EmptyState>
        )}
      </Section>

      <Section title="In review" count={inReview.length} hint={reviewText(settings.trades.reviewHours)}>
        {inReview.length ? inReview.map(card) : <EmptyState title="No trades waiting on review." />}
      </Section>

      <Section title="History">
        {history.length ? history.map(card) : <EmptyState title="No trades yet." />}
        {history.length === HISTORY_LIMIT ? <p className="text-center text-xs text-muted">Showing the latest {HISTORY_LIMIT}.</p> : null}
      </Section>
    </Page>
  );
}

function Section({ title, count, hint, children }: { title: string; count?: number; hint?: string; children: ReactNode }) {
  return (
    <section className="space-y-3" aria-label={title}>
      <div>
        <CardTitle>
          {title}
          {count ? <span className="ml-1.5 text-muted">({count})</span> : null}
        </CardTitle>
        {hint ? <p className="-mt-2 text-xs text-muted">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}
