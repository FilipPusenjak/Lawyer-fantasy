import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { Badge, Button, Card, EmptyState, Input, ListRow, Page, PageHeader, Select } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/ui-client";
import { plural } from "@/lib/format";
import { CASE_TYPE_LABELS } from "@/lib/settings";
import { canManagePool, getCommissionerContext } from "@/server/league-context";
import { listPoolCases } from "@/server/services/pool";
import { createCaseAction } from "../actions";
import { BackLink, CaseFields, Disclosure, PoolTabs } from "../pool-ui";
import { listFilters } from "../pool-rules";

export const metadata: Metadata = { title: "Cases" };

const LIST_LIMIT = 300;

export default async function PoolCasesPage({ params, searchParams }: PageProps<"/leagues/[leagueId]/commish/pool/cases">) {
  const { leagueId } = await params;
  const ctx = await getCommissionerContext(leagueId);
  if (!(await canManagePool(ctx.user, ctx.league.poolId))) notFound();
  const f = listFilters(await searchParams);
  const rows = await listPoolCases(db, ctx.league.poolId, { q: f.q, status: f.status, limit: LIST_LIMIT });
  const base = `/leagues/${leagueId}/commish/pool`;
  const filtered = !!(f.q || f.status);

  return (
    <Page className="space-y-4">
      <BackLink href={`/leagues/${leagueId}/commish`} label="Commissioner" />
      <PageHeader title="Player pool" subtitle="Public court cases. Lawyers score from events in the cases they appear in." />
      <PoolTabs leagueId={leagueId} active="cases" />

      <Disclosure summary="Add a case">
        <ActionForm action={createCaseAction.bind(null, leagueId)}>
          <CaseFields />
          <SubmitButton className="w-full">Add case</SubmitButton>
        </ActionForm>
      </Disclosure>

      <form action={`${base}/cases`} className="flex gap-2" role="search">
        <Input name="q" defaultValue={f.q} placeholder="Caption, docket, court" aria-label="Search cases" className="min-w-0 flex-1" />
        <Select name="status" defaultValue={f.status ?? ""} aria-label="Status" className="w-28 shrink-0">
          <option value="">All</option>
          <option value="active">Active</option>
          <option value="closed">Closed</option>
        </Select>
        <Button type="submit" variant="secondary" className="shrink-0">
          Go
        </Button>
      </form>

      <Card>
        {rows.length === 0 ? (
          <EmptyState title={filtered ? "No matches" : "No cases yet"}>
            {filtered ? "Try a different search." : "Add a case above or paste a list on the Import tab."}
          </EmptyState>
        ) : (
          <div>
            {rows.map((c) => (
              <ListRow key={c.id} href={`${base}/cases/${c.id}`}>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{c.caption}</p>
                  <p className="truncate text-sm text-muted">
                    {[c.court, c.docketNumber, CASE_TYPE_LABELS[c.caseType]].filter(Boolean).join(" · ")}
                  </p>
                  <p className="text-xs text-muted">{c.appearanceCount === 0 ? "No lawyers added yet" : plural(c.appearanceCount, "lawyer")}</p>
                </div>
                {c.status === "closed" ? <Badge>Closed</Badge> : null}
                <span className="text-muted" aria-hidden>
                  ›
                </span>
              </ListRow>
            ))}
            {rows.length >= LIST_LIMIT ? <p className="pt-2 text-sm text-muted">Showing the first {LIST_LIMIT}. Search to narrow it down.</p> : null}
          </div>
        )}
      </Card>
    </Page>
  );
}
