import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { Badge, Card, CardTitle, EmptyState, ListRow, Page, PageHeader } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/ui-client";
import { isUuid } from "@/lib/format";
import { POSITION_LABELS, POSITION_SHORT, sideLabel } from "@/lib/settings";
import { canManagePool, getCommissionerContext } from "@/server/league-context";
import { deleteBlocker, firmMembers, getPoolLawyer, lawyerUsage, listLawyerCases, listPoolFirms } from "@/server/services/pool";
import { deleteLawyerAction, updateFirmAction, updateLawyerAction } from "../../actions";
import { BackLink, FirmFields, LawyerFields } from "../../pool-ui";

export const metadata: Metadata = { title: "Edit lawyer" };

export default async function EditLawyerPage({ params }: PageProps<"/leagues/[leagueId]/commish/pool/lawyers/[lawyerId]">) {
  const { leagueId, lawyerId } = await params;
  const ctx = await getCommissionerContext(leagueId);
  if (!isUuid(lawyerId) || !(await canManagePool(ctx.user, ctx.league.poolId))) notFound();
  const poolId = ctx.league.poolId;
  const l = await getPoolLawyer(db, poolId, lawyerId);
  if (!l) notFound();
  const isFirm = l.kind === "firm";
  const [firms, members, caseRows, usage] = await Promise.all([
    isFirm ? Promise.resolve([]) : listPoolFirms(db, poolId),
    isFirm ? firmMembers(db, poolId, lawyerId) : Promise.resolve([]),
    listLawyerCases(db, poolId, lawyerId),
    lawyerUsage(db, lawyerId),
  ]);
  const blocker = deleteBlocker(l.name, usage);
  const base = `/leagues/${leagueId}/commish/pool`;

  return (
    <Page className="space-y-4">
      <BackLink href={isFirm ? `${base}/firms` : base} label={isFirm ? "Firms" : "Lawyers"} />
      <PageHeader
        title={l.name}
        subtitle={[POSITION_LABELS[l.position], l.preseasonRank ? `Rank #${l.preseasonRank}` : null].filter(Boolean).join(" · ")}
        action={usage.rosteredIn.length > 0 ? <Badge tone="brand">On a team</Badge> : null}
      />

      <Card>
        <CardTitle>Details</CardTitle>
        {isFirm ? (
          <ActionForm action={updateFirmAction.bind(null, leagueId, lawyerId)}>
            <FirmFields d={l} />
            <SubmitButton className="w-full">Save firm</SubmitButton>
          </ActionForm>
        ) : (
          <ActionForm action={updateLawyerAction.bind(null, leagueId, lawyerId)}>
            <LawyerFields firms={firms} d={l} />
            {usage.rosteredIn.length > 0 ? (
              <p className="text-xs text-muted">A team has this lawyer, so their position can&apos;t change right now.</p>
            ) : null}
            <SubmitButton className="w-full">Save lawyer</SubmitButton>
          </ActionForm>
        )}
      </Card>

      {isFirm ? (
        <Card>
          <CardTitle>Lawyers at this firm</CardTitle>
          {members.length === 0 ? (
            <EmptyState title="No lawyers linked yet">Pick this firm on a lawyer&apos;s page to link them.</EmptyState>
          ) : (
            members.map((m) => (
              <ListRow key={m.id} href={`${base}/lawyers/${m.id}`}>
                <Badge tone="brand" className="w-12 shrink-0 justify-center">
                  {POSITION_SHORT[m.position]}
                </Badge>
                <p className="min-w-0 flex-1 truncate font-semibold">{m.name}</p>
                <span className="text-muted" aria-hidden>
                  ›
                </span>
              </ListRow>
            ))
          )}
        </Card>
      ) : null}

      <Card>
        <CardTitle>Cases</CardTitle>
        {caseRows.length === 0 ? (
          <EmptyState title="Not on any cases yet">Open a case and add {isFirm ? "this firm" : "this lawyer"} to a side.</EmptyState>
        ) : (
          caseRows.map((c) => (
            <ListRow key={c.appearanceId} href={`${base}/cases/${c.caseId}`}>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{c.caption}</p>
                <p className="truncate text-sm text-muted">
                  {sideLabel(c.caseType, c.side)} · {[c.court, c.docketNumber].filter(Boolean).join(" · ")}
                </p>
              </div>
              {c.status === "closed" ? <Badge>Closed</Badge> : null}
              <span className="text-muted" aria-hidden>
                ›
              </span>
            </ListRow>
          ))
        )}
      </Card>

      <Card>
        <CardTitle>Delete</CardTitle>
        {blocker ? (
          <p className="text-sm text-muted">{blocker}</p>
        ) : (
          <ActionForm action={deleteLawyerAction.bind(null, leagueId, lawyerId)}>
            <p className="text-sm text-muted">
              {isFirm
                ? "Removes the firm from the pool and its case list. Its lawyers stay, without a firm."
                : "Removes the lawyer from the pool and from every case."}
            </p>
            <SubmitButton variant="danger" className="w-full" confirm={`Delete ${l.name}? This can't be undone.`}>
              Delete {isFirm ? "firm" : "lawyer"}
            </SubmitButton>
          </ActionForm>
        )}
      </Card>
    </Page>
  );
}
