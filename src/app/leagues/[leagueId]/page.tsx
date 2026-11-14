import type { Metadata } from "next";
import Link from "next/link";
import { and, asc, count, eq } from "drizzle-orm";
import { db } from "@/db";
import { drafts, teams, trades, users, type Matchup, type Team } from "@/db/schema";
import { Badge, Card, CardTitle, cx, EmptyState, LinkButton, ListRow, Page, Points } from "@/components/ui";
import { fmtRecord, plural } from "@/lib/format";
import { median } from "@/lib/schedule";
import {
  currentWeek,
  editableWeek,
  formatDate,
  formatDateTime,
  formatShortDate,
  weekEndDate,
  weekLockTime,
  weekStartDate,
} from "@/lib/time";
import { getLeagueContext, type LeagueContext } from "@/server/league-context";
import { countPendingByOrigin } from "@/server/services/events";
import { leagueClock } from "@/server/services/lineups";
import { matchupPhase, MATCHUP_PHASE_LABELS, periodTitle, playoffRoundTotal, seasonLength } from "@/server/services/results";
import { getScoreboard } from "@/server/services/scores";
import { getLeagueMatchups, getStandings, teamMatchupInPeriod, type StandingWithTeam } from "@/server/services/standings";
import { LEAGUE_STATUS_LABELS, pickHomePeriod } from "@/app/leagues/new/league-rules";
import { PHASE_TONES } from "./matchups/matchup-view";
import { ActivityList, loadActivity, type ActivityItem } from "./activity/activity-list";
import { inviteUrl } from "./more/invite-url";
import { ShareInvite } from "./more/share-invite";

export const metadata: Metadata = { title: "League home" };

