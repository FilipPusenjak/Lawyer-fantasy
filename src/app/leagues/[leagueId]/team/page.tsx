import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/db";
import { Badge, Card, CardTitle, EmptyState, LinkButton, ListRow, Notice, Page, PageHeader, Points } from "@/components/ui";
import { sanitizeLineup } from "@/lib/lineup";
import { fmtRecord, plural } from "@/lib/format";
import { rosterSize, starterSlots, totalSeasonWeeks } from "@/lib/settings";
import { editableWeek, formatDateTime, isWeekLocked, weekLockTime } from "@/lib/time";
import { getLeagueContext } from "@/server/league-context";
import { leagueClock } from "@/server/services/lineups";
import { loadPendingClaims } from "@/server/services/players";
import { getTeamRoster } from "@/server/services/roster";
import { getScoreboard } from "@/server/services/scores";
import { getStandings } from "@/server/services/standings";
import { dropGoesToWaivers, movesOpen } from "@/server/services/transactions-moves";
import { LawyerLink, PositionBadge } from "../players/player-bits";
import { DropButton, MoveProvider } from "../players/move-controls";
import { LineupEditor } from "./lineup-editor";
import { parseWeekParam } from "./lineup-model";
import { LineupView, WeekPicker } from "./lineup-view";

export const metadata: Metadata = { title: "My team" };

export default async function MyTeamPage({ params, searchParams }: PageProps<"/leagues/[leagueId]/team">) {
  const { leagueId } = await params;
  const sp = await searchParams;
  const ctx = await getLeagueContext(leagueId);
  const { league, settings, team } = ctx;
  const base = `/leagues/${leagueId}`;

  if (!team) {
    return (
      <Page>
        <PageHeader title="My team" />
        <EmptyState title="You don't have a team in this league">Ask your commissioner if you think this is a mistake.</EmptyState>
      </Page>
    );
  }

  if (league.status === "setup" || league.status === "drafting") {
    const live = league.status === "drafting";
    return (
      <Page className="space-y-4">
        <PageHeader title={team.name} subtitle="Your roster fills up on draft day." />
        <EmptyState title={live ? "The draft is live!" : "No lawyers yet"}>
          {live ? "Head to the draft room to make your picks." : "Once the draft is done, your lawyers and lineup show up here."}
        </EmptyState>
        <LinkButton href={`${base}/draft`} className="w-full">
          {live ? "Enter the draft room" : "Go to the draft room"}
        </LinkButton>
      </Page>
    );
  }

  const now = new Date();
  const clock = leagueClock({ seasonStart: league.seasonStart, settings });
  const totalWeeks = totalSeasonWeeks(settings.schedule);
  const editable = editableWeek(now, clock);
  const maxWeek = Math.max(1, Math.min(editable, totalWeeks));
  const week = parseWeekParam(sp.week, 1, maxWeek) ?? maxWeek;
  const canEdit = movesOpen(league.status) && week === editable && !isWeekLocked(week, now, clock);

  const [sb, roster, standings, claims] = await Promise.all([
    getScoreboard(leagueId),
    getTeamRoster(db, team.id),
    getStandings(db, leagueId),
    loadPendingClaims(db, leagueId, team.id),
  ]);
  const slots = starterSlots(settings.roster);
  const maxRoster = rosterSize(settings.roster);
  const record = standings.find((s) => s.teamId === team.id);
  const canMove = movesOpen(league.status);
  const tz = settings.schedule.timezone;

  const players = roster.map((r) => ({
    id: r.id,
    name: r.name,
    position: r.position,
    preseasonRank: r.preseasonRank,
    weekPoints: sb.lawyerWeek(r.id, week),
    seasonPoints: sb.lawyerTotal(r.id),
  }));
  const rawStarters = sb.starters(team.id, week);

  const subtitle = [
    record ? `${fmtRecord(record.wins, record.losses, record.ties)} · #${record.rank}` : null,
    `${roster.length}/${maxRoster} on roster`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Page className="space-y-4">
      <PageHeader
        title={team.name}
        subtitle={subtitle}
        action={
          <LinkButton href={`${base}/players`} variant="secondary">
            Find lawyers
          </LinkButton>
        }
      />
      <WeekPicker basePath={`${base}/team`} week={week} min={1} max={maxWeek} seasonStart={league.seasonStart} />

      {canEdit ? (
        <>
          <Notice>
            Locks <span className="font-semibold">{formatDateTime(weekLockTime(week, clock.seasonStart, clock.lockTime, clock.timeZone), tz)}</span>.
            Lawyers with no court activity that week score 0.
          </Notice>
          <LineupEditor
            key={`${week}:${players.map((p) => p.id).join(",")}`}
            leagueId={leagueId}
            week={week}
            roster={settings.roster}
            slots={slots}
            players={players}
            initial={sanitizeLineup(rawStarters, settings.roster, roster)}
          />
        </>
      ) : (
        <Card>
          <CardTitle action={<Badge tone={sb.finalizedWeeks.has(week) ? "pos" : "neutral"}>{sb.finalizedWeeks.has(week) ? "Final" : "Locked"}</Badge>}>
            Week {week} lineup
          </CardTitle>
          <LineupView
            leagueId={leagueId}
            rows={slots.map((slot, i) => {
              const id = rawStarters[i];
              const l = id ? sb.lawyers.get(id) : undefined;
              return {
                slot,
                lawyer: l ? { id: l.id, name: l.name, position: l.position } : null,
                points: id ? sb.lawyerWeek(id, week) : 0,
              };
            })}
            total={sb.teamWeek(team.id, week)}
            totalLabel={`Week ${week} total`}
          />
          {league.status === "complete" ? (
            <p className="mt-3 text-sm text-muted">The season is over. Thanks for playing!</p>
          ) : (
            <p className="mt-3 text-sm text-muted">This week is locked, so the lineup can&apos;t change.</p>
          )}
        </Card>
      )}

      <Card>
        <CardTitle action={<span className="text-xs text-muted">Season pts</span>}>
          Roster ({roster.length}/{maxRoster})
        </CardTitle>
        {roster.length === 0 ? (
          <EmptyState title="No lawyers on your roster">
            <Link href={`${base}/players`} className="font-semibold text-brand">
              Add some from the lawyer pool
            </Link>
          </EmptyState>
        ) : (
          <MoveProvider leagueId={leagueId} dropOptions={[]} rosterFull={roster.length >= maxRoster}>
            <div>
              {roster.map((r) => (
                <ListRow key={r.id}>
                  <PositionBadge position={r.position} />
                  <div className="min-w-0 flex-1">
                    <LawyerLink leagueId={leagueId} id={r.id} name={r.name} className="block truncate" />
                    {r.organization ? <p className="truncate text-xs text-muted">{r.organization}</p> : null}
                  </div>
                  <Points value={sb.lawyerTotal(r.id)} className="font-semibold" />
                  {canMove ? <DropButton lawyerId={r.id} lawyerName={r.name} toWaivers={dropGoesToWaivers(r, now)} /> : null}
                </ListRow>
              ))}
            </div>
          </MoveProvider>
        )}
      </Card>

      {canMove ? (
        <Card>
          <ListRow href={`${base}/waivers`}>
            <div className="min-w-0 flex-1">
              <p className="font-semibold">Waiver claims</p>
              <p className="text-sm text-muted">{claims.length ? `${plural(claims.length, "pending claim")}` : "No pending claims"}</p>
            </div>
            <span className="text-muted" aria-hidden>
              ›
            </span>
          </ListRow>
        </Card>
      ) : null}
    </Page>
  );
}
