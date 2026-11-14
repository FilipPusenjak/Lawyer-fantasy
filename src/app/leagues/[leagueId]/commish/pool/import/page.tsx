import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card, CardTitle, Page, PageHeader } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/ui-client";
import { canManagePool, getCommissionerContext } from "@/server/league-context";
import { importCsvAction } from "../actions";
import { IMPORT_FORMATS, MAX_IMPORT_ROWS, type ImportKind } from "../csv";
import { BackLink, PoolTabs } from "../pool-ui";
import { CsvImportFields } from "./csv-import-fields";

export const metadata: Metadata = { title: "Import" };

const STEPS: { kind: ImportKind; title: string; button: string }[] = [
  { kind: "lawyers", title: "1. Lawyers & firms", button: "Import lawyers" },
  { kind: "cases", title: "2. Cases", button: "Import cases" },
  { kind: "appearances", title: "3. Who's on which case", button: "Import appearances" },
];

export default async function PoolImportPage({ params }: PageProps<"/leagues/[leagueId]/commish/pool/import">) {
  const { leagueId } = await params;
  const ctx = await getCommissionerContext(leagueId);
  if (!(await canManagePool(ctx.user, ctx.league.poolId))) notFound();

  return (
    <Page className="space-y-4">
      <BackLink href={`/leagues/${leagueId}/commish`} label="Commissioner" />
      <PageHeader
        title="Player pool"
        subtitle={`Paste rows from a spreadsheet or CSV, up to ${MAX_IMPORT_ROWS} at a time. Do lawyers and cases first, then link them.`}
      />
      <PoolTabs leagueId={leagueId} active="import" />

      {STEPS.map((s) => {
        const fmt = IMPORT_FORMATS[s.kind];
        return (
          <Card key={s.kind}>
            <CardTitle>{s.title}</CardTitle>
            <p className="mb-1 text-sm">
              Columns: <code className="break-all rounded bg-surface-2 px-1 py-0.5 text-xs">{fmt.header}</code>
            </p>
            <ul className="mb-3 list-disc space-y-0.5 pl-5 text-xs text-muted">
              {fmt.help.map((h) => (
                <li key={h}>{h}</li>
              ))}
              <li>The header row is optional. Blank lines are ignored. Put commas inside &quot;quotes&quot;.</li>
            </ul>
            <ActionForm action={importCsvAction.bind(null, leagueId, s.kind)} resetOnSuccess>
              <CsvImportFields kind={s.kind} placeholder={fmt.example} />
              <SubmitButton className="w-full" pendingText="Importing…">
                {s.button}
              </SubmitButton>
            </ActionForm>
          </Card>
        );
      })}
    </Page>
  );
}
