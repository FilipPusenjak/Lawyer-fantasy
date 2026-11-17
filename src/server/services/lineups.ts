/**
 * Lineup storage. A team's effective lineup for week N is the stored row with
 * the largest week <= N. Rows are only ever written for weeks that are not yet
 * locked, so locked weeks are frozen automatically.
 */
import { and, eq, gte, inArray } from "drizzle-orm";
import type { DbOrTx } from "@/db";
import { lineups, teams } from "@/db/schema";
import type { LeagueSettings, SlotType } from "@/lib/settings";
import { starterSlots } from "@/lib/settings";
import { editableWeek } from "@/lib/time";

export type LineupRow = { week: number; starters: (string | null)[] };

/** All lineup rows for a league's teams: teamId -> rows sorted by week asc. */
export async function loadLeagueLineups(db: DbOrTx, leagueId: string): Promise<Map<string, LineupRow[]>> {
  const rows = await db
    .select({ teamId: lineups.teamId, week: lineups.week, starters: lineups.starters })
    .from(lineups)
    .innerJoin(teams, eq(teams.id, lineups.teamId))
    .where(eq(teams.leagueId, leagueId));
  const out = new Map<string, LineupRow[]>();
  for (const r of rows) {
    const arr = out.get(r.teamId) ?? [];
    arr.push({ week: r.week, starters: r.starters });
    out.set(r.teamId, arr);
  }
  for (const arr of out.values()) arr.sort((a, b) => a.week - b.week);
  return out;
}

export async function loadTeamLineups(db: DbOrTx, teamId: string): Promise<LineupRow[]> {
  const rows = await db.select({ week: lineups.week, starters: lineups.starters }).from(lineups).where(eq(lineups.teamId, teamId));
  return rows.sort((a, b) => a.week - b.week);
}

/** Effective starters for a week, normalized to the current slot count. */
export function effectiveStarters(rows: LineupRow[] | undefined, week: number, settings: LeagueSettings): (string | null)[] {
  const n = starterSlots(settings.roster).length;
  let chosen: LineupRow | undefined;
  for (const r of rows ?? []) {
    if (r.week <= week) chosen = r;
    else break;
  }
  const base = chosen?.starters ?? [];
  return Array.from({ length: n }, (_, i) => base[i] ?? null);
}

export async function saveLineup(db: DbOrTx, teamId: string, week: number, starters: (string | null)[]): Promise<void> {
  await db
    .insert(lineups)
    .values({ teamId, week, starters, updatedAt: new Date() })
    .onConflictDoUpdate({ target: [lineups.teamId, lineups.week], set: { starters, updatedAt: new Date() } });
}

type LeagueClockInfo = { seasonStart: string; settings: LeagueSettings };

export function leagueClock(league: LeagueClockInfo) {
  return {
    seasonStart: league.seasonStart,
    lockTime: league.settings.schedule.lockTime,
    timeZone: league.settings.schedule.timezone,
  };
}

/** A team's starters for the week that can still be edited (the earliest unlocked week). */
export async function editableWeekStarters(
  db: DbOrTx,
  league: LeagueClockInfo,
  teamId: string,
  now: Date = new Date(),
): Promise<{ week: number; starters: (string | null)[] }> {
  const week = editableWeek(now, leagueClock(league));
  return { week, starters: effectiveStarters(await loadTeamLineups(db, teamId), week, league.settings) };
}

/**
 * Remove a lawyer from a team's lineups for every week that is not yet locked
 * (used when the lawyer is dropped or traded away). Locked weeks keep them.
 * Returns the slot they left empty in the editable week, or null if they
 * weren't starting that week.
 */
export async function removeLawyerFromUpcomingLineups(
  db: DbOrTx,
  league: LeagueClockInfo,
  teamId: string,
  lawyerId: string,
  now: Date = new Date(),
): Promise<SlotType | null> {
  const week = editableWeek(now, leagueClock(league));
  const rows = await loadTeamLineups(db, teamId);
  const current = effectiveStarters(rows, week, league.settings);
  const slotIndex = current.indexOf(lawyerId);
  if (slotIndex >= 0) {
    await saveLineup(
      db,
      teamId,
      week,
      current.map((x) => (x === lawyerId ? null : x)),
    );
  }
  const future = await db
    .select({ id: lineups.id, starters: lineups.starters })
    .from(lineups)
    .where(and(eq(lineups.teamId, teamId), gte(lineups.week, week + 1)));
  for (const f of future) {
    if (f.starters.includes(lawyerId)) {
      await db
        .update(lineups)
        .set({ starters: f.starters.map((x) => (x === lawyerId ? null : x)), updatedAt: new Date() })
        .where(eq(lineups.id, f.id));
    }
  }
  return slotIndex >= 0 ? (starterSlots(league.settings.roster)[slotIndex] ?? null) : null;
}

export async function deleteLineupsForTeams(db: DbOrTx, teamIds: string[]): Promise<void> {
  if (teamIds.length === 0) return;
  await db.delete(lineups).where(inArray(lineups.teamId, teamIds));
}
