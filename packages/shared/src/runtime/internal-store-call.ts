import { AsyncLocalStorage } from "node:async_hooks";
import { Context } from "effect";
import { type DatabaseConnection, type Driver, PostgresDialect } from "kysely";
import type { Pool } from "pg";

// A call-local cancellation capability, not another Store method or pool.
// Ordinary Store users keep their existing 10-second driver configuration.
export const InternalStoreSignal = Context.Reference<AbortSignal | undefined>(
  "krun/InternalStoreSignal",
  { defaultValue: () => undefined },
);
const current = new AsyncLocalStorage<AbortSignal>();
export const internalStoreTimeout = () => (current.getStore() ? 5000 : 0);
export const internalStoreCall = <A>(
  signal: AbortSignal | undefined,
  call: () => Promise<A>,
): Promise<A> => (signal ? current.run(signal, call) : call());

// Keep pg's public QueryConfig timeout per internal invocation, without changing
// the shared five-connection pool or its other callers' 10000ms default.
export const internalTimeoutPool = (pool: Pool): Pool =>
  new Proxy(pool, {
    get(target, key) {
      if (key === "connect")
        return async () => {
          const signal = current.getStore();
          const pending = target.connect();
          const client = signal
            ? await new Promise<Awaited<typeof pending>>((resolve, reject) => {
                const abort = () => reject(signal.reason);
                signal.addEventListener("abort", abort, { once: true });
                if (signal.aborted) abort();
                pending.then(
                  (client) => {
                    signal.removeEventListener("abort", abort);
                    if (signal.aborted) client.release();
                    else resolve(client);
                  },
                  (error: unknown) => {
                    signal.removeEventListener("abort", abort);
                    reject(error);
                  },
                );
              })
            : await pending;
          return new Proxy(client, {
            get(client, property) {
              if (property === "query")
                return (...args: unknown[]) => {
                  const signal = current.getStore();
                  if (signal && typeof args[0] === "string")
                    args = [{ text: args[0], values: args[1], query_timeout: 5000 }];
                  return Reflect.apply(client.query, client, args);
                };
              const value: unknown = Reflect.get(client, property);
              return typeof value === "function" ? value.bind(client) : value;
            },
          });
        };
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

// Kysely's high-level abort API rejects before the cancelled query settles and
// prints late errors to console. Own cancellation here instead: await both the
// server cancel and native query before rollback/release. Never release an active
// transaction or print driver diagnostics. Uses the installed public driver API.
export class InternalDeadlinePostgresDialect extends PostgresDialect {
  override createDriver(): Driver {
    const driver = super.createDriver();
    const originals = new WeakMap<DatabaseConnection, DatabaseConnection>();
    const wrapped = new WeakMap<DatabaseConnection, DatabaseConnection>();
    const wrap = (connection: DatabaseConnection): DatabaseConnection => {
      const cached = wrapped.get(connection);
      if (cached) return cached;
      const proxy = new Proxy(connection, {
        get(target, property) {
          if (property === "executeQuery")
            return async (...args: Parameters<DatabaseConnection["executeQuery"]>) => {
              const signal = current.getStore();
              // Rollback must finish after deadline; all other SQL fails closed.
              if (!signal || /^rollback\b/i.test(args[0].sql)) return target.executeQuery(...args);
              signal.throwIfAborted();
              await target.collectSessionInfo?.();
              signal.throwIfAborted();
              let cancellation: Promise<void> | undefined;
              const abort = () => {
                cancellation ??= target
                  .cancelQuery?.(async (use) => {
                    const control = await driver.acquireConnection();
                    try {
                      return await use(control);
                    } finally {
                      await driver.releaseConnection(control);
                    }
                  })
                  .then(() => undefined)
                  .catch(() => undefined);
              };
              signal.addEventListener("abort", abort, { once: true });
              try {
                signal.throwIfAborted();
                const result = await target.executeQuery(...args);
                signal.throwIfAborted();
                return result;
              } finally {
                signal.removeEventListener("abort", abort);
                await cancellation;
              }
            };
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      originals.set(proxy, connection);
      wrapped.set(connection, proxy);
      return proxy;
    };
    return new Proxy(driver, {
      get(target, property) {
        if (property === "acquireConnection")
          return async (...args: Parameters<Driver["acquireConnection"]>) =>
            wrap(await target.acquireConnection(...args));
        if (property === "releaseConnection")
          return (connection: DatabaseConnection) =>
            target.releaseConnection(originals.get(connection) ?? connection);
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
}
