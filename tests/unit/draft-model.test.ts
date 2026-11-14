import { describe, expect, it } from "vitest";
import { snakeSlot } from "@/lib/draft";
import { defaultLeagueSettings } from "@/lib/settings";
import {
  MIN_FRESH_CLOCK_SECONDS,
  MIN_RESUME_SECONDS,
  afterDraftCopy,
  buildBoard,
  connectionForStatus,
  filterAvailable,
  finalDraftOrder,
  formatClock,
  groupByPosition,
  isTerminalConnection,
  isUnchanged,
  moveInList,
  nextAutoPickDeadline,
  onClockFor,
  openSlotsFor,
  overallFor,
  picksUntilMyTurn,
  remainingMs,
  resumeClockMs,
  shapeDraftState,
  sortByDraftPosition,
  type DraftLawyer,
  type DraftPickInfo,
  type DraftStateSource,
} from "@/components/draft/model";

const lawyer = (id: string, position: DraftLawyer["position"], rank: number | null, name = id, organization: string | null = null): DraftLawyer => ({
  id,
  name,
  kind: position === "firm" ? "firm" : "lawyer",
  position,
  organization,
  rank,
});

describe("catch-up deadline math", () => {
  const s = 90;
  it("chains from the expired deadline while picks are still overdue", () => {
    const expired = 1_000_000;
    const now = expired + 10 * 60_000; // 10 minutes later
    const next = nextAutoPickDeadline(expired, now, s);
    expect(next).toBe(expired + 90_000);
    expect(next).toBeLessThanOrEqual(now);
  });

  it("simulates a full catch-up: picks due while nobody watched are all auto-picked", () => {
    const start = 0;
    const now = 5 * 90_000 + 30_000; // 5.33 clocks later
    let deadline = start + 90_000;
    let picks = 0;
    while (deadline <= now) {
      deadline = nextAutoPickDeadline(deadline, now, s);
      picks++;
    }
    expect(picks).toBe(5);
    // The team now on the clock gets the rest of its chained clock (60s left)
    expect(deadline - now).toBe(60_000);
  });

  it("live polling: next team gets a full clock from the expired deadline", () => {
    const expired = 500_000;
    const now = expired + 1_200; // polled 1.2s late
    expect(nextAutoPickDeadline(expired, now, s)).toBe(expired + 90_000);
  });

  it("a team landing on the clock with almost no time left gets a minimum clock", () => {
    const expired = 0;
    const now = 89_000; // chained deadline would leave 1s
    expect(nextAutoPickDeadline(expired, now, s)).toBe(now + MIN_FRESH_CLOCK_SECONDS * 1000);
  });

  it("minimum clock never exceeds a full pick clock", () => {
    expect(nextAutoPickDeadline(0, 14_999, 15)).toBe(14_999 + 15_000);
    expect(nextAutoPickDeadline(0, 15_000, 15)).toBe(15_000); // exactly due -> keep catching up
  });
});

describe("resume clock", () => {
  it("keeps remaining time, with a floor and a ceiling", () => {
    expect(resumeClockMs(45_000, 90)).toBe(45_000);
    expect(resumeClockMs(500, 90)).toBe(MIN_RESUME_SECONDS * 1000);
    expect(resumeClockMs(null, 90)).toBe(90_000);
    expect(resumeClockMs(200_000, 90)).toBe(90_000);
    expect(resumeClockMs(0, 5)).toBe(5_000);
  });
});

