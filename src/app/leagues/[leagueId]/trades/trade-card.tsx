import Link from "next/link";
import { Badge, Card, Input, LinkButton, Notice, Points } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/ui-client";
import { POSITION_LABELS, POSITION_SHORT } from "@/lib/settings";
import { formatDateTime } from "@/lib/time";
import { allowedTradeActions, TRADE_MESSAGE_MAX, type TradeLawyer, type TradeView, type TradeViewer } from "@/server/services/trades";
import { cancelTradeAction, respondToTradeAction, reviewTradeAction } from "./actions";
import { newTradeHref, TRADE_STATUS_LABELS, tradeStatusTone } from "./trade-labels";

type CardProps = {
  trade: TradeView;
  leagueId: string;
  viewer: TradeViewer;
  /** Season points per lawyer id. */
  points: (lawyerId: string) => number;
  timeZone: string;
  /** Names of lawyers no longer on the team giving them up. */
  stale?: string[];
  /** On the detail page: no title link, full timeline. */
  detail?: boolean;
};

export function TradeCard({ trade, leagueId, viewer, points, timeZone, stale, detail }: CardProps) {
  const href = `/leagues/${leagueId}/trades/${trade.id}`;
  const title = (
    <>
      <span className="break-words">{trade.proposerName}</span>
      <span className="mx-1.5 text-muted" aria-hidden>
        ⇄
      </span>
      <span className="sr-only"> and </span>
      <span className="break-words">{trade.recipientName}</span>
    </>
  );
  const mine = (teamId: string) => (viewer.teamId === teamId ? " (you)" : "");
  return (
    <Card className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        {detail ? (
          <h2 className="min-w-0 text-lg font-semibold uppercase leading-tight">{title}</h2>
        ) : (
          <Link href={href} className="flex min-h-11 min-w-0 items-center font-display text-lg font-semibold uppercase leading-tight">
            <span>{title}</span>
          </Link>
        )}
        <Badge tone={tradeStatusTone(trade.status)} className="mt-1 shrink-0">
          {TRADE_STATUS_LABELS[trade.status]}
        </Badge>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <TradeSide
          title={`${trade.proposerName}${mine(trade.proposerTeamId)} gives`}
          lawyers={trade.proposerGives}
          leagueId={leagueId}
          points={points}
        />
        <TradeSide
          title={`${trade.recipientName}${mine(trade.recipientTeamId)} gives`}
          lawyers={trade.recipientGives}
          leagueId={leagueId}
          points={points}
        />
      </div>

      {trade.message ? (
        <p className="whitespace-pre-line break-words rounded-xl bg-surface-2 px-3 py-2 text-sm">
          <span className="sr-only">Message: </span>“{trade.message}”
        </p>
      ) : null}

      {stale && stale.length > 0 ? (
        <Notice tone="warn">
          {stale.join(", ")} moved to a different roster since this offer was made, so it probably can&apos;t go through.
        </Notice>
      ) : null}

      {trade.failReason && (trade.status === "failed" || trade.status === "vetoed") ? (
        <p className="text-sm text-muted">
          <span className="font-semibold text-ink">{trade.status === "vetoed" ? "Commissioner's note: " : "Why: "}</span>
          {trade.failReason}
        </p>
      ) : null}

      {detail ? <TradeTimeline trade={trade} timeZone={timeZone} /> : <p className="text-xs text-muted">{summaryLine(trade, timeZone)}</p>}

      <TradeActionForms trade={trade} leagueId={leagueId} viewer={viewer} />
    </Card>
  );
}

function TradeSide({
  title,
  lawyers,
  leagueId,
  points,
}: {
  title: string;
  lawyers: TradeLawyer[];
  leagueId: string;
  points: (lawyerId: string) => number;
}) {
  return (
    <div className="min-w-0 rounded-xl border border-line">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
        <span className="min-w-0 truncate">{title}</span>
        {lawyers.length > 0 ? <span className="shrink-0">Season pts</span> : null}
      </div>
      {lawyers.length === 0 ? (
        <p className="px-3 py-2.5 text-sm text-muted">Nobody</p>
      ) : (
        lawyers.map((l) => (
          <Link
            key={l.id}
            href={`/leagues/${leagueId}/lawyers/${l.id}`}
            className="flex min-h-11 items-center gap-2 border-b border-line px-3 py-1.5 last:border-b-0 active:bg-surface-2"
          >
            <Badge className="w-11 shrink-0 justify-center" tone={l.position === "firm" ? "accent" : "neutral"}>
              <abbr title={POSITION_LABELS[l.position]} className="no-underline">
                {POSITION_SHORT[l.position]}
              </abbr>
            </Badge>
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{l.name}</span>
            <Points value={points(l.id)} className="shrink-0 text-sm" />
          </Link>
        ))
      )}
    </div>
  );
}

