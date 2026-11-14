/**
 * Demo seed: a fictional lawyer pool, a mid-season league and a draft
 * practice league.
 *
 *   npm run db:seed                      # DATABASE_URL from .env.local
 *   DATABASE_URL=postgres://… npm run db:seed   # the environment wins over .env.local
 *
 * Re-runnable: it first deletes ONLY previous demo data (pools with
 * is_demo = true, leagues using them, users named demo_*), then rebuilds
 * everything through the real services: the draft service finishes the draft
 * and starts the season, weekly waiver runs, free-agent moves, waiver claims,
 * trades, lineup saves and week finalizing all go through the same code the
 * app uses, back-dated with each service's `now` argument. Generation is
 * deterministic (seeded PRNG, see scripts/seed-data.ts) except for dates,
 * which are relative to today so the demo league is always in week 7.
 */
import { and, asc, eq, gt, inArray, notInArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  caseAppearances,
  cases,
  draftPicks,
  drafts,
  lawyers,
  leagueMembers,
  leagues,
  lineups,
  matchups,
  pools,
  rosterSpots,
  scoringEvents,
  teams,
  tradeItems,
  trades,
  transactions,
  users,
  waiverClaims,
  waiverHolds,
  weekFinalizations,
} from "@/db/schema";
import { autoFillLineup } from "@/lib/lineup";
import { defaultLeagueSettings, rosterSize, type LeagueSettings } from "@/lib/settings";
import { addDays, currentWeek, editableWeek, mondayOnOrAfter, todayIn, weekStartDate, zonedTimeToUtc } from "@/lib/time";
import { hashPassword } from "@/server/auth/password";
import { makePick, setDraftOrder, startDraft } from "@/server/services/draft";
import { normalizeEventInput } from "@/server/services/events";
import { createLeague, createPool, joinLeague, scheduleNextWaiverRun } from "@/server/services/league";
import { effectiveStarters, leagueClock, loadTeamLineups } from "@/server/services/lineups";
import { finalizeWeek } from "@/server/services/results";
import { getTeamRoster, type RosterLawyer } from "@/server/services/roster";
import { setMemberRole } from "@/server/services/settings-admin";
import { acceptTrade, proposeTrade, rejectTrade } from "@/server/services/trades";
import { processDueTrades } from "@/server/services/trades-processing";
import { addFreeAgent, createWaiverClaim, setTeamLineup } from "@/server/services/transactions-moves";
import { runDueWaivers } from "@/server/services/waivers-processing";
import {
  DEMO_CURRENT_WEEK,
  DEMO_LEAGUE_NAME,
  DEMO_PASSWORD,
  DEMO_POOL_NAME,
  DEMO_TEAM_NAMES,
  DEMO_USERNAME_PREFIX,
  DEMO_USERS,
  PRACTICE_LEAGUE_NAME,
  PRACTICE_SECONDS_PER_PICK,
  PRACTICE_TEAM_NAMES,
  demoSeasonStart,
  generateWorld,
  planDraft,
  rngFor,
  variedLineup,
  type DemoWorld,
  type PlannedPick,
  type Rng,
} from "./seed-data";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Weeks finalized by the seed (periods 1–2); weeks 5–6 are left for the commissioner. */
const FINALIZED_WEEKS = 4;

type SeedUser = { id: string; username: string; displayName: string };
type SeedTeam = { id: string; name: string; ownerId: string };

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Delete previous demo data only: leagues using demo pools, the demo pools
 * (cascading to their lawyers, cases and events) and demo_* users. Refuses
 * (deleting nothing) if a demo account belongs to a non-demo league, since
 * removing the account would cascade into that league.
 */
export async function deleteDemoData(): Promise<{ leagues: number; pools: number; users: number }> {
  return db.transaction(async (tx) => {
    const demoPoolIds = (await tx.select({ id: pools.id }).from(pools).where(eq(pools.isDemo, true))).map((p) => p.id);
    const demoUserIds = (
      await tx
        .select({ id: users.id })
        .from(users)
        .where(sql`left(${users.username}, ${DEMO_USERNAME_PREFIX.length}) = ${DEMO_USERNAME_PREFIX}`)
    ).map((u) => u.id);

    if (demoUserIds.length > 0) {
      const blockers = await tx
        .selectDistinct({ name: leagues.name })
        .from(leagues)
        .innerJoin(pools, eq(pools.id, leagues.poolId))
        .leftJoin(leagueMembers, eq(leagueMembers.leagueId, leagues.id))
        .where(and(eq(pools.isDemo, false), or(inArray(leagues.createdBy, demoUserIds), inArray(leagueMembers.userId, demoUserIds))));
      if (blockers.length > 0) {
        throw new Error(
          `Demo accounts are in non-demo leagues (${blockers.map((b) => b.name).join(", ")}). ` +
            "Remove them from those leagues first. Nothing was deleted.",
        );
      }
    }

    // Leagues first: leagues.pool_id and leagues.created_by are ON DELETE RESTRICT.
    const deletedLeagues = demoPoolIds.length
      ? await tx.delete(leagues).where(inArray(leagues.poolId, demoPoolIds)).returning({ id: leagues.id })
      : [];
    const deletedPools = demoPoolIds.length ? await tx.delete(pools).where(inArray(pools.id, demoPoolIds)).returning({ id: pools.id }) : [];
    const deletedUsers = demoUserIds.length ? await tx.delete(users).where(inArray(users.id, demoUserIds)).returning({ id: users.id }) : [];
    return { leagues: deletedLeagues.length, pools: deletedPools.length, users: deletedUsers.length };
  });
}

