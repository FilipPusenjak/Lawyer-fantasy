import type { Metadata } from "next";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { teams, type Matchup } from "@/db/schema";
import { Badge, Card, CardTitle, EmptyState, LinkButton, Notice, Page, PageHeader } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/ui-client";
import { plural } from "@/lib/format";
import { regularSeasonWeeks, totalSeasonWeeks, type LeagueSettings } from "@/lib/settings";
import { addDays, formatShortDate } from "@/lib/time";
import { getCommissionerContext } from "@/server/league-context";
import {
  getWeekStatuses,
  pendingEventCountsByWeek,
  periodRef,
  periodTitle,
  playoffRoundList,
  playoffRoundName,
  playoffRoundRef,
  playoffRoundTotal,
  seasonLength,
  weekRangeLabel,
  type WeekStatusRow,
} from "@/server/services/results";
import { hasWeekScoring } from "@/server/services/scores";
import { getLeagueMatchups } from "@/server/services/standings";
import { LEAGUE_STATUS_LABELS, leagueStatusTone } from "@/app/leagues/new/league-rules";
import { WeekStateBadge } from "../../matchups/matchup-view";
import { finalizeWeekAction, reopenWeekAction } from "./actions";

export const metadata: Metadata = { title: "Weeks" };

function dates(r: Pick<WeekStatusRow, "startDate" | "endDate">): string {
  return `${formatShortDate(r.startDate)} – ${formatShortDate(r.endDate)}`;
}