function summaryLine(t: TradeView, tz: string): string {
  const at = (d: Date | null) => (d ? formatDateTime(d, tz) : "");
  switch (t.status) {
    case "proposed":
      return `Offered ${at(t.createdAt)}`;
    case "accepted":
      return `Accepted ${at(t.respondedAt)} · Goes through ${at(t.reviewEndsAt)}`;
    case "completed":
      return `Completed ${at(t.resolvedAt)}`;
    case "rejected":
      return `Declined ${at(t.resolvedAt)}`;
    case "cancelled":
      return `Cancelled ${at(t.resolvedAt)}`;
    case "vetoed":
      return `Vetoed ${at(t.resolvedAt)}`;
    case "failed":
      return `Fell through ${at(t.resolvedAt ?? t.createdAt)}`;
  }
}

function TradeTimeline({ trade: t, timeZone }: { trade: TradeView; timeZone: string }) {
  const rows: { label: string; at: Date }[] = [{ label: `Offered by ${t.proposerName}`, at: t.createdAt }];
  if (t.respondedAt && t.status !== "rejected") rows.push({ label: `Accepted by ${t.recipientName}`, at: t.respondedAt });
  if (t.status === "accepted" && t.reviewEndsAt) rows.push({ label: "Goes through (unless vetoed)", at: t.reviewEndsAt });
  if (t.resolvedAt) {
    const by = t.resolvedByName ? ` by ${t.resolvedByName}` : "";
    const label: Record<string, string> = {
      completed: t.resolvedBy ? `Approved early${by}` : "Trade went through",
      rejected: `Declined${by}`,
      cancelled: `Cancelled${by}`,
      vetoed: `Vetoed${by}`,
      failed: "Fell through",
    };
    rows.push({ label: label[t.status] ?? TRADE_STATUS_LABELS[t.status], at: t.resolvedAt });
  }
  return (
    <ol className="space-y-1 border-l-2 border-line pl-3 text-sm">
      {rows.map((r) => (
        <li key={r.label}>
          <span className="font-medium">{r.label}</span>
          <span className="block text-xs text-muted">{formatDateTime(r.at, timeZone)}</span>
        </li>
      ))}
    </ol>
  );
}

function Hidden({ leagueId, tradeId }: { leagueId: string; tradeId: string }) {
  return (
    <>
      <input type="hidden" name="leagueId" value={leagueId} />
      <input type="hidden" name="tradeId" value={tradeId} />
    </>
  );
}

/** Buttons for whoever may act on this trade. The server re-checks everything. */
export function TradeActionForms({ trade, leagueId, viewer }: { trade: TradeView; leagueId: string; viewer: TradeViewer }) {
  const can = allowedTradeActions(trade, viewer);
  if (!can.accept && !can.reject && !can.cancel && !can.veto && !can.approve) return null;
  return (
    <div className="space-y-2 border-t border-line pt-3">
      {can.accept || can.reject ? (
        <ActionForm action={respondToTradeAction}>
          <Hidden leagueId={leagueId} tradeId={trade.id} />
          <div className="grid grid-cols-2 gap-2">
            <SubmitButton name="intent" value="accept" confirm="Accept this trade?" pendingText="Saving…">
              Accept
            </SubmitButton>
            <SubmitButton name="intent" value="reject" variant="secondary" confirm="Decline this offer?" pendingText="Saving…">
              Decline
            </SubmitButton>
          </div>
          <LinkButton
            variant="ghost"
            className="w-full"
            href={newTradeHref(leagueId, {
              withTeamId: trade.proposerTeamId,
              give: trade.recipientGives.map((l) => l.id),
              get: trade.proposerGives.map((l) => l.id),
            })}
          >
            Make a counteroffer
          </LinkButton>
        </ActionForm>
      ) : null}

      {can.cancel ? (
        <ActionForm action={cancelTradeAction}>
          <Hidden leagueId={leagueId} tradeId={trade.id} />
          <SubmitButton
            variant="secondary"
            className="w-full"
            confirm={trade.status === "accepted" ? "Back out of this trade?" : "Cancel this offer?"}
            pendingText="Cancelling…"
          >
            {trade.status === "accepted" ? "Back out of trade" : "Cancel offer"}
          </SubmitButton>
        </ActionForm>
      ) : null}

      {can.veto || can.approve ? (
        <details className="group rounded-xl border border-line">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between px-3 text-sm font-semibold text-accent">
            Commissioner review
            <span aria-hidden className="transition group-open:rotate-90">
              ›
            </span>
          </summary>
          <div className="border-t border-line p-3">
            <ActionForm action={reviewTradeAction}>
              <Hidden leagueId={leagueId} tradeId={trade.id} />
              <label className="block">
                <span className="mb-1 block text-sm font-medium">Reason for a veto (optional)</span>
                <Input name="reason" maxLength={TRADE_MESSAGE_MAX} placeholder="Shown to the league" autoComplete="off" />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <SubmitButton name="intent" value="veto" variant="danger" confirm="Veto this trade?" pendingText="Saving…">
                  Veto
                </SubmitButton>
                <SubmitButton
                  name="intent"
                  value="approve"
                  variant="secondary"
                  confirm="Approve this trade now? The lawyers switch teams right away."
                  pendingText="Saving…"
                >
                  Approve now
                </SubmitButton>
              </div>
            </ActionForm>
          </div>
        </details>
      ) : null}
    </div>
  );
}
