import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { LeagueSettings } from "@/lib/settings";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const lawyerKindEnum = pgEnum("lawyer_kind", ["lawyer", "firm"]);
export const positionEnum = pgEnum("position", ["trial", "appellate", "prosecutor", "defense", "firm"]);
export const caseTypeEnum = pgEnum("case_type", ["civil", "criminal", "appeal", "supreme_court", "other"]);
export const caseStatusEnum = pgEnum("case_status", ["active", "closed"]);
export const sideEnum = pgEnum("side", ["plaintiff", "defendant"]);
export const eventStatusEnum = pgEnum("event_status", ["pending", "approved", "rejected"]);
export const eventOriginEnum = pgEnum("event_origin", ["manual", "courtlistener", "ai"]);
export const leagueStatusEnum = pgEnum("league_status", ["setup", "drafting", "in_season", "playoffs", "complete"]);
export const memberRoleEnum = pgEnum("member_role", ["commissioner", "member"]);
export const draftStatusEnum = pgEnum("draft_status", ["not_started", "in_progress", "paused", "complete"]);
export const acquiredViaEnum = pgEnum("acquired_via", ["draft", "waiver", "free_agent", "trade", "commissioner"]);
export const waiverClaimStatusEnum = pgEnum("waiver_claim_status", ["pending", "won", "lost", "cancelled"]);
export const tradeStatusEnum = pgEnum("trade_status", [
  "proposed", // waiting on the other team
  "accepted", // accepted, in commissioner review window
  "completed",
  "rejected",
  "cancelled",
  "vetoed",
  "failed", // could not be executed (rosters changed)
]);
export const transactionTypeEnum = pgEnum("transaction_type", [
  "draft",
  "add",
  "drop",
  "waiver_add",
  "trade",
  "commissioner",
]);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Always stored lowercase. */
  username: text("username").notNull().unique(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash").notNull(),
  /** Optional; only used for password resets. */
  email: text("email"),
  isAdmin: boolean("is_admin").notNull().default(false),
  createdAt: createdAt(),
});

