/**
 * League-creation transaction used by createLeagueAction. Free of request
 * APIs so it can be exercised from scripts.
 */
import { eq } from "drizzle-orm";
import type { DbOrTx } from "@/db";
import { pools, type League } from "@/db/schema";
import { defaultLeagueSettings } from "@/lib/settings";
import { UserError } from "@/server/action-result";
import { createLeague, createPool } from "@/server/services/league";
import { resolveSeasonStart, type CreateLeagueInput } from "./league-rules";

/** Create a league (and optionally a new pool) with the creator's team. */
export async function createLeagueFromForm(
  db: DbOrTx,
  input: CreateLeagueInput,
  createdBy: string,
  now: Date = new Date(),
): Promise<League> {
  const settings = defaultLeagueSettings();
  settings.maxTeams = input.maxTeams;
  const start = resolveSeasonStart(input.seasonStart, now, settings.schedule.timezone);
  if (!start.ok) throw new UserError(start.error);

  return db.transaction(async (tx) => {
    let poolId: string;
    if (input.pool === "new") {
      poolId = (await createPool(tx, { name: input.newPoolName, createdBy })).id;
    } else {
      const [pool] = await tx.select({ id: pools.id }).from(pools).where(eq(pools.id, input.pool));
      if (!pool) throw new UserError("That player pool doesn't exist anymore. Pick another one.");
      poolId = pool.id;
    }
    return createLeague(tx, {
      name: input.name,
      poolId,
      createdBy,
      teamName: input.teamName,
      seasonStart: start.date,
      settings,
    });
  });
}
