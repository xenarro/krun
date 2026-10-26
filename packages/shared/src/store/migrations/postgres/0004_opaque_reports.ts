import { type Kysely, sql } from "kysely";

// D74: internal reports have the same opaque JSON/Unicode domain as input and
// result. Preserve shipped values and existing pg JSON decoding; no down path.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table runs add column runtime_status_at timestamptz`.execute(db);
  await sql`update runs set runtime_status_at=(runtime_status->>'at')::timestamptz where runtime_status is not null`.execute(
    db,
  );
  await sql`alter table runs
    alter column runtime_status type json using runtime_status::json,
    alter column error type json using error::json`.execute(db);
  // Every status replacement invalidates the projection, including writers
  // from before this migration. New writers republish it in the same locked
  // transaction. A NULL projection is decoded from authoritative JSON by the
  // application, never by PostgreSQL's Unicode-narrowing JSON text operators.
  await sql`create function krun_invalidate_runtime_status_at() returns trigger
    language plpgsql as $$ begin new.runtime_status_at := null; return new; end $$`.execute(db);
  await sql`create trigger krun_invalidate_runtime_status_at
    before update of runtime_status on runs for each row
    execute function krun_invalidate_runtime_status_at()`.execute(db);
  await sql`alter table run_events alter column payload type json using payload::json`.execute(db);
  await sql`alter table deliveries alter column payload type json using payload::json`.execute(db);
}
