CREATE TYPE "public"."acquired_via" AS ENUM('draft', 'waiver', 'free_agent', 'trade', 'commissioner');--> statement-breakpoint
CREATE TYPE "public"."case_status" AS ENUM('active', 'closed');--> statement-breakpoint
CREATE TYPE "public"."case_type" AS ENUM('civil', 'criminal', 'appeal', 'supreme_court', 'other');--> statement-breakpoint
CREATE TYPE "public"."draft_status" AS ENUM('not_started', 'in_progress', 'paused', 'complete');--> statement-breakpoint
CREATE TYPE "public"."event_origin" AS ENUM('manual', 'courtlistener', 'ai');--> statement-breakpoint
CREATE TYPE "public"."event_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."lawyer_kind" AS ENUM('lawyer', 'firm');--> statement-breakpoint
CREATE TYPE "public"."league_status" AS ENUM('setup', 'drafting', 'in_season', 'playoffs', 'complete');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('commissioner', 'member');--> statement-breakpoint
CREATE TYPE "public"."position" AS ENUM('trial', 'appellate', 'prosecutor', 'defense', 'firm');--> statement-breakpoint
CREATE TYPE "public"."side" AS ENUM('plaintiff', 'defendant');--> statement-breakpoint
CREATE TYPE "public"."trade_status" AS ENUM('proposed', 'accepted', 'completed', 'rejected', 'cancelled', 'vetoed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."transaction_type" AS ENUM('draft', 'add', 'drop', 'waiver_add', 'trade', 'commissioner');--> statement-breakpoint
CREATE TYPE "public"."waiver_claim_status" AS ENUM('pending', 'won', 'lost', 'cancelled');--> statement-breakpoint
CREATE TABLE "case_appearances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"lawyer_id" uuid NOT NULL,
	"side" "side" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pool_id" uuid NOT NULL,
	"caption" text NOT NULL,
	"court" text NOT NULL,
	"docket_number" text,
	"case_type" "case_type" DEFAULT 'civil' NOT NULL,
	"status" "case_status" DEFAULT 'active' NOT NULL,
	"filed_on" date,
	"source_url" text,
	"courtlistener_docket_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "draft_picks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"overall" integer NOT NULL,
	"round" integer NOT NULL,
	"pick_in_round" integer NOT NULL,
	"team_id" uuid NOT NULL,
	"lawyer_id" uuid NOT NULL,
	"is_auto" boolean DEFAULT false NOT NULL,
	"made_by" uuid,
	"made_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "draft_queue" (
	"team_id" uuid NOT NULL,
	"lawyer_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	CONSTRAINT "draft_queue_team_id_lawyer_id_pk" PRIMARY KEY("team_id","lawyer_id")
);
--> statement-breakpoint
CREATE TABLE "drafts" (
	"league_id" uuid PRIMARY KEY NOT NULL,
	"status" "draft_status" DEFAULT 'not_started' NOT NULL,
	"seconds_per_pick" integer NOT NULL,
	"rounds" integer NOT NULL,
	"current_pick" integer DEFAULT 0 NOT NULL,
	"pick_deadline" timestamp with time zone,
	"paused_remaining_ms" integer,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lawyers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pool_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "lawyer_kind" DEFAULT 'lawyer' NOT NULL,
	"position" "position" NOT NULL,
	"firm_id" uuid,
	"organization" text,
	"preseason_rank" integer,
	"courtlistener_attorney_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"courtlistener_firm_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "league_members" (
	"league_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "member_role" DEFAULT 'member' NOT NULL,
	"is_creator" boolean DEFAULT false NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "league_members_league_id_user_id_pk" PRIMARY KEY("league_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "leagues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"pool_id" uuid NOT NULL,
	"invite_code" text NOT NULL,
	"created_by" uuid NOT NULL,
	"status" "league_status" DEFAULT 'setup' NOT NULL,
	"settings" jsonb NOT NULL,
	"season_start" date NOT NULL,
	"next_waiver_run_at" timestamp with time zone,
	"last_waiver_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leagues_invite_code_unique" UNIQUE("invite_code")
);
--> statement-breakpoint
CREATE TABLE "lineups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"week" integer NOT NULL,
	"starters" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "matchups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"period" integer NOT NULL,
	"week_start" integer NOT NULL,
	"week_end" integer NOT NULL,
	"is_playoff" boolean DEFAULT false NOT NULL,
	"playoff_round" integer,
	"bracket_slot" integer,
	"team_a_id" uuid NOT NULL,
	"team_b_id" uuid,
	"is_median" boolean DEFAULT false NOT NULL,
	"is_bye" boolean DEFAULT false NOT NULL,
	"seed_a" integer,
	"seed_b" integer,
	"score_a" double precision,
	"score_b" double precision,
	"winner_team_id" uuid,
	"final" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roster_spots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"lawyer_id" uuid NOT NULL,
	"acquired_via" "acquired_via" NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scoring_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pool_id" uuid NOT NULL,
	"case_id" uuid,
	"side" "side",
	"lawyer_id" uuid,
	"type" text NOT NULL,
	"custom_points" double precision,
	"occurred_on" date NOT NULL,
	"summary" text NOT NULL,
	"source_url" text,
	"status" "event_status" DEFAULT 'pending' NOT NULL,
	"origin" "event_origin" DEFAULT 'manual' NOT NULL,
	"external_ref" text,
	"created_by" uuid,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_week_scores" (
	"league_id" uuid NOT NULL,
	"week" integer NOT NULL,
	"team_id" uuid NOT NULL,
	"points" double precision NOT NULL,
	CONSTRAINT "team_week_scores_league_id_week_team_id_pk" PRIMARY KEY("league_id","week","team_id")
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"draft_position" integer,
	"waiver_priority" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trade_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trade_id" uuid NOT NULL,
	"from_team_id" uuid NOT NULL,
	"lawyer_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"proposer_team_id" uuid NOT NULL,
	"recipient_team_id" uuid NOT NULL,
	"status" "trade_status" DEFAULT 'proposed' NOT NULL,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone,
	"review_ends_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"fail_reason" text
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"team_id" uuid,
	"type" "transaction_type" NOT NULL,
	"lawyer_id" uuid,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"email" text,
	"is_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "waiver_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"add_lawyer_id" uuid NOT NULL,
	"drop_lawyer_id" uuid,
	"claim_order" integer NOT NULL,
	"status" "waiver_claim_status" DEFAULT 'pending' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "waiver_holds" (
	"league_id" uuid NOT NULL,
	"lawyer_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waiver_holds_league_id_lawyer_id_pk" PRIMARY KEY("league_id","lawyer_id")
);
--> statement-breakpoint
CREATE TABLE "week_finalizations" (
	"league_id" uuid NOT NULL,
	"week" integer NOT NULL,
	"finalized_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_by" uuid,
	CONSTRAINT "week_finalizations_league_id_week_pk" PRIMARY KEY("league_id","week")
);
--> statement-breakpoint
CREATE TABLE "week_scores" (
	"league_id" uuid NOT NULL,
	"week" integer NOT NULL,
	"lawyer_id" uuid NOT NULL,
	"points" double precision NOT NULL,
	CONSTRAINT "week_scores_league_id_week_lawyer_id_pk" PRIMARY KEY("league_id","week","lawyer_id")
);
--> statement-breakpoint
ALTER TABLE "case_appearances" ADD CONSTRAINT "case_appearances_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_appearances" ADD CONSTRAINT "case_appearances_lawyer_id_lawyers_id_fk" FOREIGN KEY ("lawyer_id") REFERENCES "public"."lawyers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_pool_id_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_picks" ADD CONSTRAINT "draft_picks_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_picks" ADD CONSTRAINT "draft_picks_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_picks" ADD CONSTRAINT "draft_picks_lawyer_id_lawyers_id_fk" FOREIGN KEY ("lawyer_id") REFERENCES "public"."lawyers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_picks" ADD CONSTRAINT "draft_picks_made_by_users_id_fk" FOREIGN KEY ("made_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_queue" ADD CONSTRAINT "draft_queue_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_queue" ADD CONSTRAINT "draft_queue_lawyer_id_lawyers_id_fk" FOREIGN KEY ("lawyer_id") REFERENCES "public"."lawyers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lawyers" ADD CONSTRAINT "lawyers_pool_id_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_members" ADD CONSTRAINT "league_members_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_members" ADD CONSTRAINT "league_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leagues" ADD CONSTRAINT "leagues_pool_id_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."pools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leagues" ADD CONSTRAINT "leagues_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lineups" ADD CONSTRAINT "lineups_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matchups" ADD CONSTRAINT "matchups_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matchups" ADD CONSTRAINT "matchups_team_a_id_teams_id_fk" FOREIGN KEY ("team_a_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matchups" ADD CONSTRAINT "matchups_team_b_id_teams_id_fk" FOREIGN KEY ("team_b_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matchups" ADD CONSTRAINT "matchups_winner_team_id_teams_id_fk" FOREIGN KEY ("winner_team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pools" ADD CONSTRAINT "pools_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_spots" ADD CONSTRAINT "roster_spots_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_spots" ADD CONSTRAINT "roster_spots_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_spots" ADD CONSTRAINT "roster_spots_lawyer_id_lawyers_id_fk" FOREIGN KEY ("lawyer_id") REFERENCES "public"."lawyers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoring_events" ADD CONSTRAINT "scoring_events_pool_id_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoring_events" ADD CONSTRAINT "scoring_events_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoring_events" ADD CONSTRAINT "scoring_events_lawyer_id_lawyers_id_fk" FOREIGN KEY ("lawyer_id") REFERENCES "public"."lawyers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoring_events" ADD CONSTRAINT "scoring_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoring_events" ADD CONSTRAINT "scoring_events_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_week_scores" ADD CONSTRAINT "team_week_scores_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_week_scores" ADD CONSTRAINT "team_week_scores_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_items" ADD CONSTRAINT "trade_items_trade_id_trades_id_fk" FOREIGN KEY ("trade_id") REFERENCES "public"."trades"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_items" ADD CONSTRAINT "trade_items_from_team_id_teams_id_fk" FOREIGN KEY ("from_team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_items" ADD CONSTRAINT "trade_items_lawyer_id_lawyers_id_fk" FOREIGN KEY ("lawyer_id") REFERENCES "public"."lawyers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_proposer_team_id_teams_id_fk" FOREIGN KEY ("proposer_team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_recipient_team_id_teams_id_fk" FOREIGN KEY ("recipient_team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_lawyer_id_lawyers_id_fk" FOREIGN KEY ("lawyer_id") REFERENCES "public"."lawyers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiver_claims" ADD CONSTRAINT "waiver_claims_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiver_claims" ADD CONSTRAINT "waiver_claims_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiver_claims" ADD CONSTRAINT "waiver_claims_add_lawyer_id_lawyers_id_fk" FOREIGN KEY ("add_lawyer_id") REFERENCES "public"."lawyers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiver_claims" ADD CONSTRAINT "waiver_claims_drop_lawyer_id_lawyers_id_fk" FOREIGN KEY ("drop_lawyer_id") REFERENCES "public"."lawyers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiver_holds" ADD CONSTRAINT "waiver_holds_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiver_holds" ADD CONSTRAINT "waiver_holds_lawyer_id_lawyers_id_fk" FOREIGN KEY ("lawyer_id") REFERENCES "public"."lawyers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "week_finalizations" ADD CONSTRAINT "week_finalizations_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "week_finalizations" ADD CONSTRAINT "week_finalizations_finalized_by_users_id_fk" FOREIGN KEY ("finalized_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "week_scores" ADD CONSTRAINT "week_scores_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "week_scores" ADD CONSTRAINT "week_scores_lawyer_id_lawyers_id_fk" FOREIGN KEY ("lawyer_id") REFERENCES "public"."lawyers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "case_appearances_case_lawyer_uq" ON "case_appearances" USING btree ("case_id","lawyer_id");--> statement-breakpoint
CREATE INDEX "case_appearances_lawyer_idx" ON "case_appearances" USING btree ("lawyer_id");--> statement-breakpoint
CREATE INDEX "cases_pool_idx" ON "cases" USING btree ("pool_id");--> statement-breakpoint
CREATE UNIQUE INDEX "draft_picks_league_overall_uq" ON "draft_picks" USING btree ("league_id","overall");--> statement-breakpoint
CREATE UNIQUE INDEX "draft_picks_league_lawyer_uq" ON "draft_picks" USING btree ("league_id","lawyer_id");--> statement-breakpoint
CREATE INDEX "lawyers_pool_idx" ON "lawyers" USING btree ("pool_id");--> statement-breakpoint
CREATE INDEX "lawyers_firm_idx" ON "lawyers" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "league_members_user_idx" ON "league_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lineups_team_week_uq" ON "lineups" USING btree ("team_id","week");--> statement-breakpoint
CREATE INDEX "matchups_league_period_idx" ON "matchups" USING btree ("league_id","period");--> statement-breakpoint
CREATE UNIQUE INDEX "roster_spots_league_lawyer_uq" ON "roster_spots" USING btree ("league_id","lawyer_id");--> statement-breakpoint
CREATE INDEX "roster_spots_team_idx" ON "roster_spots" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "scoring_events_pool_status_idx" ON "scoring_events" USING btree ("pool_id","status");--> statement-breakpoint
CREATE INDEX "scoring_events_case_idx" ON "scoring_events" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "scoring_events_lawyer_idx" ON "scoring_events" USING btree ("lawyer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scoring_events_external_ref_uq" ON "scoring_events" USING btree ("pool_id","external_ref");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "teams_league_owner_uq" ON "teams" USING btree ("league_id","owner_id");--> statement-breakpoint
CREATE INDEX "teams_league_idx" ON "teams" USING btree ("league_id");--> statement-breakpoint
CREATE INDEX "trade_items_trade_idx" ON "trade_items" USING btree ("trade_id");--> statement-breakpoint
CREATE INDEX "trades_league_idx" ON "trades" USING btree ("league_id");--> statement-breakpoint
CREATE INDEX "transactions_league_idx" ON "transactions" USING btree ("league_id","created_at");--> statement-breakpoint
CREATE INDEX "waiver_claims_league_status_idx" ON "waiver_claims" USING btree ("league_id","status");