// ---------------------------------------------------------------------------
// Users and pool
// ---------------------------------------------------------------------------

async function createDemoUsers(): Promise<SeedUser[]> {
  const hashes = await Promise.all(DEMO_USERS.map(() => hashPassword(DEMO_PASSWORD)));
  const rows = await db
    .insert(users)
    .values(DEMO_USERS.map((u, i) => ({ username: u.username, displayName: u.displayName, passwordHash: hashes[i], isAdmin: false })))
    .returning({ id: users.id, username: users.username, displayName: users.displayName });
  return DEMO_USERS.map((u) => rows.find((r) => r.username === u.username)!);
}

/** Latest of `date` and a few minutes before `now` (nothing is stamped in the future). */
function notAfterNow(date: Date, now: Date): Date {
  return date.getTime() > now.getTime() - 5 * MINUTE ? new Date(now.getTime() - 5 * MINUTE) : date;
}

async function insertPool(world: DemoWorld, commishId: string, now: Date, timeZone: string): Promise<{ poolId: string }> {
  const pool = await createPool(db, { name: DEMO_POOL_NAME, isDemo: true, createdBy: commishId });
  const poolId = pool.id;

  // Firms first so lawyers can point at them. Names are unique within the pool.
  const lawyerIds = new Map<number, string>();
  const firms = world.lawyers.filter((l) => l.kind === "firm");
  const firmRows = await db
    .insert(lawyers)
    .values(
      firms.map((f) => ({
        poolId,
        name: f.name,
        kind: "firm" as const,
        position: "firm" as const,
        firmId: null,
        organization: f.organization,
        preseasonRank: f.preseasonRank,
      })),
    )
    .returning({ id: lawyers.id, name: lawyers.name });
  const firmIdByName = new Map(firmRows.map((r) => [r.name, r.id]));
  for (const f of firms) lawyerIds.set(f.key, firmIdByName.get(f.name)!);

  const individuals = world.lawyers.filter((l) => l.kind === "lawyer");
  const lawyerRows = await db
    .insert(lawyers)
    .values(
      individuals.map((l) => ({
        poolId,
        name: l.name,
        kind: "lawyer" as const,
        position: l.position,
        firmId: l.firmKey === null ? null : lawyerIds.get(l.firmKey)!,
        organization: l.organization,
        preseasonRank: l.preseasonRank,
      })),
    )
    .returning({ id: lawyers.id, name: lawyers.name });
  const lawyerIdByName = new Map(lawyerRows.map((r) => [r.name, r.id]));
  for (const l of individuals) lawyerIds.set(l.key, lawyerIdByName.get(l.name)!);

  const caseRows = await db
    .insert(cases)
    .values(
      world.cases.map((c) => ({
        poolId,
        caption: c.caption,
        court: c.court,
        docketNumber: c.docketNumber,
        caseType: c.caseType,
        status: c.status,
        filedOn: c.filedOn,
        sourceUrl: c.sourceUrl,
      })),
    )
    .returning({ id: cases.id, sourceUrl: cases.sourceUrl });
  const caseIdByUrl = new Map(caseRows.map((r) => [r.sourceUrl, r.id]));
  const caseIds = new Map(world.cases.map((c) => [c.key, caseIdByUrl.get(c.sourceUrl)!]));

  await db.insert(caseAppearances).values(
    world.cases.flatMap((c) => c.appearances.map((a) => ({ caseId: caseIds.get(c.key)!, lawyerId: lawyerIds.get(a.lawyerKey)!, side: a.side }))),
  );

  // Events go through the events service's validation, then one batch insert.
  await db.insert(scoringEvents).values(
    world.events.map((e) => {
      const input = normalizeEventInput(
        {
          type: e.type,
          caseId: e.caseKey === null ? null : caseIds.get(e.caseKey)!,
          side: e.side,
          lawyerId: e.lawyerKey === null ? null : lawyerIds.get(e.lawyerKey)!,
          occurredOn: e.occurredOn,
          summary: e.summary,
          sourceUrl: e.sourceUrl,
          customPoints: e.customPoints,
        },
        { requireSource: true },
      );
      const createdAt = notAfterNow(zonedTimeToUtc(e.occurredOn, "17:30", timeZone), now);
      const approved = e.status === "approved";
      return {
        poolId,
        ...input,
        status: e.status,
        origin: "manual" as const,
        createdBy: commishId,
        reviewedBy: approved ? commishId : null,
        reviewedAt: approved ? notAfterNow(new Date(createdAt.getTime() + 15 * HOUR), now) : null,
        createdAt,
      };
    }),
  );
  return { poolId };
}

