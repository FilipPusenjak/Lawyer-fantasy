import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { leagueMembers, leagues, teams } from "@/db/schema";
import { SiteHeader } from "@/components/site-header";
import { Badge, Button, Card, CardTitle, EmptyState, Field, Input, LinkButton, ListRow, Page } from "@/components/ui";
import { SubmitButton } from "@/components/ui-client";
import { getCurrentUser, type CurrentUser } from "@/server/auth/session";
import { logoutAction } from "@/app/auth-actions";
import { StickyForm } from "@/app/account/sticky-form";
import { joinLeagueAction } from "@/app/join/actions";
import { TEAM_NAME_MAX } from "@/app/join/join-rules";
import { LEAGUE_STATUS_LABELS, leagueStatusTone } from "@/app/leagues/new/league-rules";

export default async function HomePage() {
  const user = await getCurrentUser();
  if (!user) return <Landing />;
  return <Dashboard user={user} />;
}

// ---------------------------------------------------------------------------
// Signed out
// ---------------------------------------------------------------------------

const STEPS = [
  {
    title: "Draft real lawyers",
    body: "Build a team of trial lawyers, appellate lawyers, prosecutors, defense attorneys and law firms.",
  },
  {
    title: "Score from public court records",
    body: "Motions granted, verdicts, settlements, appeals: real case events earn (or cost) points each week.",
  },
  {
    title: "Your commissioner approves every event",
    body: "Points only count once your league's commissioner checks the event against the public record.",
  },
];

function Landing() {
  return (
    <>
      <SiteHeader user={null} />
      <Page className="space-y-5">
        <section className="pt-4 text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-accent">For mock trial clubs</p>
          <h1 className="mt-2 text-3xl font-extrabold leading-tight">Fantasy football, but for the courtroom.</h1>
          <p className="mx-auto mt-3 max-w-sm text-muted">
            Draft real lawyers and law firms, set your lineup each week, and score points from what happens in their public court cases.
          </p>
          <div className="mx-auto mt-5 grid max-w-sm grid-cols-2 gap-2">
            <LinkButton href="/signup">Sign up</LinkButton>
            <LinkButton href="/login" variant="secondary">
              Log in
            </LinkButton>
          </div>
        </section>

        <Card>
          <CardTitle>How it works</CardTitle>
          <ol className="space-y-4">
            {STEPS.map((s, i) => (
              <li key={s.title} className="flex gap-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-soft text-sm font-bold text-brand">
                  {i + 1}
                </span>
                <div>
                  <p className="font-semibold">{s.title}</p>
                  <p className="text-sm text-muted">{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </Card>

        <p className="px-2 text-center text-xs text-muted">
          Lawyer Fantasy only uses neutral facts from public court records (case name, court, docket number, what happened and when).
          It&apos;s a game for learning how cases work, not a rating of anyone.
        </p>
      </Page>
    </>
  );
}

// ---------------------------------------------------------------------------
// Signed in
// ---------------------------------------------------------------------------

async function loadMyLeagues(userId: string) {
  return db
    .select({
      id: leagues.id,
      name: leagues.name,
      status: leagues.status,
      role: leagueMembers.role,
      teamName: teams.name,
    })
    .from(leagueMembers)
    .innerJoin(leagues, eq(leagues.id, leagueMembers.leagueId))
    .leftJoin(teams, and(eq(teams.leagueId, leagueMembers.leagueId), eq(teams.ownerId, leagueMembers.userId)))
    .where(eq(leagueMembers.userId, userId))
    .orderBy(desc(leagueMembers.joinedAt));
}

async function Dashboard({ user }: { user: CurrentUser }) {
  const myLeagues = await loadMyLeagues(user.id);

  return (
    <>
      <SiteHeader user={user} />
      <Page className="space-y-4">
        <div>
          <h1 className="text-xl font-bold">Hi, {user.displayName}!</h1>
          <p className="text-sm text-muted">
            {myLeagues.length > 0 ? "Pick a league to check your team." : "Let's get you into a league."}
          </p>
        </div>

        <Card>
          <CardTitle>My leagues</CardTitle>
          {myLeagues.length === 0 ? (
            <EmptyState title="No leagues yet">Ask your commissioner for an invite code, then join below.</EmptyState>
          ) : (
            <div>
              {myLeagues.map((l) => (
                <ListRow key={l.id} href={`/leagues/${l.id}`}>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">{l.name}</p>
                    <p className="truncate text-sm text-muted">
                      {l.teamName ?? "No team"}
                      {l.role === "commissioner" ? " · Commissioner" : ""}
                    </p>
                  </div>
                  <Badge tone={leagueStatusTone(l.status)}>{LEAGUE_STATUS_LABELS[l.status]}</Badge>
                  <span className="text-muted" aria-hidden>
                    ›
                  </span>
                </ListRow>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <CardTitle>Join a league</CardTitle>
          <StickyForm action={joinLeagueAction}>
            <Field label="Invite code">
              <Input
                name="code"
                required
                maxLength={12}
                placeholder="ABC123"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                className="font-mono uppercase tracking-widest"
              />
            </Field>
            <Field label="Your team name">
              <Input name="teamName" required minLength={2} maxLength={TEAM_NAME_MAX} autoComplete="off" />
            </Field>
            <SubmitButton className="w-full" pendingText="Joining…">
              Join league
            </SubmitButton>
          </StickyForm>
        </Card>

        {user.isAdmin ? (
          <Card className="space-y-3">
            <CardTitle>Club admin</CardTitle>
            <p className="text-sm text-muted">Start a new league and invite your club with a code.</p>
            <LinkButton href="/leagues/new" className="w-full">
              Create a league
            </LinkButton>
          </Card>
        ) : (
          <p className="px-1 text-center text-xs text-muted">Only the club admin can create new leagues.</p>
        )}

        <form action={logoutAction} className="text-center">
          <Button type="submit" variant="ghost">
            Log out
          </Button>
        </form>
      </Page>
    </>
  );
}
