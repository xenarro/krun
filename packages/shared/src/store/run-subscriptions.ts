import { Effect, Result, Stream } from "effect";
import { sql } from "kysely";
import { z } from "zod";
import { Database } from "../runtime/database.js";
import { DatabaseError } from "./errors.js";
import type { StoreShape } from "./index.js";
import { states } from "./model.js";

type Event = Stream.Success<ReturnType<StoreShape["subscribe"]>>;
const notificationSchema = z.strictObject({
  id: z.uuid(),
  suffix: z.enum([...states, "status", "job_status"]),
});
const cursorSchema = z.strictObject({ rowid: z.number().int().nonnegative() });
const eventSchema = z.strictObject({
  rowid: z.number().int().positive(),
  run_id: z.uuid(),
  from_state: z.enum(states).nullable(),
  to_state: z.enum(states),
});
const notification = (payload: string): Result.Result<Event, void> => {
  const [id, suffix, ...extra] = payload.split(":");
  if (extra.length !== 0) return Result.fail(undefined);
  const parsed = notificationSchema.safeParse({ id, suffix });
  if (!parsed.success) return Result.fail(undefined);
  return Result.succeed({
    id: parsed.data.id,
    kind:
      parsed.data.suffix === "status" || parsed.data.suffix === "job_status"
        ? parsed.data.suffix
        : "state",
  });
};

// Incremental D45 factory: no partial/fake full Store layer. Each SQLite
// consumer initializes its OWN cursor when consumed, not when the factory or
// lazy stream value is created. Postgres shares the Database-owned transport.
export const makeRunSubscriptions: Effect.Effect<
  Pick<StoreShape, "subscribe">,
  never,
  Database
> = Effect.gen(function* () {
  const { db, dialect, notifications } = yield* Database;
  const read = <A>(f: () => Promise<A>) =>
    Effect.tryPromise({
      try: f,
      catch: () => new DatabaseError({ operation: "subscribe" }),
    });
  return {
    subscribe: () =>
      Stream.suspend(() => {
        let count = 0;
        const source =
          dialect === "postgres"
            ? notifications === undefined
              ? Stream.fail(new DatabaseError({ operation: "subscribe" }))
              : notifications.pipe(Stream.filterMap(notification))
            : Stream.unwrap(
                Effect.gen(function* () {
                  let last = yield* read(
                    async () =>
                      cursorSchema.parse(
                        (
                          await sql`select coalesce(max(rowid),0) as rowid from run_events`.execute(
                            db,
                          )
                        ).rows[0],
                      ).rowid,
                  );
                  return Stream.fromIterableEffectRepeat(
                    Effect.gen(function* () {
                      yield* Effect.sleep("1 second");
                      const rows = yield* read(async () =>
                        (
                          await sql`select rowid,run_id,from_state,to_state from run_events where rowid > ${last} order by rowid`.execute(
                            db,
                          )
                        ).rows.map((row) => eventSchema.parse(row)),
                      );
                      // Decode the complete batch before advancing; corruption is a
                      // typed failure, never an empty poll or a silently skipped row.
                      if (rows.length > 0) last = rows[rows.length - 1]?.rowid ?? last;
                      return rows.map(
                        (row): Event => ({
                          id: row.run_id,
                          kind: row.from_state === row.to_state ? "job_status" : "state",
                        }),
                      );
                    }),
                  );
                }),
              );
        return source.pipe(
          Stream.tap(() => Effect.annotateCurrentSpan("db.response.returned_rows", ++count)),
          Stream.withSpan("store.subscribe", {
            kind: "client",
            attributes: { "db.operation.name": "subscribe", "db.response.returned_rows": 0 },
          }),
        );
      }),
  };
});