// ---------------------------------------------------------------------------
// League helpers
// ---------------------------------------------------------------------------

type LeagueCtx = {
  leagueId: string;
  poolId: string;
  settings: LeagueSettings;
  seasonStart: string;
  /** Teams in DEMO_USERS order (0 = demo_commish). */
  teams: SeedTeam[];
  now: Date;
};

/** Local wall-clock time on a day relative to a season week (`dayOffset` 0 = that week's Monday). */
function weekTime(ctx: LeagueCtx, week: number, dayOffset: number, time: string): Date {
  return zonedTimeToUtc(addDays(weekStartDate(week, ctx.seasonStart), dayOffset), time, ctx.settings.schedule.timezone);
}

/** Services stamp roster spots with the DB clock; back-date them to when the move happened. */
async function stampAcquired(ctx: LeagueCtx, lawyerIds: string[], when: Date): Promise<void> {
  if (lawyerIds.length === 0) return;
  await db
    .update(rosterSpots)
    .set({ acquiredAt: when })
    .where(and(eq(rosterSpots.leagueId, ctx.leagueId), inArray(rosterSpots.lawyerId, lawyerIds)));
}

type TeamSnapshot = { roster: RosterLawyer[]; starters: Set<string>; bench: RosterLawyer[] };

/** A team's roster at `when`: starters (this week's and the editable week's lineup) and bench, worst-ranked first. */
async function teamSnapshot(ctx: LeagueCtx, team: SeedTeam, when: Date): Promise<TeamSnapshot> {
  const [roster, rows] = await Promise.all([getTeamRoster(db, team.id), loadTeamLineups(db, team.id)]);
  const clock = leagueClock(ctx);
  const starters = new Set<string>();
  for (const week of new Set([Math.max(1, currentWeek(when, clock)), editableWeek(when, clock)])) {
    for (const id of effectiveStarters(rows, week, ctx.settings)) if (id) starters.add(id);
  }
  const bench = roster
    .filter((l) => !starters.has(l.id) && l.kind === "lawyer")
    .sort((a, b) => (b.preseasonRank ?? 999) - (a.preseasonRank ?? 999) || a.id.localeCompare(b.id));
  return { roster, starters, bench };
}

/** Individual lawyers nobody has, best rank first (optionally only true free agents, i.e. not on waivers). */
async function unrostered(ctx: LeagueCtx, opts: { freeAgentsOnly: boolean }) {
  const rostered = db.select({ id: rosterSpots.lawyerId }).from(rosterSpots).where(eq(rosterSpots.leagueId, ctx.leagueId));
  const held = db.select({ id: waiverHolds.lawyerId }).from(waiverHolds).where(eq(waiverHolds.leagueId, ctx.leagueId));
  return db
    .select({ id: lawyers.id, name: lawyers.name, position: lawyers.position })
    .from(lawyers)
    .where(
      and(
        eq(lawyers.poolId, ctx.poolId),
        eq(lawyers.kind, "lawyer"),
        notInArray(lawyers.id, rostered),
        opts.freeAgentsOnly ? notInArray(lawyers.id, held) : undefined,
      ),
    )
    .orderBy(asc(lawyers.preseasonRank), asc(lawyers.name));
}

async function saveVariedLineup(ctx: LeagueCtx, team: SeedTeam, when: Date, rng: Rng): Promise<void> {
  const roster = await getTeamRoster(db, team.id);
  const week = editableWeek(when, leagueClock(ctx));
  await setTeamLineup(db, {
    leagueId: ctx.leagueId,
    teamId: team.id,
    week,
    starters: variedLineup(roster, ctx.settings.roster, rng),
    now: when,
  });
}

/** Fill any empty starter slots (e.g. after a starter was traded or dropped), like an active manager would. */
async function refillLineup(ctx: LeagueCtx, team: SeedTeam, when: Date): Promise<void> {
  const [roster, rows] = await Promise.all([getTeamRoster(db, team.id), loadTeamLineups(db, team.id)]);
  const week = editableWeek(when, leagueClock(ctx));
  const current = effectiveStarters(rows, week, ctx.settings);
  const filled = autoFillLineup(current, ctx.settings.roster, roster);
  if (filled.some((id, i) => id !== current[i])) {
    await setTeamLineup(db, { leagueId: ctx.leagueId, teamId: team.id, week, starters: filled, now: when });
  }
}

