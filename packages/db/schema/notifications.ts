import {
  pgTable,
  pgEnum,
  text,
  uuid,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const notificationTypeEnum = pgEnum("notification_type", [
  "liquidation_warning",
  "auto_close",
  "funding_flip",
  "position_movement",
  "size_drift",
  "close_error",
  "better_opportunity",
  "custom",
]);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    privyUserId: text("privy_user_id").notNull(),
    type: notificationTypeEnum().notNull(),
    data: jsonb("data").notNull().$type<Record<string, unknown>>(),
    read: boolean("read").default(false).notNull(),
    dedupeKey: text("dedupe_key"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("notifications_user_unread_idx").on(
      table.privyUserId,
      table.read,
      table.createdAt
    ),
    uniqueIndex("notifications_dedupe_key_idx").on(
      table.privyUserId,
      table.dedupeKey
    ),
  ]
);
