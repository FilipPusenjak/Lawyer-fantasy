/**
 * Commissioner admin: league settings (one save per section) and members
 * (co-commissioners, team names, removal, invite code, temporary passwords).
 *
 * Settings writes lock the league's drafts row and league row (same order as
 * the draft service) so they can't race the draft starting. No request/cookie
 * access, so scripts can use these too.
 */
import { and, asc, desc, eq } from "drizzle-orm";
import type { DbOrTx } from "@/db";
import { drafts, leagueMembers, leagues, matchups, sessions, teams, users, type League } from "@/db/schema";
import {
  leagueSettingsSchema,
  parseLeagueSettings,
  rosterSize,
  starterSlots,
  totalSeasonWeeks,
  type DraftSettings,
  type LeagueSettings,
  type RosterSettings,
  type ScheduleSettings,
  type ScoringSettings,
  type TradeSettings,
  type WaiverSettings,
} from "@/lib/settings";
import { dayOfWeek, editableWeek } from "@/lib/time";
import { UserError } from "@/server/action-result";
import { hashPassword } from "@/server/auth/password";
import { generateInviteCode, scheduleNextWaiverRun } from "./league";

export type LeagueStatus = League["status"];
export type DraftStatus = "not_started" | "in_progress" | "paused" | "complete";

/** Longest season the schedule form allows. */
export const MAX_SEASON_WEEKS = 52;

// ---------------------------------------------------------------------------
// Lock rules (pure)
// ---------------------------------------------------------------------------

/** true = locked (can't be changed right now). */
export type SettingsLocks = {
  /** Roster slots + max teams. */
  roster: boolean;
  /** Seconds per pick + scheduled draft time. */
  draft: boolean;
  seasonStart: boolean;
  /**
   * Time zone, weeks per matchup, regular-season matchups and weeks per
   * playoff round: the generated schedule, week→period mapping and playoff
   * week ranges depend on them, so they're fixed once the league leaves setup.
   */
  scheduleShape: boolean;
  /** Playoff team count: fixed once a playoff matchup exists or the playoffs have started. */
  playoffTeams: boolean;
  /** Members (and their teams) can be removed. */
  removeMembers: boolean;
};

export function settingsLocks(status: LeagueStatus, draftStatus: DraftStatus | null, hasPlayoffMatchups = false): SettingsLocks {
  const preDraft = status === "setup" && (draftStatus ?? "not_started") === "not_started";
  return {
    roster: !preDraft,
    draft: !preDraft,
    seasonStart: !preDraft,
    scheduleShape: !preDraft,
    playoffTeams: hasPlayoffMatchups || status === "playoffs" || status === "complete",
    removeMembers: !preDraft,
  };
}

/** Max playoff teams: before the draft any number up to max teams; after, up to the real team count. */
export function playoffTeamLimit(locks: SettingsLocks, maxTeams: number, teamCount: number): number {
  return Math.min(12, locks.roster ? teamCount : Math.max(maxTeams, teamCount));
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type AdminLeague = {
  league: League;
  settings: LeagueSettings;
  draftStatus: DraftStatus | null;
  teamCount: number;
  hasPlayoffMatchups: boolean;
  locks: SettingsLocks;
};

async function hasPlayoffMatchups(db: DbOrTx, leagueId: string): Promise<boolean> {
  const [m] = await db
    .select({ id: matchups.id })
    .from(matchups)
    .where(and(eq(matchups.leagueId, leagueId), eq(matchups.isPlayoff, true)))
    .limit(1);
  return !!m;
}

/** Load what the settings page needs (no locks taken). */
export async function loadAdminLeague(db: DbOrTx, leagueId: string): Promise<AdminLeague> {
  const [[league], [d], teamRows, playoffs] = await Promise.all([
    db.select().from(leagues).where(eq(leagues.id, leagueId)),
    db.select({ status: drafts.status }).from(drafts).where(eq(drafts.leagueId, leagueId)),
    db.select({ id: teams.id }).from(teams).where(eq(teams.leagueId, leagueId)),
    hasPlayoffMatchups(db, leagueId),
  ]);
  if (!league) throw new UserError("League not found.");
  const draftStatus = d?.status ?? null;
  return {
    league,
    settings: parseLeagueSettings(league.settings),
    draftStatus,
    teamCount: teamRows.length,
    hasPlayoffMatchups: playoffs,
    locks: settingsLocks(league.status, draftStatus, playoffs),
  };
}

async function withLockedLeague<T>(db: DbOrTx, leagueId: string, fn: (tx: DbOrTx, l: AdminLeague) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    // Lock order matches the draft service: drafts row first, then the league.
    const [d] = await tx.select({ status: drafts.status }).from(drafts).where(eq(drafts.leagueId, leagueId)).for("update");
    const [league] = await tx.select().from(leagues).where(eq(leagues.id, leagueId)).for("update");
    if (!league) throw new UserError("League not found.");
    const teamRows = await tx.select({ id: teams.id }).from(teams).where(eq(teams.leagueId, leagueId));
    const playoffs = await hasPlayoffMatchups(tx, leagueId);
    const draftStatus = d?.status ?? null;
    return fn(tx, {
      league,
      settings: parseLeagueSettings(league.settings),
      draftStatus,
      teamCount: teamRows.length,
      hasPlayoffMatchups: playoffs,
      locks: settingsLocks(league.status, draftStatus, playoffs),
    });
  });
}

