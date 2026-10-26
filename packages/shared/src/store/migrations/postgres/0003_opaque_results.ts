import { type Kysely, sql } from "kysely";

// Opaque results share the public JSON domain of input (D64). jsonb cannot
// represent valid escaped Unicode NUL; pg parses json and jsonb alike.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table runs alter column result type json using result::json`.execute(db);
}