export default async function LeagueHomePage({ params }: PageProps<"/leagues/[leagueId]">) {
  const { leagueId } = await params;
  const ctx = await getLeagueContext(leagueId);
  const status = ctx.league.status;
  const now = new Date();

  const inSeason = status === "in_season" || status === "playoffs" || status === "complete";

  const [alerts, activity, season] = await Promise.all([
    loadAlerts(ctx),
    loadActivity(leagueId, 8),
    inSeason ? loadSeason(ctx) : Promise.resolve(null),
  ]);

  return (
    <Page className="space-y-4">
      <StatusLine ctx={ctx} now={now} season={season} />
      <Alerts alerts={alerts} />
      {status === "setup" ? <SetupView ctx={ctx} /> : null}
      {status === "drafting" ? <DraftingView ctx={ctx} /> : null}
      {season ? <SeasonView ctx={ctx} now={now} season={season} /> : null}
      {status !== "setup" || activity.length > 0 ? <RecentActivity ctx={ctx} items={activity} /> : null}
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Header line + alerts
// ---------------------------------------------------------------------------

/** Everything the in-season views need, loaded once. */
type SeasonData = {
  allMatchups: Matchup[];
  standings: StandingWithTeam[];
  /** Rounds in the real bracket (playoff spots capped at the number of teams). */
  totalRounds: number;
  /** Weeks the season really runs (regular season + real bracket). */
  totalWeeks: number;
};

async function loadSeason(ctx: LeagueContext): Promise<SeasonData> {
  const [allMatchups, standings] = await Promise.all([getLeagueMatchups(db, ctx.league.id), getStandings(db, ctx.league.id)]);
  const totalRounds = playoffRoundTotal(ctx.settings.schedule, standings.length, allMatchups);
  return { allMatchups, standings, totalRounds, totalWeeks: seasonLength(ctx.settings.schedule, totalRounds) };
}

function StatusLine({ ctx, now, season }: { ctx: LeagueContext; now: Date; season: SeasonData | null }) {
  const { league, settings } = ctx;
  const week = currentWeek(now, leagueClock({ seasonStart: league.seasonStart, settings }));
  let detail: string;
  if (!season || week < 1) detail = `Season starts ${formatDate(league.seasonStart)}`;
  else if (league.status === "complete") detail = "Season complete";
  // Every week is over, but the last results aren't finalized yet.
  else if (week > season.totalWeeks) detail = "Waiting for final results";
  else detail = `Week ${week} of ${season.totalWeeks}`;
  return (
    <div className="flex items-center gap-2 text-sm">
      <Badge tone={league.status === "drafting" ? "warn" : "brand"}>{LEAGUE_STATUS_LABELS[league.status]}</Badge>
      <span className="text-muted">{detail}</span>
    </div>
  );
}

type Alert = { href: string; text: string };

async function loadAlerts(ctx: LeagueContext): Promise<Alert[]> {
  const leagueId = ctx.league.id;
  const base = `/leagues/${leagueId}`;
  const countOf = (rows: { n: number }[]) => rows[0]?.n ?? 0;
  const [offers, pendingEvents, inReview] = await Promise.all([
    ctx.team
      ? db
          .select({ n: count() })
          .from(trades)
          .where(and(eq(trades.leagueId, leagueId), eq(trades.recipientTeamId, ctx.team.id), eq(trades.status, "proposed")))
          .then(countOf)
      : 0,
    ctx.isCommissioner ? countPendingByOrigin(db, ctx.league.poolId) : null,
    ctx.isCommissioner
      ? db
          .select({ n: count() })
          .from(trades)
          .where(and(eq(trades.leagueId, leagueId), eq(trades.status, "accepted")))
          .then(countOf)
      : 0,
  ]);
  const out: Alert[] = [];
  if (offers > 0) out.push({ href: `${base}/trades`, text: `${plural(offers, "trade offer")} waiting for your answer` });
  if (pendingEvents && pendingEvents.courtlistener > 0) {
    const n = pendingEvents.courtlistener;
    out.push({ href: `${base}/commish/events?origin=courtlistener`, text: `${plural(n, "new suggestion")} from court records` });
  }
  const otherPending = pendingEvents ? pendingEvents.total - pendingEvents.courtlistener : 0;
  if (otherPending > 0) {
    const word = pendingEvents?.courtlistener ? "other scoring event" : "scoring event";
    out.push({ href: `${base}/commish/events`, text: `${plural(otherPending, word)} to review` });
  }
  if (inReview > 0) out.push({ href: `${base}/trades`, text: `${plural(inReview, "accepted trade")} in commissioner review` });
  return out;
}

function Alerts({ alerts }: { alerts: Alert[] }) {
  if (alerts.length === 0) return null;
  return (
    <div className="space-y-2" role="status">
      {alerts.map((a) => (
        <Link
          key={a.text}
          href={a.href}
          className="flex min-h-11 items-center justify-between gap-3 rounded-xl border border-line bg-warn-soft px-3 py-2 text-sm font-semibold active:scale-[0.99]"
        >
          <span>{a.text}</span>
          <span aria-hidden>›</span>
        </Link>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Before the draft
// ---------------------------------------------------------------------------

async function SetupView({ ctx }: { ctx: LeagueContext }) {
  const { league, settings } = ctx;
  const base = `/leagues/${league.id}`;
  const tz = settings.schedule.timezone;
  const [teamRows, url] = await Promise.all([
    db
      .select({ id: teams.id, name: teams.name, owner: users.displayName })
      .from(teams)
      .innerJoin(users, eq(users.id, teams.ownerId))
      .where(eq(teams.leagueId, league.id))
      .orderBy(asc(teams.createdAt)),
    ctx.isCommissioner ? inviteUrl(league.inviteCode) : Promise.resolve(""),
  ]);
  const scheduled = settings.draft.scheduledAt ? new Date(settings.draft.scheduledAt) : null;
  const hasSchedule = scheduled !== null && !Number.isNaN(scheduled.getTime());

  return (
    <>
      <Card className="space-y-3">
        <CardTitle>Draft day</CardTitle>
        {hasSchedule ? (
          <p>
            The draft is scheduled for <span className="font-semibold">{formatDateTime(scheduled, tz)}</span>.
          </p>
        ) : (
          <p>The draft hasn&apos;t been scheduled yet. Your commissioner will pick a time.</p>
        )}
        <p className="text-sm text-muted">
          Week 1 starts {formatDate(league.seasonStart)}. Add lawyers to your draft queue so you&apos;re ready.
        </p>
        <LinkButton href={`${base}/draft`} className="w-full">
          Go to the draft room
        </LinkButton>
      </Card>

      {ctx.isCommissioner ? (
        <Card>
          <CardTitle>Invite your club</CardTitle>
          <ShareInvite code={league.inviteCode} url={url} leagueName={league.name} />
        </Card>
      ) : null}

      <Card>
        <CardTitle>
          Teams joined ({teamRows.length} / {settings.maxTeams})
        </CardTitle>
        <div>
          {teamRows.map((t) => (
            <ListRow key={t.id} href={`${base}/teams/${t.id}`}>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{t.name}</p>
                <p className="truncate text-sm text-muted">{t.owner}</p>
              </div>
              {t.id === ctx.team?.id ? <Badge tone="brand">You</Badge> : null}
            </ListRow>
          ))}
        </div>
        {teamRows.length < 2 ? <p className="mt-2 text-sm text-muted">You need at least 2 teams to draft.</p> : null}
      </Card>

      {ctx.isCommissioner ? (
        <Card>
          <CardTitle>Commissioner shortcuts</CardTitle>
          <ShortcutRow href={`${base}/commish/settings`} label="League settings" hint="Roster, scoring, schedule, draft time" />
          <ShortcutRow href={`${base}/commish/members`} label="Members" hint="Co-commissioners and invite code" />
          <ShortcutRow href={`${base}/commish/pool`} label="Player pool" hint="Lawyers, firms and cases" />
        </Card>
      ) : null}
    </>
  );
}

function ShortcutRow({ href, label, hint }: { href: string; label: string; hint: string }) {
  return (
    <ListRow href={href}>
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{label}</p>
        <p className="truncate text-sm text-muted">{hint}</p>
      </div>
      <span className="text-muted" aria-hidden>
        ›
      </span>
    </ListRow>
  );
}

// ---------------------------------------------------------------------------
// During the draft
// ---------------------------------------------------------------------------

async function DraftingView({ ctx }: { ctx: LeagueContext }) {
  const leagueId = ctx.league.id;
  const [[draft], [{ n: teamCount }]] = await Promise.all([
    db
      .select({ status: drafts.status, currentPick: drafts.currentPick, rounds: drafts.rounds })
      .from(drafts)
      .where(eq(drafts.leagueId, leagueId)),
    db.select({ n: count() }).from(teams).where(eq(teams.leagueId, leagueId)),
  ]);
  const paused = draft?.status === "paused";
  const totalPicks = draft ? draft.rounds * teamCount : 0;

  return (
    <Link href={`/leagues/${leagueId}/draft`} className="block rounded-2xl bg-brand p-5 text-brand-ink shadow-sm active:scale-[0.99]">
      <p className="text-xs font-semibold uppercase tracking-widest opacity-80">{paused ? "Draft paused" : "Live now"}</p>
      <p className="mt-1 text-2xl font-extrabold">{paused ? "The draft is on pause" : "The draft is live!"}</p>
      <p className="mt-1 text-sm opacity-90">
        {draft && totalPicks > 0 ? `Pick ${Math.min(draft.currentPick + 1, totalPicks)} of ${totalPicks}. ` : ""}
        {paused ? "It will pick up again soon." : "Jump in and make your picks."}
      </p>
      <span className="mt-4 inline-flex min-h-11 items-center rounded-xl bg-brand-ink px-4 text-sm font-semibold text-brand">
        Enter the draft room ›
      </span>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Season, playoffs, complete
// ---------------------------------------------------------------------------

function SeasonView({ ctx, now, season }: { ctx: LeagueContext; now: Date; season: SeasonData }) {
  const { league, settings } = ctx;
  const base = `/leagues/${league.id}`;
  const tz = settings.schedule.timezone;
  const clock = leagueClock({ seasonStart: league.seasonStart, settings });

  const { allMatchups, standings, totalRounds, totalWeeks } = season;
  const teamsById = new Map(standings.map((s) => [s.teamId, s.team]));

  const week = currentWeek(now, clock);
  const period = pickHomePeriod(allMatchups, week);
  const mine = period !== null && ctx.team ? teamMatchupInPeriod(allMatchups, ctx.team.id, period) : null;

  const lockWeek = editableWeek(now, clock);
  const showLock = league.status !== "complete" && ctx.team !== null && lockWeek <= totalWeeks;
  const champion = league.status === "complete" ? findChampion(allMatchups, standings) : null;

  return (
    <>
      {champion ? (
        <Card className="text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-accent">Season champion</p>
          <p className="mt-1 text-2xl font-extrabold">{champion.name}</p>
          {champion.id === ctx.team?.id ? <p className="mt-1 text-sm font-semibold text-pos">That&apos;s you. Congrats!</p> : null}
        </Card>
      ) : null}

      {mine && ctx.team ? (
        <MatchupCard m={mine} myTeam={ctx.team} teamsById={teamsById} ctx={ctx} week={week} totalRounds={totalRounds} />
      ) : (
        <Card>
          <CardTitle>Your matchup</CardTitle>
          <p className="text-sm text-muted">
            {allMatchups.length === 0
              ? "The schedule isn't ready yet."
              : league.status === "playoffs"
                ? "Your team isn't playing this playoff round. Follow the bracket on the standings page."
                : "No matchup for your team right now."}
          </p>
        </Card>
      )}

      {showLock ? (
        <Card className="flex items-center justify-between gap-3">
          <p className="min-w-0 text-sm">
            Lineups for week {lockWeek} lock{" "}
            <span className="font-semibold">
              {formatDateTime(weekLockTime(lockWeek, league.seasonStart, settings.schedule.lockTime, tz), tz)}
            </span>
          </p>
          <LinkButton href={`${base}/team`} variant="secondary" className="shrink-0">
            Set lineup
          </LinkButton>
        </Card>
      ) : null}

      <StandingsMini standings={standings} myTeamId={ctx.team?.id ?? null} base={base} />
    </>
  );
}

async function MatchupCard({
  m,
  myTeam,
  teamsById,
  ctx,
  week,
  totalRounds,
}: {
  m: Matchup;
  myTeam: Team;
  teamsById: Map<string, Team>;
  ctx: LeagueContext;
  week: number;
  totalRounds: number;
}) {
  const { league } = ctx;
  const base = `/leagues/${league.id}`;
  const iAmA = m.teamAId === myTeam.id;
  const oppId = iAmA ? m.teamBId : m.teamAId;
  const opponent = oppId ? teamsById.get(oppId) : undefined;

  let myScore: number;
  let oppScore: number | null;
  if (m.final && m.scoreA !== null && m.scoreB !== null) {
    myScore = iAmA ? m.scoreA : m.scoreB;
    oppScore = m.isBye ? null : iAmA ? m.scoreB : m.scoreA;
  } else {
    const sb = await getScoreboard(league.id);
    myScore = sb.teamRange(myTeam.id, m.weekStart, m.weekEnd);
    if (m.isBye) oppScore = null;
    else if (m.isMedian || !oppId) oppScore = median([...teamsById.keys()].map((id) => sb.teamRange(id, m.weekStart, m.weekEnd)));
    else oppScore = sb.teamRange(oppId, m.weekStart, m.weekEnd);
  }

  const dates = `${formatShortDate(weekStartDate(m.weekStart, league.seasonStart))} – ${formatShortDate(weekEndDate(m.weekEnd, league.seasonStart))}`;

  // Same phase vocabulary as the matchups pages: Upcoming / Live / Awaiting final / Final.
  const phase = matchupPhase(m, week);
  let stateText: string = MATCHUP_PHASE_LABELS[phase];
  let stateTone: "neutral" | "pos" | "neg" | "brand" | "accent" | "warn" = PHASE_TONES[phase];
  let hint: string | null = null;
  if (phase === "bye") {
    stateText = "Bye · you advance automatically";
    stateTone = "pos";
  } else if (phase === "final") {
    // Median games store a null winner for both ties and losses, so compare scores.
    if (m.winnerTeamId === myTeam.id) {
      stateText = "Final · You won!";
      stateTone = "pos";
    } else if (m.winnerTeamId === null && !m.isPlayoff && oppScore !== null && myScore === oppScore) {
      stateText = "Final · Tie";
    } else {
      stateText = "Final · You lost";
      stateTone = "neg";
    }
  } else if (phase === "live") {
    hint = "Scores update as court events are approved.";
  } else if (phase === "awaiting") {
    hint = "These weeks are over. Scores can still change until the commissioner finalizes them.";
  }

  const oppName = m.isBye ? "Bye" : m.isMedian || !oppId ? "League median" : (opponent?.name ?? "Opponent");
  const myLeads = oppScore !== null && myScore > oppScore;
  const oppLeads = oppScore !== null && oppScore > myScore;

  return (
    <Link href={`${base}/matchups/${m.id}`} className="block active:scale-[0.99]">
      <Card>
        <CardTitle action={<span className="text-sm font-semibold text-brand">Details ›</span>}>
          {periodTitle(m, totalRounds)}
        </CardTitle>
        <div className="space-y-2">
          <ScoreRow name={myTeam.name} sub="You" score={myScore} leading={myLeads} />
          {m.isBye ? null : (
            <ScoreRow
              name={oppName}
              sub={m.isMedian || !oppId ? "Beat the middle score to win" : undefined}
              score={oppScore ?? 0}
              leading={oppLeads}
            />
          )}
        </div>
        <div className="mt-3 flex items-center justify-between gap-2 text-xs">
          <Badge tone={stateTone} className="min-w-0">
            <span className="truncate">{stateText}</span>
          </Badge>
          <span className="shrink-0 whitespace-nowrap text-muted">{dates}</span>
        </div>
        {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
      </Card>
    </Link>
  );
}

function ScoreRow({ name, sub, score, leading }: { name: string; sub?: string; score: number; leading: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className={cx("truncate", leading ? "font-bold" : "font-semibold")}>{name}</p>
        {sub ? <p className="truncate text-xs text-muted">{sub}</p> : null}
      </div>
      <Points value={score} className={cx("text-2xl", leading ? "font-extrabold" : "font-semibold text-muted")} />
    </div>
  );
}

function findChampion(all: Matchup[], standings: StandingWithTeam[]): Team | null {
  const playoff = all.filter((m) => m.isPlayoff);
  if (playoff.length === 0) return standings[0]?.team ?? null;
  const lastRound = Math.max(...playoff.map((m) => m.playoffRound ?? 0));
  const finals = playoff.filter((m) => (m.playoffRound ?? 0) === lastRound);
  if (finals.length !== 1 || !finals[0].final || !finals[0].winnerTeamId) return null;
  return standings.find((s) => s.teamId === finals[0].winnerTeamId)?.team ?? null;
}

function StandingsMini({ standings, myTeamId, base }: { standings: StandingWithTeam[]; myTeamId: string | null; base: string }) {
  const top = standings.slice(0, 5);
  const me = myTeamId ? standings.find((s) => s.teamId === myTeamId) : undefined;
  const rows = me && !top.includes(me) ? [...top, me] : top;
  return (
    <Card>
      <CardTitle
        action={
          <Link href={`${base}/standings`} className="inline-flex min-h-11 items-center text-sm font-semibold text-brand">
            Full standings ›
          </Link>
        }
      >
        Standings
      </CardTitle>
      {rows.length === 0 ? (
        <EmptyState title="No teams yet" />
      ) : (
        <table className="w-full table-fixed text-sm">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="w-8 pb-1 font-medium">#</th>
              <th className="pb-1 font-medium">Team</th>
              <th className="w-16 pb-1 text-right font-medium">W-L</th>
              <th className="w-16 pb-1 text-right font-medium">PF</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={r.teamId}
                className={cx(
                  "border-t border-line",
                  r.teamId === myTeamId && "font-semibold",
                  i === top.length && "border-t-2 border-dashed",
                )}
              >
                <td className="tabular-nums text-muted">{r.rank}</td>
                <td className="truncate">
                  <Link href={`${base}/teams/${r.teamId}`} className="flex min-h-11 items-center truncate">
                    <span className="truncate">{r.team.name}</span>
                  </Link>
                </td>
                <td className="text-right tabular-nums">{fmtRecord(r.wins, r.losses, r.ties)}</td>
                <td className="text-right">
                  <Points value={r.pointsFor} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Recent activity
// ---------------------------------------------------------------------------

function RecentActivity({ ctx, items }: { ctx: LeagueContext; items: ActivityItem[] }) {
  return (
    <Card>
      <CardTitle
        action={
          <Link href={`/leagues/${ctx.league.id}/activity`} className="inline-flex min-h-11 items-center text-sm font-semibold text-brand">
            See all ›
          </Link>
        }
      >
        Recent activity
      </CardTitle>
      {items.length === 0 ? (
        <EmptyState title="No moves yet">Pickups, drops and trades will show up here.</EmptyState>
      ) : (
        <ActivityList items={items} timeZone={ctx.settings.schedule.timezone} />
      )}
    </Card>
  );
}
