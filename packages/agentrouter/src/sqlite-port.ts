// SQLite port shared by Bun and Node runtimes. bun:sqlite and node:sqlite differ only in
// statement lookup and empty-result conventions, so the port lazily resolves the runtime's
// native module and normalizes both to one closed surface. The module load itself stays
// runtime-neutral: importing this file under Node never touches bun:sqlite and vice versa.

export type SqliteBinding = string | number | bigint | boolean | null | Uint8Array;
export interface SqliteStatement<Row, _Params extends SqliteBinding[] = SqliteBinding[]> {
  get(...params: unknown[]): Row | null;
  run(...params: unknown[]): { changes: number };
}
export interface SqliteDatabase {
  exec(sql: string): void;
  query<Row = unknown, Params extends SqliteBinding[] = SqliteBinding[]>(sql: string): SqliteStatement<Row, Params>;
  close(): void;
}

type NativeStatement = {
  get(...params: never[]): unknown;
  run(...params: never[]): { changes: number | bigint };
};
type NativeDatabase = {
  exec(sql: string): unknown;
  prepare(sql: string): NativeStatement;
  close(): void;
};

export function wrapSqliteDatabase(database: NativeDatabase): SqliteDatabase {
  // Match bun:sqlite defaults so file layout and constraint behavior are identical whichever
  // runtime opened the database: WAL journal (bun default; node:sqlite leaves the file's own
  // mode) and foreign_keys off (SQLite/bun default; node:sqlite enables it by default).
  database.exec("PRAGMA journal_mode=WAL");
  database.exec("PRAGMA foreign_keys=OFF");
  let closed = false;
  // node:sqlite rejects boolean bindings where bun:sqlite coerces them to 0/1; normalize.
  const bind = (params: readonly unknown[]) => params.map(value => typeof value === "boolean" ? Number(value) : value);
  return {
    exec(sql) { database.exec(sql); },
    query(sql) {
      const statement = database.prepare(sql);
      return {
        get: (...params: unknown[]) => ((statement.get as (...args: unknown[]) => unknown)(...bind(params)) ?? null) as never,
        run: (...params: unknown[]) => ({ changes: Number((statement.run as (...args: unknown[]) => { changes: number | bigint })(...bind(params)).changes) }),
      };
    },
    close() { if (!closed) { closed = true; database.close(); } },
  };
}

export async function openAccountDatabase(path: string): Promise<SqliteDatabase> {
  const database: NativeDatabase = typeof Bun === "undefined"
    ? new (await import("node:sqlite")).DatabaseSync(path)
    : new (await import("bun:sqlite")).Database(path);
  return wrapSqliteDatabase(database);
}
