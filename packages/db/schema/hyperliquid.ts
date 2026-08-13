import {
  pgTable,
  pgEnum,
  bigserial,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

export const hlConversionStatusEnum = pgEnum("hl_conversion_status", [
  "pending",
  "converting",
  "completed",
  "no_balance",
  "failed",
]);

export const pendingHlConversions = pgTable(
  "pending_hl_conversions",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    privyUserId: text("privy_user_id").notNull(),
    ethAddress: text("eth_address").notNull(),
    walletId: text("wallet_id").notNull(),
    status: hlConversionStatusEnum("status").default("pending").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    lastError: text("last_error"),
    depositTx: text("deposit_tx"),
    usolSold: text("usol_sold"),
    usdcTransferred: text("usdc_transferred"),
    /**
     * Target venue for the converted collateral. `main` (default) keeps the
     * existing flow (USDC → main perp). For HIP-3 dexes, `hl:<dexName>`
     * triggers a `sendAsset` from spot into that dex's perp balance using
     * the dex's collateral token.
     */
    targetVenue: text("target_venue").default("main").notNull(),
    /** Collateral symbol for the target venue: USDC, USDH, USDE, or USDT. */
    targetCollateral: text("target_collateral").default("USDC").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("hl_conversions_status_idx").on(t.status),
    index("hl_conversions_eth_address_idx").on(t.ethAddress),
  ],
);
