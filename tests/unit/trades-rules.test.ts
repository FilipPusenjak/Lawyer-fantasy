import { describe, expect, it } from "vitest";
import {
  allowedTradeActions,
  canViewTrade,
  describeTradeForTeam,
  joinNames,
  normalizeTradeMessage,
  ownershipError,
  reviewEndsAtFor,
  rosterOverflow,
  rosterSizeError,
  rosterSizesAfterTrade,
  TRADE_MESSAGE_MAX,
  tradeWindowError,
  validateTradeShape,
  type TradeStatus,
} from "@/server/services/trades";
import {
  firstParam,
  idParams,
  newTradeHref,
  reviewText,
  TRADE_STATUS_LABELS,
  tradeDeadlineText,
  tradeStatusTone,
} from "@/app/leagues/[leagueId]/trades/trade-labels";
import { isUuid } from "@/lib/format";

const A = "team-a";
const B = "team-b";
const C = "team-c";

describe("tradeWindowError", () => {
  it("is closed before the draft and after the season", () => {
    expect(tradeWindowError({ leagueStatus: "setup", deadlineWeek: null, currentWeek: 0 })).toMatch(/draft/);
    expect(tradeWindowError({ leagueStatus: "drafting", deadlineWeek: null, currentWeek: 0 })).toMatch(/draft/);
    expect(tradeWindowError({ leagueStatus: "complete", deadlineWeek: null, currentWeek: 30 })).toMatch(/over/);
  });
  it("is open in season and playoffs with no deadline", () => {
    expect(tradeWindowError({ leagueStatus: "in_season", deadlineWeek: null, currentWeek: 12 })).toBeNull();
    expect(tradeWindowError({ leagueStatus: "playoffs", deadlineWeek: null, currentWeek: 22 })).toBeNull();
  });
  it("allows trades through the deadline week (inclusive)", () => {
    expect(tradeWindowError({ leagueStatus: "in_season", deadlineWeek: 8, currentWeek: 8 })).toBeNull();
    expect(tradeWindowError({ leagueStatus: "in_season", deadlineWeek: 8, currentWeek: 9 })).toBe("The trade deadline (week 8) has passed.");
  });
});

describe("validateTradeShape", () => {
  const base = { proposerTeamId: A, recipientTeamId: B, giveLawyerIds: ["x"], getLawyerIds: ["y"], message: null };
  it("accepts a normal trade and one-sided trades", () => {
    expect(validateTradeShape(base)).toBeNull();
    expect(validateTradeShape({ ...base, getLawyerIds: [] })).toBeNull();
    expect(validateTradeShape({ ...base, giveLawyerIds: [] })).toBeNull();
  });
  it("rejects trading with yourself", () => {
    expect(validateTradeShape({ ...base, recipientTeamId: A })).toMatch(/yourself/);
  });
  it("needs at least one lawyer", () => {
    expect(validateTradeShape({ ...base, giveLawyerIds: [], getLawyerIds: [] })).toMatch(/at least one/);
  });
  it("rejects duplicates, within and across sides", () => {
    expect(validateTradeShape({ ...base, giveLawyerIds: ["x", "x"] })).toMatch(/once/);
    expect(validateTradeShape({ ...base, getLawyerIds: ["x"] })).toMatch(/once/);
  });
  it("limits the message length", () => {
    expect(validateTradeShape({ ...base, message: "a".repeat(TRADE_MESSAGE_MAX) })).toBeNull();
    expect(validateTradeShape({ ...base, message: "a".repeat(TRADE_MESSAGE_MAX + 1) })).toMatch(/280/);
  });
});

describe("normalizeTradeMessage", () => {
  it("trims and turns blanks into null", () => {
    expect(normalizeTradeMessage("  hi  ")).toBe("hi");
    expect(normalizeTradeMessage("   ")).toBeNull();
    expect(normalizeTradeMessage(null)).toBeNull();
    expect(normalizeTradeMessage(undefined)).toBeNull();
    expect(normalizeTradeMessage("a\r\nb")).toBe("a\nb");
  });
});

