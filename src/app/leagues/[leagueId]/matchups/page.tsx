import type { Metadata } from "next";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { teams, type Matchup } from "@/db/schema";
import { buttonClass, Card, cx, EmptyState, LinkButton, Notice, Page, PageHeader } from "@/components/ui";
import { currentWeek } from "@/lib/time";
import { getLeagueContext } from "@/server/league-context";
import { leagueClock } from "@/server/services/lineups";
import { currentPeriod, listPeriods, playoffRoundTotal } from "@/server/services/results";
import { getScoreboard } from "@/server/services/scores";
import { getLeagueMatchups } from "@/server/services/standings";
import { leadingSide, matchupPhase, matchupScores, PhaseBadge, ScoreLine, weekRangeDates } from "./matchup-view";
import { PeriodPicker } from "./period-picker";

export const metadata: Metadata = { title: "Matchups" };

export default async function MatchupsPage({ params, searchParams }: PageProps<"/leagues/[leagueId]/matchups">) {
  const { leagueId } = await params;
  const sp = await searchParams;
  const ctx = await getLeagueContext(leagueId);
  const base = `/leagues/${leagueId}`;

  const [all, teamRows] = await Promise.all([
    getLeagueMatchups(db, leagueId),
    db.select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.leagueId, leagueId)),
  ]);

  if (all.length === 0) {
    return (
      <Page>
        <PageHeader title="Matchups" />
        <EmptyState title="No matchups yet">The schedule is made as soon as the draft is done.</EmptyState>
      </Page>
    );
  }

  const week = currentWeek(new Date(), leagueClock({ seasonStart: ctx.league.seasonStart, settings: ctx.settings }));
  const periods = listPeriods(all, playoffRoundTotal(ctx.settings.schedule, teamRows.length, all));
  const requested = Number(Array.isArray(sp.period) ? sp.period[0] : sp.period);
  const selected =
    periods.find((p) => p.period === requested) ??
    periods.find((p) => p.period === currentPeriod(all, week)) ??
    periods[0];
  const idx = periods.indexOf(selected);
  const prev = periods[idx - 1];
  const next = periods[idx + 1];

  const sb = await getScoreboard(leagueId);
  const teamIds = teamRows.map((t) => t.id);
  const names = new Map(teamRows.map((t) => [t.id, t.name]));
  const myId = ctx.team?.id ?? null;
  const isMine = (m: Matchup) => myId !== null && (m.teamAId === myId || m.teamBId === myId);

  const inPeriod = all
    .filter((m) => m.period === selected.period)
    .sort((a, b) => Number(isMine(b)) - Number(isMine(a)) || (a.bracketSlot ?? 0) - (b.bracketSlot ?? 0));
  const waitingOnFinal = inPeriod.some((m) => matchupPhase(m, week) === "awaiting");

  return (
    <Page className="space-y-4">
      <PageHeader title="Matchups" subtitle={weekRangeDates(selected.weekStart, selected.weekEnd, ctx.league.seasonStart)} />

      <nav className="flex items-center gap-2" aria-label="Matchup periods">
        {prev ? (
          <Link href={`${base}/matchups?period=${prev.period}`} className={buttonClass("secondary", "w-11 shrink-0 px-0")} aria-label={`Previous: ${prev.label}`}>
            ‹
          </Link>
        ) : (
          <span className={buttonClass("secondary", "pointer-events-none w-11 shrink-0 px-0 opacity-40")} aria-hidden>
            ‹
          </span>
        )}
        <div className="min-w-0 flex-1">
          <PeriodPicker basePath={`${base}/matchups`} value={selected.period} options={periods} />
        </div>
        {next ? (
          <Link href={`${base}/matchups?period=${next.period}`} className={buttonClass("secondary", "w-11 shrink-0 px-0")} aria-label={`Next: ${next.label}`}>
            ›
          </Link>
        ) : (
          <span className={buttonClass("secondary", "pointer-events-none w-11 shrink-0 px-0 opacity-40")} aria-hidden>
            ›
          </span>
        )}
      </nav>

      {waitingOnFinal ? (
        <Notice tone="warn">
          These weeks are over. Scores can still change until the commissioner finalizes them.
          {ctx.isCommissioner ? (
            <>
              {" "}
              <Link href={`${base}/commish/weeks`} className="inline-flex min-h-11 items-center font-semibold text-brand underline">
                Finalize weeks
              </Link>
            </>
          ) : null}
        </Notice>
      ) : null}

      <div className="space-y-3">
        {inPeriod.map((m) => {
          const s = matchupScores(m, sb, teamIds);
          const lead = leadingSide(m, s);
          const mine = isMine(m);
          const phase = matchupPhase(m, week);
          return (
            <Link key={m.id} href={`${base}/matchups/${m.id}`} className="block active:scale-[0.99]">
              <Card className={cx(mine && "border-brand")}>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <PhaseBadge phase={phase} />
                    {mine ? <span className="text-xs font-semibold uppercase tracking-wide text-brand">Your matchup</span> : null}
                  </div>
                  <span className="text-sm font-semibold text-brand">Details ›</span>
                </div>
                <ScoreLine
                  name={names.get(m.teamAId) ?? "Team"}
                  seed={m.isPlayoff ? m.seedA : null}
                  score={s.scoreA}
                  leading={lead === "A"}
                  isMine={m.teamAId === myId}
                />
                {m.isBye ? (
                  <ScoreLine name="Bye" sub="Moves on to the next round" seed={null} score={null} leading={false} />
                ) : m.teamBId ? (
                  <ScoreLine
                    name={names.get(m.teamBId) ?? "Team"}
                    seed={m.isPlayoff ? m.seedB : null}
                    score={s.scoreB}
                    leading={lead === "B"}
                    isMine={m.teamBId === myId}
                  />
                ) : (
                  <ScoreLine name="League median" sub="Beat the middle score to win" score={s.scoreB} leading={lead === "B"} />
                )}
              </Card>
            </Link>
          );
        })}
      </div>

      <p className="text-center text-xs text-muted">
        Live scores update as the commissioner approves court events. They lock when a week is finalized.
      </p>
      <div className="flex justify-center">
        <LinkButton href={`${base}/standings`} variant="ghost">
          Standings &amp; bracket ›
        </LinkButton>
      </div>
    </Page>
  );
}