export default async function CommishWeeksPage({ params }: PageProps<"/leagues/[leagueId]/commish/weeks">) {
  const { leagueId } = await params;
  const ctx = await getCommissionerContext(leagueId);
  const { league, settings } = ctx;
  const base = `/leagues/${leagueId}`;

  const header = (
    <>
      <Link href={`${base}/commish`} className="inline-flex min-h-11 items-center text-sm font-semibold text-brand">
        ‹ Commissioner tools
      </Link>
      <PageHeader title="Weeks & results" subtitle="Finalizing locks that week's scores. Late approvals won't change it unless you reopen it." />
    </>
  );

  if (league.status === "setup" || league.status === "drafting") {
    return (
      <Page className="space-y-4">
        {header}
        <EmptyState title="The season hasn't started yet">Weeks show up here once the draft is done.</EmptyState>
      </Page>
    );
  }

  const total = totalSeasonWeeks(settings.schedule);
  const [allRows, pending, all, teamRows] = await Promise.all([
    getWeekStatuses(db, leagueId),
    pendingEventCountsByWeek(db, { poolId: league.poolId, seasonStart: league.seasonStart, totalWeeks: total }),
    getLeagueMatchups(db, leagueId),
    db.select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.leagueId, leagueId)),
  ]);
  const names = new Map(teamRows.map((t) => [t.id, t.name]));
  const playoff = all.filter((m) => m.isPlayoff);
  // With fewer teams than playoff spots the bracket has fewer rounds than the settings allow for.
  const totalRounds = playoffRoundTotal(settings.schedule, teamRows.length, all);
  const rows = allRows.filter((r) => r.week <= seasonLength(settings.schedule, totalRounds));

  const finalizable = rows.find((r) => r.canFinalize) ?? null;
  const nextOpen = rows.find((r) => r.state !== "finalized") ?? null;
  const latestFinal = rows.find((r) => r.canReopen) ?? null;
  const finalCount = rows.filter((r) => r.state === "finalized").length;
  const generatedAfterLatest = latestFinal ? playoff.filter((m) => m.weekStart > latestFinal.week) : [];
  const pendingTotal = [...pending.values()].reduce((a, b) => a + b, 0);
  // Weeks finalized before scoring was stored per week re-score with today's settings.
  const scoringNote = latestFinal
    ? (await hasWeekScoring(db, leagueId, latestFinal.week))
      ? "It keeps the scoring it was finalized with."
      : "It uses the current scoring."
    : "";

  return (
    <Page className="space-y-4">
      {header}

      <Card className="space-y-3">
        <CardTitle>Finalize</CardTitle>
        <ActionForm action={finalizeWeekAction}>
          {finalizable ? (
            <>
              <p className="text-sm">
                Week {finalizable.week} ({dates(finalizable)}) is over.{" "}
                {settlesText(finalizable, settings, playoff, totalRounds)}
              </p>
              {(pending.get(finalizable.week) ?? 0) > 0 ? (
                <Notice tone="warn">
                  {plural(pending.get(finalizable.week)!, "scoring event")} dated week {finalizable.week}{" "}
                  {pending.get(finalizable.week) === 1 ? "is" : "are"} still waiting for review. Review them first so they count.{" "}
                  <Link href={`${base}/commish/events`} className="inline-flex min-h-11 items-center font-semibold text-brand underline">
                    Review events
                  </Link>
                </Notice>
              ) : null}
              <input type="hidden" name="leagueId" value={leagueId} />
              <input type="hidden" name="week" value={finalizable.week} />
              <SubmitButton
                className="w-full"
                pendingText="Finalizing…"
                confirm={`Finalize week ${finalizable.week}? Its scores lock, and approvals after this won't change them unless you reopen it.`}
              >
                Finalize week {finalizable.week}
              </SubmitButton>
            </>
          ) : (
            <p className="text-sm text-muted">{waitingText(league.status, nextOpen)}</p>
          )}
        </ActionForm>
      </Card>

      <Card className="space-y-3">
        <CardTitle>Reopen</CardTitle>
        <ActionForm action={reopenWeekAction}>
          {latestFinal ? (
            <>
              <p className="text-sm">
                Week {latestFinal.week} is the latest final week. Reopen it if a late approval or a fix should count. Its scores
                can change until you finalize it again. {scoringNote}
              </p>
              {generatedAfterLatest.length > 0 ? (
                <Notice tone="warn">
                  This also removes the {playoffRoundList(generatedAfterLatest.map((m) => m.playoffRound ?? 1), totalRounds)}{" "}
                  matchups made when week {latestFinal.week} was finalized. They&apos;re rebuilt, with fresh seeding, when you
                  finalize it again.
                </Notice>
              ) : null}
              <input type="hidden" name="leagueId" value={leagueId} />
              <input type="hidden" name="week" value={latestFinal.week} />
              <SubmitButton
                variant="secondary"
                className="w-full"
                pendingText="Reopening…"
                confirm={`Reopen week ${latestFinal.week}? Its scores can change until you finalize it again. ${scoringNote}`}
              >
                Reopen week {latestFinal.week}
              </SubmitButton>
            </>
          ) : (
            <p className="text-sm text-muted">No weeks are final yet.</p>
          )}
        </ActionForm>
      </Card>

      <SeasonCard
        base={base}
        status={league.status}
        settings={settings}
        playoff={playoff}
        names={names}
        totalRounds={totalRounds}
        finalCount={finalCount}
        totalWeeks={rows.length}
        teamCount={teamRows.length}
      />

      <Card>
        <CardTitle>All weeks</CardTitle>
        <ul>
          {rows.map((r) => {
            const p = pending.get(r.week) ?? 0;
            const context = weekContext(r, totalRounds);
            return (
              <li key={r.week} className="flex min-h-12 items-center gap-3 border-b border-line py-2 last:border-b-0">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">
                    Week {r.week}
                    {context ? <span className="text-xs font-normal text-muted"> · {context}</span> : null}
                  </p>
                  <p className="text-xs text-muted">
                    {dates(r)}
                    {p > 0 ? <span className="text-warn"> · {p} pending</span> : null}
                  </p>
                </div>
                {r.canFinalize ? <Badge tone="warn">Ready to finalize</Badge> : <WeekStateBadge state={r.state} />}
              </li>
            );
          })}
        </ul>
        {pendingTotal > 0 ? (
          <div className="mt-3">
            <LinkButton href={`${base}/commish/events`} variant="secondary" className="w-full">
              Review {plural(pendingTotal, "pending event")}
            </LinkButton>
          </div>
        ) : null}
      </Card>
    </Page>
  );
}

/**
 * Which matchup a week belongs to, for the week list: the playoff round name,
 * or the multi-week matchup ("Weeks 1–2 matchup"). Nothing for one-week matchups.
 */
