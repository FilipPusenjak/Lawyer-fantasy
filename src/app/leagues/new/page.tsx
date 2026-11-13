import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { asc, count, desc } from "drizzle-orm";
import { db } from "@/db";
import { lawyers, pools } from "@/db/schema";
import { SiteHeader } from "@/components/site-header";
import { Card, CardTitle, Field, Input, Page, PageHeader, Select } from "@/components/ui";
import { SubmitButton } from "@/components/ui-client";
import { defaultLeagueSettings } from "@/lib/settings";
import { mondayOnOrBefore, todayIn } from "@/lib/time";
import { requireUser } from "@/server/auth/session";
import { StickyForm } from "@/app/account/sticky-form";
import { TEAM_NAME_MAX } from "@/app/join/join-rules";
import { createLeagueAction } from "./actions";
import { defaultSeasonStart, LEAGUE_NAME_MAX, POOL_NAME_MAX } from "./league-rules";

export const metadata: Metadata = { title: "Create a league" };

async function loadPools() {
  const [rows, counts] = await Promise.all([
    db.select({ id: pools.id, name: pools.name, isDemo: pools.isDemo }).from(pools).orderBy(asc(pools.isDemo), desc(pools.createdAt)),
    db.select({ poolId: lawyers.poolId, n: count() }).from(lawyers).groupBy(lawyers.poolId),
  ]);
  const byPool = new Map(counts.map((c) => [c.poolId, c.n]));
  return rows.map((p) => ({ ...p, lawyerCount: byPool.get(p.id) ?? 0 }));
}

export default async function NewLeaguePage() {
  const user = await requireUser();
  if (!user.isAdmin) notFound();

  const allPools = await loadPools();
  const defaults = defaultLeagueSettings();
  const now = new Date();
  const seasonStart = defaultSeasonStart(now, defaults.schedule.timezone);
  const earliest = mondayOnOrBefore(todayIn(defaults.schedule.timezone, now));
  const teamOptions = Array.from({ length: 11 }, (_, i) => i + 2);

  return (
    <>
      <SiteHeader user={user} />
      <Page>
        <PageHeader title="Create a league" subtitle="You'll be the commissioner. You can fine-tune scoring and schedule later." />
        <StickyForm action={createLeagueAction} className="space-y-4">
          <Card className="space-y-3">
            <CardTitle>League</CardTitle>
            <Field label="League name">
              <Input name="name" required minLength={2} maxLength={LEAGUE_NAME_MAX} placeholder="Mock Trial Club 2026" autoComplete="off" />
            </Field>
            <Field label="Your team name">
              <Input name="teamName" required minLength={2} maxLength={TEAM_NAME_MAX} autoComplete="off" />
            </Field>
            <Field label="Max teams" hint="Between 2 and 12.">
              <Select name="maxTeams" defaultValue={String(defaults.maxTeams)}>
                {teamOptions.map((n) => (
                  <option key={n} value={n}>
                    {n} teams
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Season starts" hint="Weeks run Monday to Sunday. If you pick another day, we'll use the next Monday.">
              <Input name="seasonStart" type="date" required defaultValue={seasonStart} min={earliest} />
            </Field>
          </Card>

          <Card className="space-y-3">
            <CardTitle>Player pool</CardTitle>
            <p className="text-sm text-muted">
              The pool holds the lawyers, firms, cases and scoring events your league plays with. Leagues can share a pool.
            </p>
            <Field label="Use pool">
              <Select name="pool" defaultValue={allPools[0]?.id ?? "new"}>
                {allPools.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.isDemo ? " (demo)" : ""} · {p.lawyerCount} {p.lawyerCount === 1 ? "lawyer" : "lawyers"}
                  </option>
                ))}
                <option value="new">Create a new pool…</option>
              </Select>
            </Field>
            <Field label="New pool name" hint="Only needed if you picked “Create a new pool”.">
              <Input name="newPoolName" maxLength={POOL_NAME_MAX} placeholder="Real cases 2026" autoComplete="off" />
            </Field>
          </Card>

          <SubmitButton className="w-full" pendingText="Creating league…">
            Create league
          </SubmitButton>
        </StickyForm>
      </Page>
    </>
  );
}
