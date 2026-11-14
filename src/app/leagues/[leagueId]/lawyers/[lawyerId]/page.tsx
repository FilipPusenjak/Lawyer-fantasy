import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { db } from "@/db";
import { Badge, Card, CardTitle, cx, EmptyState, ListRow, Page, PageHeader, Points } from "@/components/ui";
import { fmtPoints, isUuid } from "@/lib/format";
import {
  CASE_TYPE_LABELS,
  EVENT_LABELS,
  POSITION_LABELS,
  rosterSize,
  sideLabel,
  totalSeasonWeeks,
  type EventType,
} from "@/lib/settings";
import { currentWeek, formatDate } from "@/lib/time";
import { getLeagueContext } from "@/server/league-context";
import { leagueClock } from "@/server/services/lineups";
import { getPoolLawyer, loadAvailability, loadEventDetails, loadLawyerCases, loadPendingClaimLawyerIds } from "@/server/services/players";
import { getTeamRoster } from "@/server/services/roster";
import { getScoreboard } from "@/server/services/scores";
import { dropGoesToWaivers, movesOpen } from "@/server/services/transactions-moves";
import { AddClaimButton, DropButton, MoveProvider } from "../../players/move-controls";
import { AvailabilityBadge, LawyerLink, PositionBadge } from "../../players/player-bits";
import { formatShortDay } from "../../players/player-filters";
import { barPercent, eventRows, safeHttpUrl, weeklyPoints } from "./lawyer-stats";

export const metadata: Metadata = { title: "Lawyer" };

function SourceLink({ url, children = "Public record ↗" }: { url: string | null; children?: ReactNode }) {
  const safe = safeHttpUrl(url);
  if (!safe) return null;
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center text-sm font-semibold text-accent">
      {children}
    </a>
  );
}

