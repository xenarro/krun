import { type Kysely, sql } from "kysely";

// Expand the stored domain, not the public API. Existing text keys/index and
// old explicit-column writers remain valid; pg parses json and jsonb alike.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table runs alter column input type json using input::json`.execute(db);
  await sql`alter table runs add column idempotency_key_nul bytea
    check (idempotency_key_nul is null or
      (idempotency_key is null and octet_length(idempotency_key_nul) % 2 = 0))`.execute(db);
  await sql`create unique index runs_idem_nul_idx on runs
    (created_by, function_name, idempotency_key_nul)
    where idempotency_key_nul is not null`.execute(db);
}
