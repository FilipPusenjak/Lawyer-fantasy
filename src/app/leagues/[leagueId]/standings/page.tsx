import type { Metadata } from "next";
import Link from "next/link";
import { Fragment } from "react";
import { db } from "@/db";
import type { Matchup } from "@/db/schema";
import { Badge, Card, CardTitle, cx, EmptyState, Page, PageHeader, Points } from "@/components/ui";
import { fmtRecord } from "@/lib/format";
import { playoffRoundWeeks } from "@/lib/schedule";
import { playoffRounds, type LeagueSettings } from "@/lib/settings";
import { currentWeek } from "@/lib/time";
import { getLeagueContext } from "@/server/league-context";
import { leagueClock } from "@/server/services/lineups";
import { bracketRoundCount, playoffRoundName, playoffRoundRef, weekRangeLabel } from "@/server/services/results";
import { getScoreboard } from "@/server/services/scores";
import { getLeagueMatchups, getStandings, type StandingWithTeam } from "@/server/services/standings";
import { leadingSide, matchupPhase, matchupScores, PhaseBadge, ScoreLine, weekRangeDates } from "../matchups/matchup-view";

export const metadata: Metadata = { title: "Standings" };

const STATUS_SUBTITLES: Record<"setup" | "drafting" | "in_season" | "playoffs" | "complete", string> = {
  setup: "Records start once the season begins.",
  drafting: "Records start once the season begins.",
  in_season: "Regular season",
  playoffs: "The regular season is done. Playoffs are on!",
  complete: "Final standings",
};