export const sessions = pgTable(
  "sessions",
  {
    /** sha256 hex of the session token stored in the cookie. */
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

// ---------------------------------------------------------------------------
// The "legal world": player pools of lawyers, firms, cases and scoring events.
// A pool is shared by every league that uses it (e.g. a demo pool vs. a real pool).
// ---------------------------------------------------------------------------

export const pools = pgTable("pools", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  isDemo: boolean("is_demo").notNull().default(false),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

export const lawyers = pgTable(
  "lawyers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    poolId: uuid("pool_id")
      .notNull()
      .references(() => pools.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: lawyerKindEnum("kind").notNull().default("lawyer"),
    /** Firms always have position "firm". */
    position: positionEnum("position").notNull(),
    /** For individual lawyers: the firm entity (a lawyers row with kind "firm") they belong to. */
    firmId: uuid("firm_id"),
    /** Neutral affiliation text, e.g. "U.S. Attorney's Office, S.D. Example". */
    organization: text("organization"),
    /** Commissioner's preseason ranking, used by auto-pick (1 = best). */
    preseasonRank: integer("preseason_rank"),
    /** Phase 2: CourtListener attorney IDs (one lawyer has a different ID on each case). */
    courtlistenerAttorneyIds: jsonb("courtlistener_attorney_ids").$type<number[]>().notNull().default(sql`'[]'::jsonb`),
    /** Phase 2: CourtListener firm IDs. */
    courtlistenerFirmIds: jsonb("courtlistener_firm_ids").$type<number[]>().notNull().default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [index("lawyers_pool_idx").on(t.poolId), index("lawyers_firm_idx").on(t.firmId)],
);

export const cases = pgTable(
  "cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    poolId: uuid("pool_id")
      .notNull()
      .references(() => pools.id, { onDelete: "cascade" }),
    caption: text("caption").notNull(),
    court: text("court").notNull(),
    docketNumber: text("docket_number"),
    caseType: caseTypeEnum("case_type").notNull().default("civil"),
    status: caseStatusEnum("status").notNull().default("active"),
    filedOn: date("filed_on"),
    /** Link to the public record (CourtListener docket page, court site, etc.). */
    sourceUrl: text("source_url"),
    /** Phase 2: CourtListener docket ID. */
    courtlistenerDocketId: integer("courtlistener_docket_id"),
    /** Phase 2: when court data (CourtListener or the Supreme Court feed) was last pulled for this case. */
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    /** Phase 2: high-water mark for incremental pulls (e.g. CourtListener date_modified ISO, or SCOTUS proceeding count). */
    syncCursor: text("sync_cursor"),
    /** Phase 2: last sync error message (null when the last sync succeeded). */
    syncError: text("sync_error"),
    createdAt: createdAt(),
  },
  (t) => [index("cases_pool_idx").on(t.poolId), index("cases_synced_idx").on(t.syncedAt)],
);

/** Which lawyers (or firms) appear on which side of which case. */
export const caseAppearances = pgTable(
  "case_appearances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    lawyerId: uuid("lawyer_id")
      .notNull()
      .references(() => lawyers.id, { onDelete: "cascade" }),
    side: sideEnum("side").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("case_appearances_case_lawyer_uq").on(t.caseId, t.lawyerId),
    index("case_appearances_lawyer_idx").on(t.lawyerId),
  ],
);

/**
 * A scoring event is a fact about a case (or a specific lawyer). Points only
 * count once status = "approved". Values come from each league's settings.
 * Either (caseId + side) or lawyerId must be set.
 */
export const scoringEvents = pgTable(
  "scoring_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    poolId: uuid("pool_id")
      .notNull()
      .references(() => pools.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").references(() => cases.id, { onDelete: "cascade" }),
    /** Side of the case the event credits (when not lawyer-specific). */
    side: sideEnum("side"),
    /** Set for lawyer-specific events (e.g. sanctioned, Supreme Court argument). */
    lawyerId: uuid("lawyer_id").references(() => lawyers.id, { onDelete: "cascade" }),
    /** One of EVENT_TYPES in src/lib/settings.ts. */
    type: text("type").notNull(),
    /** Only for type "custom". */
    customPoints: doublePrecision("custom_points"),
    /** Date the event happened (court date / filing date), YYYY-MM-DD. Determines the week. */
    occurredOn: date("occurred_on").notNull(),
    /** Neutral, factual description. No commentary about the lawyers. */
    summary: text("summary").notNull(),
    sourceUrl: text("source_url"),
    status: eventStatusEnum("status").notNull().default("pending"),
    origin: eventOriginEnum("origin").notNull().default("manual"),
    /** Phase 2: e.g. "cl-docket-entry:12345" to avoid duplicate suggestions. */
    externalRef: text("external_ref"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    reviewedBy: uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("scoring_events_pool_status_idx").on(t.poolId, t.status),
    index("scoring_events_case_idx").on(t.caseId),
    index("scoring_events_lawyer_idx").on(t.lawyerId),
    uniqueIndex("scoring_events_external_ref_uq").on(t.poolId, t.externalRef),
  ],
);

// ---------------------------------------------------------------------------
// Leagues
// ---------------------------------------------------------------------------

export const leagues = pgTable("leagues", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  poolId: uuid("pool_id")
    .notNull()
    .references(() => pools.id, { onDelete: "restrict" }),
  inviteCode: text("invite_code").notNull().unique(),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  status: leagueStatusEnum("status").notNull().default("setup"),
  settings: jsonb("settings").$type<LeagueSettings>().notNull(),
  /** A Monday, YYYY-MM-DD. Week 1 starts this day. */
  seasonStart: date("season_start").notNull(),
  /** When waivers next process (computed from settings). */
  nextWaiverRunAt: timestamp("next_waiver_run_at", { withTimezone: true }),
  lastWaiverRunAt: timestamp("last_waiver_run_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const leagueMembers = pgTable(
  "league_members",
  {
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: memberRoleEnum("role").notNull().default("member"),
    /** The league creator can't be removed or demoted. */
    isCreator: boolean("is_creator").notNull().default(false),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.leagueId, t.userId] }), index("league_members_user_idx").on(t.userId)],
);

export const teams = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** 1-based draft slot. */
    draftPosition: integer("draft_position"),
    /** 1 = first claim. Rolling: a successful claim moves the team to last. */
    waiverPriority: integer("waiver_priority"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("teams_league_owner_uq").on(t.leagueId, t.ownerId), index("teams_league_idx").on(t.leagueId)],
);

