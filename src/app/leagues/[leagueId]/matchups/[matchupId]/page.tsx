import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { matchups, teams } from "@/db/schema";
import { Badge, Card, CardTitle, cx, LinkButton, Page, PageHeader, Points } from "@/components/ui";
import { isUuid } from "@/lib/format";
import { SLOT_LABELS, starterSlots } from "@/lib/settings";
import {
  currentWeek,
  editableWeek,
  formatDateTime,
  formatShortDate,
  isWeekLocked,
  todayIn,
  weekEndDate,
  weekLockTime,
  weekStartDate,
} from "@/lib/time";
import { getLeagueContext } from "@/server/league-context";
import { leagueClock } from "@/server/services/lineups";
import { periodTitle, playoffRoundTotal, weekState } from "@/server/services/results";
import { getScoreboard, type Scoreboard } from "@/server/services/scores";
import { getLeagueMatchups } from "@/server/services/standings";
import { leadingSide, matchupPhase, matchupScores, PhaseBadge, ScoreLine, weekRangeDates, WeekStateBadge } from "../matchup-view";

export const metadata: Metadata = { title: "Matchup" };

export default async function MatchupDetailPage({ params }: PageProps<"/leagues/[leagueId]/matchups/[matchupId]">) {
  const { leagueId, matchupId } = await params;
  const ctx = await getLeagueContext(leagueId);
  if (!isUuid(matchupId)) notFound();
  const [m] = await db
    .select()
    .from(matchups)
    .where(and(eq(matchups.id, matchupId), eq(matchups.leagueId, leagueId)));
  if (!m) notFound();

  const base = `/leagues/${leagueId}`;
  const { league, settings } = ctx;
  const tz = settings.schedule.timezone;
  const now = new Date();
  const clock = leagueClock({ seasonStart: league.seasonStart, settings });
  const week = currentWeek(now, clock);
  const today = todayIn(tz, now);

  const [teamRows, sb, all] = await Promise.all([
    db.select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.leagueId, leagueId)),
    getScoreboard(leagueId),
    // Only playoff titles need the bracket (for the round name).
    m.isPlayoff ? getLeagueMatchups(db, leagueId) : Promise.resolve([]),
  ]);
  const names = new Map(teamRows.map((t) => [t.id, t.name]));
  const s = matchupScores(m, sb, teamRows.map((t) => t.id));
  const lead = leadingSide(m, s);
  const myId = ctx.team?.id ?? null;
  const phase = matchupPhase(m, week);
  const title = periodTitle(m, playoffRoundTotal(settings.schedule, teamRows.length, all));
  // "Set my lineup" only helps in my own matchup while one of its weeks can still change.
  const inMatchup = myId !== null && (m.teamAId === myId || m.teamBId === myId);
  const canSetLineup = inMatchup && !m.isBye && !m.final && league.status !== "complete" && editableWeek(now, clock) <= m.weekEnd;

  const sides: { teamId: string; name: string }[] = [{ teamId: m.teamAId, name: names.get(m.teamAId) ?? "Team" }];
  if (m.teamBId) sides.push({ teamId: m.teamBId, name: names.get(m.teamBId) ?? "Team" });

  const weeks: number[] = [];
  for (let w = m.weekStart; w <= m.weekEnd; w++) weeks.push(w);
  const slots = starterSlots(settings.roster);

  return (
    <Page className="space-y-4 md:max-w-3xl">
      <Link href={`${base}/matchups?period=${m.period}`} className="inline-flex min-h-11 items-center text-sm font-semibold text-brand">
        ‹ All matchups
      </Link>
      <PageHeader
        title={title}
        subtitle={weekRangeDates(m.weekStart, m.weekEnd, league.seasonStart)}
        action={<PhaseBadge phase={phase} />}
      />

      <Card>
        <ScoreLine
          big
          name={<TeamLink base={base} teamId={m.teamAId} name={names.get(m.teamAId) ?? "Team"} />}
          seed={m.isPlayoff ? m.seedA : null}
          score={s.scoreA}
          leading={lead === "A"}
          isMine={m.teamAId === myId}
        />
        {m.isBye ? (
          <ScoreLine name="Bye" sub="Moves on to the next round automatically" score={null} leading={false} />
        ) : m.teamBId ? (
          <ScoreLine
            big
            name={<TeamLink base={base} teamId={m.teamBId} name={names.get(m.teamBId) ?? "Team"} />}
            seed={m.isPlayoff ? m.seedB : null}
            score={s.scoreB}
            leading={lead === "B"}
            isMine={m.teamBId === myId}
          />
        ) : (
          <ScoreLine
            big
            name="League median"
            sub={`Middle total of all ${teamRows.length} teams for these weeks`}
            score={s.scoreB}
            leading={lead === "B"}
          />
        )}
        {m.final && !m.isBye && m.isMedian ? (
          <p className="mt-2 text-sm text-muted">
            {m.winnerTeamId ? "Beat the league median for a win." : s.scoreA === s.scoreB ? "Tied the league median." : "Fell short of the league median."}
          </p>
        ) : null}
      </Card>

      {m.isBye ? (
        <p className="text-sm text-muted">Top seeds skip this round. Lineup points this round don&apos;t affect the bracket.</p>
      ) : (
        weeks.map((w) => {
          const state = weekState(w, league.seasonStart, today, sb.finalizedWeeks);
          const locked = isWeekLocked(w, now, clock);
          return (
            <section key={w} className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-lg font-semibold">
                  Week {w}{" "}
                  <span className="text-sm font-normal text-muted">
                    {formatShortDate(weekStartDate(w, league.seasonStart))} – {formatShortDate(weekEndDate(w, league.seasonStart))}
                  </span>
                </h2>
                <WeekStateBadge state={state} />
              </div>
              {!locked ? (
                <p className="text-xs text-muted">
                  Lineups can change until they lock {formatDateTime(weekLockTime(w, league.seasonStart, settings.schedule.lockTime, tz), tz)}.
                </p>
              ) : null}
              <div className={cx("grid grid-cols-1 gap-3", sides.length > 1 && "md:grid-cols-2")}>
                {sides.map((side) => (
                  <WeekLineup
                    key={side.teamId}
                    base={base}
                    sb={sb}
                    week={w}
                    teamId={side.teamId}
                    teamName={side.name}
                    slotLabels={slots.map((t) => SLOT_LABELS[t])}
                    isMine={side.teamId === myId}
                  />
                ))}
              </div>
            </section>
          );
        })
      )}

      <p className="text-center text-xs text-muted">0 = no approved court activity that week.</p>
      {canSetLineup ? (
        <div className="flex justify-center">
          <LinkButton href={`${base}/team`} variant="ghost">
            Set my lineup ›
          </LinkButton>
        </div>
      ) : null}
    </Page>
  );
}

