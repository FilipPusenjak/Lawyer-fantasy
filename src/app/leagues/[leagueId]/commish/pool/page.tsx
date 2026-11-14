import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { Badge, Button, Card, EmptyState, Input, ListRow, Page, PageHeader, Select } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/ui-client";
import { POSITION_LABELS, POSITION_SHORT } from "@/lib/settings";
import { canManagePool, getCommissionerContext } from "@/server/league-context";
import { listPoolFirms, listPoolLawyers, poolCounts } from "@/server/services/pool";
import { poolCourtStats } from "../court/court-data";
import { PoolCourtCard } from "../court/court-ui";
import { createLawyerAction } from "./actions";
import { BackLink, Disclosure, LawyerFields, PoolTabs } from "./pool-ui";
import { INDIVIDUAL_POSITIONS, listFilters } from "./pool-rules";

export const metadata: Metadata = { title: "Player pool" };

const LIST_LIMIT = 300;

export default async function PoolLawyersPage({ params, searchParams }: PageProps<"/leagues/[leagueId]/commish/pool">) {
  const { leagueId } = await params;
  const ctx = await getCommissionerContext(leagueId);
  if (!(await canManagePool(ctx.user, ctx.league.poolId))) notFound();
  const f = listFilters(await searchParams);
  const poolId = ctx.league.poolId;
  const [rows, firms, counts, courtStats] = await Promise.all([
    listPoolLawyers(db, poolId, { kind: "lawyer", q: f.q, position: f.position, limit: LIST_LIMIT }),
    listPoolFirms(db, poolId),
    poolCounts(db, poolId),
    poolCourtStats(db, poolId),
  ]);
  const base = `/leagues/${leagueId}/commish/pool`;
  const filtered = !!(f.q || f.position);

  return (
    <Page className="space-y-4">
      <BackLink href={`/leagues/${leagueId}/commish`} label="Commissioner" />
      <PageHeader
        title="Player pool"
        subtitle={`${counts.lawyers} lawyers · ${counts.firms} firms · ${counts.cases} cases. Shared by every league that uses this pool.`}
      />
      <PoolTabs leagueId={leagueId} active="lawyers" />

      <Disclosure summary="Add a lawyer">
        <ActionForm action={createLawyerAction.bind(null, leagueId)} resetOnSuccess>
          <LawyerFields firms={firms} />
          <SubmitButton className="w-full">Add lawyer</SubmitButton>
        </ActionForm>
      </Disclosure>

      <form action={base} className="flex gap-2" role="search">
        <Input name="q" defaultValue={f.q} placeholder="Name, firm, org" aria-label="Search lawyers" className="min-w-0 flex-1" />
        <Select name="pos" defaultValue={f.position ?? ""} aria-label="Position" className="w-24 shrink-0">
          <option value="">All</option>
          {INDIVIDUAL_POSITIONS.map((p) => (
            <option key={p} value={p}>
              {POSITION_SHORT[p]}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="secondary" className="shrink-0">
          Go
        </Button>
      </form>

      <Card>
        {rows.length === 0 ? (
          <EmptyState title={filtered ? "No matches" : "No lawyers yet"}>
            {filtered ? "Try a different search." : "Add lawyers above or paste a list on the Import tab."}
          </EmptyState>
        ) : (
          <div>
            {filtered ? <p className="mb-1 text-sm text-muted">{rows.length} found</p> : null}
            {rows.map((l) => (
              <ListRow key={l.id} href={`${base}/lawyers/${l.id}`}>
                <Badge tone="brand" className="w-12 shrink-0 justify-center">
                  {POSITION_SHORT[l.position]}
                </Badge>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{l.name}</p>
                  <p className="truncate text-sm text-muted">
                    {[l.firmName, l.organization].filter(Boolean).join(" · ") || POSITION_LABELS[l.position]}
                  </p>
                </div>
                {l.preseasonRank ? <span className="shrink-0 text-sm tabular-nums text-muted">#{l.preseasonRank}</span> : null}
                <span className="text-muted" aria-hidden>
                  ›
                </span>
              </ListRow>
            ))}
            {rows.length >= LIST_LIMIT ? <p className="pt-2 text-sm text-muted">Showing the first {LIST_LIMIT}. Search to narrow it down.</p> : null}
          </div>
        )}
      </Card>

      <PoolCourtCard leagueId={leagueId} stats={courtStats} />
    </Page>
  );
}
