/**
 * Grant or revoke site admin (the right to create leagues).
 *
 *   npm run make-admin -- <username>
 *   npm run make-admin -- <username> --revoke
 *
 * Uses DATABASE_URL from .env.local; to target another database, run
 * `DATABASE_URL=... npx tsx scripts/make-admin.ts <username>`.
 */
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { users } from "../src/db/schema";

async function main() {
  const args = process.argv.slice(2);
  const username = args.find((a) => !a.startsWith("--"))?.trim().toLowerCase();
  const revoke = args.includes("--revoke");
  if (!username) {
    console.error("Usage: npm run make-admin -- <username> [--revoke]");
    process.exit(1);
  }
  const rows = await db.update(users).set({ isAdmin: !revoke }).where(eq(users.username, username)).returning({ username: users.username });
  if (rows.length === 0) {
    console.error(`No user named "${username}". Sign up first, then run this again.`);
    process.exit(1);
  }
  console.log(`${revoke ? "Revoked" : "Granted"} site admin for @${rows[0].username}.`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
