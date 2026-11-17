import { describe, expect, it } from "vitest";
import { parseTakeoverUsername, teamHandoffProblem, type TeamHandoffFacts } from "@/app/leagues/[leagueId]/commish/members/rules";

const OK: TeamHandoffFacts = {
  leagueStatus: "in_season",
  leagueCreatedBy: "creator",
  team: { ownerId: "old" },
  expectedOwnerId: "old",
  currentOwner: { role: "member", isCreator: false },
  newUser: { id: "new" },
  newUserIsMember: false,
  newUserOwnsTeam: false,
};

describe("parseTakeoverUsername", () => {
  it("trims, lowercases and drops a leading @", () => {
    expect(parseTakeoverUsername("  @Sam_K ")).toBe("sam_k");
    expect(parseTakeoverUsername("sam")).toBe("sam");
  });
  it("is blank for missing input", () => {
    expect(parseTakeoverUsername(null)).toBe("");
    expect(parseTakeoverUsername("   ")).toBe("");
    expect(parseTakeoverUsername("@")).toBe("");
  });
});

describe("teamHandoffProblem", () => {
  it("refuses when the team changed hands since the page loaded", () => {
    expect(teamHandoffProblem({ ...OK, team: { ownerId: "someone-else" } })).toMatch(/just changed hands/);
    expect(teamHandoffProblem({ ...OK, expectedOwnerId: "stale" })).toMatch(/just changed hands/);
  });
  it("allows a hand-off in every phase before the season ends", () => {
    for (const leagueStatus of ["setup", "drafting", "in_season", "playoffs"] as const) {
      expect(teamHandoffProblem({ ...OK, leagueStatus })).toBeNull();
    }
  });

  it("refuses once the season is complete", () => {
    expect(teamHandoffProblem({ ...OK, leagueStatus: "complete" })).toMatch(/season is over/);
  });

  it("refuses a team that isn't in the league", () => {
    expect(teamHandoffProblem({ ...OK, team: null })).toMatch(/isn't in this league/);
  });

  it("never gives away the creator's team", () => {
    expect(teamHandoffProblem({ ...OK, leagueCreatedBy: "old" })).toMatch(/creator/);
    expect(teamHandoffProblem({ ...OK, currentOwner: { role: "commissioner", isCreator: true } })).toMatch(/creator/);
  });

  it("refuses a commissioner's team", () => {
    expect(teamHandoffProblem({ ...OK, currentOwner: { role: "commissioner", isCreator: false } })).toMatch(/Commissioners/);
  });

  it("still works when the old owner has no membership row", () => {
    expect(teamHandoffProblem({ ...OK, currentOwner: null })).toBeNull();
  });

  it("refuses an unknown username", () => {
    expect(teamHandoffProblem({ ...OK, newUser: null })).toMatch(/No account/);
  });

  it("refuses the current owner", () => {
    expect(teamHandoffProblem({ ...OK, newUser: { id: "old" }, newUserIsMember: true, newUserOwnsTeam: true })).toMatch(
      /already owns this team/,
    );
  });

  it("refuses someone who already has a team or is already a member", () => {
    expect(teamHandoffProblem({ ...OK, newUserOwnsTeam: true, newUserIsMember: true })).toMatch(/already has a team/);
    expect(teamHandoffProblem({ ...OK, newUserIsMember: true })).toMatch(/already in this league/);
  });
});
