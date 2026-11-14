/**
 * Load a player pool from the three import CSVs (the same files and parser the
 * commissioner's Import page uses), creating the pool if it doesn't exist.
 *
 *   npx tsx --env-file=.env.local scripts/import-pool.ts "<pool name>" <dir-with-csvs> [--dry-run]
 *
 * <dir> must contain 1-lawyers.csv, 2-cases.csv and 3-appearances.csv.
 * Re-running is safe: lawyers and cases already in the pool are skipped.
 * Set DATABASE_URL in the environment to target another database.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { pools } from "../src/db/schema";
import { parseAppearancesCsv, parseCasesCsv, parseLawyersCsv } from "../src/app/leagues/[leagueId]/commish/pool/csv";
import { importAppearances, importCases, importLawyers } from "../src/server/services/pool";

async function main() {
  const [poolName, dir] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const dryRun = process.argv.includes("--dry-run");
  if (!poolName || !dir) {
    console.error('Usage: tsx scripts/import-pool.ts "<pool name>" <dir> [--dry-run]');
    process.exit(1);
  }
  const lawyersCsv = parseLawyersCsv(readFileSync(join(dir, "1-lawyers.csv"), "utf8"));
  const casesCsv = parseCasesCsv(readFileSync(join(dir, "2-cases.csv"), "utf8"));
  const appsCsv = parseAppearancesCsv(readFileSync(join(dir, "3-appearances.csv"), "utf8"));
  const errors = [
    ...lawyersCsv.errors.map((e) => `lawyers line ${e.line}: ${e.message}`),
    ...casesCsv.errors.map((e) => `cases line ${e.line}: ${e.message}`),
    ...appsCsv.errors.map((e) => `appearances line ${e.line}: ${e.message}`),
  ];
  console.log(`Parsed ${lawyersCsv.rows.length} lawyers/firms, ${casesCsv.rows.length} cases, ${appsCsv.rows.length} appearances.`);
  if (errors.length) {
    console.error(`CSV problems:\n  ${errors.join("\n  ")}`);
    process.exit(1);
  }
  if (dryRun) return console.log("Dry run: nothing written.");

  let [pool] = await db.select().from(pools).where(eq(pools.name, poolName));
  if (!pool) [pool] = await db.insert(pools).values({ name: poolName, isDemo: false, createdBy: null }).returning();
  console.log(`Pool "${pool.name}" (${pool.id})`);

  const l = await importLawyers(db, pool.id, lawyersCsv.rows);
  console.log(`Lawyers: ${l.created} created, ${l.firmsCreated} firms created, ${l.skipped.length} already there, ${l.problems.length} problems`);
  const c = await importCases(db, pool.id, casesCsv.rows);
  console.log(`Cases: ${c.created} created, ${c.skipped.length} already there`);
  const a = await importAppearances(db, pool.id, appsCsv.rows);
  console.log(`Appearances: ${a.created} created, ${a.skipped} already there, ${a.problems.length} problems`);
  for (const p of [...l.problems, ...a.problems]) console.log(`  line ${p.line}: ${p.message}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
