import type { Metadata } from "next";
import { and, count, eq } from "drizzle-orm";
import { db } from "@/db";
import { leagueMembers, leagues, teams } from "@/db/schema";
import { SiteHeader } from "@/components/site-header";
import { Card, Field, Input, LinkButton, Notice, Page, PageHeader } from "@/components/ui";
import { SubmitButton } from "@/components/ui-client";
import { parseLeagueSettings } from "@/lib/settings";
import { getCurrentUser } from "@/server/auth/session";
import { normalizeInviteCode } from "@/server/services/league";
import { authHref } from "@/app/account/rules";
import { StickyForm } from "@/app/account/sticky-form";
import { joinLeagueAction } from "./actions";
import { joinClosedReason, joinPath, TEAM_NAME_MAX } from "./join-rules";

export const metadata: Metadata = { title: "Join a league" };

async function findLeague(code: string, userId: string | null) {
  const [league] = await db
    .select({ id: leagues.id, name: leagues.name, status: leagues.status, settings: leagues.settings })
    .from(leagues)
    .where(eq(leagues.inviteCode, code));
  if (!league) return null;
  const [[{ n: teamCount }], member] = await Promise.all([
    db.select({ n: count() }).from(teams).where(eq(teams.leagueId, league.id)),
    userId
      ? db
          .select({ userId: leagueMembers.userId })
          .from(leagueMembers)
          .where(and(eq(leagueMembers.leagueId, league.id), eq(leagueMembers.userId, userId)))
          .then((r) => r[0])
      : Promise.resolve(undefined),
  ]);
  return {
    id: league.id,
    name: league.name,
    status: league.status,
    teamCount,
    maxTeams: parseLeagueSettings(league.settings).maxTeams,
    isMember: !!member,
  };
}

export default async function JoinPage({ searchParams }: PageProps<"/join">) {
  const rawCode = (await searchParams).code;
  const code = normalizeInviteCode(typeof rawCode === "string" ? rawCode : (rawCode?.[0] ?? "")).slice(0, 12);
  const user = await getCurrentUser();
  const league = code ? await findLeague(code, user?.id ?? null) : null;
  const next = code ? joinPath(code) : "/join";
  const closedReason = league ? joinClosedReason(league) : null;

  return (
    <>
      <SiteHeader user={user} />
      <Page className="space-y-4">
        <PageHeader
          title={league ? `Join ${league.name}` : "Join a league"}
          subtitle={
            league ? `${league.teamCount} of ${league.maxTeams} teams have joined.` : "Enter the invite code from your commissioner."
          }
        />

        {code && !league ? (
          <Notice tone="warn">We couldn&apos;t find a league with the code {code}. Double-check it with your commissioner.</Notice>
        ) : null}

        {!user ? (
          <Card className="space-y-3">
            <p className="text-sm">
              {league ? "You're invited! " : ""}Create a free account (or log in) and we&apos;ll bring you right back here to pick your team
              name.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <LinkButton href={authHref("/signup", next)}>Sign up</LinkButton>
              <LinkButton href={authHref("/login", next)} variant="secondary">
                Log in
              </LinkButton>
            </div>
          </Card>
        ) : league?.isMember ? (
          <Card className="space-y-3">
            <p className="text-sm">You&apos;re already in this league.</p>
            <LinkButton href={`/leagues/${league.id}`} className="w-full">
              Go to {league.name}
            </LinkButton>
          </Card>
        ) : closedReason ? (
          <Card className="space-y-3">
            <Notice tone="warn">{closedReason}</Notice>
            <p className="text-sm text-muted">Ask your commissioner if there&apos;s another league you can join.</p>
            <div className="grid grid-cols-2 gap-2">
              <LinkButton href="/join" variant="secondary">
                Use another code
              </LinkButton>
              <LinkButton href="/" variant="secondary">
                My leagues
              </LinkButton>
            </div>
          </Card>
        ) : (
          <Card>
            <StickyForm action={joinLeagueAction}>
              <Field label="Invite code">
                <Input
                  name="code"
                  required
                  maxLength={12}
                  defaultValue={code}
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  className="font-mono uppercase tracking-widest"
                />
              </Field>
              <Field label="Your team name" hint="You can be creative. Keep it friendly!">
                <Input name="teamName" required minLength={2} maxLength={TEAM_NAME_MAX} autoComplete="off" autoFocus={!!league} />
              </Field>
              <SubmitButton className="w-full" pendingText="Joining…">
                Join league
              </SubmitButton>
            </StickyForm>
          </Card>
        )}
      </Page>
    </>
  );
}
