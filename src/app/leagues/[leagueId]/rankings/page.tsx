import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { db } from "@/db";
import { Badge, Card, CardTitle, cx, EmptyState, LinkButton, Notice, Page, PageHeader } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/ui-client";
import { plural } from "@/lib/format";
import {
  activityLabel,
  DEFAULT_PROJECTION_OPTIONS,
  fmtProjection,
  PROJECTION_DISCLAIMER,
  projectionInputsLine,
  projectionRangeLabel,
} from "@/lib/projections";
import { POSITION_LABELS, POSITION_SHORT, POSITIONS, type Position } from "@/lib/settings";
import { formatShortDate } from "@/lib/time";
import { canManagePool, getLeagueContext } from "@/server/league-context";
import { countPoolLeagues, getLeagueProjections, type LeagueProjectionRow } from "@/server/services/projections";
import { applyProjectionRanksAction } from "./actions";
import {
  draftPositionRanks,
  filterRankRows,
  parseRankFilters,
  RANK_PAGE_STEP,
  RANK_SORT_LABELS,
  RANK_SORTS,
  RANK_STATUS_FILTERS,
  RANK_STATUS_LABELS,
  rankingsHref,
} from "./rankings-filters";

export const metadata: Metadata = { title: "Rankings & projections" };

function Chip({ href, active, children }: { href: string; active: boolean; children: ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={cx(
        "flex min-h-11 shrink-0 items-center rounded-full border px-4 text-sm font-semibold",
        active ? "border-brand bg-brand text-brand-ink" : "border-line bg-surface text-muted",
      )}
    >
      {children}
    </Link>
  );
}

function ChipRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="group" aria-label={label}>
      {children}
    </div>
  );
}

function StatusBadge({ status, myTeamId }: { status: LeagueProjectionRow["status"]; myTeamId: string | null }) {
  if (status.kind === "rostered") {
    if (status.teamId === myTeamId) return <Badge tone="brand">Your team</Badge>;
    return (
      <Badge className="min-w-0 max-w-40">
        <span className="truncate" title={status.teamName}>
          {status.teamName}
        </span>
      </Badge>
    );
  }
  if (status.kind === "waivers") return <Badge tone="warn">Waivers</Badge>;
  return <Badge tone="pos">Free agent</Badge>;
}

function RankBadge({ position, label, rank }: { position: Position; label: string; rank: number }) {
  return (
    <Badge tone={position === "firm" ? "accent" : "brand"} className="tabular-nums">
      <span aria-hidden>{label}</span>
      <span className="sr-only">
        {POSITION_LABELS[position]} rank {rank}
      </span>
    </Badge>
  );
}

function ApplyRanksForm({ leagueId, poolLeagueCount, prominent }: { leagueId: string; poolLeagueCount: number; prominent: boolean }) {
  return (
    <div className="space-y-2 text-sm">
      <p>
        Sets every lawyer&apos;s and firm&apos;s draft rank to their projection rank (1 = highest projected week). Auto-pick in the
        draft uses these ranks. This replaces any draft ranks set by hand.
      </p>
      <p className="text-muted">
        {poolLeagueCount > 1
          ? `This player pool is shared by ${poolLeagueCount} leagues, so the ranks change in all of them.`
          : "A player pool can be shared by other leagues; any league using this pool gets the same ranks."}
      </p>
      <ActionForm action={applyProjectionRanksAction} className="space-y-2">
        <input type="hidden" name="leagueId" value={leagueId} />
        <SubmitButton
          variant={prominent ? "primary" : "secondary"}
          className="w-full"
          pendingText="Saving…"
          confirm="Replace the draft rank of every lawyer and firm in this pool with their projection rank? Ranks set by hand will be lost."
        >
          Use projection ranks
        </SubmitButton>
      </ActionForm>
    </div>
  );
}

