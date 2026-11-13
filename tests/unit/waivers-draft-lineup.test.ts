import { describe, expect, it } from "vitest";
import { processWaivers } from "@/lib/waivers";
import { chooseAutoPick, openStarterSlots, snakeSlot } from "@/lib/draft";
import { autoFillLineup, sanitizeLineup, validateLineup } from "@/lib/lineup";
import { defaultLeagueSettings, starterSlots } from "@/lib/settings";

const roster = defaultLeagueSettings().roster;

describe("waivers", () => {
  it("rolling priority: winner moves to the back, then next team gets their next claim", () => {
    const res = processWaivers({
      priority: ["t1", "t2"],
      claims: [
        { id: "c1", teamId: "t1", addLawyerId: "X", dropLawyerId: null, claimOrder: 1, createdAt: 1 },
        { id: "c2", teamId: "t1", addLawyerId: "Y", dropLawyerId: null, claimOrder: 2, createdAt: 2 },
        { id: "c3", teamId: "t2", addLawyerId: "X", dropLawyerId: null, claimOrder: 1, createdAt: 3 },
        { id: "c4", teamId: "t2", addLawyerId: "Y", dropLawyerId: null, claimOrder: 2, createdAt: 4 },
      ],
      rosters: new Map([
        ["t1", new Set<string>()],
        ["t2", new Set<string>()],
      ]),
      maxRoster: 12,
    });
    expect(res.awarded.map((a) => a.claimId)).toEqual(["c1", "c4"]);
    expect(res.lost.sort()).toEqual(["c2", "c3"]);
    expect(res.finalPriority).toEqual(["t1", "t2"]);
  });

  it("respects roster limits and drop validity", () => {
    const res = processWaivers({
      priority: ["t1"],
      claims: [
        { id: "a", teamId: "t1", addLawyerId: "X", dropLawyerId: null, claimOrder: 1, createdAt: 1 },
        { id: "b", teamId: "t1", addLawyerId: "Y", dropLawyerId: "gone", claimOrder: 2, createdAt: 2 },
        { id: "c", teamId: "t1", addLawyerId: "Z", dropLawyerId: "p1", claimOrder: 3, createdAt: 3 },
      ],
      rosters: new Map([["t1", new Set(["p1"])]]),
      maxRoster: 1,
    });
    expect(res.awarded.map((a) => a.claimId)).toEqual(["c"]);
  });
});

describe("draft", () => {
  it("snake order", () => {
    expect([0, 1, 2, 3, 4, 5].map((o) => snakeSlot(o, 3).draftPosition)).toEqual([1, 2, 3, 3, 2, 1]);
    expect(snakeSlot(4, 3)).toEqual({ round: 2, pickInRound: 2, draftPosition: 2 });
  });

  it("open starter slots use exact positions before flex", () => {
    const open = openStarterSlots(["trial", "trial", "trial"], roster);
    expect(open).toEqual(["appellate", "prosecutor", "defense", "firm"]);
  });

  it("auto-pick prefers queue, then needs, then rank", () => {
    const available = [
      { id: "f", position: "firm" as const, preseasonRank: 1, name: "F" },
      { id: "t", position: "trial" as const, preseasonRank: 2, name: "T" },
      { id: "p", position: "prosecutor" as const, preseasonRank: 3, name: "P" },
    ];
    expect(chooseAutoPick({ available, queue: ["p"], draftedPositions: [], roster })!.id).toBe("p");
    expect(chooseAutoPick({ available, queue: [], draftedPositions: [], roster })!.id).toBe("f");
    // firm slot already filled -> skip firm for an open slot
    expect(chooseAutoPick({ available, queue: [], draftedPositions: ["firm"], roster })!.id).toBe("t");
  });
});

describe("lineup", () => {
  const players = [
    { id: "t1", position: "trial" as const, preseasonRank: 1 },
    { id: "t2", position: "trial" as const, preseasonRank: 2 },
    { id: "f1", position: "firm" as const, preseasonRank: 3 },
    { id: "d1", position: "defense" as const, preseasonRank: 4 },
  ];
  const n = starterSlots(roster).length;

  it("validates slot eligibility", () => {
    const s: (string | null)[] = new Array(n).fill(null);
    s[0] = "t1";
    expect(validateLineup(s, roster, players)).toBeNull();
    s[0] = "f1";
    expect(validateLineup(s, roster, players)).toMatch(/can't play/);
    s[0] = null;
    s[4] = "f1"; // flex
    expect(validateLineup(s, roster, players)).toMatch(/can't play/);
  });

  it("autofill fills exact slots then flex", () => {
    const lineup = autoFillLineup(new Array(n).fill(null), roster, players);
    const slots = starterSlots(roster);
    expect(lineup[slots.indexOf("trial")]).toBe("t1");
    expect(lineup[slots.indexOf("defense")]).toBe("d1");
    expect(lineup[slots.indexOf("firm")]).toBe("f1");
    expect(lineup[slots.indexOf("flex")]).toBe("t2");
  });

  it("sanitize drops players not on roster", () => {
    const s: (string | null)[] = new Array(n).fill(null);
    s[0] = "gone";
    expect(sanitizeLineup(s, roster, players)[0]).toBeNull();
  });
});
