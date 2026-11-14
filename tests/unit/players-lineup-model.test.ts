import { describe, expect, it } from "vitest";
import {
  assignSlot,
  benchOf,
  eligibleFor,
  parseWeekParam,
  reconcileStarters,
  sameLineup,
  type EditorPlayer,
} from "@/app/leagues/[leagueId]/team/lineup-model";
import type { SlotType } from "@/lib/settings";

const slots: SlotType[] = ["trial", "defense", "flex", "firm"];
const players: EditorPlayer[] = [
  { id: "t1", position: "trial" },
  { id: "t2", position: "trial" },
  { id: "d1", position: "defense" },
  { id: "f1", position: "firm" },
  { id: "a1", position: "appellate" },
];

describe("assignSlot", () => {
  it("fills an empty slot from the bench", () => {
    expect(assignSlot([null, null, null, null], slots, players, 0, "t1")).toEqual(["t1", null, null, null]);
  });

  it("swaps when moving a starter into another slot and the occupant fits back", () => {
    // t1 in TRL, t2 in FLEX: putting t2 into TRL sends t1 to FLEX.
    expect(assignSlot(["t1", null, "t2", null], slots, players, 0, "t2")).toEqual(["t2", null, "t1", null]);
  });

  it("benches the occupant when they can't play the other slot", () => {
    // d1 in DEF, t1 in FLEX: moving d1 to FLEX can't put t1 in DEF, so t1 goes to the bench.
    expect(assignSlot(["t2", "d1", "t1", null], slots, players, 2, "d1")).toEqual(["t2", null, "d1", null]);
  });

  it("empties a slot and ignores ineligible or unknown players", () => {
    expect(assignSlot(["t1", null, null, "f1"], slots, players, 3, null)).toEqual(["t1", null, null, null]);
    expect(assignSlot(["t1", null, null, null], slots, players, 1, "t2")).toEqual(["t1", null, null, null]);
    expect(assignSlot(["t1", null, null, null], slots, players, 2, "f1")).toEqual(["t1", null, null, null]);
    expect(assignSlot(["t1", null, null, null], slots, players, 2, "zz")).toEqual(["t1", null, null, null]);
    expect(assignSlot(["t1", null, null, null], slots, players, 9, "t2")).toEqual(["t1", null, null, null]);
  });

  it("does not mutate the input", () => {
    const s = ["t1", null, null, null];
    assignSlot(s, slots, players, 2, "t2");
    expect(s).toEqual(["t1", null, null, null]);
  });
});

describe("lineup helpers", () => {
  it("eligibleFor uses slot rules (FLEX takes any lawyer, not firms)", () => {
    expect(eligibleFor("flex", players).map((p) => p.id)).toEqual(["t1", "t2", "d1", "a1"]);
    expect(eligibleFor("firm", players).map((p) => p.id)).toEqual(["f1"]);
  });

  it("benchOf lists non-starters", () => {
    expect(benchOf(["t1", null, "a1", null], players).map((p) => p.id)).toEqual(["t2", "d1", "f1"]);
  });

  it("sameLineup compares slot by slot", () => {
    expect(sameLineup(["a", null], ["a", null])).toBe(true);
    expect(sameLineup(["a", null], [null, "a"])).toBe(false);
    expect(sameLineup(["a"], ["a", null])).toBe(false);
  });

  it("parseWeekParam", () => {
    expect(parseWeekParam("3", 1, 5)).toBe(3);
    expect(parseWeekParam(["2", "4"], 1, 5)).toBe(2);
    expect(parseWeekParam("0", 1, 5)).toBeNull();
    expect(parseWeekParam("6", 1, 5)).toBeNull();
    expect(parseWeekParam("2.5", 1, 5)).toBeNull();
    expect(parseWeekParam(undefined, 1, 5)).toBeNull();
  });
});

describe("reconcileStarters", () => {
  const roster = new Set(["t1", "t2", "d1", "f1"]);

  it("takes the new saved lineup when there are no unsaved edits", () => {
    const saved = ["t1", "d1", null, "f1"];
    expect(reconcileStarters(saved, saved, ["t1", null, null, "f1"], roster)).toEqual(["t1", null, null, "f1"]);
  });

  it("keeps unsaved edits when the roster changes, dropping only lawyers who left", () => {
    const prevSaved = ["t1", "d1", null, "f1"];
    const edited = ["t2", "d1", "t1", "f1"];
    // d1 was dropped: the server cleared it from the saved lineup too.
    const nextSaved = ["t1", null, null, "f1"];
    const rosterAfter = new Set(["t1", "t2", "f1"]);
    expect(reconcileStarters(edited, prevSaved, nextSaved, rosterAfter)).toEqual(["t2", null, "t1", "f1"]);
  });

  it("keeps edits as they are after a save that matches them", () => {
    const edited = ["t2", "d1", "t1", "f1"];
    expect(reconcileStarters(edited, ["t1", "d1", null, "f1"], edited, roster)).toEqual(edited);
  });

  it("falls back to the saved lineup when the slot count changed", () => {
    expect(reconcileStarters(["t2", "d1", "t1", "f1"], ["t1", "d1", null, "f1"], ["t1", "d1", null], roster)).toEqual(["t1", "d1", null]);
  });
});
