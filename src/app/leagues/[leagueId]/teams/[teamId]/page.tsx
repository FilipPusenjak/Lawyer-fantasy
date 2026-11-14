import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { Badge, Card, CardTitle, EmptyState, LinkButton, ListRow, Page, PageHeader, Points } from "@/components/ui";
import { fmtRecord, isUuid } from "@/lib/format";
import { rosterSize, starterSlots, totalSeasonWeeks } from "@/lib/settings";
import { currentWeek, editableWeek, isWeekLocked } from "@/lib/time";
import { getLeagueContext } from "@/server/league-context";
import { leagueClock } from "@/server/services/lineups";
import { loadLeagueTeams } from "@/server/services/players";
import { getTeamRoster } from "@/server/services/roster";
import { getScoreboard } from "@/server/services/scores";
import { getStandings } from "@/server/services/standings";
import { movesOpen } from "@/server/services/transactions-moves";
import { LawyerLink, PositionBadge } from "../../players/player-bits";
import { newTradeHref } from "@/app/leagues/[leagueId]/trades/trade-labels";
import { parseWeekParam } from "../../team/lineup-model";
import { LineupView, WeekPicker } from "../../team/lineup-view";

export const metadata: Metadata = { title: "Team" };

export default async function TeamPage({ params, searchParams }: PageProps<"/leagues/[leagueId]/teams/[teamId]">) {
  const { leagueId, teamId } = await params;
  const sp = await searchParams;
  const ctx = await getLeagueContext(leagueId);
  if (!isUuid(teamId)) notFound();
  const { league, settings } = ctx;
  const base = `/leagues/${leagueId}`;

  const [teamList, roster, standings] = await Promise.all([
    loadLeagueTeams(db, leagueId),
    getTeamRoster(db, teamId),
    getStandings(db, leagueId),
  ]);
  const team = teamList.find((t) => t.id === teamId);
  if (!team) notFound();
  const isMine = ctx.team?.id === team.id;
  const record = standings.find((s) => s.teamId === team.id);
  const maxRoster = rosterSize(settings.roster);

  const action = isMine ? (
    <LinkButton href={`${base}/team`} variant="secondary">
      My team
    </LinkButton>
  ) : movesOpen(league.status) && ctx.team ? (
    <LinkButton href={newTradeHref(leagueId, { withTeamId: team.id })} variant="secondary">
      Propose trade
    </LinkButton>
  ) : null;

  const subtitle = [team.ownerName, record && league.status !== "setup" ? `${fmtRecord(record.wins, record.losses, record.ties)} · #${record.rank}` : null]
    .filter(Boolean)
    .join(" · ");

  if (league.status === "setup") {
    return (
      <Page className="space-y-4">
        <PageHeader title={team.name} subtitle={subtitle} action={action} />
        <EmptyState title="No lawyers yet">Rosters fill up on draft day.</EmptyState>
      </Page>
    );
  }

  const now = new Date();
  const clock = leagueClock({ seasonStart: league.seasonStart, settings });
  const totalWeeks = totalSeasonWeeks(settings.schedule);
  const maxWeek = Math.max(1, Math.min(editableWeek(now, clock), totalWeeks));
  const defaultWeek = Math.min(Math.max(1, currentWeek(now, clock)), maxWeek);
  const week = parseWeekParam(sp.week, 1, maxWeek) ?? defaultWeek;

  const sb = await getScoreboard(leagueId);
  const slots = starterSlots(settings.roster);
  const starters = sb.starters(team.id, week);
  const starting = new Set(starters.filter((x): x is string => !!x));
  const lockState = sb.finalizedWeeks.has(week) ? "Final" : isWeekLocked(week, now, clock) ? "Locked" : "Can still change";

  return (
    <Page className="space-y-4">
      <PageHeader title={team.name} subtitle={subtitle} action={action} />
      <WeekPicker basePath={`${base}/teams/${team.id}`} week={week} min={1} max={maxWeek} seasonStart={league.seasonStart} />

      <Card>
        <CardTitle action={<Badge tone={lockState === "Final" ? "pos" : "neutral"}>{lockState}</Badge>}>Week {week} lineup</CardTitle>
        <LineupView
          leagueId={leagueId}
          rows={slots.map((slot, i) => {
            const id = starters[i];
            const l = id ? sb.lawyers.get(id) : undefined;
            return { slot, lawyer: l ? { id: l.id, name: l.name, position: l.position } : null, points: id ? sb.lawyerWeek(id, week) : 0 };
          })}
          total={sb.teamWeek(team.id, week)}
          totalLabel={`Week ${week} total`}
        />
      </Card>

      <Card>
        <CardTitle action={<span className="text-xs text-muted">Season pts</span>}>
          Roster ({roster.length}/{maxRoster})
        </CardTitle>
        {roster.length === 0 ? (
          <EmptyState title="No lawyers on this roster" />
        ) : (
          <div>
            {roster.map((r) => (
              <ListRow key={r.id} className="relative">
                <PositionBadge position={r.position} />
                <div className="min-w-0 flex-1">
                  <LawyerLink leagueId={leagueId} id={r.id} name={r.name} className="block truncate" stretch />
                  {r.organization ? <p className="truncate text-xs text-muted">{r.organization}</p> : null}
                </div>
                {starting.has(r.id) ? <Badge tone="brand">Starter</Badge> : <Badge>Bench</Badge>}
                <Points value={sb.lawyerTotal(r.id)} className="w-12 text-right font-semibold" />
              </ListRow>
            ))}
          </div>
        )}
      </Card>
    </Page>
  );
}
