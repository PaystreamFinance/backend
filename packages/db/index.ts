import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.ts";

const client = postgres(process.env.DATABASE_URL!, {
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});
export const db = drizzle(client, { schema });

export type Database = typeof db;
