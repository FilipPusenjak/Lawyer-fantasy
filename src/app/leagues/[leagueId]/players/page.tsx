import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { db } from "@/db";
import { Badge, Button, Card, cx, EmptyState, Input, LinkButton, Notice, Page, PageHeader, Points } from "@/components/ui";
import { plural } from "@/lib/format";
import { POSITION_SHORT, POSITIONS, rosterSize } from "@/lib/settings";
import { getLeagueContext } from "@/server/league-context";
import { loadAvailability, loadPendingClaimLawyerIds } from "@/server/services/players";
import { getTeamRoster } from "@/server/services/roster";
import { getScoreboard } from "@/server/services/scores";
import { dropGoesToWaivers, movesClosedReason, movesOpen } from "@/server/services/transactions-moves";
import { AddClaimButton, DropButton, MoveProvider } from "./move-controls";
import { AvailabilityBadge, LawyerLink, PositionBadge } from "./player-bits";
import {
  filterPlayers,
  formatShortDay,
  PAGE_STEP,
  parsePlayerFilters,
  playersHref,
  SORT_LABELS,
  SORTS,
  STATUS_FILTER_LABELS,
  STATUS_FILTERS,
  type ListItem,
} from "./player-filters";

export const metadata: Metadata = { title: "Lawyers" };

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

