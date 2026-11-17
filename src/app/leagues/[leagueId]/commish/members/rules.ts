/**
 * Pure rules for the commissioner Members page. No DB or request access here
 * so they can be unit tested.
 */
import { normalizeUsername } from "@/app/account/rules";

/** The username box: trims, lowercases and drops a leading "@". "" when blank. */
export function parseTakeoverUsername(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return normalizeUsername(raw).replace(/^@+/, "").trim();
}

export type TeamHandoffFacts = {
  leagueStatus: "setup" | "drafting" | "in_season" | "playoffs" | "complete";
  /** The league's creator (leagues.created_by). */
  leagueCreatedBy: string;
  /** The team being handed over, or null when it isn't in this league. */
  team: { ownerId: string } | null;
  /** The owner the commissioner saw on the page when they confirmed. */
  expectedOwnerId: string;
  /** The current owner's membership, or null if they somehow have none. */
  currentOwner: { role: "commissioner" | "member"; isCreator: boolean } | null;
  /** The account the username points to, or null when there's no such account. */
  newUser: { id: string } | null;
  /** That account already has a league_members row here. */
  newUserIsMember: boolean;
  /** That account already owns a team here. */
  newUserOwnsTeam: boolean;
};

/**
 * Why a team can't be handed to another student, or null when it can. Works
 * in every phase (before, during and after the draft) except a finished season.
 */
export function teamHandoffProblem(f: TeamHandoffFacts): string | null {
  if (f.leagueStatus === "complete") return "This season is over, so teams can't change hands.";
  if (!f.team) return "That team isn't in this league.";
  if (f.team.ownerId !== f.expectedOwnerId) return "This team just changed hands. Refresh and try again.";
  if (f.team.ownerId === f.leagueCreatedBy || f.currentOwner?.isCreator) return "The league creator's team can't be given away.";
  if (f.currentOwner?.role === "commissioner") {
    return "Commissioners' teams can't be given away. Make them a regular member first.";
  }
  if (!f.newUser) return "No account has that username. Check the spelling.";
  if (f.newUser.id === f.team.ownerId) return "That student already owns this team.";
  if (f.newUserOwnsTeam) return "That student already has a team in this league.";
  if (f.newUserIsMember) return "That student is already in this league.";
  return null;
}
