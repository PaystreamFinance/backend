import {
  pgTable,
  bigserial,
  text,
  uuid,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const swaps = pgTable(
  "swaps",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    publicId: uuid("public_id").defaultRandom().notNull(),
    privyUserId: text("privy_user_id").notNull(),
    walletAddress: text("wallet_address").notNull(),
    inputMint: text("input_mint").notNull(),
    outputMint: text("output_mint").notNull(),
    inAmount: text("in_amount").notNull(),
    outAmount: text("out_amount").notNull(),
    txHash: text("tx_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("swaps_public_id_idx").on(table.publicId),
    index("swaps_privy_user_id_idx").on(table.privyUserId),
    index("swaps_created_at_idx").on(table.createdAt),
  ]
);