describe("order helpers", () => {
  it("sorts by slot with unplaced teams last in given order", () => {
    const teams = [
      { id: "a", draftPosition: null },
      { id: "b", draftPosition: 2 },
      { id: "c", draftPosition: null },
      { id: "d", draftPosition: 1 },
    ];
    expect(sortByDraftPosition(teams).map((t) => t.id)).toEqual(["d", "b", "a", "c"]);
  });

  it("final order keeps placed teams and shuffles unplaced in after them", () => {
    const reverse = <U,>(xs: U[]) => [...xs].reverse();
    const teams = [
      { id: "a", draftPosition: null },
      { id: "b", draftPosition: 2 },
      { id: "c", draftPosition: null },
      { id: "d", draftPosition: 1 },
    ];
    expect(finalDraftOrder(teams, reverse)).toEqual(["d", "b", "c", "a"]);
  });

  it("final order is fully shuffled when nobody has a slot", () => {
    const reverse = <U,>(xs: U[]) => [...xs].reverse();
    const teams = [
      { id: "a", draftPosition: null },
      { id: "b", draftPosition: null },
      { id: "c", draftPosition: null },
    ];
    expect(finalDraftOrder(teams, reverse)).toEqual(["c", "b", "a"]);
  });

  it("moves items within bounds", () => {
    expect(moveInList(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveInList(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
    expect(moveInList(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
    expect(moveInList(["a", "b", "c"], 2, 1)).toEqual(["a", "b", "c"]);
  });
});

describe("snake helpers", () => {
  const teams = [{ id: "t1" }, { id: "t2" }, { id: "t3" }];

  it("finds the team on the clock", () => {
    expect(onClockFor(0, teams, 2)).toEqual({ overall: 0, round: 1, pickInRound: 1, teamId: "t1" });
    expect(onClockFor(2, teams, 2)?.teamId).toBe("t3");
    expect(onClockFor(3, teams, 2)).toEqual({ overall: 3, round: 2, pickInRound: 1, teamId: "t3" });
    expect(onClockFor(5, teams, 2)?.teamId).toBe("t1");
    expect(onClockFor(6, teams, 2)).toBeNull();
    expect(onClockFor(0, [], 2)).toBeNull();
  });

  it("overallFor inverts snakeSlot", () => {
    for (const n of [2, 3, 4, 7]) {
      for (let overall = 0; overall < n * 5; overall++) {
        const s = snakeSlot(overall, n);
        expect(overallFor(s.round, s.draftPosition, n)).toBe(overall);
      }
    }
  });

  it("counts picks until my turn", () => {
    // 3 teams, 2 rounds: order 1 2 3 3 2 1
    expect(picksUntilMyTurn(0, 1, 3, 6)).toBe(0);
    expect(picksUntilMyTurn(1, 1, 3, 6)).toBe(4);
    expect(picksUntilMyTurn(2, 3, 3, 6)).toBe(0);
    expect(picksUntilMyTurn(3, 3, 3, 6)).toBe(0);
    expect(picksUntilMyTurn(4, 3, 3, 6)).toBeNull();
    expect(picksUntilMyTurn(0, null, 3, 6)).toBeNull();
  });
});

describe("clock display", () => {
  it("formats remaining time", () => {
    expect(formatClock(90_000)).toBe("1:30");
    expect(formatClock(9_001)).toBe("0:10");
    expect(formatClock(9_000)).toBe("0:09");
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(-5)).toBe("0:00");
  });

  it("corrects for clock skew", () => {
    const deadline = new Date(100_000).toISOString();
    // Client clock is 5s behind the server: skew = +5000
    expect(remainingMs(deadline, 60_000, 5_000)).toBe(35_000);
    expect(remainingMs(deadline, 200_000, 0)).toBe(0);
    expect(remainingMs(null, 0, 0)).toBeNull();
  });
});

describe("lawyer lists", () => {
  const pool = [
    lawyer("a", "trial", 3, "Avery Stone", "Stone & Co"),
    lawyer("b", "prosecutor", 1, "Blake Ford", "U.S. Attorney's Office"),
    lawyer("c", "firm", null, "Crane LLP"),
    lawyer("d", "trial", null, "Dana Ruiz"),
    lawyer("e", "trial", 2, "Eli Park"),
  ];

  it("filters out picked lawyers and sorts by rank then name", () => {
    const out = filterAvailable(pool, new Set(["b"]), {});
    expect(out.map((l) => l.id)).toEqual(["e", "a", "c", "d"]);
  });

  it("filters by position and search (name or organization)", () => {
    expect(filterAvailable(pool, new Set(), { position: "trial" }).map((l) => l.id)).toEqual(["e", "a", "d"]);
    expect(filterAvailable(pool, new Set(), { query: "attorney" }).map((l) => l.id)).toEqual(["b"]);
    expect(filterAvailable(pool, new Set(), { query: "  RUIZ " }).map((l) => l.id)).toEqual(["d"]);
  });

  it("groups by position in standard order", () => {
    const groups = groupByPosition(pool);
    expect(groups.map((g) => g.position)).toEqual(["trial", "prosecutor", "firm"]);
    expect(groups[0].lawyers.map((l) => l.id)).toEqual(["a", "d", "e"]);
  });

  it("reports open starter slots", () => {
    const roster = defaultLeagueSettings().roster; // TRL APP PRO DEF FLEX FLEX FIRM
    // Three trial lawyers fill TRL and both FLEX spots.
    expect(openSlotsFor([pool[0], pool[3], pool[4]], roster)).toEqual(["appellate", "prosecutor", "defense", "firm"]);
    expect(openSlotsFor([pool[0]], roster)).toEqual(["appellate", "prosecutor", "defense", "flex", "flex", "firm"]);
  });
});

describe("board", () => {
  it("places picks in round x team-in-draft-order cells", () => {
    const teams = [{ id: "t1" }, { id: "t2" }];
    const picks: DraftPickInfo[] = [
      { overall: 0, round: 1, pickInRound: 1, teamId: "t1", lawyerId: "x", isAuto: false },
      { overall: 1, round: 1, pickInRound: 2, teamId: "t2", lawyerId: "y", isAuto: true },
      { overall: 2, round: 2, pickInRound: 1, teamId: "t2", lawyerId: "z", isAuto: false },
    ];
    const grid = buildBoard(teams, picks, 3);
    expect(grid).toHaveLength(3);
    expect(grid[0].map((c) => c?.lawyerId ?? null)).toEqual(["x", "y"]);
    expect(grid[1].map((c) => c?.lawyerId ?? null)).toEqual([null, "z"]);
    expect(grid[2].map((c) => c?.lawyerId ?? null)).toEqual([null, null]);
  });
});

describe("shapeDraftState", () => {
  const src: DraftStateSource = {
    leagueId: "L",
    leagueStatus: "drafting",
    status: "in_progress",
    version: 7,
    rounds: 2,
    secondsPerPick: 60,
    currentPick: 1,
    pickDeadline: new Date("2026-01-01T00:01:00Z"),
    pausedRemainingMs: null,
    scheduledAt: null,
    teams: [
      { id: "t1", name: "One", ownerName: "A", draftPosition: 1 },
      { id: "t2", name: "Two", ownerName: "B", draftPosition: 2 },
    ],
    picks: [{ overall: 0, round: 1, pickInRound: 1, teamId: "t1", lawyerId: "x", isAuto: false }],
    queue: ["q1"],
    poolSize: 10,
    lawyers: [lawyer("x", "trial", 1)],
  };

  it("builds the client JSON with clock info", () => {
    const now = new Date("2026-01-01T00:00:30Z");
    const json = shapeDraftState(src, { myTeamId: "t2", isCommissioner: false, now, includePool: false });
    expect(json.onClock).toEqual({ overall: 1, round: 1, pickInRound: 2, teamId: "t2" });
    expect(json.totalPicks).toBe(4);
    expect(json.deadline).toBe("2026-01-01T00:01:00.000Z");
    expect(json.serverNow).toBe("2026-01-01T00:00:30.000Z");
    expect(json.orderSet).toBe(true);
    expect(json.myQueue).toEqual(["q1"]);
    expect(json.pool).toBeUndefined();
    expect(isUnchanged(json)).toBe(false);
  });

  it("includes the pool only when asked and hides the deadline when paused", () => {
    const json = shapeDraftState(
      { ...src, status: "paused", pickDeadline: null, pausedRemainingMs: 12_000 },
      { myTeamId: null, isCommissioner: true, now: new Date(0), includePool: true },
    );
    expect(json.pool).toHaveLength(1);
    expect(json.deadline).toBeNull();
    expect(json.pausedRemainingMs).toBe(12_000);
    expect(json.onClock?.teamId).toBe("t2");
  });

  it("has no team on the clock before the draft or when it is complete", () => {
    const before = shapeDraftState(
      { ...src, status: "not_started", leagueStatus: "setup", currentPick: 0, teams: [{ ...src.teams[0], draftPosition: null }] },
      { myTeamId: null, isCommissioner: false, now: new Date(0), includePool: false },
    );
    expect(before.onClock).toBeNull();
    expect(before.deadline).toBeNull();
    expect(before.orderSet).toBe(false);
    const done = shapeDraftState({ ...src, status: "complete", currentPick: 4 }, { myTeamId: null, isCommissioner: false, now: new Date(0), includePool: false });
    expect(done.onClock).toBeNull();
    expect(isUnchanged({ unchanged: true, version: 1, serverNow: "" })).toBe(true);
  });
});

describe("draft room polling and after-draft copy", () => {
  it("stops polling on 401 / 404 and retries other failures", () => {
    expect(connectionForStatus(200)).toBe("ok");
    expect(connectionForStatus(401)).toBe("signed_out");
    expect(connectionForStatus(404)).toBe("removed");
    expect(connectionForStatus(403)).toBe("removed");
    expect(connectionForStatus(500)).toBe("retrying");
    expect(connectionForStatus(503)).toBe("retrying");
    expect(isTerminalConnection("signed_out")).toBe(true);
    expect(isTerminalConnection("removed")).toBe(true);
    expect(isTerminalConnection("retrying")).toBe(false);
  });
  it("varies the done card by where the season stands", () => {
    expect(afterDraftCopy({ phase: "preseason", nextLock: "Mon, Sep 7, 9:00 AM" }).body).toBe(
      "The season is set up. Check your roster and set your starting lineup before the first lineup lock (Mon, Sep 7, 9:00 AM).",
    );
    expect(afterDraftCopy({ phase: "in_season", nextLock: "Mon, Oct 5, 9:00 AM" }).body).toContain("under way");
    expect(afterDraftCopy({ phase: "in_season", nextLock: null }).body).not.toContain("lock");
    expect(afterDraftCopy({ phase: "playoffs", nextLock: null }).body).toContain("playoffs are on");
    const done = afterDraftCopy({ phase: "complete", nextLock: null });
    expect(done.title).toBe("Draft results");
    expect(done.body).not.toContain("lineup");
  });
});
