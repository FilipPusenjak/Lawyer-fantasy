/**
 * Firm names: one key per firm however it's spelled, and which firms a pool
 * import creates. Pure (safe on the client).
 */

const FIRM_SUFFIXES = new Set(["llp", "llc", "pllc", "lllp", "pc", "pa", "lp", "ltd", "inc", "plc", "l", "p", "c", "a"]);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Comparable key for a firm name, ignoring punctuation, "and"/"&" and entity
 * suffixes: "Cravath, Swaine & Moore LLP" and "Cravath, Swaine and Moore" → "cravath swaine moore";
 * "Susman Godfrey L.L.P." and "Susman Godfrey LLP" → "susman godfrey".
 */
export function firmKey(name: string): string {
  const t = tokens(name).filter((w) => w !== "and");
  while (t.length > 1 && FIRM_SUFFIXES.has(t[t.length - 1])) t.pop();
  return t.join(" ");
}

export type FirmToCreate = { key: string; name: string; organization: string | null; rank: number | null };

/**
 * Firms an import should create, keyed by firmKey so two spellings of one firm
 * become one firm. A firm already in the pool always wins; otherwise an
 * explicit firm row (its name, organization and rank) wins over a spelling
 * that only appears in a lawyer's firm column; otherwise the first spelling.
 */
export function planFirmImport(
  existingFirmNames: readonly string[],
  rows: readonly { position: string; name: string; firm: string | null; organization: string | null; rank: number | null }[],
): FirmToCreate[] {
  const existing = new Set(existingFirmNames.map(firmKey));
  const plan = new Map<string, FirmToCreate & { explicit: boolean }>();
  for (const r of rows) {
    const explicit = r.position === "firm";
    const name = explicit ? r.name : r.firm;
    if (!name) continue;
    const key = firmKey(name);
    if (!key || existing.has(key)) continue;
    const prev = plan.get(key);
    if (prev && (prev.explicit || !explicit)) continue;
    plan.set(key, { key, name, organization: explicit ? r.organization : null, rank: explicit ? r.rank : null, explicit });
  }
  return [...plan.values()].map((f) => ({ key: f.key, name: f.name, organization: f.organization, rank: f.rank }));
}
