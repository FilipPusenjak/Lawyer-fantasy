/**
 * Pure rolling-priority waiver processing.
 *
 * Repeatedly: walk teams in priority order; the first team with a valid
 * pending claim wins it, moves to the back of the priority order, and the walk
 * restarts from the top. Stops when no team has a valid claim. Remaining
 * pending claims are lost.
 *
 * A claim is valid if the added lawyer is unrostered, the drop lawyer (if any)
 * is still on the claiming team, and the team's roster stays within maxRoster.
 */
import { nextWeeklyTime } from "./time";

// ---------------------------------------------------------------------------
// Minimum time on waivers
// ---------------------------------------------------------------------------

/**
 * A lawyer stays on waivers at least this long, so a drop just before the run
 * still gets a full claim window (and can't be handed to a friend right after).
 */
export const WAIVER_MIN_HOLD_HOURS = 24;
const WAIVER_MIN_HOLD_MS = WAIVER_MIN_HOLD_HOURS * 60 * 60 * 1000;

/** Can a run at `runAt` release a lawyer who went on waivers at `heldSince`? */
export function holdReleasable(heldSince: Date, runAt: Date): boolean {
  return runAt.getTime() - heldSince.getTime() >= WAIVER_MIN_HOLD_MS;
}

/**
 * When a lawyer on waivers since `heldSince` clears waivers (claims on them are
 * decided then): the first scheduled run, starting at `nextRunAt`, that is at
 * least WAIVER_MIN_HOLD_HOURS after `heldSince`.
 */
export function waiverClearTime(
  heldSince: Date,
  nextRunAt: Date,
  schedule: { processDay: number; processTime: string; timeZone: string },
): Date {
  let t = nextRunAt;
  // Runs are weekly and the hold is a day, so this loops at most a couple of times.
  for (let i = 0; i < 60 && !holdReleasable(heldSince, t); i++) {
    t = nextWeeklyTime(t, schedule.processDay, schedule.processTime, schedule.timeZone);
  }
  return t;
}

// ---------------------------------------------------------------------------
// Processing
// ---------------------------------------------------------------------------

export type ClaimInput = {
  id: string;
  teamId: string;
  addLawyerId: string;
  dropLawyerId: string | null;
  claimOrder: number;
  createdAt: number; // epoch ms, tiebreak within a team
};

export type WaiverResult = {
  awarded: { claimId: string; teamId: string; addLawyerId: string; dropLawyerId: string | null }[];
  lost: string[]; // claim ids
  finalPriority: string[]; // team ids, first = top priority
};

export function processWaivers(args: {
  priority: string[]; // team ids, index 0 = first priority
  claims: ClaimInput[];
  rosters: Map<string, Set<string>>; // teamId -> lawyer ids (mutated copy is used)
  maxRoster: number;
}): WaiverResult {
  const priority = [...args.priority];
  const rosters = new Map<string, Set<string>>();
  for (const [t, s] of args.rosters) rosters.set(t, new Set(s));
  const rostered = new Set<string>();
  for (const s of rosters.values()) for (const l of s) rostered.add(l);

  const pending = new Map<string, ClaimInput[]>();
  for (const c of args.claims) {
    const arr = pending.get(c.teamId) ?? [];
    arr.push(c);
    pending.set(c.teamId, arr);
  }
  for (const arr of pending.values()) arr.sort((a, b) => a.claimOrder - b.claimOrder || a.createdAt - b.createdAt);

  const awarded: WaiverResult["awarded"] = [];
  const done = new Set<string>();

  const isValid = (c: ClaimInput): boolean => {
    if (rostered.has(c.addLawyerId)) return false;
    const roster = rosters.get(c.teamId) ?? new Set<string>();
    if (c.dropLawyerId) {
      if (!roster.has(c.dropLawyerId)) return false;
      return roster.size - 1 + 1 <= args.maxRoster;
    }
    return roster.size + 1 <= args.maxRoster;
  };

  let progress = true;
  while (progress) {
    progress = false;
    for (let i = 0; i < priority.length; i++) {
      const teamId = priority[i];
      const claims = (pending.get(teamId) ?? []).filter((c) => !done.has(c.id));
      const claim = claims.find(isValid);
      if (!claim) continue;
      // award
      done.add(claim.id);
      const roster = rosters.get(teamId) ?? new Set<string>();
      if (claim.dropLawyerId) {
        roster.delete(claim.dropLawyerId);
        rostered.delete(claim.dropLawyerId);
      }
      roster.add(claim.addLawyerId);
      rostered.add(claim.addLawyerId);
      rosters.set(teamId, roster);
      awarded.push({
        claimId: claim.id,
        teamId,
        addLawyerId: claim.addLawyerId,
        dropLawyerId: claim.dropLawyerId,
      });
      priority.splice(i, 1);
      priority.push(teamId);
      progress = true;
      break;
    }
  }

  const lost = args.claims.filter((c) => !done.has(c.id)).map((c) => c.id);
  return { awarded, lost, finalPriority: priority };
}
