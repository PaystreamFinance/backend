import {
  pgTable,
  text,
  boolean,
  timestamp,
  bigint,
  uuid,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

export const telegramUserLinks = pgTable(
  "telegram_user_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    privyUserId: text("privy_user_id").notNull().unique(),
    walletAddress: text("wallet_address").notNull(),
    ethAddress: text("eth_address"),
    telegramChatId: bigint("telegram_chat_id", { mode: "number" }).notNull(),
    telegramUsername: text("telegram_username"),
    notificationsEnabled: boolean("notifications_enabled").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("tg_links_chat_id_idx").on(t.telegramChatId),
  ],
);

export const telegramLinkTokens = pgTable(
  "telegram_link_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    token: text("token").notNull().unique(),
    privyUserId: text("privy_user_id").notNull(),
    walletAddress: text("wallet_address").notNull(),
    ethAddress: text("eth_address"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    used: boolean("used").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("tg_link_tokens_token_idx").on(t.token),
  ],
);

export const telegramNotificationPreferences = pgTable(
  "telegram_notification_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    privyUserId: text("privy_user_id").notNull(),
    notificationType: text("notification_type").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("tg_prefs_user_type_key").on(t.privyUserId, t.notificationType),
  ],
);
