import type { Metadata } from "next";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { teams, users } from "@/db/schema";
import { Badge, Card, CardTitle, ListRow, Page, PageHeader } from "@/components/ui";
import { getLeagueContext } from "@/server/league-context";
import { LEAGUE_STATUS_LABELS } from "@/app/leagues/new/league-rules";
import { inviteUrl } from "./invite-url";
import { ShareInvite } from "./share-invite";

export const metadata: Metadata = { title: "League" };

function MenuRow({ href, label, hint }: { href: string; label: string; hint?: string }) {
  return (
    <ListRow href={href}>
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{label}</p>
        {hint ? <p className="truncate text-sm text-muted">{hint}</p> : null}
      </div>
      <span className="text-muted" aria-hidden>
        ›
      </span>
    </ListRow>
  );
}

export default async function MorePage({ params }: PageProps<"/leagues/[leagueId]/more">) {
  const { leagueId } = await params;
  const ctx = await getLeagueContext(leagueId);
  const base = `/leagues/${leagueId}`;

  const [teamRows, url] = await Promise.all([
    db
      .select({ id: teams.id, name: teams.name, owner: users.displayName })
      .from(teams)
      .innerJoin(users, eq(users.id, teams.ownerId))
      .where(eq(teams.leagueId, leagueId))
      .orderBy(asc(teams.name)),
    ctx.isCommissioner ? inviteUrl(ctx.league.inviteCode) : Promise.resolve(""),
  ]);

  return (
    <Page className="space-y-4">
      <PageHeader title="League" subtitle={`${ctx.league.name} · ${LEAGUE_STATUS_LABELS[ctx.league.status]}`} />

      <Card>
        <MenuRow href={`${base}/standings`} label="Standings" hint="Records, points and the playoff bracket" />
        <MenuRow href={`${base}/rankings`} label="Rankings & projections" hint="Projected points and rankings for every lawyer and firm" />
        <MenuRow href={`${base}/matchups`} label="Matchups" hint="Every matchup, period by period" />
        <MenuRow href={`${base}/trades`} label="Trades" hint="Offers you've sent and received" />
        <MenuRow href={`${base}/waivers`} label="Waiver claims" hint="Your pending claims and waiver order" />
        <MenuRow
          href={`${base}/draft`}
          label="Draft room"
          hint={ctx.league.status === "setup" ? "Get ready for draft day" : "Draft board and results"}
        />
        <MenuRow href={`${base}/activity`} label="Activity" hint="Every pick, add, drop and trade" />
        {ctx.isCommissioner ? (
          <MenuRow href={`${base}/commish`} label="Commissioner tools" hint="Settings, members, player pool, scoring events" />
        ) : null}
      </Card>

      <Card>
        <CardTitle>Teams ({teamRows.length})</CardTitle>
        <div>
          {teamRows.map((t) => (
            <ListRow key={t.id} href={`${base}/teams/${t.id}`}>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{t.name}</p>
                <p className="truncate text-sm text-muted">{t.owner}</p>
              </div>
              {t.id === ctx.team?.id ? <Badge tone="brand">You</Badge> : null}
              <span className="text-muted" aria-hidden>
                ›
              </span>
            </ListRow>
          ))}
        </div>
      </Card>

      {ctx.isCommissioner ? (
        <Card>
          <CardTitle>Invite friends</CardTitle>
          {ctx.league.status === "setup" ? (
            <ShareInvite code={ctx.league.inviteCode} url={url} leagueName={ctx.league.name} />
          ) : (
            <p className="text-sm text-muted">
              Invite code <span className="font-mono font-semibold text-ink">{ctx.league.inviteCode}</span>. New teams can only join before
              the draft.
            </p>
          )}
        </Card>
      ) : null}

      <Card>
        <MenuRow href="/" label="All my leagues" />
        <MenuRow href="/account" label="My account" hint={`Logged in as @${ctx.user.username}`} />
      </Card>
    </Page>
  );
}
