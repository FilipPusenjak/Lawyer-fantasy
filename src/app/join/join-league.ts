/**
 * Join-by-code transaction used by joinLeagueAction. Kept free of request
 * APIs (cookies, redirect) so it can be exercised from scripts.
 */
import { eq } from "drizzle-orm";
import type { DbOrTx } from "@/db";
import { leagues, teams } from "@/db/schema";
import { UserError } from "@/server/action-result";
import { joinLeague } from "@/server/services/league";

/**
 * Join a league by (normalized) invite code. Locks the league row so
 * simultaneous joins can't overfill it, and rejects duplicate team names.
 * Returns the league id (also when the user is already a member).
 */
export async function joinLeagueByCode(db: DbOrTx, args: { code: string; userId: string; teamName: string }): Promise<string> {
  return db.transaction(async (tx) => {
    const [league] = await tx.select({ id: leagues.id }).from(leagues).where(eq(leagues.inviteCode, args.code)).for("update");
    if (!league) throw new UserError("No league found with that invite code. Check it and try again.");
    const existing = await tx.select({ name: teams.name, ownerId: teams.ownerId }).from(teams).where(eq(teams.leagueId, league.id));
    const alreadyIn = existing.some((t) => t.ownerId === args.userId);
    if (!alreadyIn && existing.some((t) => t.name.toLowerCase() === args.teamName.toLowerCase())) {
      throw new UserError("Another team in this league already has that name. Pick a different one.");
    }
    return joinLeague(tx, { inviteCode: args.code, userId: args.userId, teamName: args.teamName });
  });
}
