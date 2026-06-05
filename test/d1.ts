// Minimal D1Database-compatible adapter over Node's built-in SQLite, so the
// Hono worker can be unit-tested in plain vitest without miniflare/workerd.
import { DatabaseSync } from "node:sqlite";

class Stmt {
  private args: unknown[] = [];
  constructor(private db: DatabaseSync, private sql: string) {}
  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }
  async first<T = unknown>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...(this.args as never[]));
    return (row ?? null) as T | null;
  }
  async all<T = unknown>(): Promise<{ results: T[] }> {
    const results = this.db.prepare(this.sql).all(...(this.args as never[])) as T[];
    return { results };
  }
  async run() {
    this.db.prepare(this.sql).run(...(this.args as never[]));
    return { success: true as const };
  }
}

export class D1 {
  private db = new DatabaseSync(":memory:");
  prepare(sql: string) {
    return new Stmt(this.db, sql);
  }
  exec(sql: string) {
    this.db.exec(sql);
  }
}
