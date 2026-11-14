import { describe, expect, it } from "vitest";
import { chooseAutoPick } from "@/lib/draft";
import { defaultLeagueSettings, type Position } from "@/lib/settings";

const roster = defaultLeagueSettings().roster; // TRL, APP, PRO, DEF, FLEX x2, FIRM + 5 bench

const cand = (id: string, position: Position, preseasonRank: number | null) => ({ id, position, preseasonRank, name: id.toUpperCase() });

describe("chooseAutoPick (review)", () => {
  it("uses the queue when the only open starter slot can't be filled by anyone left", () => {
    // Every individual starter slot is filled; only FIRM is open, but no firms remain.
    const drafted: Position[] = ["trial", "appellate", "prosecutor", "defense", "trial", "defense"];
    const available = [cand("best", "trial", 1), cand("queued", "appellate", 50)];
    const pick = chooseAutoPick({ available, queue: ["queued"], draftedPositions: drafted, roster });
    expect(pick?.id).toBe("queued");
  });

  it("still prefers a queued lawyer who fills a fillable open slot over one who doesn't", () => {
    // Open: FIRM (no firms left) and PRO (fillable).
    const drafted: Position[] = ["trial", "appellate", "defense", "trial", "defense"];
    const available = [cand("app", "appellate", 1), cand("pro", "prosecutor", 9)];
    const pick = chooseAutoPick({ available, queue: ["app", "pro"], draftedPositions: drafted, roster });
    expect(pick?.id).toBe("pro");
  });

  it("falls back to need, then rank, when the queue is empty", () => {
    const drafted: Position[] = ["trial", "appellate", "prosecutor", "defense", "trial", "defense"];
    const available = [cand("b", "trial", 2), cand("a", "appellate", 1)];
    expect(chooseAutoPick({ available, queue: [], draftedPositions: drafted, roster })?.id).toBe("a");
  });
});