async function waiverRun(ctx: LeagueCtx, when: Date): Promise<void> {
  const res = await runDueWaivers(db, ctx.leagueId, when);
  if (!res) throw new Error(`Waivers weren't due at ${when.toISOString()}`);
  await stampAcquired(
    ctx,
    res.awarded.map((a) => a.addLawyerId),
    when,
  );
  for (const teamId of new Set(res.awarded.map((a) => a.teamId))) {
    await refillLineup(ctx, ctx.teams.find((t) => t.id === teamId)!, new Date(when.getTime() + MINUTE));
  }
}

/** Add one of the best free agents, dropping the team's worst bench lawyer. */
async function freeAgentMove(ctx: LeagueCtx, team: SeedTeam, when: Date, rng: Rng, reserved: Set<string>) {
  const snap = await teamSnapshot(ctx, team, when);
  const drop = snap.bench.find((l) => !reserved.has(l.id));
  const options = (await unrostered(ctx, { freeAgentsOnly: true })).filter((l) => !reserved.has(l.id)).slice(0, 4);
  if (!drop || options.length === 0) throw new Error(`No free-agent move possible for ${team.name}`);
  const add = rng.pick(options);
  await addFreeAgent(db, { leagueId: ctx.leagueId, teamId: team.id, lawyerId: add.id, dropLawyerId: drop.id, now: when });
  await stampAcquired(ctx, [add.id], when);
  return { add, drop };
}

/** Put in a waiver claim (dropping the worst unreserved bench lawyer) and back-date it. */
async function waiverClaim(ctx: LeagueCtx, team: SeedTeam, lawyerId: string, when: Date, reserved: Set<string>): Promise<void> {
  const snap = await teamSnapshot(ctx, team, when);
  const drop = snap.bench.find((l) => !reserved.has(l.id));
  if (!drop) throw new Error(`${team.name} has nobody to drop for a claim`);
  reserved.add(drop.id);
  await createWaiverClaim(db, { leagueId: ctx.leagueId, teamId: team.id, lawyerId, dropLawyerId: drop.id });
  await db
    .update(waiverClaims)
    .set({ createdAt: when })
    .where(and(eq(waiverClaims.teamId, team.id), eq(waiverClaims.addLawyerId, lawyerId), eq(waiverClaims.status, "pending")));
}

/** Offer a 1-for-1 swap of bench lawyers (preferably of different positions). Returns the trade id. */
async function offerTrade(ctx: LeagueCtx, from: SeedTeam, to: SeedTeam, when: Date, message: string, reserved: Set<string>): Promise<string> {
  const [a, b] = await Promise.all([teamSnapshot(ctx, from, when), teamSnapshot(ctx, to, when)]);
  const give = a.bench.filter((l) => !reserved.has(l.id)).at(-1);
  const theirs = b.bench.filter((l) => !reserved.has(l.id));
  const get = theirs.filter((l) => l.position !== give?.position).at(-1) ?? theirs.at(-1);
  if (!give || !get) throw new Error(`No trade possible between ${from.name} and ${to.name}`);
  reserved.add(give.id);
  reserved.add(get.id);
  const { tradeId } = await proposeTrade(db, {
    leagueId: ctx.leagueId,
    proposerTeamId: from.id,
    recipientTeamId: to.id,
    giveLawyerIds: [give.id],
    getLawyerIds: [get.id],
    message,
    now: when,
  });
  return tradeId;
}

/** Run the trade review processor and check the trade went through. */
async function completeReviewedTrade(ctx: LeagueCtx, tradeId: string, when: Date, parties: SeedTeam[]): Promise<void> {
  await processDueTrades(db, ctx.leagueId, when);
  const [t] = await db.select({ status: trades.status, failReason: trades.failReason }).from(trades).where(eq(trades.id, tradeId));
  if (t?.status !== "completed") throw new Error(`Trade didn't complete: ${t?.status} ${t?.failReason ?? ""}`);
  const items = await db.select({ lawyerId: tradeItems.lawyerId }).from(tradeItems).where(eq(tradeItems.tradeId, tradeId));
  await stampAcquired(
    ctx,
    items.map((i) => i.lawyerId),
    when,
  );
  // executeTrade logs with the DB clock; move this trade's log lines to when it happened.
  await db
    .update(transactions)
    .set({ createdAt: when })
    .where(and(eq(transactions.leagueId, ctx.leagueId), eq(transactions.type, "trade"), gt(transactions.createdAt, new Date(when.getTime() + 24 * HOUR))));
  for (const team of parties) await refillLineup(ctx, team, new Date(when.getTime() + MINUTE));
}

