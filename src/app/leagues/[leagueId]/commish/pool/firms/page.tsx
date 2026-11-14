import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { Button, Card, EmptyState, Input, ListRow, Page, PageHeader } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/ui-client";
import { plural } from "@/lib/format";
import { canManagePool, getCommissionerContext } from "@/server/league-context";
import { firmMemberCounts, listPoolLawyers } from "@/server/services/pool";
import { createFirmAction } from "../actions";
import { BackLink, Disclosure, FirmFields, PoolTabs } from "../pool-ui";
import { listFilters } from "../pool-rules";

export const metadata: Metadata = { title: "Firms" };

export default async function PoolFirmsPage({ params, searchParams }: PageProps<"/leagues/[leagueId]/commish/pool/firms">) {
  const { leagueId } = await params;
  const ctx = await getCommissionerContext(leagueId);
  if (!(await canManagePool(ctx.user, ctx.league.poolId))) notFound();
  const f = listFilters(await searchParams);
  const poolId = ctx.league.poolId;
  const [rows, members] = await Promise.all([
    listPoolLawyers(db, poolId, { kind: "firm", q: f.q }),
    firmMemberCounts(db, poolId),
  ]);
  const base = `/leagues/${leagueId}/commish/pool`;

  return (
    <Page className="space-y-4">
      <BackLink href={`/leagues/${leagueId}/commish`} label="Commissioner" />
      <PageHeader title="Player pool" subtitle="Law firms play the FIRM spot and score a share of every event on their cases." />
      <PoolTabs leagueId={leagueId} active="firms" />

      <Disclosure summary="Add a firm">
        <ActionForm action={createFirmAction.bind(null, leagueId)} resetOnSuccess>
          <FirmFields />
          <SubmitButton className="w-full">Add firm</SubmitButton>
        </ActionForm>
      </Disclosure>

      <form action={`${base}/firms`} className="flex gap-2" role="search">
        <Input name="q" defaultValue={f.q} placeholder="Search firms" aria-label="Search firms" className="min-w-0 flex-1" />
        <Button type="submit" variant="secondary" className="shrink-0">
          Go
        </Button>
      </form>

      <Card>
        {rows.length === 0 ? (
          <EmptyState title={f.q ? "No matches" : "No firms yet"}>
            {f.q ? "Try a different search." : "Add a firm above, or import lawyers with a firm column and firms are created for you."}
          </EmptyState>
        ) : (
          rows.map((l) => (
            <ListRow key={l.id} href={`${base}/lawyers/${l.id}`}>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{l.name}</p>
                <p className="truncate text-sm text-muted">
                  {[plural(members.get(l.id) ?? 0, "lawyer"), l.organization].filter(Boolean).join(" · ")}
                </p>
              </div>
              {l.preseasonRank ? <span className="shrink-0 text-sm tabular-nums text-muted">#{l.preseasonRank}</span> : null}
              <span className="text-muted" aria-hidden>
                ›
              </span>
            </ListRow>
          ))
        )}
      </Card>
    </Page>
  );
}