async function writeSettings(tx: DbOrTx, leagueId: string, next: LeagueSettings, extra: { seasonStart?: string } = {}): Promise<LeagueSettings> {
  const parsed = leagueSettingsSchema.safeParse(next);
  if (!parsed.success) throw new UserError("Those settings don't look right. Check the numbers and try again.");
  await tx
    .update(leagues)
    .set({ settings: parsed.data, ...(extra.seasonStart ? { seasonStart: extra.seasonStart } : {}) })
    .where(eq(leagues.id, leagueId));
  return parsed.data;
}

const inSeason = (s: LeagueStatus) => s === "in_season" || s === "playoffs";

/** Roster slots + max teams (before the draft only). Also sets the draft's round count. */
export async function saveRosterSettings(
  db: DbOrTx,
  leagueId: string,
  input: { roster: RosterSettings; maxTeams: number },
): Promise<LeagueSettings> {
  return withLockedLeague(db, leagueId, async (tx, l) => {
    if (l.locks.roster) throw new UserError("Roster spots are locked once the draft starts.");
    if (input.maxTeams < l.teamCount) {
      throw new UserError(`${l.teamCount} teams have already joined, so max teams can't be lower than ${l.teamCount}.`);
    }
    if (starterSlots(input.roster).length < 1) throw new UserError("Teams need at least one starting spot.");
    // Keep the playoff field no bigger than the league.
    const schedule = { ...l.settings.schedule, playoffTeams: Math.min(l.settings.schedule.playoffTeams, input.maxTeams) };
    const next = await writeSettings(tx, leagueId, { ...l.settings, roster: input.roster, maxTeams: input.maxTeams, schedule });
    await tx.update(drafts).set({ rounds: rosterSize(next.roster) }).where(eq(drafts.leagueId, leagueId));
    return next;
  });
}

/** Scoring values (any time; open weeks re-score automatically). */
export async function saveScoringSettings(db: DbOrTx, leagueId: string, scoring: ScoringSettings): Promise<LeagueSettings> {
  return withLockedLeague(db, leagueId, (tx, l) => writeSettings(tx, leagueId, { ...l.settings, scoring }));
}

/**
 * Schedule. Season start, time zone and the matchup/playoff-round shape only
 * before the draft; playoff team count until a playoff round exists; lineup
 * lock time any time.
 */