/**
 * Times for "this week" actions: between the last waiver run and now, at least
 * a few hours apart where possible (so an accepted trade is still in review).
 */
function recentTimes(after: Date, now: Date, hoursAgo: number[]): Date[] {
  const lo = after.getTime() + MINUTE;
  const hi = now.getTime() - MINUTE;
  return hoursAgo.map(
    (h, i) => new Date(Math.min(hi, Math.max(lo + ((i + 1) / (hoursAgo.length + 1)) * Math.max(0, hi - lo), now.getTime() - h * HOUR))),
  );
}

// ---------------------------------------------------------------------------
// Mid-season league
// ---------------------------------------------------------------------------

/**
 * Snake draft on the Saturday evening before week 1. Picks 1..N-1 are written
 * in one batch (same rows makePick writes, timestamped as the draft went);
 * the final pick goes through makePick, which completes the draft and runs
 * startSeason (schedule, waiver order, waiver holds, week-1 lineups).
 */
async function runDraft(ctx: LeagueCtx, rng: Rng): Promise<void> {
  const { leagueId, settings } = ctx;
  const order = rng.shuffle(ctx.teams);
  await setDraftOrder(
    db,
    leagueId,
    order.map((t) => t.id),
  );
  const startAt = weekTime(ctx, 0, 5, "19:00");
  await startDraft(db, leagueId, startAt);

  const pool = await db
    .select({ id: lawyers.id, name: lawyers.name, position: lawyers.position, preseasonRank: lawyers.preseasonRank })
    .from(lawyers)
    .where(eq(lawyers.poolId, ctx.poolId))
    .orderBy(asc(lawyers.preseasonRank), asc(lawyers.name));
  const names = new Map(pool.map((l) => [l.id, l.name]));
  const plan = planDraft({
    teamCount: order.length,
    rounds: rosterSize(settings.roster),
    roster: settings.roster,
    candidates: pool,
    rng,
    maxSecondsPerPick: settings.draft.secondsPerPick - 15,
  });
  const madeAt = (p: PlannedPick) => new Date(startAt.getTime() + p.secondsAfterStart * 1000);
  const teamOf = (p: PlannedPick) => order[p.draftPosition - 1];
  const head = plan.slice(0, -1);
  const last = plan[plan.length - 1];

  await db.transaction(async (tx) => {
    await tx.insert(draftPicks).values(
      head.map((p) => ({
        leagueId,
        overall: p.overall,
        round: p.round,
        pickInRound: p.pickInRound,
        teamId: teamOf(p).id,
        lawyerId: p.lawyerId,
        isAuto: p.isAuto,
        madeBy: p.isAuto ? null : teamOf(p).ownerId,
        madeAt: madeAt(p),
      })),
    );
    await tx
      .insert(rosterSpots)
      .values(head.map((p) => ({ leagueId, teamId: teamOf(p).id, lawyerId: p.lawyerId, acquiredVia: "draft" as const, acquiredAt: madeAt(p) })));
    await tx.insert(transactions).values(
      head.map((p) => ({
        leagueId,
        teamId: teamOf(p).id,
        type: "draft" as const,
        lawyerId: p.lawyerId,
        description: `${p.isAuto ? "Auto-drafted" : "Drafted"} ${names.get(p.lawyerId)} (round ${p.round}, pick ${p.pickInRound})`,
        createdAt: madeAt(p),
      })),
    );
    await tx
      .update(drafts)
      .set({
        currentPick: head.length,
        pickDeadline: new Date(madeAt(head[head.length - 1]).getTime() + settings.draft.secondsPerPick * 1000),
        version: sql`${drafts.version} + ${head.length}`,
      })
      .where(eq(drafts.leagueId, leagueId));
  });

  const lastTeam = teamOf(last);
  const result = await makePick(db, leagueId, lastTeam.id, last.lawyerId, last.isAuto ? null : lastTeam.ownerId, last.isAuto, madeAt(last));
  if (!result.completed) throw new Error("The draft didn't complete.");
  await stampAcquired(ctx, [last.lawyerId], madeAt(last));
}

type Action = { when: Date; label: string; run: () => Promise<unknown> };

/**
 * Weeks 1–7 as they would have happened, in time order: weekly waiver runs,
 * claims, free-agent moves, trades and lineup changes. Ends with two recent
 * drops on waivers, pending claims on them, an accepted trade in its review
 * window and an offer waiting on demo_commish's team.
 */
