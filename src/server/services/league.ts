/**
 * League creation, joining and loading. No request/cookie access here so the
 * seed script can reuse it.
 */
import { randomInt } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { DbOrTx } from "@/db";
import { drafts, leagueMembers, leagues, pools, teams, type League } from "@/db/schema";
import { UserError } from "@/server/action-result";
import { defaultLeagueSettings, parseLeagueSettings, rosterSize, type LeagueSettings } from "@/lib/settings";
import { mondayOnOrAfter, nextWeeklyTime, todayIn } from "@/lib/time";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

export function generateInviteCode(): string {
  let s = "";
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

export function normalizeInviteCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export type LoadedLeague = League & { parsedSettings: LeagueSettings };

export async function loadLeague(db: DbOrTx, leagueId: string): Promise<LoadedLeague | null> {
  const [l] = await db.select().from(leagues).where(eq(leagues.id, leagueId));
  if (!l) return null;
  return { ...l, parsedSettings: parseLeagueSettings(l.settings) };
}

export async function leagueTeams(db: DbOrTx, leagueId: string) {
  return db.select().from(teams).where(eq(teams.leagueId, leagueId)).orderBy(asc(teams.draftPosition), asc(teams.createdAt));
}

export async function createPool(db: DbOrTx, args: { name: string; isDemo?: boolean; createdBy: string | null }) {
  const [p] = await db.insert(pools).values({ name: args.name, isDemo: args.isDemo ?? false, createdBy: args.createdBy }).returning();
  return p;
}

export async function createLeague(
  db: DbOrTx,
  args: {
    name: string;
    poolId: string;
    createdBy: string;
    teamName: string;
    seasonStart?: string;
    settings?: LeagueSettings;
  },
): Promise<League> {
  const settings = args.settings ?? defaultLeagueSettings();
  const seasonStart = args.seasonStart ?? mondayOnOrAfter(todayIn(settings.schedule.timezone));
  let league: League | undefined;
  for (let attempt = 0; attempt < 5 && !league; attempt++) {
    const rows = await db
      .insert(leagues)
      .values({
        name: args.name,
        poolId: args.poolId,
        inviteCode: generateInviteCode(),
        createdBy: args.createdBy,
        settings,
        seasonStart,
      })
      .onConflictDoNothing({ target: leagues.inviteCode })
      .returning();
    league = rows[0];
  }
  if (!league) throw new Error("Could not generate a unique invite code");
  await db.insert(leagueMembers).values({ leagueId: league.id, userId: args.createdBy, role: "commissioner", isCreator: true });
  await db.insert(teams).values({ leagueId: league.id, ownerId: args.createdBy, name: args.teamName });
  await db.insert(drafts).values({
    leagueId: league.id,
    secondsPerPick: settings.draft.secondsPerPick,
    rounds: rosterSize(settings.roster),
  });
  return league;
}

/** Join a league by invite code, creating the member's team. Returns the league id. */
export async function joinLeague(db: DbOrTx, args: { inviteCode: string; userId: string; teamName: string }): Promise<string> {
  const code = normalizeInviteCode(args.inviteCode);
  const [league] = await db.select().from(leagues).where(eq(leagues.inviteCode, code));
  if (!league) throw new UserError("No league found with that invite code.");
  const [existing] = await db
    .select()
    .from(leagueMembers)
    .where(and(eq(leagueMembers.leagueId, league.id), eq(leagueMembers.userId, args.userId)));
  if (existing) return league.id;
  if (league.status === "drafting") throw new UserError("This league's draft is in progress, so it can't take new teams.");
  if (league.status === "complete") throw new UserError("This league's season is over.");
  if (league.status !== "setup") throw new UserError("This league has already drafted, so it can't take new teams.");
  const settings = parseLeagueSettings(league.settings);
  const current = await db.select({ id: teams.id }).from(teams).where(eq(teams.leagueId, league.id));
  if (current.length >= settings.maxTeams) throw new UserError("This league is full.");
  const name = args.teamName.trim();
  if (name.length < 2 || name.length > 40) throw new UserError("Team name must be 2–40 characters.");
  await db.insert(leagueMembers).values({ leagueId: league.id, userId: args.userId, role: "member" });
  await db.insert(teams).values({ leagueId: league.id, ownerId: args.userId, name });
  return league.id;
}

/** Compute and store when waivers next run (strictly after `after`). */
export async function scheduleNextWaiverRun(db: DbOrTx, leagueId: string, settings: LeagueSettings, after: Date): Promise<Date> {
  const next = nextWeeklyTime(after, settings.waivers.processDay, settings.waivers.processTime, settings.schedule.timezone);
  await db.update(leagues).set({ nextWaiverRunAt: next }).where(eq(leagues.id, leagueId));
  return next;
}
