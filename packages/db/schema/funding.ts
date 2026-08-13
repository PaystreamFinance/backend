import {
  pgTable,
  bigserial,
  text,
  doublePrecision,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

export const fundingRateHistory = pgTable(
  "funding_rate_history",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    dex: text("dex").notNull(),
    symbol: text("symbol").notNull(),
    protocolSymbol: text("protocol_symbol"),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
    rate: doublePrecision("rate").notNull(),
    granularity: text("granularity").default("1h").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("funding_rate_history_dex_symbol_ts_key").on(t.dex, t.symbol, t.timestamp),
    index("funding_symbol_ts_idx").on(t.symbol, t.timestamp),
    index("funding_dex_ts_idx").on(t.dex, t.timestamp),
    index("funding_ts_idx").on(t.timestamp),
  ],
);
