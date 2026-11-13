/**
 * Pure lineup helpers.
 */
import type { Position, RosterSettings, SlotType } from "./settings";
import { slotAccepts, starterSlots } from "./settings";

export type RosterPlayer = { id: string; position: Position; preseasonRank?: number | null };

/**
 * Validate a proposed starters array against the roster. Returns an error
 * message or null when valid. Empty slots (null) are allowed.
 */
export function validateLineup(starters: (string | null)[], roster: RosterSettings, players: RosterPlayer[]): string | null {
  const slots = starterSlots(roster);
  if (starters.length !== slots.length) return "Lineup has the wrong number of slots.";
  const byId = new Map(players.map((p) => [p.id, p]));
  const seen = new Set<string>();
  for (let i = 0; i < slots.length; i++) {
    const id = starters[i];
    if (id === null) continue;
    const p = byId.get(id);
    if (!p) return "A starter is not on your roster.";
    if (seen.has(id)) return "A lawyer can only start in one slot.";
    seen.add(id);
    if (!slotAccepts(slots[i], p.position)) return `That lawyer can't play the ${slots[i].toUpperCase()} slot.`;
  }
  return null;
}

/**
 * Remove starters who are no longer on the roster (or now ineligible) and
 * normalize the array length to the current slot count.
 */
export function sanitizeLineup(starters: (string | null)[], roster: RosterSettings, players: RosterPlayer[]): (string | null)[] {
  const slots = starterSlots(roster);
  const byId = new Map(players.map((p) => [p.id, p]));
  const seen = new Set<string>();
  return slots.map((slot, i) => {
    const id = starters[i] ?? null;
    if (!id) return null;
    const p = byId.get(id);
    if (!p || seen.has(id) || !slotAccepts(slot, p.position)) return null;
    seen.add(id);
    return id;
  });
}

/**
 * Fill empty starter slots from the bench, best preseason rank first. Keeps
 * existing valid starters in place.
 */
export function autoFillLineup(starters: (string | null)[], roster: RosterSettings, players: RosterPlayer[]): (string | null)[] {
  const slots: SlotType[] = starterSlots(roster);
  const current = sanitizeLineup(starters, roster, players);
  const used = new Set(current.filter((x): x is string => !!x));
  const bench = players
    .filter((p) => !used.has(p.id))
    .sort((a, b) => (a.preseasonRank ?? 1e9) - (b.preseasonRank ?? 1e9) || a.id.localeCompare(b.id));
  // exact-position slots first, flex last
  const order = slots.map((s, i) => ({ s, i })).sort((a, b) => Number(a.s === "flex") - Number(b.s === "flex"));
  for (const { s, i } of order) {
    if (current[i]) continue;
    const idx = bench.findIndex((p) => slotAccepts(s, p.position));
    if (idx >= 0) {
      current[i] = bench[idx].id;
      bench.splice(idx, 1);
    }
  }
  return current;
}