export const rosterSpots = pgTable(
  "roster_spots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    lawyerId: uuid("lawyer_id")
      .notNull()
      .references(() => lawyers.id, { onDelete: "cascade" }),
    acquiredVia: acquiredViaEnum("acquired_via").notNull(),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("roster_spots_league_lawyer_uq").on(t.leagueId, t.lawyerId),
    index("roster_spots_team_idx").on(t.teamId),
  ],
);

/**
 * A team's starting lineup for one week. The effective lineup for week N is the
 * row with the largest week <= N (lineups carry forward). Rows are only written
 * for weeks whose lock time is still in the future, so locked weeks are frozen.
 */
export const lineups = pgTable(
  "lineups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    week: integer("week").notNull(),
    /** One entry per starter slot (same order as starterSlots(settings.roster)); null = empty. */
    starters: jsonb("starters").$type<(string | null)[]>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("lineups_team_week_uq").on(t.teamId, t.week)],
);

// ---------------------------------------------------------------------------
// Draft
// ---------------------------------------------------------------------------

export const drafts = pgTable("drafts", {
  leagueId: uuid("league_id")
    .primaryKey()
    .references(() => leagues.id, { onDelete: "cascade" }),
  status: draftStatusEnum("status").notNull().default("not_started"),
  secondsPerPick: integer("seconds_per_pick").notNull(),
  rounds: integer("rounds").notNull(),
  /** 0-based overall index of the pick currently on the clock. */
  currentPick: integer("current_pick").notNull().default(0),
  pickDeadline: timestamp("pick_deadline", { withTimezone: true }),
  /** Remaining ms on the clock when paused. */
  pausedRemainingMs: integer("paused_remaining_ms"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  /** Bumped on every change so clients can cheaply detect updates. */
  version: integer("version").notNull().default(0),
});

export const draftPicks = pgTable(
  "draft_picks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    overall: integer("overall").notNull(),
    round: integer("round").notNull(),
    pickInRound: integer("pick_in_round").notNull(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    lawyerId: uuid("lawyer_id")
      .notNull()
      .references(() => lawyers.id, { onDelete: "cascade" }),
    isAuto: boolean("is_auto").notNull().default(false),
    madeBy: uuid("made_by").references(() => users.id, { onDelete: "set null" }),
    madeAt: timestamp("made_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("draft_picks_league_overall_uq").on(t.leagueId, t.overall),
    uniqueIndex("draft_picks_league_lawyer_uq").on(t.leagueId, t.lawyerId),
  ],
);

export const draftQueue = pgTable(
  "draft_queue",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    lawyerId: uuid("lawyer_id")
      .notNull()
      .references(() => lawyers.id, { onDelete: "cascade" }),
    rank: integer("rank").notNull(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.lawyerId] })],
);

// ---------------------------------------------------------------------------
// Waivers, trades, transactions
// ---------------------------------------------------------------------------

/** Lawyers currently on waivers (claimable only via waiver claim until the next run). */
export const waiverHolds = pgTable(
  "waiver_holds",
  {
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    lawyerId: uuid("lawyer_id")
      .notNull()
      .references(() => lawyers.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.leagueId, t.lawyerId] })],
);

