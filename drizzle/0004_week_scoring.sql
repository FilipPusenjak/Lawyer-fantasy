CREATE TABLE "week_scoring" (
	"league_id" uuid NOT NULL,
	"week" integer NOT NULL,
	"scoring" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "week_scoring_league_id_week_pk" PRIMARY KEY("league_id","week")
);
--> statement-breakpoint
ALTER TABLE "week_scoring" ADD CONSTRAINT "week_scoring_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;