import { describe, expect, it } from "vitest";
import {
  dropGoesToWaivers,
  FREE_AGENT_GRACE_MS,
  movesClosedReason,
  movesOpen,
  reorderIds,
} from "@/server/services/transactions-moves";
import { waiverOrder, waiverRunDue } from "@/server/services/waivers-processing";

const now = new Date("2026-11-14T12:00:00Z");

describe("drop rules", () => {
  it("free-agent pickups dropped within 24h skip waivers", () => {
    expect(dropGoesToWaivers({ acquiredVia: "free_agent", acquiredAt: new Date(now.getTime() - 60_000) }, now)).toBe(false);
    expect(dropGoesToWaivers({ acquiredVia: "free_agent", acquiredAt: new Date(now.getTime() - FREE_AGENT_GRACE_MS + 1) }, now)).toBe(false);
    expect(dropGoesToWaivers({ acquiredVia: "free_agent", acquiredAt: new Date(now.getTime() - FREE_AGENT_GRACE_MS) }, now)).toBe(true);
  });

  it("everyone else goes to waivers", () => {
    for (const via of ["draft", "waiver", "trade", "commissioner"]) {
      expect(dropGoesToWaivers({ acquiredVia: via, acquiredAt: now }, now)).toBe(true);
    }
  });

  it("moves are open only in season and playoffs", () => {
    expect(movesOpen("in_season")).toBe(true);
    expect(movesOpen("playoffs")).toBe(true);
    for (const s of ["setup", "drafting", "complete"] as const) {
      expect(movesOpen(s)).toBe(false);
      expect(movesClosedReason(s)).toBeTruthy();
    }
    expect(movesClosedReason("in_season")).toBeNull();
  });
});

describe("reorderIds", () => {
  it("moves an id up or down and ignores the ends", () => {
    expect(reorderIds(["a", "b", "c"], "b", "up")).toEqual(["b", "a", "c"]);
    expect(reorderIds(["a", "b", "c"], "b", "down")).toEqual(["a", "c", "b"]);
    expect(reorderIds(["a", "b", "c"], "a", "up")).toEqual(["a", "b", "c"]);
    expect(reorderIds(["a", "b", "c"], "c", "down")).toEqual(["a", "b", "c"]);
    expect(reorderIds(["a", "b"], "zz", "up")).toEqual(["a", "b"]);
  });
});

describe("waiver run helpers", () => {
  it("orders teams by priority, then teams without one (oldest first)", () => {
    const t = (id: string, waiverPriority: number | null, created: number) => ({ id, waiverPriority, createdAt: new Date(created) });
    expect(waiverOrder([t("c", null, 1), t("a", 2, 5), t("b", 1, 9), t("d", null, 0)])).toEqual(["b", "a", "d", "c"]);
  });

  it("is due only in season/playoffs once the scheduled time passes", () => {
    const past = new Date(now.getTime() - 1);
    const future = new Date(now.getTime() + 1);
    expect(waiverRunDue({ status: "in_season", nextWaiverRunAt: past }, now)).toBe(true);
    expect(waiverRunDue({ status: "playoffs", nextWaiverRunAt: now }, now)).toBe(true);
    expect(waiverRunDue({ status: "in_season", nextWaiverRunAt: future }, now)).toBe(false);
    expect(waiverRunDue({ status: "in_season", nextWaiverRunAt: null }, now)).toBe(false);
    expect(waiverRunDue({ status: "complete", nextWaiverRunAt: past }, now)).toBe(false);
    expect(waiverRunDue({ status: "drafting", nextWaiverRunAt: past }, now)).toBe(false);
  });
});
