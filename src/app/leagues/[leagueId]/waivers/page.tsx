import type { Metadata } from "next";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { leagues } from "@/db/schema";
import { Badge, Card, CardTitle, cx, EmptyState, LinkButton, ListRow, Notice, Page, PageHeader } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/ui-client";
import { formatDateTime } from "@/lib/time";
import { getLeagueContext } from "@/server/league-context";
import { loadLeagueTeams, loadPendingClaims, loadProcessedClaims } from "@/server/services/players";
import { movesClosedReason, movesOpen } from "@/server/services/transactions-moves";
import { waiverOrder } from "@/server/services/waivers-processing";
import { LawyerLink, PositionBadge } from "../players/player-bits";
import { claimOpAction } from "./actions";

export const metadata: Metadata = { title: "Waivers" };

export default async function WaiversPage({ params }: PageProps<"/leagues/[leagueId]/waivers">) {
  const { leagueId } = await params;
  const ctx = await getLeagueContext(leagueId);
  const { league, settings, team } = ctx;
  const base = `/leagues/${leagueId}`;
  const tz = settings.schedule.timezone;

  const [[fresh], teamList, pending, processed] = await Promise.all([
    // Re-read the schedule: a run may have just happened during this request.
    db.select({ next: leagues.nextWaiverRunAt, last: leagues.lastWaiverRunAt }).from(leagues).where(eq(leagues.id, leagueId)),
    loadLeagueTeams(db, leagueId),
    team ? loadPendingClaims(db, leagueId, team.id) : Promise.resolve([]),
    team ? loadProcessedClaims(db, leagueId, team.id) : Promise.resolve([]),
  ]);
  const order = waiverOrder(teamList);
  const teamsById = new Map(teamList.map((t) => [t.id, t]));
  const myPriority = team ? order.indexOf(team.id) + 1 : 0;
  const open = movesOpen(league.status);
  const closedReason = movesClosedReason(league.status);
  const hasPriorities = teamList.some((t) => t.waiverPriority !== null);

  return (
    <Page className="space-y-4">
      <PageHeader
        title="Waivers"
        subtitle={open && fresh?.next ? `Next run ${formatDateTime(fresh.next, tz)}` : undefined}
        action={
          open ? (
            <LinkButton href={`${base}/players?status=waivers`} variant="secondary">
              Find lawyers
            </LinkButton>
          ) : null
        }
      />

      {closedReason ? <Notice>{league.status === "complete" ? closedReason : "Waivers open once the draft is done."}</Notice> : null}

      {open ? (
        <Card>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">Your priority</p>
              <p className="font-display text-3xl font-bold">
                {myPriority > 0 && hasPriorities ? (
                  <>
                    #{myPriority} <span className="text-base font-semibold text-muted">of {order.length}</span>
                  </>
                ) : (
                  "–"
                )}
              </p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">Next run</p>
              <p className="font-semibold leading-tight">{fresh?.next ? formatDateTime(fresh.next, tz) : "Not scheduled"}</p>
            </div>
          </div>
          <p className="mt-3 text-sm text-muted">
            Dropped lawyers sit on waivers until the next run. Claims are decided in priority order; win one and you move to the back of
            the line. Anyone left unclaimed becomes a free agent.
          </p>
        </Card>
      ) : null}

      {team ? (
        <Card>
          <CardTitle>Your claims ({pending.length})</CardTitle>
          {pending.length === 0 ? (
            <EmptyState title="No pending claims">
              {open ? (
                <Link href={`${base}/players?status=waivers`} className="font-semibold text-brand">
                  See who&apos;s on waivers
                </Link>
              ) : null}
            </EmptyState>
          ) : (
            <>
              <p className="mb-2 text-sm text-muted">If you could win more than one, the top claim goes first.</p>
              <ol>
                {pending.map((c, i) => (
                  <li key={c.id} className="relative border-b border-line py-2.5 last:border-b-0">
                    <div className="flex items-center gap-3">
                      <span className="w-6 shrink-0 font-display text-lg font-bold text-brand">{i + 1}</span>
                      <div className="min-w-0 flex-1">
                        <p className="flex min-w-0 items-center gap-1.5">
                          <PositionBadge position={c.addPosition} />
                          <LawyerLink leagueId={leagueId} id={c.addLawyerId} name={c.addName} className="truncate" stretch />
                        </p>
                        <p className="mt-0.5 truncate text-xs text-muted">{c.dropName ? `Drops ${c.dropName}` : "No drop"}</p>
                      </div>
                    </div>
                    <ActionForm action={claimOpAction} className="relative z-10 mt-2 flex flex-wrap items-center gap-2 pl-9">
                      <input type="hidden" name="leagueId" value={leagueId} />
                      <input type="hidden" name="claimId" value={c.id} />
                      <SubmitButton name="op" value="up" variant="secondary" className="px-3" pendingText="↑" disabled={i === 0}>
                        <span aria-hidden>↑</span>
                        <span className="sr-only">Move up</span>
                      </SubmitButton>
                      <SubmitButton
                        name="op"
                        value="down"
                        variant="secondary"
                        className="px-3"
                        pendingText="↓"
                        disabled={i === pending.length - 1}
                      >
                        <span aria-hidden>↓</span>
                        <span className="sr-only">Move down</span>
                      </SubmitButton>
                      <SubmitButton name="op" value="cancel" variant="ghost" className="px-3" pendingText="…" confirm={`Cancel your claim on ${c.addName}?`}>
                        Cancel
                      </SubmitButton>
                    </ActionForm>
                  </li>
                ))}
              </ol>
            </>
          )}
        </Card>
      ) : null}

      {open && hasPriorities ? (
        <Card>
          <CardTitle>Waiver order</CardTitle>
          <div>
            {order.map((id, i) => {
              const t = teamsById.get(id)!;
              return (
                <ListRow key={id} href={`${base}/teams/${id}`} className={cx(id === team?.id && "font-semibold")}>
                  <span className="w-6 shrink-0 font-display text-lg font-bold text-muted">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate">{t.name}</span>
                  {id === team?.id ? <Badge tone="brand">You</Badge> : null}
                </ListRow>
              );
            })}
          </div>
        </Card>
      ) : null}

      {team && processed.length > 0 ? (
        <Card>
          <CardTitle>Recent results</CardTitle>
          <div>
            {processed.map((c) => (
              <ListRow key={c.id} className="relative items-start">
                <Badge tone={c.status === "won" ? "pos" : "neg"} className="mt-0.5 w-12 shrink-0 justify-center">
                  {c.status === "won" ? "Won" : "Lost"}
                </Badge>
                <div className="min-w-0 flex-1">
                  <LawyerLink leagueId={leagueId} id={c.addLawyerId} name={c.addName} className="block truncate" stretch />
                  <p className="text-xs text-muted">
                    {c.processedAt ? formatDateTime(c.processedAt, tz) : ""}
                    {c.dropName ? ` · ${c.status === "won" ? "Dropped" : "Would have dropped"} ${c.dropName}` : ""}
                  </p>
                </div>
              </ListRow>
            ))}
          </div>
        </Card>
      ) : null}
    </Page>
  );
}
