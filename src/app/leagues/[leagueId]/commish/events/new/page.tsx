import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { Card, LinkButton, Notice, Page, PageHeader } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/ui-client";
import { todayIn } from "@/lib/time";
import { canManagePool, getCommissionerContext } from "@/server/league-context";
import { countPending } from "@/server/services/events";
import { listCaseOptions, listLawyerOptions } from "@/server/services/pool";
import { BackLink } from "../../pool/pool-ui";
import { createEventAction } from "../actions";
import { EventFields } from "../event-fields";
import { EventsTabs } from "../event-ui";

export const metadata: Metadata = { title: "Add scoring event" };

export default async function NewEventPage({ params, searchParams }: PageProps<"/leagues/[leagueId]/commish/events/new">) {
  const { leagueId } = await params;
  const ctx = await getCommissionerContext(leagueId);
  if (!(await canManagePool(ctx.user, ctx.league.poolId))) notFound();
  const poolId = ctx.league.poolId;
  const [caseOptions, lawyerOptions, pending] = await Promise.all([
    listCaseOptions(db, poolId),
    listLawyerOptions(db, poolId),
    countPending(db, poolId),
  ]);
  const sp = await searchParams;
  const wantedCase = typeof sp.caseId === "string" ? sp.caseId : "";
  const today = todayIn(ctx.settings.schedule.timezone);

  return (
    <Page className="space-y-4">
      <BackLink href={`/leagues/${leagueId}/commish`} label="Commissioner" />
      <PageHeader title="Scoring events" subtitle="Record something that happened in a public court case." />
      <EventsTabs leagueId={leagueId} active="new" pending={pending} />

      {caseOptions.length === 0 && lawyerOptions.length === 0 ? (
        <Notice tone="warn">
          The player pool is empty. Add lawyers and cases first.{" "}
          <LinkButton href={`/leagues/${leagueId}/commish/pool`} variant="ghost">
            Player pool
          </LinkButton>
        </Notice>
      ) : null}

      <Card>
        <ActionForm action={createEventAction.bind(null, leagueId)}>
          <EventFields
            cases={caseOptions}
            lawyers={lawyerOptions}
            today={today}
            isNew
            requireSource
            defaults={{
              type: "",
              caseId: caseOptions.some((c) => c.id === wantedCase) ? wantedCase : "",
              side: "",
              lawyerId: "",
              occurredOn: today,
              summary: "",
              sourceUrl: "",
              customPoints: "",
            }}
          />
          <SubmitButton className="w-full" pendingText="Saving…">
            Add event
          </SubmitButton>
        </ActionForm>
      </Card>
    </Page>
  );
}
