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

/**
 * Starters to show when the server sends a new saved lineup or roster while
 * the editor is open (e.g. after a drop from the roster card). With no
 * unsaved edits, take the new saved lineup; otherwise keep the edits, minus
 * anyone who is no longer on the roster.
 */
export function reconcileStarters(
  current: (string | null)[],
  prevSaved: (string | null)[],
  nextSaved: (string | null)[],
  rosterIds: ReadonlySet<string>,
): (string | null)[] {
  if (sameLineup(current, prevSaved) || current.length !== nextSaved.length) return [...nextSaved];
  return current.map((id) => (id && rosterIds.has(id) ? id : null));
}

/**
 * sessionStorage key for the unsaved lineup of one team and week. Scoped to
 * the team so a draft left on a shared tab (log out, someone else logs in)
 * never lands in another student's editor.
 */
export function lineupDraftKey(leagueId: string, teamId: string, week: number): string {
  return `lf:lineup-draft:${leagueId}:${teamId}:${week}`;
}

/** Unsaved edits plus the slots and saved lineup they were made against. */
export function serializeLineupDraft(slots: SlotType[], saved: (string | null)[], starters: (string | null)[]): string {
  return JSON.stringify({ v: 1, slots, saved, starters });
}

function isLineupArray(x: unknown, length: number): x is (string | null)[] {
  return Array.isArray(x) && x.length === length && x.every((id) => id === null || (typeof id === "string" && id.length > 0));
}

/**
 * Starters to restore from a stored draft, or null when there is nothing
 * usable: bad JSON, different slots, or a draft that no longer differs from
 * the saved lineup. Edits are merged with the current saved lineup and roster
 * the same way the open editor does (reconcileStarters), and the result must
 * still be a legal lineup (no duplicates, every starter fits their slot).
 */
export function restoreLineupDraft(
  raw: string | null,
  slots: SlotType[],
  saved: (string | null)[],
  players: EditorPlayer[],
): (string | null)[] | null {
  if (!raw) return null;
  let draft: unknown;
  try {
    draft = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!draft || typeof draft !== "object") return null;
  const d = draft as { v?: unknown; slots?: unknown; saved?: unknown; starters?: unknown };
  if (d.v !== 1) return null;
  if (!Array.isArray(d.slots) || d.slots.length !== slots.length || d.slots.some((s, i) => s !== slots[i])) return null;
  if (!isLineupArray(d.saved, slots.length) || !isLineupArray(d.starters, slots.length)) return null;
  if (saved.length !== slots.length) return null;

  const byId = new Map(players.map((p) => [p.id, p]));
  // None of the draft's starters are on this roster: it isn't this team's draft.
  const draftIds = d.starters.filter((id): id is string => id !== null);
  if (draftIds.length > 0 && !draftIds.some((id) => byId.has(id))) return null;
  const next = reconcileStarters(d.starters, d.saved, saved, new Set(byId.keys()));
  const seen = new Set<string>();
  for (let i = 0; i < slots.length; i++) {
    const id = next[i];
    if (id === null) continue;
    const p = byId.get(id);
    if (!p || seen.has(id) || !slotAccepts(slots[i], p.position)) return null;
    seen.add(id);
  }
  return sameLineup(next, saved) ? null : next;
}

/** Read ?week= as an integer within [min, max]; null when missing or out of range. */
export function parseWeekParam(raw: string | string[] | undefined, min: number, max: number): number | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v || !/^\d{1,3}$/.test(v.trim())) return null;
  const n = Number(v.trim());
  return n >= min && n <= max ? n : null;
}