export default async function PlayersPage({ params, searchParams }: PageProps<"/leagues/[leagueId]/players">) {
  const { leagueId } = await params;
  const filters = parsePlayerFilters(await searchParams);
  const ctx = await getLeagueContext(leagueId);
  const { league, settings, team } = ctx;
  const base = `/leagues/${leagueId}/players`;
  const tz = settings.schedule.timezone;

  const [sb, availability, myRoster, myClaims] = await Promise.all([
    getScoreboard(leagueId),
    loadAvailability(db, leagueId),
    team ? getTeamRoster(db, team.id) : Promise.resolve([]),
    team ? loadPendingClaimLawyerIds(db, team.id) : Promise.resolve(new Map<string, number>()),
  ]);

  const canMove = movesOpen(league.status) && !!team;
  const closedReason = movesClosedReason(league.status);
  const maxRoster = rosterSize(settings.roster);
  const rosterFull = myRoster.length >= maxRoster;
  const waiversUntil = league.nextWaiverRunAt ? formatShortDay(league.nextWaiverRunAt, tz) : null;
  const now = new Date();
  const mySpots = new Map(myRoster.map((r) => [r.id, r]));

  const items = [...sb.lawyers.values()].map((l) => {
    const firm = l.firmId ? sb.lawyers.get(l.firmId) : undefined;
    const a = availability.get(l.id);
    return {
      id: l.id,
      name: l.name,
      kind: l.kind,
      position: l.position,
      organization: firm?.name ?? l.organization,
      preseasonRank: l.preseasonRank,
      seasonPoints: sb.lawyerTotal(l.id),
      availability: a,
      searchText: l.organization ?? "",
    } satisfies ListItem & { kind: string };
  });
  const matches = filterPlayers(items, filters);
  const shown = matches.slice(0, filters.limit);

  return (
    <Page className="space-y-3">
      <PageHeader
        title="Lawyers"
        subtitle={team ? `Your roster: ${myRoster.length}/${maxRoster}${rosterFull ? " (full)" : ""}` : undefined}
        action={
          team && movesOpen(league.status) ? (
            <LinkButton href={`/leagues/${leagueId}/waivers`} variant="secondary">
              {myClaims.size ? `Claims (${myClaims.size})` : "Waivers"}
            </LinkButton>
          ) : null
        }
      />

      {league.status === "setup" || league.status === "drafting" ? (
        <Notice>
          Draft hasn&apos;t happened yet, so this list is view-only.{" "}
          <Link href={`/leagues/${leagueId}/draft`} className="font-semibold text-brand">
            Go to the draft room
          </Link>
        </Notice>
      ) : closedReason ? (
        <Notice>{closedReason}</Notice>
      ) : null}

      <form action={base} method="get" className="flex gap-2" role="search">
        {filters.position !== "all" ? <input type="hidden" name="pos" value={filters.position} /> : null}
        {filters.status !== "available" ? <input type="hidden" name="status" value={filters.status} /> : null}
        {filters.sort !== "points" ? <input type="hidden" name="sort" value={filters.sort} /> : null}
        <Input
          type="search"
          name="q"
          defaultValue={filters.q}
          placeholder="Search name, firm or office"
          aria-label="Search lawyers"
          maxLength={60}
          className="flex-1"
        />
        <Button type="submit" variant="secondary" className="px-3">
          Search
        </Button>
      </form>

      <ChipRow label="Filter by position">
        {(["all", ...POSITIONS] as const).map((p) => (
          <Chip key={p} href={playersHref(base, filters, { position: p })} active={filters.position === p}>
            {p === "all" ? "All" : POSITION_SHORT[p]}
          </Chip>
        ))}
      </ChipRow>
      <ChipRow label="Filter by status">
        {STATUS_FILTERS.map((s) => (
          <Chip key={s} href={playersHref(base, filters, { status: s })} active={filters.status === s}>
            {STATUS_FILTER_LABELS[s]}
          </Chip>
        ))}
      </ChipRow>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="text-muted">Sort:</span>
        {SORTS.map((s) => (
          <Link
            key={s}
            href={playersHref(base, filters, { sort: s })}
            className={cx("flex min-h-11 items-center font-semibold", filters.sort === s ? "text-brand" : "text-muted")}
            aria-current={filters.sort === s ? "true" : undefined}
          >
            {SORT_LABELS[s]}
          </Link>
        ))}
      </div>

      <Card className="px-3 py-1">
        {shown.length === 0 ? (
          <div className="py-3">
            <EmptyState title="No lawyers match">
              {filters.q ? "Try a different search, position or status." : "Try a different position or status."}
            </EmptyState>
          </div>
        ) : (
          <MoveProvider
            leagueId={leagueId}
            dropOptions={myRoster.map((r) => ({ id: r.id, name: r.name, position: r.position }))}
            rosterFull={rosterFull}
          >
            <ul>
              {shown.map((p) => {
                const a = p.availability;
                const mine = a.kind === "rostered" && a.teamId === team?.id;
                const claimOrder = myClaims.get(p.id);
                const spot = mySpots.get(p.id);
                return (
                  <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line py-2.5 last:border-b-0">
                    <div className="min-w-0 flex-1">
                      <LawyerLink leagueId={leagueId} id={p.id} name={p.name} className="block truncate leading-tight" />
                      <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted">
                        <PositionBadge position={p.position} />
                        <span className="truncate">{p.organization ?? (p.kind === "firm" ? "Law firm" : "")}</span>
                      </p>
                      <p className="mt-1 flex flex-wrap items-center gap-1.5">
                        <AvailabilityBadge availability={a} myTeamId={team?.id ?? null} waiversUntil={waiversUntil} />
                        {claimOrder !== undefined ? <Badge tone="accent">Your claim #{claimOrder}</Badge> : null}
                      </p>
                    </div>
                    <div className="w-12 shrink-0 text-right">
                      <Points value={p.seasonPoints} className="block text-lg font-semibold leading-tight" />
                      <span className="text-[10px] uppercase text-muted">pts</span>
                    </div>
                    {canMove ? (
                      a.kind === "free_agent" ? (
                        <AddClaimButton lawyerId={p.id} lawyerName={p.name} mode="add" />
                      ) : a.kind === "waivers" && claimOrder === undefined ? (
                        <AddClaimButton lawyerId={p.id} lawyerName={p.name} mode="claim" />
                      ) : mine && spot ? (
                        <DropButton lawyerId={p.id} lawyerName={p.name} toWaivers={dropGoesToWaivers(spot, now)} />
                      ) : null
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </MoveProvider>
        )}
      </Card>

      <div className="flex items-center justify-between gap-3 text-sm text-muted">
        <span>
          Showing {shown.length} of {plural(matches.length, "lawyer")}
        </span>
        {matches.length > shown.length ? (
          <LinkButton href={playersHref(base, filters, { limit: filters.limit + PAGE_STEP })} variant="secondary">
            Show more
          </LinkButton>
        ) : null}
      </div>
    </Page>
  );
}
