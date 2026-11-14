import { describe, expect, it } from "vitest";
import { joinClosedReason } from "@/app/join/join-rules";

describe("joinClosedReason", () => {
  const open = { status: "setup" as const, teamCount: 3, maxTeams: 8 };
  it("lets pre-draft leagues with a free spot take teams", () => {
    expect(joinClosedReason(open)).toBeNull();
  });
  it("explains why a league is closed", () => {
    expect(joinClosedReason({ ...open, teamCount: 8 })).toMatch(/full/);
    expect(joinClosedReason({ ...open, status: "drafting" })).toMatch(/draft is in progress/);
    expect(joinClosedReason({ ...open, status: "in_season" })).toMatch(/already drafted/);
    expect(joinClosedReason({ ...open, status: "playoffs" })).toMatch(/already drafted/);
    expect(joinClosedReason({ ...open, status: "complete" })).toMatch(/season is over/);
  });
});