async function runSeason(ctx: LeagueCtx): Promise<void> {
  const { now, leagueId } = ctx;
  const T = ctx.teams;
  const rng = rngFor("main-season");
  const reserved = new Set<string>();
  const actions: Action[] = [];
  const at = (week: number, dayOffset: number, time: string, label: string, run: (when: Date) => Promise<unknown>) => {
    const when = weekTime(ctx, week, dayOffset, time);
    actions.push({ when, label, run: () => run(when) });
  };

  // Waivers run every Wednesday at 03:00 league time.
  let lastRun = weekTime(ctx, 1, 2, "03:01");
  for (let week = 1; week <= DEMO_CURRENT_WEEK; week++) {
    const when = weekTime(ctx, week, 2, "03:01");
    if (when.getTime() > now.getTime() - 10 * MINUTE) break;
    lastRun = when;
    at(week, 2, "03:01", `waiver run (week ${week})`, (w) => waiverRun(ctx, w));
  }

  // Sunday before week 1: claims on undrafted lawyers (two teams want the same one) and lineup tweaks.
  at(0, 6, "12:00", "week 1 waiver claims", async (when) => {
    const [first, second] = await unrostered(ctx, { freeAgentsOnly: false });
    await waiverClaim(ctx, T[3], first.id, when, reserved);
    await waiverClaim(ctx, T[6], first.id, when, reserved);
    await waiverClaim(ctx, T[9], second.id, when, reserved);
  });
  for (const i of [2, 5, 8]) at(0, 6, "20:00", "week 1 lineup", (when) => saveVariedLineup(ctx, T[i], when, rng));

  // Weeks 2–6.
  at(2, 3, "14:00", "free-agent move", (when) => freeAgentMove(ctx, T[4], when, rng, reserved));
  for (const i of [0, 1, 4, 7]) at(2, 6, "20:00", "week 3 lineup", (when) => saveVariedLineup(ctx, T[i], when, rng));
  let declinedTradeId = "";
  at(3, 1, "18:00", "trade offer", async (when) => {
    declinedTradeId = await offerTrade(ctx, T[6], T[7], when, "Bench swap? We'd both get depth at a new position.", reserved);
  });
  at(3, 2, "10:00", "trade declined", (when) =>
    rejectTrade(db, { leagueId, tradeId: declinedTradeId, teamId: T[7].id, userId: T[7].ownerId, now: when }),
  );
  at(3, 4, "11:00", "free-agent move", (when) => freeAgentMove(ctx, T[2], when, rng, reserved));
  let completedTradeId = "";
  at(4, 1, "12:00", "trade offer", async (when) => {
    completedTradeId = await offerTrade(ctx, T[8], T[9], when, "One-for-one bench swap?", reserved);
  });
  at(4, 1, "21:00", "trade accepted", (when) =>
    acceptTrade(db, { leagueId, tradeId: completedTradeId, teamId: T[9].id, userId: T[9].ownerId, now: when }),
  );
  at(4, 3, "09:00", "trade review ends", (when) => completeReviewedTrade(ctx, completedTradeId, when, [T[8], T[9]]));
  for (const i of [1, 3, 5, 8]) at(4, 6, "20:00", "week 5 lineup", (when) => saveVariedLineup(ctx, T[i], when, rng));
  at(5, 3, "16:30", "free-agent move", (when) => freeAgentMove(ctx, T[7], when, rng, reserved));
  for (const i of [0, 2, 6, 9]) at(6, 6, "20:00", "week 7 lineup", (when) => saveVariedLineup(ctx, T[i], when, rng));

  // Since the last waiver run: drops (now on waivers), claims on them, open trades.
  const recent = recentTimes(lastRun, now, [30, 22, 14, 9, 6, 4]);
  const onWaivers: string[] = [];
  const later = (i: number, label: string, run: (when: Date) => Promise<unknown>) =>
    actions.push({ when: recent[i], label, run: () => run(recent[i]) });
  later(0, "free-agent move (drop to waivers)", async (when) => onWaivers.push((await freeAgentMove(ctx, T[5], when, rng, reserved)).drop.id));
  later(1, "free-agent move (drop to waivers)", async (when) => onWaivers.push((await freeAgentMove(ctx, T[3], when, rng, reserved)).drop.id));
  later(2, "pending waiver claims", async (when) => {
    await waiverClaim(ctx, T[8], onWaivers[0], when, reserved);
    await waiverClaim(ctx, T[8], onWaivers[1], when, reserved);
    await waiverClaim(ctx, T[2], onWaivers[1], when, reserved);
  });
  let reviewTradeId = "";
  later(3, "trade offer", async (when) => {
    reviewTradeId = await offerTrade(ctx, T[4], T[6], when, "Fair swap? Helps both our benches.", reserved);
  });
  later(4, "trade offer to the commissioner", (when) =>
    offerTrade(ctx, T[7], T[0], when, "Want to swap bench lawyers? Open to a counter.", reserved),
  );
  later(5, "trade accepted (in review)", async (when) => {
    const res = await acceptTrade(db, { leagueId, tradeId: reviewTradeId, teamId: T[6].id, userId: T[6].ownerId, now: when });
    if (res.status !== "accepted" || !res.reviewEndsAt || res.reviewEndsAt <= now) {
      throw new Error(`Expected the trade to be in review, got ${res.status} until ${res.reviewEndsAt?.toISOString()}`);
    }
  });

  actions.sort((a, b) => a.when.getTime() - b.when.getTime());
  for (const a of actions) {
    if (a.when.getTime() > now.getTime()) throw new Error(`"${a.label}" is in the future (${a.when.toISOString()})`);
    await a.run();
  }
}

