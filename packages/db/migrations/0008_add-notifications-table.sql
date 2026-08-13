CREATE TYPE "public"."notification_type" AS ENUM('liquidation_warning', 'auto_close', 'funding_flip', 'position_movement', 'size_drift', 'close_error', 'better_opportunity', 'custom');--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"privy_user_id" text NOT NULL,
	"type" "notification_type" NOT NULL,
	"data" jsonb NOT NULL,
	"read" boolean DEFAULT false NOT NULL,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "notifications_user_unread_idx" ON "notifications" USING btree ("privy_user_id","read","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_key_idx" ON "notifications" USING btree ("privy_user_id","dedupe_key");