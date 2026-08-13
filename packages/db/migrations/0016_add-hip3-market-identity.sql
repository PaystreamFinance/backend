ALTER TABLE "arb_position_pairs" ADD COLUMN "long_dex" text;--> statement-breakpoint
ALTER TABLE "arb_position_pairs" ADD COLUMN "long_native_symbol" text;--> statement-breakpoint
ALTER TABLE "arb_position_pairs" ADD COLUMN "long_quote" text;--> statement-breakpoint
ALTER TABLE "arb_position_pairs" ADD COLUMN "long_unit_scale" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "arb_position_pairs" ADD COLUMN "short_dex" text;--> statement-breakpoint
ALTER TABLE "arb_position_pairs" ADD COLUMN "short_native_symbol" text;--> statement-breakpoint
ALTER TABLE "arb_position_pairs" ADD COLUMN "short_quote" text;--> statement-breakpoint
ALTER TABLE "arb_position_pairs" ADD COLUMN "short_unit_scale" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "spot_perp_trades" ADD COLUMN "perp_dex" text;--> statement-breakpoint
ALTER TABLE "spot_perp_trades" ADD COLUMN "perp_native_symbol" text;--> statement-breakpoint
ALTER TABLE "spot_perp_trades" ADD COLUMN "perp_quote" text;--> statement-breakpoint
ALTER TABLE "spot_perp_trades" ADD COLUMN "perp_unit_scale" integer DEFAULT 1 NOT NULL;--> statement-breakpoint

-- Backfill existing rows with best-effort market identity. `native_symbol`
-- is copied from `symbol` (close enough for matching — canonicalizeSymbol
-- still handles prefix-variant mismatches during the transition). `dex`
-- is '' for Hyperliquid legs (all existing HL rows predate HIP-3) and NULL
-- elsewhere. `quote` defaults from the known collateral token per protocol:
-- USDT for Aster, USDC for everything else. `unit_scale` is 1000 for
-- scale-prefixed tickers (1000X or KX that isn't a real K-token), else 1.

UPDATE "arb_position_pairs" SET
  "long_native_symbol" = COALESCE("long_native_symbol", "symbol"),
  "long_dex" = CASE WHEN "long_protocol" = 'hyperliquid' THEN '' ELSE "long_dex" END,
  "long_quote" = COALESCE("long_quote", CASE "long_protocol" WHEN 'aster' THEN 'USDT' ELSE 'USDC' END),
  "long_unit_scale" = CASE
    WHEN "symbol" LIKE '1000%' AND length("symbol") > 4 THEN 1000
    WHEN "symbol" LIKE 'K%'
         AND length("symbol") > 1
         AND "symbol" NOT IN ('KAS', 'KAVA', 'KMNO', 'KDA', 'KNC', 'KAIA')
      THEN 1000
    ELSE 1
  END,
  "short_native_symbol" = COALESCE("short_native_symbol", "symbol"),
  "short_dex" = CASE WHEN "short_protocol" = 'hyperliquid' THEN '' ELSE "short_dex" END,
  "short_quote" = COALESCE("short_quote", CASE "short_protocol" WHEN 'aster' THEN 'USDT' ELSE 'USDC' END),
  "short_unit_scale" = CASE
    WHEN "symbol" LIKE '1000%' AND length("symbol") > 4 THEN 1000
    WHEN "symbol" LIKE 'K%'
         AND length("symbol") > 1
         AND "symbol" NOT IN ('KAS', 'KAVA', 'KMNO', 'KDA', 'KNC', 'KAIA')
      THEN 1000
    ELSE 1
  END;--> statement-breakpoint

UPDATE "spot_perp_trades" SET
  "perp_native_symbol" = COALESCE("perp_native_symbol", "market"),
  "perp_dex" = CASE WHEN "perp_protocol" = 'hyperliquid' THEN '' ELSE "perp_dex" END,
  "perp_quote" = COALESCE("perp_quote", CASE "perp_protocol" WHEN 'aster' THEN 'USDT' ELSE 'USDC' END),
  "perp_unit_scale" = CASE
    WHEN "market" LIKE '1000%' AND length("market") > 4 THEN 1000
    WHEN "market" LIKE 'K%'
         AND length("market") > 1
         AND "market" NOT IN ('KAS', 'KAVA', 'KMNO', 'KDA', 'KNC', 'KAIA')
      THEN 1000
    ELSE 1
  END;