export default async function LawyerPage({ params }: PageProps<"/leagues/[leagueId]/lawyers/[lawyerId]">) {
  const { leagueId, lawyerId } = await params;
  const ctx = await getLeagueContext(leagueId);
  if (!isUuid(lawyerId)) notFound();
  const { league, settings, team } = ctx;
  const lawyer = await getPoolLawyer(db, league.poolId, lawyerId);
  if (!lawyer) notFound();

  const base = `/leagues/${leagueId}`;
  const tz = settings.schedule.timezone;
  const isFirm = lawyer.kind === "firm";

  const [sb, availabilityMap, myRoster, myClaims] = await Promise.all([
    getScoreboard(leagueId),
    loadAvailability(db, leagueId),
    team ? getTeamRoster(db, team.id) : Promise.resolve([]),
    team ? loadPendingClaimLawyerIds(db, team.id) : Promise.resolve(new Map<string, number>()),
  ]);

  const members = isFirm
    ? [...sb.lawyers.values()].filter((l) => l.firmId === lawyer.id).sort((a, b) => sb.lawyerTotal(b.id) - sb.lawyerTotal(a.id) || a.name.localeCompare(b.name))
    : [];
  const firm = lawyer.firmId ? sb.lawyers.get(lawyer.firmId) : undefined;
  const lines = sb.live.get(lawyer.id)?.lines ?? [];

  const [caseList, eventDetails] = await Promise.all([
    loadLawyerCases(db, league.poolId, [lawyer.id, ...members.map((m) => m.id)]),
    loadEventDetails(
      db,
      league.poolId,
      lines.map((l) => l.eventId),
    ),
  ]);
  const events = eventRows(lines, eventDetails);

  const availability = availabilityMap.get(lawyer.id);
  const canMove = movesOpen(league.status) && !!team;
  const mySpot = myRoster.find((r) => r.id === lawyer.id);
  const claimOrder = myClaims.get(lawyer.id);
  const rosterFull = myRoster.length >= rosterSize(settings.roster);
  const waiversUntil = league.nextWaiverRunAt ? formatShortDay(league.nextWaiverRunAt, tz) : null;

  const totalWeeks = totalSeasonWeeks(settings.schedule);
  const nowWeek = Math.min(Math.max(1, currentWeek(new Date(), leagueClock({ seasonStart: league.seasonStart, settings }))), totalWeeks);
  const weeks = league.status === "setup" ? [] : weeklyPoints(totalWeeks, nowWeek, (w) => sb.lawyerWeek(lawyer.id, w));
  const maxAbs = Math.max(0, ...weeks.map((w) => Math.abs(w.points)));

  let action: ReactNode = null;
  if (canMove) {
    if (mySpot) action = <DropButton lawyerId={lawyer.id} lawyerName={lawyer.name} toWaivers={dropGoesToWaivers(mySpot, new Date())} />;
    else if (availability.kind === "free_agent") action = <AddClaimButton lawyerId={lawyer.id} lawyerName={lawyer.name} mode="add" />;
    else if (availability.kind === "waivers" && claimOrder === undefined)
      action = <AddClaimButton lawyerId={lawyer.id} lawyerName={lawyer.name} mode="claim" />;
  }

  return (
    <Page className="space-y-4">
      <PageHeader title={lawyer.name} subtitle={POSITION_LABELS[lawyer.position]} />

      <Card className="space-y-3">
        <div className="flex items-center gap-2 text-sm">
          <PositionBadge position={lawyer.position} />
          <span className="min-w-0 truncate text-muted">
            {firm ? (
              <Link href={`${base}/lawyers/${firm.id}`} className="font-semibold text-brand">
                {firm.name}
              </Link>
            ) : (
              (lawyer.organization ?? (isFirm ? "Law firm" : "No organization listed"))
            )}
          </span>
        </div>

        <MoveProvider
          leagueId={leagueId}
          dropOptions={myRoster.map((r) => ({ id: r.id, name: r.name, position: r.position }))}
          rosterFull={rosterFull}
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <div className="min-w-0 flex-1 text-sm">
              {availability.kind === "rostered" && availability.teamId !== team?.id ? (
                <>
                  On{" "}
                  <Link href={`${base}/teams/${availability.teamId}`} className="font-semibold text-brand">
                    {availability.teamName}
                  </Link>
                </>
              ) : (
                <span className="flex flex-wrap items-center gap-1.5">
                  <AvailabilityBadge availability={availability} myTeamId={team?.id ?? null} waiversUntil={waiversUntil} />
                  {claimOrder !== undefined ? (
                    <Link href={`${base}/waivers`} className="font-semibold text-accent">
                      Your claim #{claimOrder} ›
                    </Link>
                  ) : null}
                </span>
              )}
            </div>
            {action}
          </div>
        </MoveProvider>

        <div className="grid grid-cols-2 gap-3 border-t border-line pt-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Season points</p>
            <Points value={sb.lawyerTotal(lawyer.id)} className="text-3xl font-bold" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Preseason rank</p>
            <p className="font-display text-3xl font-bold">{lawyer.preseasonRank ?? "–"}</p>
          </div>
        </div>
      </Card>

      {weeks.length > 0 ? (
        <Card>
          <CardTitle>Points by week</CardTitle>
          <ul className="space-y-1.5">
            {weeks.map((w) => (
              <li key={w.week} className="flex items-center gap-3 text-sm">
                <span className={cx("w-16 shrink-0", w.isCurrent ? "font-semibold" : "text-muted")}>
                  Wk {w.week}
                  {w.isCurrent ? " ·now" : ""}
                </span>
                <span className="h-3 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-2" aria-hidden>
                  <span
                    className={cx("block h-full rounded-full", w.points < 0 ? "bg-neg" : "bg-brand")}
                    style={{ width: `${barPercent(w.points, maxAbs)}%` }}
                  />
                </span>
                <Points value={w.points} signed className="w-12 shrink-0 text-right font-semibold" />
              </li>
            ))}
          </ul>
          {weeks.every((w) => w.points === 0) ? <p className="mt-2 text-sm text-muted">No points yet this season.</p> : null}
        </Card>
      ) : null}

      {isFirm ? (
        <Card>
          <CardTitle>Lawyers at this firm ({members.length})</CardTitle>
          {members.length === 0 ? (
            <EmptyState title="No lawyers listed">The firm still scores from its own cases.</EmptyState>
          ) : (
            <div>
              {members.map((m) => (
                <ListRow key={m.id}>
                  <PositionBadge position={m.position} />
                  <LawyerLink leagueId={leagueId} id={m.id} name={m.name} className="min-w-0 flex-1 truncate" />
                  <Points value={sb.lawyerTotal(m.id)} className="font-semibold" />
                </ListRow>
              ))}
            </div>
          )}
          <p className="mt-2 text-xs text-muted">
            Firms score {fmtPoints(settings.scoring.firmMultiplier)}× each event on their lawyers&apos; cases (once per event).
          </p>
        </Card>
      ) : null}

      <Card>
        <CardTitle>Cases ({caseList.length})</CardTitle>
        {caseList.length === 0 ? (
          <EmptyState title="No cases yet">Cases show up here once the commissioner adds them.</EmptyState>
        ) : (
          <ul>
            {caseList.map((c) => (
              <li key={c.id} className="border-b border-line py-3 last:border-b-0">
                <p className="font-semibold leading-snug">{c.caption}</p>
                <p className="mt-0.5 text-sm text-muted">
                  {c.court}
                  {c.docketNumber ? ` · No. ${c.docketNumber}` : ""}
                  {c.filedOn ? ` · Filed ${formatDate(c.filedOn)}` : ""}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <Badge>{CASE_TYPE_LABELS[c.caseType]}</Badge>
                  <Badge tone={c.status === "active" ? "pos" : "neutral"}>{c.status === "active" ? "Active" : "Closed"}</Badge>
                  {c.appearances.map((a) => (
                    <Badge key={a.lawyerId} tone="accent">
                      {sideLabel(c.caseType, a.side)}
                      {a.lawyerId !== lawyer.id ? ` · ${a.lawyerName}` : ""}
                    </Badge>
                  ))}
                </div>
                <SourceLink url={c.sourceUrl} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardTitle>Scoring events ({events.length})</CardTitle>
        {events.length === 0 ? (
          <EmptyState title="No scoring events yet">Points show up after the commissioner approves events from public records.</EmptyState>
        ) : (
          <ul>
            {events.map(({ line, event }) => (
              <li key={line.eventId} className="border-b border-line py-3 last:border-b-0">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold leading-snug">{EVENT_LABELS[event.type as EventType] ?? event.type}</p>
                    <p className="mt-0.5 text-xs text-muted">
                      {formatDate(event.occurredOn)} · Week {line.week}
                      {line.viaFirm ? ` · via firm (${fmtPoints(settings.scoring.firmMultiplier)}×)` : ""}
                    </p>
                  </div>
                  <Points value={line.points} signed className="shrink-0 text-xl font-bold" />
                </div>
                {event.caseCaption ? <p className="mt-1 text-sm">{event.caseCaption}</p> : null}
                <p className="mt-1 text-sm text-muted">{event.summary}</p>
                <SourceLink url={event.sourceUrl ?? event.caseSourceUrl} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <p className="text-center text-xs text-muted">
        Facts come from public court records. Points use this league&apos;s scoring settings.
      </p>
    </Page>
  );
}
