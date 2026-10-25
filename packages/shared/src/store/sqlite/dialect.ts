import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  CompiledQuery,
  type DatabaseConnection,
  SqliteAdapter,
  type SqliteDatabase,
  SqliteDialect,
  type SqliteDialectConfig,
  SqliteDriver,
} from "kysely";

const parameters = (values: ReadonlyArray<unknown>): SQLInputValue[] =>
  values.map((value) => {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "bigint" ||
      value instanceof Uint8Array
    )
      return value;
    throw new TypeError("Unsupported SQLite parameter");
  });

const adapt = (database: DatabaseSync): SqliteDatabase => ({
  close: () => database.close(),
  prepare: (query) => {
    const statement = database.prepare(query);
    return {
      reader: statement.columns().length > 0,
      all: (values) => statement.all(...parameters(values)),
      run: (values) => statement.run(...parameters(values)),
      iterate: (values) => statement.iterate(...parameters(values)),
    };
  },
});

class ImmediateDriver extends SqliteDriver {
  override async beginTransaction(connection: DatabaseConnection) {
    await connection.executeQuery(CompiledQuery.raw("begin immediate"));
  }
}

class TransactionalAdapter extends SqliteAdapter {
  override get supportsTransactionalDdl() {
    return true;
  }
}

export class KrunSqliteDialect extends SqliteDialect {
  readonly #config: SqliteDialectConfig;

  constructor(path: string) {
    const config: SqliteDialectConfig = {
      // Open lazily so Kysely owns close even when no queries run. A failed
      // open/pragma sequence cleans up here before driver initialization ends.
      database: async () => {
        const database = new DatabaseSync(path);
        try {
          // Set the declared connection policy before persistent header/journal
          // writes; otherwise those run under SQLite's default FULL sync mode.
          database.exec("pragma synchronous = NORMAL");
          database.exec("pragma busy_timeout = 5000");
          database.exec("pragma auto_vacuum = INCREMENTAL");
          database.exec("pragma journal_mode = WAL");
          database.exec("pragma foreign_keys = ON");
          return adapt(database);
        } catch (error) {
          database.close();
          throw error;
        }
      },
    };
    super(config);
    this.#config = config;
  }

  override createAdapter() {
    return new TransactionalAdapter();
  }

  override createDriver() {
    return new ImmediateDriver(this.#config);
  }
}
