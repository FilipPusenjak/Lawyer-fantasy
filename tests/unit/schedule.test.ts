import { describe, expect, it } from "vitest";
import {
  bracketSeedOrder,
  decideWinner,
  firstRoundBracket,
  leagueMedianFor,
  median,
  nextRoundPairs,
  regularSeasonSchedule,
  roundRobin,
} from "@/lib/schedule";
import { defaultLeagueSettings } from "@/lib/settings";

describe("round robin", () => {
  it("every team plays every other exactly once per cycle (even)", () => {
    const teams = ["a", "b", "c", "d", "e", "f"];
    const rr = roundRobin(teams, 5);
    const seen = new Set<string>();
    for (const round of rr) {
      const inRound = new Set<string>();
      for (const p of round) {
        expect(p.teamB).not.toBeNull();
        for (const t of [p.teamA, p.teamB!]) {
          expect(inRound.has(t)).toBe(false);
          inRound.add(t);
        }
        seen.add([p.teamA, p.teamB].sort().join("-"));
      }
      expect(inRound.size).toBe(6);
    }
    expect(seen.size).toBe(15);
  });

  it("odd team counts get one median game per period", () => {
    const rr = roundRobin(["a", "b", "c", "d", "e"], 10);
    for (const round of rr) {
      expect(round.filter((p) => p.teamB === null).length).toBe(1);
      expect(round.length).toBe(3);
    }
  });

  it("regular season periods map to week ranges", () => {
    const s = defaultLeagueSettings().schedule;
    const sched = regularSeasonSchedule(["a", "b", "c", "d"], s);
    expect(sched.length).toBe(10);
    expect(sched[0]).toMatchObject({ period: 1, weekStart: 1, weekEnd: 2 });
    expect(sched[9]).toMatchObject({ period: 10, weekStart: 19, weekEnd: 20 });
  });
});

describe("playoffs", () => {
  it("seed order", () => {
    expect(bracketSeedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
  });
  it("6-team bracket gives top 2 byes", () => {
    const r1 = firstRoundBracket(6);
    expect(r1.length).toBe(4);
    const byes = r1.filter((m) => m.seedB === null).map((m) => m.seedA).sort();
    expect(byes).toEqual([1, 2]);
    const games = r1.filter((m) => m.seedB !== null).map((m) => [m.seedA, m.seedB]);
    expect(games).toContainEqual([4, 5]);
    expect(games).toContainEqual([3, 6]);
  });
  it("4-team bracket", () => {
    expect(firstRoundBracket(4)).toEqual([
      { bracketSlot: 0, seedA: 1, seedB: 4 },
      { bracketSlot: 1, seedA: 2, seedB: 3 },
    ]);
  });
  it("next round pairs adjacent slots, higher seed as team A", () => {
    const pairs = nextRoundPairs([
      { bracketSlot: 1, winnerTeamId: "t3", winnerSeed: 3 },
      { bracketSlot: 0, winnerTeamId: "t1", winnerSeed: 1 },
    ]);
    expect(pairs).toEqual([
      { bracketSlot: 0, a: { bracketSlot: 0, winnerTeamId: "t1", winnerSeed: 1 }, b: { bracketSlot: 1, winnerTeamId: "t3", winnerSeed: 3 } },
    ]);
  });
  it("playoff ties go to higher seed; regular season ties are ties", () => {
    expect(decideWinner({ teamA: "a", teamB: "b", scoreA: 5, scoreB: 5, isPlayoff: false })).toBeNull();
    expect(decideWinner({ teamA: "a", teamB: "b", scoreA: 5, scoreB: 5, isPlayoff: true, seedA: 4, seedB: 1 })).toBe("b");
  });
  it("median", () => {
    expect(median([1, 5, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it("the league median leaves out the team playing it", () => {
    const totals = new Map([
      ["a", 55],
      ["b", 40],
      ["c", 80],
    ]);
    // a is the middle score: it plays the median of b and c (60), not its own 55.
    expect(leagueMedianFor("a", totals)).toBe(60);
    expect(leagueMedianFor("b", totals)).toBe(67.5);
    expect(leagueMedianFor("c", totals)).toBe(47.5);
    expect(leagueMedianFor("a", [["a", 10]])).toBe(0);
    expect(leagueMedianFor("x", [["a", 1.111], ["b", 2.222]])).toBe(1.67);
  });
});
