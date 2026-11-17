import type { Metadata } from "next";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { teams, users } from "@/db/schema";
import { Badge, Card, CardTitle, EmptyState, Field, LinkButton, Notice, Page, PageHeader, Points, Textarea } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/ui-client";
import { isUuid } from "@/lib/format";
import { POSITION_LABELS, POSITION_SHORT, POSITIONS } from "@/lib/settings";
import { currentWeek } from "@/lib/time";
import { getLeagueContext } from "@/server/league-context";
import { leagueClock } from "@/server/services/lineups";
import { getTeamRoster, maxRosterSize, type RosterLawyer } from "@/server/services/roster";
import { getScoreboard } from "@/server/services/scores";
import { TRADE_MESSAGE_MAX, tradeWindowError } from "@/server/services/trades";
import { proposeTradeAction } from "../actions";
import { firstParam, idParams, reviewText, tradeDeadlineText } from "../trade-labels";
import { TeamPicker, TradeSummary } from "./trade-form-client";

export const metadata: Metadata = { title: "New trade" };

export default async function NewTradePage({ params, searchParams }: PageProps<"/leagues/[leagueId]/trades/new">) {
  const { leagueId } = await params;
  const sp = await searchParams;
  const ctx = await getLeagueContext(leagueId);
  const { league, settings } = ctx;
  const base = `/leagues/${leagueId}`;

  const week = currentWeek(new Date(), leagueClock({ seasonStart: league.seasonStart, settings }));
  const windowArgs = { leagueStatus: league.status, deadlineWeek: settings.trades.deadlineWeek, currentWeek: week };
  const windowErr = tradeWindowError(windowArgs);
  const subtitle = tradeDeadlineText({ ...windowArgs, seasonStart: league.seasonStart });
  const back = (
    <LinkButton href={`${base}/trades`} variant="secondary">
      All trades
    </LinkButton>
  );

  if (!ctx.team || windowErr) {
    return (
      <Page className="space-y-4">
        <PageHeader title="New trade" subtitle={subtitle} action={back} />
        <Notice tone="warn">{!ctx.team ? "You don't have a team in this league, so you can't trade." : windowErr}</Notice>
      </Page>
    );
  }
  const myTeam = ctx.team;

  const otherTeams = (
    await db
      .select({ id: teams.id, name: teams.name, owner: users.displayName })
      .from(teams)
      .innerJoin(users, eq(users.id, teams.ownerId))
      .where(eq(teams.leagueId, leagueId))
      .orderBy(asc(teams.name))
  ).filter((t) => t.id !== myTeam.id);

  const withId = firstParam(sp.with) ?? "";
  const other = otherTeams.find((t) => t.id === withId);
  const preGive = new Set(idParams(sp.give, isUuid));
  const preGet = new Set(idParams(sp.get, isUuid));

  const [myRoster, theirRoster, scoreboard] = await Promise.all([
    getTeamRoster(db, myTeam.id),
    other ? getTeamRoster(db, other.id) : Promise.resolve([] as RosterLawyer[]),
    getScoreboard(leagueId),
  ]);
  const points = (id: string) => scoreboard.lawyerTotal(id);
  const maxRoster = maxRosterSize(settings);

  return (
    <Page className="space-y-4">
      <PageHeader title="New trade" subtitle={subtitle} action={back} />

      <Card>
        {otherTeams.length === 0 ? (
          <p className="text-sm text-muted">There are no other teams to trade with yet.</p>
        ) : (
          <TeamPicker action={`${base}/trades/new`} teams={otherTeams} value={other?.id ?? ""} />
        )}
      </Card>

      {other ? (
        // Picking another team only changes ?with=, which doesn't remount client
        // state: key by team so checkboxes, counts and warnings start fresh.
        <ActionForm key={other.id} action={proposeTradeAction} className="space-y-4">
          <input type="hidden" name="leagueId" value={leagueId} />
          <input type="hidden" name="recipientTeamId" value={other.id} />

          <Card>
            <CardTitle action={<span className="text-xs text-muted">{myRoster.length} on roster</span>}>You give</CardTitle>
            <LawyerChecklist name="give" lawyers={myRoster} points={points} checked={preGive} empty="Your roster is empty." />
          </Card>

          <Card>
            <CardTitle action={<span className="text-xs text-muted">{theirRoster.length} on roster</span>}>
              You get from {other.name}
            </CardTitle>
            <LawyerChecklist name="get" lawyers={theirRoster} points={points} checked={preGet} empty="Their roster is empty." />
          </Card>

          <Card className="space-y-3">
            <Field label="Message (optional)" hint={`Up to ${TRADE_MESSAGE_MAX} characters. Keep it friendly!`}>
              <Textarea name="message" maxLength={TRADE_MESSAGE_MAX} rows={3} placeholder="Why is this a good deal?" />
            </Field>
            <TradeSummary
              theirName={other.name}
              mySize={myRoster.length}
              theirSize={theirRoster.length}
              maxRoster={maxRoster}
              initialGive={myRoster.filter((l) => preGive.has(l.id)).length}
              initialGet={theirRoster.filter((l) => preGet.has(l.id)).length}
            />
            <p className="text-xs text-muted">{reviewText(settings.trades.reviewHours)}</p>
            <SubmitButton className="w-full" pendingText="Sending…">
              Send offer
            </SubmitButton>
          </Card>
        </ActionForm>
      ) : otherTeams.length > 0 ? (
        <EmptyState title="Pick a team to see their roster.">You choose who you give and who you get.</EmptyState>
      ) : null}
    </Page>
  );
}

function LawyerChecklist({
  name,
  lawyers,
  points,
  checked,
  empty,
}: {
  name: "give" | "get";
  lawyers: RosterLawyer[];
  points: (id: string) => number;
  checked: Set<string>;
  empty: string;
}) {
  if (lawyers.length === 0) return <p className="text-sm text-muted">{empty}</p>;
  const order = (p: RosterLawyer["position"]) => POSITIONS.indexOf(p);
  const sorted = [...lawyers].sort(
    (a, b) => order(a.position) - order(b.position) || points(b.id) - points(a.id) || a.name.localeCompare(b.name),
  );
  return (
    // min-w-0: a fieldset defaults to min-content width, which would stop long names from truncating.
    <fieldset className="min-w-0">
      <legend className="sr-only">{name === "give" ? "Lawyers you give" : "Lawyers you get"}</legend>
      <div className="mb-1 flex justify-end text-xs font-semibold uppercase tracking-wide text-muted">Season pts</div>
      {sorted.map((l) => (
        <label
          key={l.id}
          className="flex min-h-12 cursor-pointer items-center gap-3 border-b border-line py-2 last:border-b-0 active:bg-surface-2"
        >
          <input type="checkbox" name={name} value={l.id} defaultChecked={checked.has(l.id)} className="h-5 w-5 shrink-0 accent-brand" />
          <Badge className="w-11 shrink-0 justify-center" tone={l.position === "firm" ? "accent" : "neutral"}>
            <abbr title={POSITION_LABELS[l.position]} className="no-underline">
              {POSITION_SHORT[l.position]}
            </abbr>
          </Badge>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{l.name}</span>
            {l.organization ? <span className="block truncate text-xs text-muted">{l.organization}</span> : null}
          </span>
          <Points value={points(l.id)} className="shrink-0 text-sm" />
        </label>
      ))}
    </fieldset>
  );
}
