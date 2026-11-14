/**
 * Import researched case outlooks (docket activity + scheduled/likely events)
 * into a player pool, for projections. See src/lib/outlook.ts and
 * data/real-pool-2026-27/5-outlooks.json.
 *
 *   npx tsx --env-file=.env.local scripts/import-outlooks.ts <poolId> <file.json> [--dry-run]
 *
 * The file is an array of { court, docketNumber, caption, outlook } where the
 * outlook's lawyer-specific events name the lawyer (`lawyerName`) instead of an
 * id. Cases are matched by court + docket number within the pool; lawyers by
 * exact name within the pool. Every outlook is validated before anything is
 * written; nothing is written if any entry fails. Set DATABASE_URL to target
 * another database (e.g. production).
 */
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { cases, lawyers } from "@/db/schema";
import { parseCaseOutlook, type CaseOutlook } from "@/lib/outlook";

type FileEvent = { type: string; side: "plaintiff" | "defendant" | null; lawyerName: string | null };
type FileEntry = {
  court: string;
  docketNumber: string;
  caption: string;
  outlook: Omit<CaseOutlook, "milestones"> & {
    milestones: (Omit<CaseOutlook["milestones"][number], "outcomes"> & {
      outcomes: { probability: number; label: string; events: FileEvent[] }[];
    })[];
  };
};

async function main() {
  const [poolId, file, flag] = process.argv.slice(2);
  if (!poolId || !file) throw new Error("Usage: import-outlooks.ts <poolId> <file.json> [--dry-run]");
  const dryRun = flag === "--dry-run";
  const entries = JSON.parse(readFileSync(file, "utf8")) as FileEntry[];

  const poolCases = await db.select({ id: cases.id, court: cases.court, docketNumber: cases.docketNumber }).from(cases).where(eq(cases.poolId, poolId));
  const caseKey = (court: string, docket: string | null) => `${court.trim().toLowerCase()}|${(docket ?? "").trim().toLowerCase()}`;
  const caseByKey = new Map(poolCases.map((c) => [caseKey(c.court, c.docketNumber), c.id]));
  const poolLawyers = await db.select({ id: lawyers.id, name: lawyers.name }).from(lawyers).where(eq(lawyers.poolId, poolId));
  const lawyerByName = new Map(poolLawyers.map((l) => [l.name, l.id]));

  const errors: string[] = [];
  const updates: { id: string; caption: string; outlook: CaseOutlook }[] = [];
  for (const e of entries) {
    const id = caseByKey.get(caseKey(e.court, e.docketNumber));
    if (!id) {
      errors.push(`${e.caption}: no case ${e.court} ${e.docketNumber} in this pool`);
      continue;
    }
    const raw = {
      ...e.outlook,
      milestones: e.outlook.milestones.map((m) => ({
        ...m,
        outcomes: m.outcomes.map((o) => ({
          ...o,
          events: o.events.map((ev) => {
            const lawyerId = ev.lawyerName ? (lawyerByName.get(ev.lawyerName) ?? null) : null;
            if (ev.lawyerName && !lawyerId) errors.push(`${e.caption}: lawyer "${ev.lawyerName}" isn't in this pool`);
            return { type: ev.type, side: ev.side, lawyerId };
          }),
        })),
      })),
    };
    const outlook = parseCaseOutlook(raw);
    if (!outlook) {
      errors.push(`${e.caption}: outlook failed validation`);
      continue;
    }
    updates.push({ id, caption: e.caption, outlook });
  }
  if (errors.length) throw new Error(`Nothing written:\n- ${errors.join("\n- ")}`);
  console.log(`${updates.length} outlooks valid${dryRun ? " (dry run, nothing written)" : ""}.`);
  if (dryRun) return;
  await db.transaction(async (tx) => {
    for (const u of updates) await tx.update(cases).set({ outlook: u.outlook }).where(and(eq(cases.id, u.id), eq(cases.poolId, poolId)));
  });
  console.log(`Wrote ${updates.length} outlooks.`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
