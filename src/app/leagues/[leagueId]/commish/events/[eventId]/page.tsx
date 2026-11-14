import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { Card, CardTitle, Page, PageHeader } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/ui-client";
import { isUuid } from "@/lib/format";
import { totalSeasonWeeks } from "@/lib/settings";
import { todayIn, weekOfDate } from "@/lib/time";
import { canManagePool, getCommissionerContext } from "@/server/league-context";
import { countPending, eventCredits, finalizedWeeks, getPoolEvent, loadCreditIndex } from "@/server/services/events";
import { listCaseOptions, listLawyerOptions } from "@/server/services/pool";
import { BackLink } from "../../pool/pool-ui";
import { setEventStatusAction, updateEventAction } from "../actions";
import { EventFields } from "../event-fields";
import { eventLabel } from "../event-rules";
import { EventFacts, EventsTabs } from "../event-ui";

export const metadata: Metadata = { title: "Edit scoring event" };

export default async function EditEventPage({ params }: PageProps<"/leagues/[leagueId]/commish/events/[eventId]">) {
  const { leagueId, eventId } = await params;
  const ctx = await getCommissionerContext(leagueId);
  if (!isUuid(eventId) || !(await canManagePool(ctx.user, ctx.league.poolId))) notFound();
  const poolId = ctx.league.poolId;
  const e = await getPoolEvent(db, poolId, eventId);
  if (!e) notFound();
  const [caseOptions, lawyerOptions, pending, index, finalized] = await Promise.all([
    listCaseOptions(db, poolId),
    listLawyerOptions(db, poolId),
    countPending(db, poolId),
    loadCreditIndex(db, poolId),
    finalizedWeeks(db, leagueId),
  ]);
  const base = `/leagues/${leagueId}/commish/events`;
  const statusAction = setEventStatusAction.bind(null, leagueId, eventId);

  return (
    <Page className="space-y-4">
      <BackLink href={e.status === "pending" ? base : `${base}/history`} label={e.status === "pending" ? "Review queue" : "History"} />
      <PageHeader title={eventLabel(e.type)} subtitle="Shared by every league that uses this player pool." />
      <EventsTabs leagueId={leagueId} active={null} pending={pending} />

      <Card className="space-y-3">
        <EventFacts
          e={e}
          credits={eventCredits(e, index, ctx.settings.scoring)}
          week={weekOfDate(e.occurredOn, ctx.league.seasonStart)}
          totalWeeks={totalSeasonWeeks(ctx.settings.schedule)}
          finalized={finalized}
          leagueId={leagueId}
          showStatus
        />
        <ActionForm action={statusAction}>
          {e.status === "pending" ? (
            <div className="flex gap-2">
              <SubmitButton name="op" value="approve" className="flex-1">
                Approve
              </SubmitButton>
              <SubmitButton name="op" value="reject" variant="secondary" className="flex-1" confirm="Reject this event? It won't score.">
                Reject
              </SubmitButton>
            </div>
          ) : (
            <SubmitButton
              name="op"
              value="pending"
              variant="secondary"
              className="w-full"
              confirm={e.status === "approved" ? "Move this event back to pending? Its points stop counting until it's approved again." : undefined}
            >
              Move back to pending
            </SubmitButton>
          )}
        </ActionForm>
      </Card>

      <Card>
        <CardTitle>Edit details</CardTitle>
        {e.status === "approved" ? (
          <p className="mb-3 text-sm text-muted">This event is approved, so saving changes re-scores every week that isn&apos;t finalized.</p>
        ) : null}
        <ActionForm action={updateEventAction.bind(null, leagueId, eventId)}>
          <EventFields
            cases={caseOptions}
            lawyers={lawyerOptions}
            today={todayIn(ctx.settings.schedule.timezone)}
            isNew={false}
            requireSource={e.origin === "manual"}
            defaults={{
              type: e.type,
              caseId: e.caseId ?? "",
              side: e.side ?? "",
              lawyerId: e.lawyerId ?? "",
              occurredOn: e.occurredOn,
              summary: e.summary,
              sourceUrl: e.sourceUrl ?? "",
              customPoints: e.customPoints === null ? "" : String(e.customPoints),
            }}
          />
          <SubmitButton className="w-full">Save changes</SubmitButton>
        </ActionForm>
      </Card>
    </Page>
  );
}