export default async function RankingsPage({ params, searchParams }: PageProps<"/leagues/[leagueId]/rankings">) {
  const { leagueId } = await params;
  const filters = parseRankFilters(await searchParams);
  const ctx = await getLeagueContext(leagueId);
  const { league, team } = ctx;
  const myTeamId = team?.id ?? null;
  const base = `/leagues/${leagueId}/rankings`;

  const [proj, canManage] = await Promise.all([
    getLeagueProjections(db, leagueId),
    ctx.isCommissioner ? canManagePool(ctx.user, league.poolId) : Promise.resolve(false),
  ]);
  const poolLeagueCount = canManage ? await countPoolLeagues(db, league.poolId) : 0;

  const { weeks } = proj;
  const lookback = proj.lookbackWeeks;
  const complete = weeks.phase === "complete";
  const matches = filterRankRows(proj.rows, filters, myTeamId);
  const shown = matches.slice(0, filters.limit);
  const byRos = filters.sort === "ros";
  const byDraft = filters.sort === "draft";
  const draftPos = byDraft ? draftPositionRanks(proj.rows) : null;

  const subtitle = complete
    ? league.status === "complete"
      ? "Season complete"
      : "No weeks left to project"
    : weeks.phase === "preseason"
      ? `Projections for week 1 · season starts ${formatShortDate(proj.seasonStart)}`
      : `Projections for week ${weeks.targetWeek}`;
  const prominentApply = canManage && league.status === "setup";
  const applyCard = canManage ? <ApplyRanksForm leagueId={leagueId} poolLeagueCount={poolLeagueCount} prominent={prominentApply} /> : null;

  return (
    <Page className="space-y-3">
      <PageHeader title="Rankings & projections" subtitle={subtitle} />

      <p className="text-xs text-muted">
        {PROJECTION_DISCLAIMER} Uses approved events through {formatShortDate(proj.historyEnd)}.
      </p>

      {complete ? (
        <Notice>
          The season is complete. The numbers below are weekly projections from recent activity, with no weeks left in this
          season.
        </Notice>
      ) : null}
      {!proj.poolHasHistory && proj.rows.length > 0 ? (
        <Notice>
          This player pool has no approved scoring events yet, so every projection uses typical rates from the league&apos;s
          scoring settings and each lawyer&apos;s active cases.
        </Notice>
      ) : null}

      {prominentApply ? (
        <Card>
          <CardTitle>Use projections as draft rankings</CardTitle>
          {applyCard}
        </Card>
      ) : null}

      <ChipRow label="Filter by position">
        {(["all", ...POSITIONS] as const).map((p) => (
          <Chip key={p} href={rankingsHref(base, filters, { position: p })} active={filters.position === p}>
            {p === "all" ? "All" : POSITION_SHORT[p]}
          </Chip>
        ))}
      </ChipRow>
      <ChipRow label="Filter by status">
        {RANK_STATUS_FILTERS.filter((s) => s !== "mine" || team).map((s) => (
          <Chip key={s} href={rankingsHref(base, filters, { status: s })} active={filters.status === s}>
            {RANK_STATUS_LABELS[s]}
          </Chip>
        ))}
      </ChipRow>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="text-muted">Sort:</span>
        {RANK_SORTS.map((s) => (
          <Link
            key={s}
            href={rankingsHref(base, filters, { sort: s })}
            className={cx("flex min-h-11 items-center font-semibold", filters.sort === s ? "text-brand" : "text-muted")}
            aria-current={filters.sort === s ? "true" : undefined}
          >
            {RANK_SORT_LABELS[s]}
          </Link>
        ))}
      </div>
      {byDraft ? (
        <p className="text-xs text-muted">
          Draft rank is the commissioner&apos;s draft order (1 = picked first), set by hand in the player pool. The draft room and
          auto-pick use it. It doesn&apos;t change with projections, which are on the right.
        </p>
      ) : null}

      <Card className="px-3 py-1">
        {shown.length === 0 ? (
          <div className="py-3">
            <EmptyState title={proj.rows.length === 0 ? "No lawyers in this pool yet" : "No lawyers match"}>
              {proj.rows.length === 0
                ? "Once the commissioner adds lawyers and cases, projections show up here."
                : filters.status === "mine"
                  ? "Nobody on your team matches this position."
                  : "Try a different position or status."}
            </EmptyState>
          </div>
        ) : (
          <ul>
            {shown.map((r) => {
              const mine = r.status.kind === "rostered" && r.status.teamId === myTeamId;
              const affiliation = r.firmName ?? r.organization ?? (r.kind === "firm" ? "Law firm" : null);
              const main = byRos ? r.restOfSeason : r.projectedWeek;
              const draftPosRank = draftPos?.get(r.lawyerId);
              return (
                <li
                  key={r.lawyerId}
                  className={cx("-mx-3 flex items-start gap-3 border-b border-line px-3 py-3 last:border-b-0", mine && "bg-brand-soft")}
                >
                  <div className="flex w-12 shrink-0 flex-col items-center gap-1 pt-0.5">
                    <span className="font-display text-lg font-bold leading-none tabular-nums">
                      {byDraft && r.preseasonRank === null ? (
                        <>
                          <span aria-hidden>–</span>
                          <span className="sr-only">No draft rank</span>
                        </>
                      ) : (
                        <>
                          <span className="sr-only">{byDraft ? "Draft rank " : "Overall rank "}</span>
                          {byDraft ? r.preseasonRank : r.overallRank}
                        </>
                      )}
                    </span>
                    {byDraft ? (
                      draftPosRank ? (
                        <RankBadge position={r.position} label={`${POSITION_SHORT[r.position]}${draftPosRank}`} rank={draftPosRank} />
                      ) : (
                        <Badge tone={r.position === "firm" ? "accent" : "brand"}>{POSITION_SHORT[r.position]}</Badge>
                      )
                    ) : (
                      <RankBadge position={r.position} label={r.positionLabel} rank={r.positionRank} />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <Link href={`/leagues/${leagueId}/lawyers/${r.lawyerId}`} className="block truncate font-semibold leading-tight hover:text-brand">
                      {r.name}
                    </Link>
                    <p className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted">
                      <StatusBadge status={r.status} myTeamId={myTeamId} />
                      {affiliation ? <span className="truncate">{affiliation}</span> : null}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      Range <span className="text-ink">{projectionRangeLabel(r)}</span> · Weeks with points{" "}
                      <span className="text-ink">{activityLabel(r)}</span>
                    </p>
                    <p className="text-xs text-muted">{projectionInputsLine(r, lookback)}</p>
                    <p className="text-xs text-muted">
                      {byDraft
                        ? `Projection rank #${r.overallRank} (${r.positionLabel})`
                        : r.preseasonRank
                          ? `Draft rank #${r.preseasonRank}`
                          : "No draft rank"}
                    </p>
                  </div>
                  <div className="w-16 shrink-0 text-right">
                    <span className="block font-display text-2xl font-bold leading-none tabular-nums">{fmtProjection(main)}</span>
                    <span className="mt-1 block text-[10px] uppercase leading-tight text-muted">
                      {byRos ? "Proj. season" : complete ? "Proj. / wk" : `Proj. wk ${weeks.targetWeek}`}
                    </span>
                    {!complete ? (
                      <span className="block text-[11px] text-muted tabular-nums">
                        {byRos ? `${fmtProjection(r.projectedWeek)} / wk` : `${fmtProjection(r.restOfSeason)} season`}
                      </span>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <div className="flex items-center justify-between gap-3 text-sm text-muted">
        <span>
          Showing {shown.length} of {plural(matches.length, "lawyer")}
        </span>
        {matches.length > shown.length ? (
          <LinkButton href={rankingsHref(base, filters, { limit: filters.limit + RANK_PAGE_STEP })} variant="secondary">
            Show more
          </LinkButton>
        ) : null}
      </div>

      <Card>
        <details>
          <summary className="flex min-h-11 cursor-pointer items-center font-display text-sm font-semibold uppercase tracking-wide text-brand">
            How projections work
          </summary>
          <div className="mt-2 space-y-2 text-sm">
            <p>
              Every number comes from public court activity entered in this app and this league&apos;s scoring settings. There are no
              opinions about anyone.
            </p>
            <ul className="list-disc space-y-1.5 pl-5">
              <li>
                <strong>Own history.</strong> We score each lawyer&apos;s approved events on their <em>active</em> cases from the last{" "}
                {lookback} full weeks (preseason weeks count too). Recent weeks count more: a week from {DEFAULT_PROJECTION_OPTIONS.halfLifeWeeks} weeks
                earlier counts half as much. Weeks with no events count as 0 points.
              </li>
              <li>
                <strong>Typical rate.</strong> For each case type (civil, criminal, appeal…) we work out the average points per week
                that one active case earns across this player pool, then add that up over the lawyer&apos;s active cases. If the
                pool has no approved events yet, we use typical event frequencies with the league&apos;s point values.
              </li>
              <li>
                <strong>Mixing the two.</strong> With little history, the projection leans on the typical rate. Each week of history
                shifts it toward the lawyer&apos;s own numbers: {DEFAULT_PROJECTION_OPTIONS.ownShrinkageWeeks} weeks of history is a
                50/50 mix.
              </li>
              <li>
                <strong>Firms</strong> get each event on a case the firm or any of its lawyers is on once, times the firm multiplier
                ({ctx.settings.scoring.firmMultiplier}×).
              </li>
              <li>
                <strong>Closed cases</strong> don&apos;t count going forward, so a lawyer with no active cases is projected at 0.
                Filing points never go over the weekly filing cap.
              </li>
              <li>
                <strong>Range</strong> is a rough low–high band. It&apos;s wider with less history, and starts at 0 when at least
                1 week in 5 is expected to have no points. <strong>Weeks with points</strong> is how often a week had (or is
                expected to have) any points.
              </li>
              <li>
                <strong>Rest of season</strong> = projected weekly points × weeks left
                {complete ? " (none — the season is over)" : ` (${plural(weeks.remainingWeeks, "week")}, including week ${weeks.targetWeek})`}.
              </li>
            </ul>
            <p className="text-muted">Projections are estimates. Real points only come from approved scoring events.</p>
          </div>
        </details>
      </Card>

      {canManage && !prominentApply ? (
        <Card>
          <details>
            <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-muted">
              Commissioner: use projections as draft rankings
            </summary>
            <div className="mt-2">{applyCard}</div>
          </details>
        </Card>
      ) : null}
    </Page>
  );
}
