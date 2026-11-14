import type { Metadata } from "next";
import { db } from "@/db";
import { Page, PageHeader } from "@/components/ui";
import { DraftRoom } from "@/components/draft/draft-room";
import { shapeDraftState, type AfterDraftInfo } from "@/components/draft/model";
import { editableWeek, formatDateTime, isWeekLocked, weekLockTime } from "@/lib/time";
import { getLeagueContext, type LeagueContext } from "@/server/league-context";
import { advanceClock, getDraftState } from "@/server/services/draft";
import { leagueClock } from "@/server/services/lineups";
import { playoffRoundTotal, seasonLength } from "@/server/services/results";
import { projectionSummaries } from "@/lib/projections";
import { getLeagueProjections } from "@/server/services/projections";

export const metadata: Metadata = { title: "Draft room" };

/** Where the season stands, for the "draft is done" card. */
function afterDraftInfo(ctx: LeagueContext, teamCount: number, now: Date): AfterDraftInfo {
  const { league, settings } = ctx;
  if (league.status === "complete") return { phase: "complete", nextLock: null };
  if (league.status === "playoffs") return { phase: "playoffs", nextLock: null };
  const clock = leagueClock({ seasonStart: league.seasonStart, settings });
  const lockWeek = editableWeek(now, clock);
  const tz = settings.schedule.timezone;
  const nextLock =
    lockWeek <= seasonLength(settings.schedule, playoffRoundTotal(settings.schedule, teamCount))
      ? formatDateTime(weekLockTime(lockWeek, league.seasonStart, settings.schedule.lockTime, tz), tz)
      : null;
  return { phase: isWeekLocked(1, now, clock) ? "in_season" : "preseason", nextLock };
}

export default async function DraftPage({ params }: PageProps<"/leagues/[leagueId]/draft">) {
  const { leagueId } = await params;
  const ctx = await getLeagueContext(leagueId);
  const now = new Date();
  await advanceClock(db, leagueId, now);
  const [state, proj] = await Promise.all([
    getDraftState(db, leagueId, { teamId: ctx.team?.id ?? null, includeLawyers: true }),
    getLeagueProjections(db, leagueId, now),
  ]);
  const initial = shapeDraftState(state, {
    myTeamId: ctx.team?.id ?? null,
    isCommissioner: ctx.isCommissioner,
    now: new Date(),
    includePool: true,
  });
  const scheduledAt = state.scheduledAt ? new Date(state.scheduledAt) : null;
  const scheduledLabel =
    scheduledAt && !Number.isNaN(scheduledAt.getTime()) ? formatDateTime(scheduledAt, ctx.settings.schedule.timezone) : null;

  const subtitle =
    state.status === "not_started"
      ? "Snake draft · get your queue ready"
      : state.status === "complete"
        ? "Final results"
        : `Snake draft · ${state.rounds} rounds`;

  return (
    <Page>
      <PageHeader title="Draft room" subtitle={subtitle} />
      <DraftRoom
        leagueId={leagueId}
        initial={initial}
        roster={ctx.settings.roster}
        scheduledLabel={scheduledLabel}
        afterDraft={afterDraftInfo(ctx, state.teams.length, now)}
        projections={projectionSummaries(proj.rows)}
      />
    </Page>
  );
}
