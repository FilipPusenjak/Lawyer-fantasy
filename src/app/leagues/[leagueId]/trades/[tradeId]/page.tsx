import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { LinkButton, Page, PageHeader } from "@/components/ui";
import { isUuid } from "@/lib/format";
import { getLeagueContext } from "@/server/league-context";
import { getScoreboard } from "@/server/services/scores";
import { canViewTrade, getTradeView, staleTradeLawyers, type TradeViewer } from "@/server/services/trades";
import { ResultToastProvider } from "../../players/result-toast";
import { TradeCard } from "../trade-card";
import { reviewText } from "../trade-labels";

export const metadata: Metadata = { title: "Trade" };

export default async function TradeDetailPage({ params }: PageProps<"/leagues/[leagueId]/trades/[tradeId]">) {
  const { leagueId, tradeId } = await params;
  const ctx = await getLeagueContext(leagueId);
  if (!isUuid(tradeId)) notFound();
  const viewer: TradeViewer = { teamId: ctx.team?.id ?? null, isCommissioner: ctx.isCommissioner };
  const trade = await getTradeView(db, leagueId, tradeId);
  if (!trade || !canViewTrade(trade, viewer)) notFound();

  const [stale, scoreboard] = await Promise.all([staleTradeLawyers(db, leagueId, [trade]), getScoreboard(leagueId)]);

  return (
    <ResultToastProvider>
      <Page className="space-y-4">
        <PageHeader
          title="Trade"
          subtitle={trade.status === "accepted" ? reviewText(ctx.settings.trades.reviewHours) : undefined}
          action={
            <LinkButton href={`/leagues/${leagueId}/trades`} variant="secondary">
              All trades
            </LinkButton>
          }
        />
        <TradeCard
          trade={trade}
          leagueId={leagueId}
          viewer={viewer}
          points={(id) => scoreboard.lawyerTotal(id)}
          timeZone={ctx.settings.schedule.timezone}
          stale={stale.get(trade.id)}
          detail
        />
      </Page>
    </ResultToastProvider>
  );
}