export default async function StandingsPage({ params }: PageProps<"/leagues/[leagueId]/standings">) {
  const { leagueId } = await params;
  const ctx = await getLeagueContext(leagueId);
  const { league, settings } = ctx;
  const base = `/leagues/${leagueId}`;

  const [standings, all] = await Promise.all([getStandings(db, leagueId), getLeagueMatchups(db, leagueId)]);
  const playoff = all.filter((m) => m.isPlayoff);
  const myId = ctx.team?.id ?? null;
  const cut = settings.schedule.playoffTeams >= 2 ? Math.min(settings.schedule.playoffTeams, standings.length) : 0;
  const hasMedianGames = all.some((m) => !m.isPlayoff && m.isMedian);
  const champion = findChampion(league.status, playoff, standings);

  return (
    <Page className="space-y-4">
      <PageHeader title="Standings" subtitle={STATUS_SUBTITLES[league.status]} />

      {champion ? (
        <Card className="text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-accent">
            {playoff.length > 0 ? "League champion" : "Regular-season champion"}
          </p>
          <p className="mt-1 font-display text-2xl font-bold uppercase">{champion.team.name}</p>
          {champion.teamId === myId ? <p className="mt-1 text-sm font-semibold text-pos">That&apos;s you. Congrats!</p> : null}
        </Card>
      ) : null}

      {playoff.length > 0 ? (
        <Bracket base={base} leagueId={leagueId} playoff={playoff} standings={standings} myId={myId} seasonStart={league.seasonStart} settings={settings} />
      ) : null}

      <Card>
        <CardTitle>Regular season</CardTitle>
        {standings.length === 0 ? (
          <EmptyState title="No teams yet" />
        ) : (
          <table className="w-full table-fixed text-sm">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th className="w-8 pb-1 font-medium">#</th>
                <th className="pb-1 font-medium">Team</th>
                <th className="w-14 pb-1 text-right font-medium">W-L</th>
                <th className="w-14 pb-1 text-right font-medium">PF</th>
                <th className="w-14 pb-1 text-right font-medium">PA</th>
              </tr>
            </thead>
            <tbody>
              {standings.map((r, i) => {
                const mine = r.teamId === myId;
                return (
                  <Fragment key={r.teamId}>
                    {cut > 0 && cut < standings.length && i === cut ? (
                      <tr aria-label="Playoff cut line">
                        <td colSpan={5} className="py-1">
                          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-accent">
                            <span className="flex-1 border-t border-dashed border-accent" />
                            Playoff line
                            <span className="flex-1 border-t border-dashed border-accent" />
                          </div>
                        </td>
                      </tr>
                    ) : null}
                    <tr className={cx("border-t border-line", mine && "bg-brand-soft")}>
                      <td className="pl-1 tabular-nums text-muted">{r.rank}</td>
                      <td>
                        <Link href={`${base}/teams/${r.teamId}`} className="flex min-h-11 min-w-0 items-center gap-1.5">
                          <span className={cx("truncate", mine ? "font-bold" : "font-semibold")}>{r.team.name}</span>
                          {mine ? <Badge tone="brand">You</Badge> : null}
                        </Link>
                      </td>
                      <td className="text-right tabular-nums">{fmtRecord(r.wins, r.losses, r.ties)}</td>
                      <td className="text-right">
                        <Points value={r.pointsFor} />
                      </td>
                      <td className="pr-1 text-right text-muted">
                        <Points value={r.pointsAgainst} />
                      </td>
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
        <div className="mt-3 space-y-1 text-xs text-muted">
          {cut > 0 ? (
            <p>
              Top {cut} make the playoffs ({weekRangeLabel(playoffRoundWeeks(1, settings.schedule).weekStart, playoffRoundWeeks(playoffRounds(cut), settings.schedule).weekEnd)}).
            </p>
          ) : (
            <p>No playoffs this season: the best record wins.</p>
          )}
          <p>Ties are broken by record, then points for (PF), then head-to-head, then fewest points against (PA).</p>
          {hasMedianGames ? <p>With an odd number of teams, one team each matchup plays the league median for a win or loss.</p> : null}
          <p>Only final matchups count. Live ones are added when the commissioner finalizes their weeks.</p>
        </div>
      </Card>
    </Page>
  );
}

function findChampion(status: string, playoff: Matchup[], standings: StandingWithTeam[]): StandingWithTeam | null {
  if (status !== "complete") return null;
  if (playoff.length === 0) return standings[0] ?? null;
  const lastRound = Math.max(...playoff.map((m) => m.playoffRound ?? 1));
  const finals = playoff.filter((m) => (m.playoffRound ?? 1) === lastRound);
  if (finals.length !== 1 || !finals[0].final || !finals[0].winnerTeamId) return null;
  return standings.find((s) => s.teamId === finals[0].winnerTeamId) ?? null;
}

async function Bracket({
  base,
  leagueId,
  playoff,
  standings,
  myId,
  seasonStart,
  settings,
}: {
  base: string;
  leagueId: string;
  playoff: Matchup[];
  standings: StandingWithTeam[];
  myId: string | null;
  seasonStart: string;
  settings: LeagueSettings;
}) {
  const week = currentWeek(new Date(), leagueClock({ seasonStart, settings }));
  const names = new Map(standings.map((s) => [s.teamId, s.team.name]));
  const teamIds = standings.map((s) => s.teamId);
  const needsLive = playoff.some((m) => !m.final && !m.isBye);
  const sb = needsLive ? await getScoreboard(leagueId) : null;

  const byRound = new Map<number, Matchup[]>();
  for (const m of playoff) {
    const r = m.playoffRound ?? 1;
    byRound.set(r, [...(byRound.get(r) ?? []), m]);
  }
  for (const ms of byRound.values()) ms.sort((a, b) => (a.bracketSlot ?? 0) - (b.bracketSlot ?? 0));
  const totalRounds = Math.max(bracketRoundCount(byRound.get(1)?.length ?? 0), ...byRound.keys());

  const rounds: number[] = [];
  for (let r = 1; r <= totalRounds; r++) rounds.push(r);

  return (
    <Card>
      <CardTitle>Playoff bracket</CardTitle>
      <div className="space-y-5">
        {rounds.map((r) => {
          const ms = byRound.get(r);
          const weeks = ms?.[0] ?? playoffRoundWeeks(r, settings.schedule);
          return (
            <section key={r} className="space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="font-semibold uppercase tracking-wide">{playoffRoundName(r, totalRounds)}</h3>
                <span className="text-xs text-muted">
                  {weekRangeLabel(weeks.weekStart, weeks.weekEnd)} · {weekRangeDates(weeks.weekStart, weeks.weekEnd, seasonStart)}
                </span>
              </div>
              {ms ? (
                ms.map((m) => {
                  const s = matchupScores(m, sb, teamIds);
                  const lead = leadingSide(m, s);
                  const phase = matchupPhase(m, week);
                  const mine = myId !== null && (m.teamAId === myId || m.teamBId === myId);
                  return (
                    <Link
                      key={m.id}
                      href={`${base}/matchups/${m.id}`}
                      className={cx(
                        "block rounded-xl border bg-surface-2 px-3 py-1 active:scale-[0.99]",
                        mine ? "border-brand" : "border-line",
                      )}
                    >
                      <ScoreLine
                        name={names.get(m.teamAId) ?? "Team"}
                        seed={m.seedA}
                        score={s.scoreA}
                        leading={lead === "A" && phase !== "upcoming"}
                        isMine={m.teamAId === myId}
                      />
                      {m.isBye || !m.teamBId ? (
                        <ScoreLine name="Bye" sub="Moves on automatically" score={null} leading={false} />
                      ) : (
                        <ScoreLine
                          name={names.get(m.teamBId) ?? "Team"}
                          seed={m.seedB}
                          score={s.scoreB}
                          leading={lead === "B" && phase !== "upcoming"}
                          isMine={m.teamBId === myId}
                        />
                      )}
                      {phase !== "bye" ? (
                        <div className="pb-1">
                          <PhaseBadge phase={phase} />
                        </div>
                      ) : null}
                    </Link>
                  );
                })
              ) : (
                <p className="rounded-xl border border-dashed border-line px-3 py-3 text-sm text-muted">
                  Winners of {playoffRoundRef(r - 1, totalRounds)} meet here.
                </p>
              )}
            </section>
          );
        })}
      </div>
    </Card>
  );
}