async function seedMainLeague(args: { people: SeedUser[]; poolId: string; seasonStart: string; now: Date }) {
  const { people, poolId, seasonStart, now } = args;
  const settings = defaultLeagueSettings();
  const commish = people[0];
  const league = await createLeague(db, {
    name: DEMO_LEAGUE_NAME,
    poolId,
    createdBy: commish.id,
    teamName: DEMO_TEAM_NAMES[0],
    seasonStart,
    settings,
  });
  for (let i = 1; i < people.length; i++) {
    await joinLeague(db, { inviteCode: league.inviteCode, userId: people[i].id, teamName: DEMO_TEAM_NAMES[i] });
  }
  await setMemberRole(db, league.id, people[1].id, "commissioner");
  const teamRows = await db.select({ id: teams.id, name: teams.name, ownerId: teams.ownerId }).from(teams).where(eq(teams.leagueId, league.id));
  const ctx: LeagueCtx = {
    leagueId: league.id,
    poolId,
    settings,
    seasonStart,
    teams: people.map((p) => teamRows.find((t) => t.ownerId === p.id)!),
    now,
  };

  await runDraft(ctx, rngFor("main-draft"));
  await runSeason(ctx);

  // Weeks 1–4 final (periods 1–2 settled, standings exist); weeks 5–6 await the commissioner.
  for (let week = 1; week <= FINALIZED_WEEKS; week++) {
    await finalizeWeek(db, league.id, week, commish.id, now);
    await db
      .update(weekFinalizations)
      .set({ finalizedAt: notAfterNow(weekTime(ctx, week + 1, 1, "19:00"), now) })
      .where(and(eq(weekFinalizations.leagueId, league.id), eq(weekFinalizations.week, week)));
  }

  // Waivers must not run on the first page view.
  const [l] = await db.select({ next: leagues.nextWaiverRunAt }).from(leagues).where(eq(leagues.id, league.id));
  if (!l.next || l.next.getTime() <= now.getTime()) await scheduleNextWaiverRun(db, league.id, settings, now);
  return { leagueId: league.id, inviteCode: league.inviteCode };
}

// ---------------------------------------------------------------------------
// Draft practice league
// ---------------------------------------------------------------------------