describe("roster sizes after a swap", () => {
  it("computes both sides", () => {
    expect(rosterSizesAfterTrade({ proposerSize: 12, recipientSize: 13, giveCount: 1, getCount: 2 })).toEqual({ proposer: 13, recipient: 12 });
  });
  it("allows trades that land exactly on the max", () => {
    const args = { proposerSize: 12, recipientSize: 13, giveCount: 1, getCount: 2, maxRoster: 13 };
    expect(rosterOverflow(args)).toBeNull();
    expect(rosterSizeError({ ...args, proposerName: "A", recipientName: "B" })).toBeNull();
  });
  it("flags the proposer's roster going over", () => {
    const args = { proposerSize: 13, recipientSize: 13, giveCount: 1, getCount: 2, maxRoster: 13 };
    expect(rosterOverflow(args)).toEqual({ side: "proposer", size: 14 });
    expect(rosterSizeError({ ...args, proposerName: "Your team", recipientName: "B" })).toBe(
      "Your team would have 14 lawyers, over the 13-lawyer roster limit.",
    );
  });
  it("flags the recipient's roster going over (one-sided gift)", () => {
    const args = { proposerSize: 10, recipientSize: 13, giveCount: 1, getCount: 0, maxRoster: 13 };
    expect(rosterOverflow(args)).toEqual({ side: "recipient", size: 14 });
    expect(rosterSizeError({ ...args, proposerName: "A", recipientName: "The Briefcases" })).toMatch(/^The Briefcases would have 14/);
  });
  it("lets a full roster make an even swap", () => {
    expect(rosterOverflow({ proposerSize: 13, recipientSize: 13, giveCount: 2, getCount: 2, maxRoster: 13 })).toBeNull();
  });
});

describe("ownershipError", () => {
  const items = [
    { lawyerId: "x", lawyerName: "Pat Example", fromTeamId: A, fromTeamName: "Team A" },
    { lawyerId: "y", lawyerName: "Sam Sample", fromTeamId: B, fromTeamName: "Team B" },
  ];
  it("passes when every lawyer is still on the giving team", () => {
    expect(ownershipError(items, new Map([["x", A], ["y", B]]))).toBeNull();
  });
  it("names the lawyer who moved or was dropped", () => {
    expect(ownershipError(items, new Map([["x", A], ["y", C]]))).toBe("Sam Sample is no longer on Team B.");
    expect(ownershipError(items, new Map([["y", B]]))).toBe("Pat Example is no longer on Team A.");
  });
});

describe("reviewEndsAtFor", () => {
  it("adds the review hours", () => {
    const t = new Date("2026-11-14T12:00:00Z");
    expect(reviewEndsAtFor(t, 24).toISOString()).toBe("2026-11-15T12:00:00.000Z");
    expect(reviewEndsAtFor(t, 0).getTime()).toBe(t.getTime());
  });
});

describe("visibility and actions", () => {
  const proposed = { status: "proposed" as TradeStatus, proposerTeamId: A, recipientTeamId: B, reviewEndsAt: null };
  const accepted = { ...proposed, status: "accepted" as TradeStatus, reviewEndsAt: new Date() };
  const rejected = { ...proposed, status: "rejected" as TradeStatus };
  const vetoed = { ...accepted, status: "vetoed" as TradeStatus };

  it("keeps offers private to the two teams until accepted", () => {
    expect(canViewTrade(proposed, { teamId: A, isCommissioner: false })).toBe(true);
    expect(canViewTrade(proposed, { teamId: B, isCommissioner: false })).toBe(true);
    expect(canViewTrade(proposed, { teamId: C, isCommissioner: false })).toBe(false);
    expect(canViewTrade(proposed, { teamId: C, isCommissioner: true })).toBe(false);
    expect(canViewTrade(rejected, { teamId: C, isCommissioner: false })).toBe(false);
  });
  it("makes accepted trades public", () => {
    expect(canViewTrade(accepted, { teamId: C, isCommissioner: false })).toBe(true);
    expect(canViewTrade(vetoed, { teamId: null, isCommissioner: false })).toBe(true);
  });
  it("gives the recipient accept/decline and the proposer cancel", () => {
    expect(allowedTradeActions(proposed, { teamId: B, isCommissioner: false })).toEqual({
      accept: true,
      reject: true,
      cancel: false,
      veto: false,
      approve: false,
    });
    expect(allowedTradeActions(proposed, { teamId: A, isCommissioner: false })).toMatchObject({ accept: false, cancel: true });
  });
  it("lets the proposer back out during review and commissioners veto/approve", () => {
    expect(allowedTradeActions(accepted, { teamId: A, isCommissioner: false })).toMatchObject({ cancel: true, veto: false });
    expect(allowedTradeActions(accepted, { teamId: B, isCommissioner: false })).toMatchObject({ accept: false, cancel: false });
    expect(allowedTradeActions(accepted, { teamId: C, isCommissioner: true })).toMatchObject({ veto: true, approve: true });
    expect(allowedTradeActions(proposed, { teamId: C, isCommissioner: true })).toMatchObject({ veto: false, approve: false });
  });
  it("offers nothing on settled trades", () => {
    for (const t of [rejected, vetoed]) {
      expect(Object.values(allowedTradeActions(t, { teamId: A, isCommissioner: true })).some(Boolean)).toBe(false);
    }
  });
});

