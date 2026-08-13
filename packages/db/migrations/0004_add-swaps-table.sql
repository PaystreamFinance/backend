CREATE TABLE "swaps" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"privy_user_id" text NOT NULL,
	"wallet_address" text NOT NULL,
	"input_mint" text NOT NULL,
	"output_mint" text NOT NULL,
	"in_amount" text NOT NULL,
	"out_amount" text NOT NULL,
	"in_usd_value" double precision,
	"out_usd_value" double precision,
	"tx_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "swaps_public_id_idx" ON "swaps" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "swaps_privy_user_id_idx" ON "swaps" USING btree ("privy_user_id");--> statement-breakpoint
CREATE INDEX "swaps_created_at_idx" ON "swaps" USING btree ("created_at");