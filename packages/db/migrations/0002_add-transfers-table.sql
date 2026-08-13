CREATE TYPE "public"."transfer_protocol" AS ENUM('drift', 'pacifica', 'hyperliquid', 'aster', 'lighter');--> statement-breakpoint
CREATE TYPE "public"."transfer_status" AS ENUM('initiated', 'confirmed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."transfer_type" AS ENUM('deposit', 'withdrawal');--> statement-breakpoint
CREATE TABLE "transfers" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"privy_user_id" text NOT NULL,
	"type" "transfer_type" NOT NULL,
	"protocol" "transfer_protocol" NOT NULL,
	"asset" text NOT NULL,
	"amount" double precision NOT NULL,
	"status" "transfer_status" DEFAULT 'initiated' NOT NULL,
	"tx_signature" text,
	"tx_hash" text,
	"from_address" text,
	"to_address" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "transfers_public_id_idx" ON "transfers" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "transfers_privy_user_id_type_idx" ON "transfers" USING btree ("privy_user_id","type");--> statement-breakpoint
CREATE INDEX "transfers_created_at_idx" ON "transfers" USING btree ("created_at");