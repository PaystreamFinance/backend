-- Remove the drift exchange from the transfers data model.
-- Existing rows with protocol = 'drift' must be deleted first because PostgreSQL
-- can't cast a TEXT value back to an enum that no longer contains it.
DELETE FROM "transfers" WHERE "protocol" = 'drift';--> statement-breakpoint
ALTER TABLE "transfers" ALTER COLUMN "protocol" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."transfer_protocol";--> statement-breakpoint
CREATE TYPE "public"."transfer_protocol" AS ENUM('pacifica', 'hyperliquid', 'aster', 'lighter');--> statement-breakpoint
ALTER TABLE "transfers" ALTER COLUMN "protocol" SET DATA TYPE "public"."transfer_protocol" USING "protocol"::"public"."transfer_protocol";
