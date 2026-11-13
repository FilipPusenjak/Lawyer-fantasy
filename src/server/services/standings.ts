/**
 * Standings and matchup lookups shared by the league home, standings page and
 * playoff seeding.
 */
import { and, asc, eq } from "drizzle-orm";
import type { DbOrTx } from "@/db";
import { leagues, matchups, teams, type Matchup, type Team } from "@/db/schema";
import { computeStandings, type StandingRow } from "@/lib/standings";

export type StandingWithTeam = StandingRow & { team: Team };

export async function getStandings(db: DbOrTx, leagueId: string): Promise<StandingWithTeam[]> {
  const [leagueTeams, ms] = await Promise.all([
    db.select().from(teams).where(eq(teams.leagueId, leagueId)),
    db.select().from(matchups).where(and(eq(matchups.leagueId, leagueId), eq(matchups.isPlayoff, false))),
  ]);
  const rows = computeStandings(
    leagueTeams.map((t) => t.id),
    ms.map((m) => ({
      teamAId: m.teamAId,
      teamBId: m.teamBId,
      scoreA: m.scoreA ?? 0,
      scoreB: m.scoreB ?? 0,
      final: m.final,
      isPlayoff: m.isPlayoff,
    })),
    leagueId,
  );
  const byId = new Map(leagueTeams.map((t) => [t.id, t]));
  return rows.map((r) => ({ ...r, team: byId.get(r.teamId)! }));
}

export async function getLeagueMatchups(db: DbOrTx, leagueId: string): Promise<Matchup[]> {
  return db.select().from(matchups).where(eq(matchups.leagueId, leagueId)).orderBy(asc(matchups.period), asc(matchups.bracketSlot));
}

/** The matchup period containing a week (regular season or playoffs), if any. */
export function periodForWeek(all: Matchup[], week: number): number | null {
  const m = all.find((x) => x.weekStart <= week && week <= x.weekEnd);
  return m ? m.period : null;
}

/** A team's matchup in a period (as team A or B). */
export function teamMatchupInPeriod(all: Matchup[], teamId: string, period: number): Matchup | null {
  return all.find((m) => m.period === period && (m.teamAId === teamId || m.teamBId === teamId)) ?? null;
}

export async function leagueSeasonStart(db: DbOrTx, leagueId: string): Promise<string> {
  const [l] = await db.select({ s: leagues.seasonStart }).from(leagues).where(eq(leagues.id, leagueId));
  return l.s;
}