export async function saveScheduleSettings(
  db: DbOrTx,
  leagueId: string,
  input: { seasonStart: string; schedule: ScheduleSettings; now?: Date },
): Promise<LeagueSettings> {
  return withLockedLeague(db, leagueId, async (tx, l) => {
    const cur = l.settings.schedule;
    const s = input.schedule;
    if (l.locks.seasonStart && input.seasonStart !== l.league.seasonStart) throw new UserError("The season start is locked once the draft starts.");
    if (
      l.locks.scheduleShape &&
      (s.timezone !== cur.timezone ||
        s.matchupWeeks !== cur.matchupWeeks ||
        s.regularSeasonMatchups !== cur.regularSeasonMatchups ||
        s.playoffRoundWeeks !== cur.playoffRoundWeeks)
    ) {
      throw new UserError("The time zone and matchup lengths are locked once the draft starts.");
    }
    if (l.locks.playoffTeams && s.playoffTeams !== cur.playoffTeams) {
      throw new UserError("The number of playoff teams is locked once the playoffs are set.");
    }
    if (dayOfWeek(input.seasonStart) !== 1) throw new UserError("The season has to start on a Monday.");
    if (!l.locks.playoffTeams) {
      const limit = playoffTeamLimit(l.locks, l.settings.maxTeams, l.teamCount);
      if (s.playoffTeams === 1 || s.playoffTeams > limit) {
        throw new UserError(`Playoff teams must be 0 (no playoffs) or between 2 and ${limit}.`);
      }
    }
    if (totalSeasonWeeks(s) > MAX_SEASON_WEEKS) throw new UserError(`The season can be at most ${MAX_SEASON_WEEKS} weeks long.`);
    if (s.lockTime !== cur.lockTime && l.league.status !== "setup") {
      // A week that has already locked must stay locked: moving the lock time
      // later on lock day would let everyone rewrite that week's lineup.
      const now = input.now ?? new Date();
      const clock = (lockTime: string, timeZone: string) => ({ seasonStart: input.seasonStart, lockTime, timeZone });
      const before = editableWeek(now, clock(cur.lockTime, cur.timezone));
      const after = editableWeek(now, clock(s.lockTime, s.timezone));
      if (after < before) {
        throw new UserError(
          `Week ${after} lineups already locked, and that lock time would reopen them. Try again after this week's lock day, or pick an earlier time.`,
        );
      }
    }
    return writeSettings(tx, leagueId, { ...l.settings, schedule: s }, { seasonStart: input.seasonStart });
  });
}

/** Draft clock + scheduled time (before the draft only). Also updates the draft row's clock. */
export async function saveDraftSettings(db: DbOrTx, leagueId: string, draft: DraftSettings): Promise<LeagueSettings> {
  return withLockedLeague(db, leagueId, async (tx, l) => {
    if (l.locks.draft) throw new UserError("Draft settings are locked once the draft starts.");
    const next = await writeSettings(tx, leagueId, { ...l.settings, draft });
    await tx.update(drafts).set({ secondsPerPick: next.draft.secondsPerPick }).where(eq(drafts.leagueId, leagueId));
    return next;
  });
}

/** Waiver day/time. Reschedules the next run when the season is underway. */
export async function saveWaiverSettings(
  db: DbOrTx,
  leagueId: string,
  waivers: WaiverSettings,
  now: Date = new Date(),
): Promise<{ settings: LeagueSettings; nextRunAt: Date | null }> {
  return withLockedLeague(db, leagueId, async (tx, l) => {
    const next = await writeSettings(tx, leagueId, { ...l.settings, waivers });
    const nextRunAt = inSeason(l.league.status) ? await scheduleNextWaiverRun(tx, leagueId, next, now) : null;
    return { settings: next, nextRunAt };
  });
}

