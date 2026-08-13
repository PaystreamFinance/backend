CREATE TYPE "public"."arb_close_reason" AS ENUM('manual', 'funding_flip', 'pnl_threshold', 'liquidation_proximity', 'max_hold_time', 'error', 'delta_drift', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."arb_pair_status" AS ENUM('open', 'closing', 'closed', 'liquidated', 'error');--> statement-breakpoint
CREATE TYPE "public"."exchange_name" AS ENUM('aster', 'lighter');--> statement-breakpoint
CREATE TYPE "public"."hl_conversion_status" AS ENUM('pending', 'converting', 'completed', 'no_balance', 'failed');--> statement-breakpoint
CREATE TYPE "public"."spot_perp_close_reason" AS ENUM('manual', 'liquidation_proximity', 'delta_drift', 'error', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."spot_perp_status" AS ENUM('open', 'closing', 'closed', 'liquidated', 'error');--> statement-breakpoint
CREATE TABLE "arb_position_pairs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_pubkey" text NOT NULL,
	"privy_user_id" text NOT NULL,
	"embedded_wallet_id" text NOT NULL,
	"eth_address" text,
	"symbol" text NOT NULL,
	"oracle_price_at_entry" double precision NOT NULL,
	"long_protocol" text NOT NULL,
	"long_margin_usd" double precision NOT NULL,
	"long_notional_usd" double precision NOT NULL,
	"long_leverage" double precision NOT NULL,
	"long_entry_price" double precision,
	"long_tx_signature" text,
	"long_order_id" bigint,
	"long_liquidation_price" double precision,
	"long_status" text DEFAULT 'success' NOT NULL,
	"long_error" text,
	"short_protocol" text NOT NULL,
	"short_margin_usd" double precision NOT NULL,
	"short_notional_usd" double precision NOT NULL,
	"short_leverage" double precision NOT NULL,
	"short_entry_price" double precision,
	"short_tx_signature" text,
	"short_order_id" bigint,
	"short_liquidation_price" double precision,
	"short_status" text DEFAULT 'success' NOT NULL,
	"short_error" text,
	"size_asset" double precision,
	"total_margin_usd" double precision NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"status" "arb_pair_status" DEFAULT 'open' NOT NULL,
	"close_reason" "arb_close_reason",
	"close_long_tx" text,
	"close_long_order_id" bigint,
	"close_short_tx" text,
	"close_short_order_id" bigint,
	"realized_pnl" double precision,
	"close_error" text,
	"close_retry_count" integer DEFAULT 0 NOT NULL,
	"last_oracle_price" double precision,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "exchange_api_keys" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"privy_user_id" text NOT NULL,
	"wallet_address" text NOT NULL,
	"exchange" "exchange_name" NOT NULL,
	"credentials" jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "funding_rate_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"dex" text NOT NULL,
	"symbol" text NOT NULL,
	"protocol_symbol" text,
	"timestamp" timestamp with time zone NOT NULL,
	"rate" double precision NOT NULL,
	"granularity" text DEFAULT '1h' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_hl_conversions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"privy_user_id" text NOT NULL,
	"eth_address" text NOT NULL,
	"wallet_id" text NOT NULL,
	"status" "hl_conversion_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"deposit_tx" text,
	"usol_sold" text,
	"usdc_transferred" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spot_perp_trades" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_pubkey" text NOT NULL,
	"privy_user_id" text NOT NULL,
	"embedded_wallet_id" text NOT NULL,
	"market" text NOT NULL,
	"spot_token_mint" text NOT NULL,
	"perp_protocol" text NOT NULL,
	"total_usd" double precision NOT NULL,
	"spot_usd" double precision NOT NULL,
	"spot_amount" text,
	"perp_margin_usd" double precision NOT NULL,
	"perp_notional_usd" double precision NOT NULL,
	"perp_leverage" double precision NOT NULL,
	"spot_txn_hash" text,
	"perp_txn_hash" text,
	"perp_order_id" bigint,
	"perp_bundle_id" text,
	"eth_address" text,
	"perp_liquidation_price" double precision,
	"size_asset" double precision,
	"active" boolean DEFAULT true NOT NULL,
	"status" "spot_perp_status" DEFAULT 'open' NOT NULL,
	"close_reason" "spot_perp_close_reason",
	"close_spot_txn_hash" text,
	"close_perp_txn_hash" text,
	"close_perp_order_id" bigint,
	"close_error" text,
	"close_retry_count" integer DEFAULT 0 NOT NULL,
	"last_oracle_price" double precision,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "telegram_link_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"privy_user_id" text NOT NULL,
	"wallet_address" text NOT NULL,
	"eth_address" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_link_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "telegram_notification_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"privy_user_id" text NOT NULL,
	"notification_type" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_user_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"privy_user_id" text NOT NULL,
	"wallet_address" text NOT NULL,
	"eth_address" text,
	"telegram_chat_id" bigint NOT NULL,
	"telegram_username" text,
	"notifications_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_user_links_privy_user_id_unique" UNIQUE("privy_user_id")
);
--> statement-breakpoint
CREATE INDEX "arb_user_pubkey_idx" ON "arb_position_pairs" USING btree ("user_pubkey");--> statement-breakpoint
CREATE INDEX "arb_privy_user_id_idx" ON "arb_position_pairs" USING btree ("privy_user_id");--> statement-breakpoint
CREATE INDEX "arb_active_status_idx" ON "arb_position_pairs" USING btree ("active","status");--> statement-breakpoint
CREATE UNIQUE INDEX "exchange_api_keys_user_exchange_key" ON "exchange_api_keys" USING btree ("privy_user_id","exchange");--> statement-breakpoint
CREATE INDEX "exchange_api_keys_wallet_exchange_idx" ON "exchange_api_keys" USING btree ("wallet_address","exchange");--> statement-breakpoint
CREATE UNIQUE INDEX "funding_rate_history_dex_symbol_ts_key" ON "funding_rate_history" USING btree ("dex","symbol","timestamp");--> statement-breakpoint
CREATE INDEX "funding_symbol_ts_idx" ON "funding_rate_history" USING btree ("symbol","timestamp");--> statement-breakpoint
CREATE INDEX "funding_dex_ts_idx" ON "funding_rate_history" USING btree ("dex","timestamp");--> statement-breakpoint
CREATE INDEX "funding_ts_idx" ON "funding_rate_history" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "hl_conversions_status_idx" ON "pending_hl_conversions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "hl_conversions_eth_address_idx" ON "pending_hl_conversions" USING btree ("eth_address");--> statement-breakpoint
CREATE INDEX "spt_user_pubkey_idx" ON "spot_perp_trades" USING btree ("user_pubkey");--> statement-breakpoint
CREATE INDEX "spt_privy_user_id_idx" ON "spot_perp_trades" USING btree ("privy_user_id");--> statement-breakpoint
CREATE INDEX "spt_active_status_idx" ON "spot_perp_trades" USING btree ("active","status");--> statement-breakpoint
CREATE INDEX "tg_link_tokens_token_idx" ON "telegram_link_tokens" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "tg_prefs_user_type_key" ON "telegram_notification_preferences" USING btree ("privy_user_id","notification_type");--> statement-breakpoint
CREATE INDEX "tg_links_chat_id_idx" ON "telegram_user_links" USING btree ("telegram_chat_id");