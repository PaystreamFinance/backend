import {
  pgTable,
  pgEnum,
  bigserial,
  text,
  doublePrecision,
  boolean,
  timestamp,
  integer,
  bigint,
  index,
} from "drizzle-orm/pg-core";

export const spotPerpStatusEnum = pgEnum("spot_perp_status", [
  "open",
  "closing",
  "closed",
  "liquidated",
  "error",
]);

export const spotPerpCloseReasonEnum = pgEnum("spot_perp_close_reason", [
  "manual",
  "liquidation_proximity",
  "delta_drift",
  "error",
  "unknown",
]);

export const spotPerpTrades = pgTable(
  "spot_perp_trades",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    userPubkey: text("user_pubkey").notNull(),
    privyUserId: text("privy_user_id").notNull(),
    embeddedWalletId: text("embedded_wallet_id").notNull(),
    market: text("market").notNull(),
    spotTokenMint: text("spot_token_mint").notNull(),
    perpProtocol: text("perp_protocol").notNull(),

    totalUsd: doublePrecision("total_usd").notNull(),
    spotUsd: doublePrecision("spot_usd").notNull(),
    spotAmount: text("spot_amount"),
    perpMarginUsd: doublePrecision("perp_margin_usd").notNull(),
    perpNotionalUsd: doublePrecision("perp_notional_usd").notNull(),
    perpLeverage: doublePrecision("perp_leverage").notNull(),

    spotTxnHash: text("spot_txn_hash"),
    perpTxnHash: text("perp_txn_hash"),
    perpOrderId: bigint("perp_order_id", { mode: "number" }),
    perpBundleId: text("perp_bundle_id"),
    ethAddress: text("eth_address"),
    perpLiquidationPrice: doublePrecision("perp_liquidation_price"),
    sizeAsset: doublePrecision("size_asset"),

    active: boolean("active").default(true).notNull(),
    status: spotPerpStatusEnum("status").default("open").notNull(),
    closeReason: spotPerpCloseReasonEnum("close_reason"),

    closeSpotTxnHash: text("close_spot_txn_hash"),
    closePerpTxnHash: text("close_perp_txn_hash"),
    closePerpOrderId: bigint("close_perp_order_id", { mode: "number" }),
    closeError: text("close_error"),
    closeRetryCount: integer("close_retry_count").default(0).notNull(),

    lastOraclePrice: doublePrecision("last_oracle_price"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [
    index("spt_user_pubkey_idx").on(t.userPubkey),
    index("spt_privy_user_id_idx").on(t.privyUserId),
    index("spt_active_status_idx").on(t.active, t.status),
  ],
);