function TeamLink({ base, teamId, name }: { base: string; teamId: string; name: string }) {
  return (
    <Link href={`${base}/teams/${teamId}`} className="hover:underline">
      {name}
    </Link>
  );
}

function WeekLineup({
  base,
  sb,
  week,
  teamId,
  teamName,
  slotLabels,
  isMine,
}: {
  base: string;
  sb: Scoreboard;
  week: number;
  teamId: string;
  teamName: string;
  slotLabels: string[];
  isMine: boolean;
}) {
  const starters = sb.starters(teamId, week);
  return (
    <Card className={cx("min-w-0 p-3", isMine && "border-brand")}>
      <CardTitle action={isMine ? <Badge tone="brand">You</Badge> : undefined}>
        <span className="wrap-anywhere">{teamName}</span>
      </CardTitle>
      <ul>
        {starters.map((lawyerId, i) => {
          const lawyer = lawyerId ? sb.lawyers.get(lawyerId) : undefined;
          const pts = lawyerId ? sb.lawyerWeek(lawyerId, week) : 0;
          return (
            <li key={i} className="flex min-h-11 items-center gap-2 border-b border-line last:border-b-0">
              <span className="w-11 shrink-0 rounded-md bg-surface-2 py-0.5 text-center text-xs font-semibold text-muted">
                {slotLabels[i] ?? "—"}
              </span>
              {lawyerId ? (
                <Link href={`${base}/lawyers/${lawyerId}`} className="flex min-h-11 min-w-0 flex-1 items-center">
                  <span className="truncate font-medium">{lawyer?.name ?? "Unknown lawyer"}</span>
                </Link>
              ) : (
                <span className="flex-1 text-sm text-muted">Empty slot</span>
              )}
              <Points value={pts} className={cx("w-12 shrink-0 text-right", pts === 0 ? "text-muted" : "font-semibold")} />
            </li>
          );
        })}
      </ul>
      <div className="mt-1 flex items-center justify-between border-t border-line pt-2 text-sm">
        <span className="text-muted">Week {week} total</span>
        <Points value={sb.teamWeek(teamId, week)} className="font-bold" />
      </div>
    </Card>
  );
}
