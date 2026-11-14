/**
 * Pure lineup-editor helpers (safe on the client; unit tested).
 */
import { slotAccepts, type Position, type SlotType } from "@/lib/settings";

export type EditorPlayer = { id: string; position: Position };

/**
 * Put a player (or nobody) into slot `index`. If the player was starting in
 * another slot, the slot's current occupant moves there when that slot accepts
 * them; otherwise the occupant goes to the bench.
 */
export function assignSlot(
  starters: (string | null)[],
  slots: SlotType[],
  players: EditorPlayer[],
  index: number,
  playerId: string | null,
): (string | null)[] {
  const next = [...starters];
  if (index < 0 || index >= slots.length) return next;
  if (playerId === null) {
    next[index] = null;
    return next;
  }
  const player = players.find((p) => p.id === playerId);
  if (!player || !slotAccepts(slots[index], player.position)) return next;
  const displaced = next[index] ?? null;
  const from = next.indexOf(playerId);
  next[index] = playerId;
  if (from >= 0 && from !== index) {
    const displacedPos = displaced ? players.find((p) => p.id === displaced)?.position : undefined;
    next[from] = displaced && displacedPos && slotAccepts(slots[from], displacedPos) ? displaced : null;
  }
  return next;
}

/** Roster players who can fill a slot. */
export function eligibleFor<T extends EditorPlayer>(slot: SlotType, players: T[]): T[] {
  return players.filter((p) => slotAccepts(slot, p.position));
}

/** Roster players who aren't starting. */
export function benchOf<T extends EditorPlayer>(starters: (string | null)[], players: T[]): T[] {
  const starting = new Set(starters.filter((x): x is string => !!x));
  return players.filter((p) => !starting.has(p.id));
}

export function sameLineup(a: (string | null)[], b: (string | null)[]): boolean {
  return a.length === b.length && a.every((x, i) => (x ?? null) === (b[i] ?? null));
}
