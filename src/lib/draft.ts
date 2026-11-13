/**
 * Pure draft helpers: snake order and auto-pick selection.
 */
import type { Position, RosterSettings, SlotType } from "./settings";
import { slotAccepts, starterSlots } from "./settings";

/** Team (by 1-based draft position) on the clock for a 0-based overall pick in a snake draft. */
export function snakeSlot(overall: number, teamCount: number): { round: number; pickInRound: number; draftPosition: number } {
  const round = Math.floor(overall / teamCount) + 1;
  const idx = overall % teamCount;
  const draftPosition = round % 2 === 1 ? idx + 1 : teamCount - idx;
  return { round, pickInRound: idx + 1, draftPosition };
}

/**
 * Given drafted positions, return the starter slots still open, filling slots
 * greedily: exact-position slots first, then FLEX, then the rest go to bench.
 */
export function openStarterSlots(positions: Position[], roster: RosterSettings): SlotType[] {
  const slots = starterSlots(roster);
  const filled = new Array(slots.length).fill(false);
  const sorted = [...positions];
  // exact matches first
  const leftovers: Position[] = [];
  for (const p of sorted) {
    const i = slots.findIndex((s, k) => !filled[k] && s !== "flex" && slotAccepts(s, p));
    if (i >= 0) filled[i] = true;
    else leftovers.push(p);
  }
  for (const p of leftovers) {
    const i = slots.findIndex((s, k) => !filled[k] && s === "flex" && slotAccepts(s, p));
    if (i >= 0) filled[i] = true;
  }
  return slots.filter((_, k) => !filled[k]);
}

export type AutoPickCandidate = {
  id: string;
  position: Position;
  preseasonRank: number | null;
  name: string;
};

function byRank(a: AutoPickCandidate, b: AutoPickCandidate): number {
  const ra = a.preseasonRank ?? Number.MAX_SAFE_INTEGER;
  const rb = b.preseasonRank ?? Number.MAX_SAFE_INTEGER;
  return ra - rb || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

/**
 * Choose an auto-pick:
 * 1. The first available player in the team's queue who fills an open starter
 *    slot (or anyone from the queue once all starter slots are filled).
 * 2. Otherwise the best-ranked available player who fills an open starter slot.
 * 3. Otherwise the best-ranked available player.
 */
export function chooseAutoPick(args: {
  available: AutoPickCandidate[];
  queue: string[]; // lawyer ids in priority order
  draftedPositions: Position[];
  roster: RosterSettings;
}): AutoPickCandidate | null {
  const { available, queue, draftedPositions, roster } = args;
  if (available.length === 0) return null;
  const availableById = new Map(available.map((c) => [c.id, c]));
  const open = openStarterSlots(draftedPositions, roster);
  const fillsOpen = (c: AutoPickCandidate) => open.some((s) => slotAccepts(s, c.position));

  for (const id of queue) {
    const c = availableById.get(id);
    if (!c) continue;
    if (open.length === 0 || fillsOpen(c)) return c;
  }
  const ranked = [...available].sort(byRank);
  if (open.length > 0) {
    const needed = ranked.find(fillsOpen);
    if (needed) return needed;
  }
  return ranked[0] ?? null;
}
