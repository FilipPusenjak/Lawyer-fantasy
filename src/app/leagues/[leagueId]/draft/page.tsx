import type { Metadata } from "next";
import { db } from "@/db";
import { Page, PageHeader } from "@/components/ui";
import { DraftRoom } from "@/components/draft/draft-room";
import { shapeDraftState } from "@/components/draft/model";
import { formatDateTime } from "@/lib/time";
import { getLeagueContext } from "@/server/league-context";
import { advanceClock, getDraftState } from "@/server/services/draft";

export const metadata: Metadata = { title: "Draft room" };

export default async function DraftPage({ params }: PageProps<"/leagues/[leagueId]/draft">) {
  const { leagueId } = await params;
  const ctx = await getLeagueContext(leagueId);
  const now = new Date();
  await advanceClock(db, leagueId, now);
  const state = await getDraftState(db, leagueId, { teamId: ctx.team?.id ?? null, includeLawyers: true });
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
      <DraftRoom leagueId={leagueId} initial={initial} roster={ctx.settings.roster} scheduledLabel={scheduledLabel} />
    </Page>
  );
}
