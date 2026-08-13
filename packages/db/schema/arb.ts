import {
  pgTable,
  pgEnum,
  bigserial,
  text,
  uuid,
  doublePrecision,
  boolean,
  timestamp,
  integer,
  bigint,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const riskTagEnum = pgEnum("risk_tag", [
  "normal",
  "warn",
  "reduce",
  "critical",
]);

export type RiskTag = "normal" | "warn" | "reduce" | "critical";

export interface RiskParams {
  liqProximity: RiskTag;
  funding: RiskTag;
  oiCascade: RiskTag;
  equityDrawdown: RiskTag;
}

export const arbPairStatusEnum = pgEnum("arb_pair_status", [
  "open",
  "closing",
  "closed",
  "liquidated",
  "error",
]);

export const arbCloseReasonEnum = pgEnum("arb_close_reason", [
  "manual",
  "funding_flip",
  "pnl_threshold",
  "liquidation_proximity",
  "max_hold_time",
  "error",
  "delta_drift",
  "unknown",
  "equity_drawdown",
  "oi_cascade",
  "risk_threshold",
  "liquidation_partial",
]);

export const arbPositionPairs = pgTable(
  "arb_position_pairs",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    publicId: uuid("public_id").defaultRandom().notNull(),
    userPubkey: text("user_pubkey").notNull(),
    privyUserId: text("privy_user_id").notNull(),
    embeddedWalletId: text("embedded_wallet_id").notNull(),
    ethAddress: text("eth_address"),
    // Back-compat ticker for single-ticker pairs. New v2 (cross-ticker) pairs
    // set this to the long leg's symbol for display / grouping purposes; use
    // `longSymbol` / `shortSymbol` for per-leg lookups.
    symbol: text("symbol").notNull(),
    longSymbol: text("long_symbol"),
    shortSymbol: text("short_symbol"),
    oraclePriceAtEntry: doublePrecision("oracle_price_at_entry").notNull(),
    entryApy: doublePrecision("entry_apy"),

    longProtocol: text("long_protocol").notNull(),
    longMarginUsd: doublePrecision("long_margin_usd").notNull(),
    longNotionalUsd: doublePrecision("long_notional_usd").notNull(),
    longLeverage: doublePrecision("long_leverage").notNull(),
    longEntryPrice: doublePrecision("long_entry_price"),
    longTxSignature: text("long_tx_signature"),
    longOrderId: bigint("long_order_id", { mode: "number" }),
    longLiquidationPrice: doublePrecision("long_liquidation_price"),
    longStatus: text("long_status").default("success").notNull(),
    longError: text("long_error"),

    shortProtocol: text("short_protocol").notNull(),
    shortMarginUsd: doublePrecision("short_margin_usd").notNull(),
    shortNotionalUsd: doublePrecision("short_notional_usd").notNull(),
    shortLeverage: doublePrecision("short_leverage").notNull(),
    shortEntryPrice: doublePrecision("short_entry_price"),
    shortTxSignature: text("short_tx_signature"),
    shortOrderId: bigint("short_order_id", { mode: "number" }),
    shortLiquidationPrice: doublePrecision("short_liquidation_price"),
    shortStatus: text("short_status").default("success").notNull(),
    shortError: text("short_error"),

    sizeAsset: doublePrecision("size_asset"),
    totalMarginUsd: doublePrecision("total_margin_usd").notNull(),
    active: boolean("active").default(true).notNull(),
    status: arbPairStatusEnum("status").default("open").notNull(),
    closeReason: arbCloseReasonEnum("close_reason"),

    closeLongTx: text("close_long_tx"),
    closeLongOrderId: bigint("close_long_order_id", { mode: "number" }),
    closeShortTx: text("close_short_tx"),
    closeShortOrderId: bigint("close_short_order_id", { mode: "number" }),
    realizedPnl: doublePrecision("realized_pnl"),
    closeError: text("close_error"),
    closeRetryCount: integer("close_retry_count").default(0).notNull(),

    riskTag: riskTagEnum("risk_tag").default("normal").notNull(),
    riskParams: jsonb("risk_params").$type<RiskParams>().default({ liqProximity: 'normal', funding: 'normal', oiCascade: 'normal', equityDrawdown: 'normal' }).notNull(),
    negFundingCount: integer("neg_funding_count").default(0).notNull(),
    currentLongMarginUsd: doublePrecision("current_long_margin_usd"),
    currentShortMarginUsd: doublePrecision("current_short_margin_usd"),

    // disableAclp: lets one leg ride to real liquidation, then sets a tight
    // stop-loss on the surviving leg (see core-worker arb-worker.ts).
    disableAclp: boolean("disable_aclp").default(false).notNull(),
    survivingLegSlSet: boolean("surviving_leg_sl_set").default(false).notNull(),
    // disableAutoclose: fully opts the pair out of auto-close monitoring — the
    // producer skips it entirely and equity drawdown ignores it. The pair can
    // only be closed by the user manually or by hitting venue liquidation.
    disableAutoclose: boolean("disable_autoclose").default(false).notNull(),

    lastOraclePrice: doublePrecision("last_oracle_price"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("arb_public_id_idx").on(t.publicId),
    index("arb_user_pubkey_idx").on(t.userPubkey),
    index("arb_privy_user_id_idx").on(t.privyUserId),
    index("arb_active_status_idx").on(t.active, t.status),
  ],
);