describe("activity text", () => {
  it("joins names", () => {
    expect(joinNames([])).toBe("");
    expect(joinNames(["A"])).toBe("A");
    expect(joinNames(["A", "B"])).toBe("A and B");
    expect(joinNames(["A", "B", "C"])).toBe("A, B and C");
  });
  it("describes each side", () => {
    expect(describeTradeForTeam({ teamName: "Team A", otherTeamName: "Team B", gave: ["X"], got: ["Y"] })).toBe("Team A traded X to Team B.");
    expect(describeTradeForTeam({ teamName: "Team B", otherTeamName: "Team A", gave: [], got: ["X", "Z"] })).toBe(
      "Team B got X and Z from Team A in a trade.",
    );
  });
});

describe("trade labels", () => {
  it("has a label and tone for every status", () => {
    const statuses: TradeStatus[] = ["proposed", "accepted", "completed", "rejected", "cancelled", "vetoed", "failed"];
    for (const s of statuses) {
      expect(TRADE_STATUS_LABELS[s]).toBeTruthy();
      expect(tradeStatusTone(s)).toBeTruthy();
    }
  });
  it("explains the deadline", () => {
    const base = { seasonStart: "2026-09-07", currentWeek: 3 };
    expect(tradeDeadlineText({ ...base, leagueStatus: "in_season", deadlineWeek: null })).toMatch(/No trade deadline/);
    expect(tradeDeadlineText({ ...base, leagueStatus: "in_season", deadlineWeek: 8 })).toBe(
      "Trade deadline: end of week 8 (Nov 1, 2026).",
    );
    expect(tradeDeadlineText({ ...base, currentWeek: 9, leagueStatus: "in_season", deadlineWeek: 8 })).toMatch(/passed/);
    expect(tradeDeadlineText({ ...base, leagueStatus: "setup", deadlineWeek: 8 })).toMatch(/draft/);
  });
  it("explains the review window", () => {
    expect(reviewText(0)).toMatch(/right away/);
    expect(reviewText(24)).toMatch(/1-day/);
    expect(reviewText(12)).toMatch(/12-hour/);
  });
  it("parses search params", () => {
    const id1 = "3f1c2b8e-6a0e-4c51-9a7e-2d9b8f1e4a10";
    const id2 = "4f1c2b8e-6a0e-4c51-9a7e-2d9b8f1e4a11";
    expect(firstParam(["a", "b"])).toBe("a");
    expect(firstParam(undefined)).toBeUndefined();
    expect(idParams(`${id1},${id2},nope,${id1}`, isUuid)).toEqual([id1, id2]);
    expect(idParams([id2], isUuid)).toEqual([id2]);
    expect(idParams(undefined, isUuid)).toEqual([]);
  });
  it("builds new-trade links", () => {
    expect(newTradeHref("L")).toBe("/leagues/L/trades/new");
    expect(newTradeHref("L", { withTeamId: "T", give: ["a"], get: ["b", "c"] })).toBe("/leagues/L/trades/new?with=T&give=a&get=b%2Cc");
  });
});