export const waiverClaims = pgTable(
  "waiver_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    addLawyerId: uuid("add_lawyer_id")
      .notNull()
      .references(() => lawyers.id, { onDelete: "cascade" }),
    dropLawyerId: uuid("drop_lawyer_id").references(() => lawyers.id, { onDelete: "cascade" }),
    /** The team's own ordering of its claims (1 = most wanted). */
    claimOrder: integer("claim_order").notNull(),
    status: waiverClaimStatusEnum("status").notNull().default("pending"),
    note: text("note"),
    createdAt: createdAt(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [index("waiver_claims_league_status_idx").on(t.leagueId, t.status)],
);

export const trades = pgTable(
  "trades",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    proposerTeamId: uuid("proposer_team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    recipientTeamId: uuid("recipient_team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    status: tradeStatusEnum("status").notNull().default("proposed"),
    message: text("message"),
    createdAt: createdAt(),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    reviewEndsAt: timestamp("review_ends_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by").references(() => users.id, { onDelete: "set null" }),
    failReason: text("fail_reason"),
  },
  (t) => [index("trades_league_idx").on(t.leagueId)],
);

export const tradeItems = pgTable(
  "trade_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tradeId: uuid("trade_id")
      .notNull()
      .references(() => trades.id, { onDelete: "cascade" }),
    /** The team giving up this lawyer. */
    fromTeamId: uuid("from_team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    lawyerId: uuid("lawyer_id")
      .notNull()
      .references(() => lawyers.id, { onDelete: "cascade" }),
  },
  (t) => [index("trade_items_trade_idx").on(t.tradeId)],
);

/** Activity log shown on the league page. */
export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "set null" }),
    type: transactionTypeEnum("type").notNull(),
    lawyerId: uuid("lawyer_id").references(() => lawyers.id, { onDelete: "set null" }),
    /** Short human-readable description. */
    description: text("description").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("transactions_league_idx").on(t.leagueId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Schedule & results
// ---------------------------------------------------------------------------

export const matchups = pgTable(
  "matchups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    /** 1-based matchup period (regular season first, then playoff rounds). */
    period: integer("period").notNull(),
    /** Inclusive week range this matchup covers. */
    weekStart: integer("week_start").notNull(),
    weekEnd: integer("week_end").notNull(),
    isPlayoff: boolean("is_playoff").notNull().default(false),
    /** 1-based playoff round. */
    playoffRound: integer("playoff_round"),
    /** Position within the playoff round (0-based), used to pair winners. */
    bracketSlot: integer("bracket_slot"),
    teamAId: uuid("team_a_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    /** Null when team A plays the league median (odd team count) or has a playoff bye. */
    teamBId: uuid("team_b_id").references(() => teams.id, { onDelete: "cascade" }),
    isMedian: boolean("is_median").notNull().default(false),
    isBye: boolean("is_bye").notNull().default(false),
    seedA: integer("seed_a"),
    seedB: integer("seed_b"),
    scoreA: doublePrecision("score_a"),
    /** For median games, the league median score. */
    scoreB: doublePrecision("score_b"),
    /** Null = tie (regular season) or not final. */
    winnerTeamId: uuid("winner_team_id").references(() => teams.id, { onDelete: "set null" }),
    final: boolean("final").notNull().default(false),
  },
  (t) => [index("matchups_league_period_idx").on(t.leagueId, t.period)],
);

export const weekFinalizations = pgTable(
  "week_finalizations",
  {
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    week: integer("week").notNull(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }).notNull().defaultNow(),
    finalizedBy: uuid("finalized_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [primaryKey({ columns: [t.leagueId, t.week] })],
);

/** Snapshot of each lawyer's points for a finalized week. */
export const weekScores = pgTable(
  "week_scores",
  {
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    week: integer("week").notNull(),
    lawyerId: uuid("lawyer_id")
      .notNull()
      .references(() => lawyers.id, { onDelete: "cascade" }),
    points: doublePrecision("points").notNull(),
  },
  (t) => [primaryKey({ columns: [t.leagueId, t.week, t.lawyerId] })],
);

/** Snapshot of each team's starter total for a finalized week. */
export const teamWeekScores = pgTable(
  "team_week_scores",
  {
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    week: integer("week").notNull(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    points: doublePrecision("points").notNull(),
  },
  (t) => [primaryKey({ columns: [t.leagueId, t.week, t.teamId] })],
);

export type User = typeof users.$inferSelect;
export type Pool = typeof pools.$inferSelect;
export type Lawyer = typeof lawyers.$inferSelect;
export type Case = typeof cases.$inferSelect;
export type CaseAppearance = typeof caseAppearances.$inferSelect;
export type ScoringEvent = typeof scoringEvents.$inferSelect;
export type League = typeof leagues.$inferSelect;
export type LeagueMember = typeof leagueMembers.$inferSelect;
export type Team = typeof teams.$inferSelect;
export type RosterSpot = typeof rosterSpots.$inferSelect;
export type Lineup = typeof lineups.$inferSelect;
export type Draft = typeof drafts.$inferSelect;
export type DraftPick = typeof draftPicks.$inferSelect;
export type WaiverClaim = typeof waiverClaims.$inferSelect;
export type Trade = typeof trades.$inferSelect;
export type TradeItem = typeof tradeItems.$inferSelect;
export type Matchup = typeof matchups.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
