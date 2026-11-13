import "server-only";
import { cache } from "react";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { leagueMembers, leagues, teams, type League, type Team } from "@/db/schema";
import { isUuid } from "@/lib/format";
import { parseLeagueSettings, type LeagueSettings } from "@/lib/settings";
import { getCurrentUser, requireUser, type CurrentUser } from "@/server/auth/session";
import { UserError } from "@/server/action-result";

export type LeagueContext = {
  user: CurrentUser;
  league: League;
  settings: LeagueSettings;
  role: "commissioner" | "member";
  isCommissioner: boolean;
  isCreator: boolean;
  /** The signed-in user's team in this league (every member has one). */
  team: Team | null;
};

async function loadContext(user: CurrentUser, leagueId: string): Promise<LeagueContext | null> {
  if (!isUuid(leagueId)) return null;
  const [league] = await db.select().from(leagues).where(eq(leagues.id, leagueId));
  if (!league) return null;
  const [member] = await db
    .select()
    .from(leagueMembers)
    .where(and(eq(leagueMembers.leagueId, leagueId), eq(leagueMembers.userId, user.id)));
  if (!member) return null;
  const [team] = await db
    .select()
    .from(teams)
    .where(and(eq(teams.leagueId, leagueId), eq(teams.ownerId, user.id)));
  return {
    user,
    league,
    settings: parseLeagueSettings(league.settings),
    role: member.role,
    isCommissioner: member.role === "commissioner",
    isCreator: member.isCreator,
    team: team ?? null,
  };
}

/**
 * For Server Components: the league as seen by the signed-in member.
 * Redirects to /login when signed out; 404s if the league doesn't exist or the
 * user isn't a member.
 */
export const getLeagueContext = cache(async (leagueId: string): Promise<LeagueContext> => {
  const user = await requireUser();
  const ctx = await loadContext(user, leagueId);
  if (!ctx) notFound();
  return ctx;
});

/** For Server Components that are commissioner-only. */
export async function getCommissionerContext(leagueId: string): Promise<LeagueContext> {
  const ctx = await getLeagueContext(leagueId);
  if (!ctx.isCommissioner) notFound();
  return ctx;
}

/**
 * For Server Actions / Route Handlers: re-verifies the session and membership
 * from scratch. Throws UserError (use with runAction) instead of redirecting.
 */
export async function actionLeagueContext(leagueId: string, opts?: { commissioner?: boolean }): Promise<LeagueContext> {
  const user = await getCurrentUser();
  if (!user) throw new UserError("Please sign in again.");
  const ctx = await loadContext(user, leagueId);
  if (!ctx) throw new UserError("League not found.");
  if (opts?.commissioner && !ctx.isCommissioner) throw new UserError("Only commissioners can do that.");
  return ctx;
}

/** Whether the user can manage a pool's lawyers, cases and scoring events. */
export async function canManagePool(user: CurrentUser, poolId: string): Promise<boolean> {
  if (user.isAdmin) return true;
  const rows = await db
    .select({ role: leagueMembers.role })
    .from(leagueMembers)
    .innerJoin(leagues, eq(leagues.id, leagueMembers.leagueId))
    .where(and(eq(leagueMembers.userId, user.id), eq(leagues.poolId, poolId), eq(leagueMembers.role, "commissioner")))
    .limit(1);
  return rows.length > 0;
}
