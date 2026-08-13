CREATE TYPE "public"."risk_tag" AS ENUM('normal', 'warn', 'reduce', 'critical');--> statement-breakpoint
ALTER TYPE "public"."arb_close_reason" ADD VALUE 'equity_drawdown';--> statement-breakpoint
ALTER TYPE "public"."arb_close_reason" ADD VALUE 'oi_cascade';--> statement-breakpoint
ALTER TYPE "public"."arb_close_reason" ADD VALUE 'risk_threshold';--> statement-breakpoint
ALTER TABLE "arb_position_pairs" ADD COLUMN "risk_tag" "risk_tag" DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "arb_position_pairs" ADD COLUMN "risk_params" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "arb_position_pairs" ADD COLUMN "neg_funding_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "arb_position_pairs" ADD COLUMN "current_long_margin_usd" double precision;--> statement-breakpoint
ALTER TABLE "arb_position_pairs" ADD COLUMN "current_short_margin_usd" double precision;