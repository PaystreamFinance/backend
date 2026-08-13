import {
  pgTable,
  pgEnum,
  bigserial,
  text,
  jsonb,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

export const exchangeNameEnum = pgEnum("exchange_name", ["aster", "lighter", "01", "phoenix"]);

export const exchangeApiKeys = pgTable(
  "exchange_api_keys",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    privyUserId: text("privy_user_id").notNull(),
    walletAddress: text("wallet_address").notNull(),
    exchange: exchangeNameEnum("exchange").notNull(),
    credentials: jsonb("credentials").notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("exchange_api_keys_user_exchange_key").on(t.privyUserId, t.exchange),
    index("exchange_api_keys_wallet_exchange_idx").on(t.walletAddress, t.exchange),
  ],
);
