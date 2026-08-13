import {
  pgTable,
  pgEnum,
  bigserial,
  text,
  uuid,
  doublePrecision,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const transferTypeEnum = pgEnum("transfer_type", [
  "deposit",
  "withdrawal",
]);

export const transferProtocolEnum = pgEnum("transfer_protocol", [
  "pacifica",
  "hyperliquid",
  "aster",
  "lighter",
  "01",
  "phoenix",
]);

export const transferStatusEnum = pgEnum("transfer_status", [
  "initiated",
  "confirmed",
  "failed",
]);

export const transfers = pgTable(
  "transfers",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    publicId: uuid("public_id").defaultRandom().notNull(),
    privyUserId: text("privy_user_id").notNull(),
    type: transferTypeEnum().notNull(),
    protocol: transferProtocolEnum().notNull(),
    asset: text("asset").notNull(),
    amount: doublePrecision("amount").notNull(),
    status: transferStatusEnum().default("initiated").notNull(),
    txHash: text("tx_hash"),
    fromAddress: text("from_address"),
    toAddress: text("to_address"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("transfers_public_id_idx").on(table.publicId),
    index("transfers_privy_user_id_type_idx").on(
      table.privyUserId,
      table.type
    ),
    index("transfers_created_at_idx").on(table.createdAt),
    index("transfers_status_protocol_idx").on(table.status, table.protocol),
  ]
);
