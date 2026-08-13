UPDATE "transfers" SET "tx_hash" = "tx_signature" WHERE "tx_hash" IS NULL AND "tx_signature" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "transfers" DROP COLUMN "tx_signature";