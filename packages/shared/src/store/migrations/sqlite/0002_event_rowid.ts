import { type Kysely, sql } from "kysely";

// D46: keep the mandated rowid cursor monotonic when retention deletes the
// maximum/all events. Migrator owns the immediate transaction (D43). Preserve
// existing rowids and shared columns so older six-column writers/readers work.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table krun_run_events_monotonic (
      rowid integer primary key autoincrement,
      run_id text not null references runs(id) on delete cascade,
      at text not null,
      from_state text,
      to_state text not null,
      reason text,
      payload text
    )
  `.execute(db);
  await sql`
    insert into krun_run_events_monotonic (rowid,run_id,at,from_state,to_state,reason,payload)
    select rowid,run_id,at,from_state,to_state,reason,payload from run_events order by rowid
  `.execute(db);
  await sql`drop table run_events`.execute(db);
  await sql`alter table krun_run_events_monotonic rename to run_events`.execute(db);
  await sql`create index run_events_run_idx on run_events (run_id,at)`.execute(db);
}