async function seedPracticeLeague(args: { people: SeedUser[]; poolId: string; today: string }) {
  const defaults = defaultLeagueSettings();
  const settings: LeagueSettings = { ...defaults, draft: { ...defaults.draft, secondsPerPick: PRACTICE_SECONDS_PER_PICK } };
  const league = await createLeague(db, {
    name: PRACTICE_LEAGUE_NAME,
    poolId: args.poolId,
    createdBy: args.people[0].id,
    teamName: PRACTICE_TEAM_NAMES[0],
    seasonStart: mondayOnOrAfter(addDays(args.today, 1)),
    settings,
  });
  for (let i = 1; i < PRACTICE_TEAM_NAMES.length; i++) {
    await joinLeague(db, { inviteCode: league.inviteCode, userId: args.people[i].id, teamName: PRACTICE_TEAM_NAMES[i] });
  }
  return { leagueId: league.id, inviteCode: league.inviteCode, seasonStart: league.seasonStart };
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

async function leagueCounts(leagueId: string, poolId: string) {
  const n = (rows: { n: number }[]) => Number(rows[0]?.n ?? 0);
  const count = sql<number>`count(*)::int`;
  const [teamCount, rosterRows, matchupCount, finalCount, finalizedCount, lineupCount, pendingEvents, approvedEvents, tradeRows, claims, holds] =
    await Promise.all([
      db.select({ n: count }).from(teams).where(eq(teams.leagueId, leagueId)),
      db
        .select({ teamId: rosterSpots.teamId, n: count })
        .from(rosterSpots)
        .where(eq(rosterSpots.leagueId, leagueId))
        .groupBy(rosterSpots.teamId),
      db.select({ n: count }).from(matchups).where(eq(matchups.leagueId, leagueId)),
      db.select({ n: count }).from(matchups).where(and(eq(matchups.leagueId, leagueId), eq(matchups.final, true))),
      db.select({ n: count }).from(weekFinalizations).where(eq(weekFinalizations.leagueId, leagueId)),
      db.select({ n: count }).from(lineups).innerJoin(teams, eq(teams.id, lineups.teamId)).where(eq(teams.leagueId, leagueId)),
      db.select({ n: count }).from(scoringEvents).where(and(eq(scoringEvents.poolId, poolId), eq(scoringEvents.status, "pending"))),
      db.select({ n: count }).from(scoringEvents).where(and(eq(scoringEvents.poolId, poolId), eq(scoringEvents.status, "approved"))),
      db.select({ status: trades.status, n: count }).from(trades).where(eq(trades.leagueId, leagueId)).groupBy(trades.status),
      db.select({ n: count }).from(waiverClaims).where(and(eq(waiverClaims.leagueId, leagueId), eq(waiverClaims.status, "pending"))),
      db.select({ n: count }).from(waiverHolds).where(eq(waiverHolds.leagueId, leagueId)),
    ]);
  const sizes = rosterRows.map((r) => Number(r.n));
  return {
    teams: n(teamCount),
    rosterSizes: sizes.length ? `${Math.min(...sizes)}–${Math.max(...sizes)}` : "none",
    matchups: `${n(finalCount)} final of ${n(matchupCount)}`,
    finalizedWeeks: n(finalizedCount),
    lineupRows: n(lineupCount),
    events: `${n(approvedEvents)} approved, ${n(pendingEvents)} pending`,
    trades: tradeRows.map((t) => `${t.n} ${t.status}`).join(", ") || "none",
    pendingClaims: n(claims),
    onWaivers: n(holds),
  };
}

function dbHost(): string {
  try {
    return new URL(process.env.DATABASE_URL ?? "").host || "(unknown host)";
  } catch {
    return "(unparsable DATABASE_URL)";
  }
}

async function main(): Promise<void> {
  const started = Date.now();
  const now = new Date();
  const timeZone = defaultLeagueSettings().schedule.timezone;
  const today = todayIn(timeZone, now);
  const seasonStart = demoSeasonStart(today);
  console.log(`Seeding demo data on ${dbHost()} (today ${today}, demo season started ${seasonStart})…`);

  const removed = await deleteDemoData();
  console.log(`Removed previous demo data: ${removed.leagues} leagues, ${removed.pools} pools, ${removed.users} users.`);

  const people = await createDemoUsers();
  const world = generateWorld({ seasonStart, today });
  const { poolId } = await insertPool(world, people[0].id, now, timeZone);
  // Practice league first so the mid-season league is listed first on the home page (newest membership first).
  const practice = await seedPracticeLeague({ people, poolId, today });
  const demo = await seedMainLeague({ people, poolId, seasonStart, now });
  const counts = await leagueCounts(demo.leagueId, poolId);

  const firms = world.lawyers.filter((l) => l.kind === "firm").length;
  console.log(`\nDemo data ready in ${((Date.now() - started) / 1000).toFixed(1)}s.\n`);
  console.log(`Pool "${DEMO_POOL_NAME}": ${world.lawyers.length - firms} lawyers, ${firms} firms, ${world.cases.length} cases.`);
  console.log(`\nLogins (password for all: ${DEMO_PASSWORD})`);
  for (const [i, u] of people.entries()) {
    const role = i === 0 ? "commissioner of both leagues" : i === 1 ? `co-commissioner of ${DEMO_LEAGUE_NAME}` : "";
    console.log(`  ${u.username.padEnd(14)} ${u.displayName.padEnd(18)} ${role}`);
  }
  console.log("\nLeagues");
  console.log(`  ${DEMO_LEAGUE_NAME}: invite code ${demo.inviteCode}  /leagues/${demo.leagueId}`);
  console.log(`    week ${DEMO_CURRENT_WEEK} · ${counts.teams} teams · roster sizes ${counts.rosterSizes} · matchups ${counts.matchups}`);
  console.log(`    weeks finalized: ${counts.finalizedWeeks} · lineup rows: ${counts.lineupRows} · events: ${counts.events}`);
  console.log(`    trades: ${counts.trades} · pending waiver claims: ${counts.pendingClaims} · on waivers: ${counts.onWaivers}`);
  console.log(`  ${PRACTICE_LEAGUE_NAME}: invite code ${practice.inviteCode}  /leagues/${practice.leagueId}`);
  console.log(`    ${PRACTICE_TEAM_NAMES.length} teams · draft not started · ${PRACTICE_SECONDS_PER_PICK}s per pick · season starts ${practice.seasonStart}`);
}

// Run only when executed directly (scripts/reset-demo.ts imports deleteDemoData).
if (/(^|[\\/])seed(\.[cm]?[jt]s)?$/.test(process.argv[1] ?? "")) {
  main().then(
    () => process.exit(0),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