function weekContext(r: WeekStatusRow, totalRounds: number): string | null {
  if (r.period.isPlayoff) return periodTitle(r.period, totalRounds);
  return r.period.weekStart === r.period.weekEnd ? null : `${periodTitle(r.period, totalRounds)} matchup`;
}

/** What finalizing this week will settle, in one sentence. */
function settlesText(r: WeekStatusRow, settings: LeagueSettings, playoff: Matchup[], totalRounds: number): string {
  if (r.week !== r.period.weekEnd) {
    return `Finalizing locks its scores. Matchups for ${periodRef(r.period, totalRounds)} are settled after week ${r.period.weekEnd}.`;
  }
  if (!r.period.isPlayoff) {
    if (r.week === regularSeasonWeeks(settings.schedule)) {
      return totalRounds > 0
        ? "This settles the last regular-season matchups and sets the playoff bracket."
        : "This settles the last matchups and ends the season.";
    }
    return `This settles the matchups for ${periodRef(r.period, totalRounds)}.`;
  }
  const round = r.period.playoffRound ?? 1;
  const exists = playoff.some((m) => m.playoffRound === round);
  if (!exists) return "Finalizing locks its scores.";
  return round === totalRounds
    ? "This settles the championship and crowns the champion."
    : `This settles ${playoffRoundRef(round, totalRounds)} and sets ${playoffRoundRef(round + 1, totalRounds)}.`;
}

function waitingText(status: string, next: WeekStatusRow | null): string {
  if (status === "complete") return "The season is complete. Nothing left to finalize.";
  if (!next) return "Every week is final.";
  if (next.state === "ended") return `Week ${next.week} has ended. Finalize the weeks before it first.`;
  return `Week ${next.week} ends ${formatShortDate(next.endDate)}. You can finalize it starting ${formatShortDate(addDays(next.endDate, 1))}.`;
}

function SeasonCard({
  base,
  status,
  settings,
  playoff,
  names,
  totalRounds,
  finalCount,
  totalWeeks,
  teamCount,
}: {
  base: string;
  status: "setup" | "drafting" | "in_season" | "playoffs" | "complete";
  settings: LeagueSettings;
  playoff: Matchup[];
  names: Map<string, string>;
  totalRounds: number;
  finalCount: number;
  totalWeeks: number;
  teamCount: number;
}) {
  const s = settings.schedule;
  const regularWeeks = regularSeasonWeeks(s);
  const seeded = Math.min(s.playoffTeams, teamCount);
  let playoffText: string;
  if (seeded < 2) {
    playoffText = "No playoffs this season. The best regular-season record wins.";
  } else if (playoff.length === 0) {
    playoffText = `Top ${seeded} teams, ${weekRangeLabel(regularWeeks + 1, seasonLength(s, totalRounds)).toLowerCase()}. The bracket is set automatically when week ${regularWeeks} is finalized.`;
  } else {
    const latest = Math.max(...playoff.map((m) => m.playoffRound ?? 1));
    const round = playoff.filter((m) => (m.playoffRound ?? 1) === latest);
    const name = playoffRoundName(latest, totalRounds);
    if (status === "complete" && round.length === 1 && round[0].winnerTeamId) {
      playoffText = `Champion: ${names.get(round[0].winnerTeamId) ?? "Team"}.`;
    } else if (round.every((m) => m.final)) {
      playoffText = `${name} is settled.`;
    } else {
      playoffText = `${name} in progress (${weekRangeLabel(round[0].weekStart, round[0].weekEnd).toLowerCase()}).`;
    }
  }

  return (
    <Card className="space-y-2">
      <CardTitle action={<Badge tone={leagueStatusTone(status)}>{LEAGUE_STATUS_LABELS[status]}</Badge>}>Season</CardTitle>
      <p className="text-sm">
        <span className="font-semibold">Regular season:</span> weeks 1–{regularWeeks}. {finalCount} of {totalWeeks} weeks final.
      </p>
      <p className="text-sm">
        <span className="font-semibold">Playoffs:</span> {playoffText}
      </p>
      <LinkButton href={`${base}/standings`} variant="ghost" className="px-0">
        Standings &amp; bracket ›
      </LinkButton>
    </Card>
  );
}
