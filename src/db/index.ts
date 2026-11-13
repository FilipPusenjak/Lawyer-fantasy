import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import * as schema from "./schema";

/**
 * Drizzle client over Neon's serverless Pool (WebSockets), which supports
 * interactive transactions and row locks (needed for the live draft).
 */
function createDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const pool = new Pool({ connectionString: url });
  return drizzle({ client: pool, schema });
}

type Db = ReturnType<typeof createDb>;

const globalForDb = globalThis as unknown as { __lawyerFantasyDb?: Db };

export const db: Db = globalForDb.__lawyerFantasyDb ?? (globalForDb.__lawyerFantasyDb = createDb());

/** A transaction handle; services accept either `db` or a transaction. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

export { schema };
