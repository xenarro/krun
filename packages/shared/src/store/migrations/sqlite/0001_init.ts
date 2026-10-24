import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table runs (
      id text primary key not null,
      idempotency_key text,
      request_hash text not null,
      function_name text not null,
      input text not null,
      state text not null check (state in ('queued','scheduled','running','succeeded','failed','cancelling','cancelled')),
      priority integer not null default 0,
      attempt integer not null default 0,
      lease_owner text,
      lease_until text,
      job_name text,
      job_token_hash text,
      result text,
      result_ref text,
      error text,
      log_tail text,
      failure_reason text,
      runtime_status text,
      job_status text,
      callback_url text,
      created_by text not null,
      created_at text not null,
      scheduled_at text,
      started_at text,
      finished_at text
    )
  `.execute(db);
  await sql`create unique index runs_idem_idx on runs (created_by, function_name, idempotency_key) where idempotency_key is not null`.execute(
    db,
  );
  await sql`create index runs_queue_idx on runs (function_name, priority desc, created_at) where state = 'queued'`.execute(
    db,
  );
  await sql`create index runs_active_idx on runs (function_name, state) where state in ('queued','scheduled','running','cancelling')`.execute(
    db,
  );
  await sql`create index runs_function_idx on runs (function_name, created_at desc, id desc)`.execute(
    db,
  );
  await sql`create index runs_owner_idx on runs (created_by, created_at desc, id desc)`.execute(db);
  await sql`create index runs_created_idx on runs (created_at desc, id desc)`.execute(db);
  await sql`create index runs_finished_idx on runs (finished_at) where finished_at is not null`.execute(
    db,
  );
  await sql`
    create table run_events (
      run_id text not null references runs(id) on delete cascade,
      at text not null,
      from_state text,
      to_state text not null,
      reason text,
      payload text
    )
  `.execute(db);
  await sql`create index run_events_run_idx on run_events (run_id, at)`.execute(db);
  await sql`
    create table deliveries (
      id text primary key not null,
      run_id text not null references runs(id) on delete cascade,
      url text not null,
      payload text not null,
      attempt integer not null default 0,
      next_at text not null,
      state text not null check (state in ('pending','delivered','dead')),
      last_error text,
      created_at text not null
    )
  `.execute(db);
  await sql`create index deliveries_due_idx on deliveries (next_at) where state = 'pending'`.execute(
    db,
  );
  await sql`create index deliveries_run_idx on deliveries (run_id)`.execute(db);
}
