import Link from "next/link";
import { LeagueNav } from "@/components/league-nav";
import { getLeagueContext } from "@/server/league-context";
import { runLeagueMaintenance } from "@/server/services/maintenance";

export default async function LeagueLayout({ children, params }: LayoutProps<"/leagues/[leagueId]">) {
  const { leagueId } = await params;
  const ctx = await getLeagueContext(leagueId);
  // Lazily process anything that came due (waivers, trade reviews, the draft
  // clock) so the league stays current even between daily cron runs. A failure
  // here must not take every league page down (the cron and the next page view
  // retry it).
  try {
    await runLeagueMaintenance(leagueId);
  } catch (e) {
    console.error(`League maintenance failed for league ${leagueId}`, e);
  }
  return (
    <>
      <header className="sticky top-0 z-20 border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-xl items-center gap-3 px-4 py-1.5">
          <Link href="/" className="-ml-1 inline-flex min-h-11 shrink-0 items-center px-1 text-sm font-semibold text-brand" aria-label="All leagues">
            ‹ Leagues
          </Link>
          <div className="min-w-0 flex-1 text-center">
            <p className="truncate text-sm font-bold">{ctx.league.name}</p>
            {ctx.team ? <p className="truncate text-xs text-muted">{ctx.team.name}</p> : null}
          </div>
          <span className="w-16 text-right text-xs font-semibold text-accent">{ctx.isCommissioner ? "Commish" : ""}</span>
        </div>
      </header>
      <main className="flex-1">{children}</main>
      <LeagueNav leagueId={leagueId} />
    </>
  );
}