/** Trade review window + deadline. */
export async function saveTradeSettings(db: DbOrTx, leagueId: string, trades: TradeSettings): Promise<LeagueSettings> {
  return withLockedLeague(db, leagueId, async (tx, l) => {
    const total = totalSeasonWeeks(l.settings.schedule);
    if (trades.deadlineWeek !== null && trades.deadlineWeek > total) {
      throw new UserError(`The trade deadline must be a week from 1 to ${total}.`);
    }
    return writeSettings(tx, leagueId, { ...l.settings, trades });
  });
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export type MemberRow = {
  userId: string;
  displayName: string;
  username: string;
  role: "commissioner" | "member";
  isCreator: boolean;
  joinedAt: Date;
  teamId: string | null;
  teamName: string | null;
};

export async function listLeagueMembers(db: DbOrTx, leagueId: string): Promise<MemberRow[]> {
  return db
    .select({
      userId: leagueMembers.userId,
      displayName: users.displayName,
      username: users.username,
      role: leagueMembers.role,
      isCreator: leagueMembers.isCreator,
      joinedAt: leagueMembers.joinedAt,
      teamId: teams.id,
      teamName: teams.name,
    })
    .from(leagueMembers)
    .innerJoin(users, eq(users.id, leagueMembers.userId))
    .leftJoin(teams, and(eq(teams.leagueId, leagueMembers.leagueId), eq(teams.ownerId, leagueMembers.userId)))
    .where(eq(leagueMembers.leagueId, leagueId))
    .orderBy(desc(leagueMembers.isCreator), asc(leagueMembers.role), asc(users.displayName));
}

async function requireMember(db: DbOrTx, leagueId: string, userId: string) {
  const [m] = await db
    .select({ role: leagueMembers.role, isCreator: leagueMembers.isCreator, displayName: users.displayName, username: users.username })
    .from(leagueMembers)
    .innerJoin(users, eq(users.id, leagueMembers.userId))
    .where(and(eq(leagueMembers.leagueId, leagueId), eq(leagueMembers.userId, userId)));
  if (!m) throw new UserError("That person isn't in this league.");
  return m;
}

/** Make someone a co-commissioner, or back to a regular member. The creator always stays commissioner. */
export async function setMemberRole(
  db: DbOrTx,
  leagueId: string,
  userId: string,
  role: "commissioner" | "member",
): Promise<{ displayName: string }> {
  const m = await requireMember(db, leagueId, userId);
  if (m.isCreator && role === "member") throw new UserError("The league creator is always a commissioner.");
  await db.update(leagueMembers).set({ role }).where(and(eq(leagueMembers.leagueId, leagueId), eq(leagueMembers.userId, userId)));
  return { displayName: m.displayName };
}

export const TEAM_NAME_MIN = 2;
export const TEAM_NAME_MAX = 40;

export async function renameTeam(db: DbOrTx, leagueId: string, teamId: string, rawName: string): Promise<{ name: string }> {
  const name = rawName.trim().replace(/\s+/g, " ");
  if (name.length < TEAM_NAME_MIN || name.length > TEAM_NAME_MAX) {
    throw new UserError(`Team names must be ${TEAM_NAME_MIN}–${TEAM_NAME_MAX} characters.`);
  }
  const rows = await db
    .update(teams)
    .set({ name })
    .where(and(eq(teams.id, teamId), eq(teams.leagueId, leagueId)))
    .returning({ id: teams.id });
  if (rows.length === 0) throw new UserError("That team isn't in this league.");
  return { name };
}

/** Remove a member and their team (before the draft only; never the creator). */
export async function removeMember(db: DbOrTx, leagueId: string, userId: string): Promise<{ displayName: string }> {
  return withLockedLeague(db, leagueId, async (tx, l) => {
    if (l.locks.removeMembers) throw new UserError("Members can only be removed before the draft starts.");
    const m = await requireMember(tx, leagueId, userId);
    if (m.isCreator) throw new UserError("The league creator can't be removed.");
    await tx.delete(teams).where(and(eq(teams.leagueId, leagueId), eq(teams.ownerId, userId)));
    await tx.delete(leagueMembers).where(and(eq(leagueMembers.leagueId, leagueId), eq(leagueMembers.userId, userId)));
    return { displayName: m.displayName };
  });
}

function isUniqueViolation(e: unknown): boolean {
  for (let cur: unknown = e, i = 0; cur && i < 4; i++) {
    if (typeof cur === "object" && (cur as { code?: unknown }).code === "23505") return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/** Give the league a fresh invite code (the old one stops working). */
export async function regenerateInviteCode(db: DbOrTx, leagueId: string): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = generateInviteCode();
    const [taken] = await db.select({ id: leagues.id }).from(leagues).where(eq(leagues.inviteCode, code));
    if (taken) continue;
    try {
      await db.update(leagues).set({ inviteCode: code }).where(eq(leagues.id, leagueId));
      return code;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
  }
  throw new UserError("Couldn't make a new code. Try again.");
}

/**
 * Site admins only (checked by the caller): set a member's password and sign
 * them out everywhere. Returns their username.
 */
export async function setTemporaryPassword(db: DbOrTx, leagueId: string, userId: string, password: string): Promise<{ username: string }> {
  const m = await requireMember(db, leagueId, userId);
  const passwordHash = await hashPassword(password);
  await db.transaction(async (tx) => {
    await tx.update(users).set({ passwordHash }).where(eq(users.id, userId));
    await tx.delete(sessions).where(eq(sessions.userId, userId));
  });
  return { username: m.username };
}
