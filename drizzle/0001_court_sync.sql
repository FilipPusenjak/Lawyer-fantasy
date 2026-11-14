ALTER TABLE "cases" ADD COLUMN "synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "sync_cursor" text;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "sync_error" text;--> statement-breakpoint
CREATE INDEX "cases_synced_idx" ON "cases" USING btree ("synced_at");