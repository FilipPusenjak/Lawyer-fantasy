import { describe, expect, it } from "vitest";
import {
  lineupDraftKey,
  restoreLineupDraft,
  serializeLineupDraft,
  type EditorPlayer,
} from "@/app/leagues/[leagueId]/team/lineup-model";
import type { SlotType } from "@/lib/settings";

const slots: SlotType[] = ["trial", "defense", "flex", "firm"];
const players: EditorPlayer[] = [
  { id: "t1", position: "trial" },
  { id: "t2", position: "trial" },
  { id: "d1", position: "defense" },
  { id: "f1", position: "firm" },
];
const saved = ["t1", "d1", null, "f1"];
const edited = ["t2", "d1", "t1", "f1"];

describe("lineup drafts", () => {
  it("keys drafts by league, team and week", () => {
    expect(lineupDraftKey("L1", "T1", 3)).toBe("lf:lineup-draft:L1:T1:3");
    expect(lineupDraftKey("L1", "T1", 3)).not.toBe(lineupDraftKey("L1", "T1", 4));
    expect(lineupDraftKey("L1", "T1", 3)).not.toBe(lineupDraftKey("L2", "T1", 3));
    expect(lineupDraftKey("L1", "T1", 3)).not.toBe(lineupDraftKey("L1", "T2", 3));
  });

  it("does not restore a draft from a different team", () => {
    // Another team's edits on a shared tab: none of its lawyers are on this roster.
    const otherPlayers: EditorPlayer[] = [
      { id: "t9", position: "trial" },
      { id: "t8", position: "trial" },
      { id: "d9", position: "defense" },
      { id: "f9", position: "firm" },
    ];
    const otherSaved = ["t9", "d9", null, "f9"];
    const raw = serializeLineupDraft(slots, saved, edited);
    expect(restoreLineupDraft(raw, slots, otherSaved, otherPlayers)).toBeNull();
  });

  it("restores a draft that still matches the roster and slots", () => {
    const raw = serializeLineupDraft(slots, saved, edited);
    expect(restoreLineupDraft(raw, slots, saved, players)).toEqual(edited);
  });

  it("returns null when there is nothing stored or it is garbage", () => {
    expect(restoreLineupDraft(null, slots, saved, players)).toBeNull();
    expect(restoreLineupDraft("", slots, saved, players)).toBeNull();
    expect(restoreLineupDraft("{not json", slots, saved, players)).toBeNull();
    expect(restoreLineupDraft("null", slots, saved, players)).toBeNull();
    expect(restoreLineupDraft(JSON.stringify({ v: 2, slots, saved, starters: edited }), slots, saved, players)).toBeNull();
    expect(restoreLineupDraft(JSON.stringify({ v: 1, slots, saved, starters: [1, 2, 3, 4] }), slots, saved, players)).toBeNull();
  });

  it("drops the draft when the league's slots changed", () => {
    const raw = serializeLineupDraft(["trial", "defense", "trial", "firm"], saved, edited);
    expect(restoreLineupDraft(raw, slots, saved, players)).toBeNull();
    const shorter = serializeLineupDraft(["trial", "defense", "flex"], ["t1", "d1", null], ["t2", "d1", "t1"]);
    expect(restoreLineupDraft(shorter, slots, saved, players)).toBeNull();
  });

  it("removes starters who left the roster, like the open editor does", () => {
    const raw = serializeLineupDraft(slots, saved, edited);
    const after = players.filter((p) => p.id !== "t2");
    expect(restoreLineupDraft(raw, slots, saved, after)).toEqual([null, "d1", "t1", "f1"]);
  });

  it("returns null when the draft equals the saved lineup", () => {
    expect(restoreLineupDraft(serializeLineupDraft(slots, saved, saved), slots, saved, players)).toBeNull();
    // Saved elsewhere since: the stored edits now match the saved lineup.
    expect(restoreLineupDraft(serializeLineupDraft(slots, saved, edited), slots, edited, players)).toBeNull();
  });

  it("rejects a draft that is no longer a legal lineup", () => {
    const dup = serializeLineupDraft(slots, saved, ["t1", "d1", "t1", "f1"]);
    expect(restoreLineupDraft(dup, slots, saved, players)).toBeNull();
    const wrongSlot = serializeLineupDraft(slots, saved, ["d1", null, null, "f1"]);
    expect(restoreLineupDraft(wrongSlot, slots, saved, players)).toBeNull();
  });
});
