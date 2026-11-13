import type { Metadata } from "next";
import { Card, EmptyState, LinkButton, Page, PageHeader } from "@/components/ui";
import { getLeagueContext } from "@/server/league-context";
import { ActivityList, loadActivity } from "./activity-list";
import { ACTIVITY_PAGE_SIZE, pageOffset, parsePage } from "./paging";

export const metadata: Metadata = { title: "Activity" };

export default async function ActivityPage({ params, searchParams }: PageProps<"/leagues/[leagueId]/activity">) {
  const { leagueId } = await params;
  const ctx = await getLeagueContext(leagueId);
  const page = parsePage((await searchParams).page);

  // Fetch one extra row to know whether there's an older page.
  const rows = await loadActivity(leagueId, ACTIVITY_PAGE_SIZE + 1, pageOffset(page));
  const hasOlder = rows.length > ACTIVITY_PAGE_SIZE;
  const items = rows.slice(0, ACTIVITY_PAGE_SIZE);
  const base = `/leagues/${leagueId}/activity`;
  const pageHref = (p: number) => (p <= 1 ? base : `${base}?page=${p}`);

  return (
    <Page className="space-y-4">
      <PageHeader title="Activity" subtitle={page > 1 ? `Page ${page}` : "Every draft pick, add, drop and trade."} />
      <Card>
        {items.length > 0 ? (
          <ActivityList items={items} timeZone={ctx.settings.schedule.timezone} />
        ) : page > 1 ? (
          <EmptyState title="Nothing more to show">You&apos;ve reached the start of the league&apos;s history.</EmptyState>
        ) : (
          <EmptyState title="No moves yet">Draft picks, pickups and trades will show up here.</EmptyState>
        )}
      </Card>
      {page > 1 || hasOlder ? (
        <nav className="grid grid-cols-2 gap-2" aria-label="Pages">
          {page > 1 ? (
            <LinkButton href={pageHref(page - 1)} variant="secondary">
              ‹ Newer
            </LinkButton>
          ) : (
            <span />
          )}
          {hasOlder ? (
            <LinkButton href={pageHref(page + 1)} variant="secondary">
              Older ›
            </LinkButton>
          ) : null}
        </nav>
      ) : null}
    </Page>
  );
}
