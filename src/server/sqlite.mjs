// Один интерфейс SQL-запросов для локальной SQLite и облачной D1.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export function createSqliteDatabase(filename, { initialize = true, schemaPath } = {}) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const connection = new DatabaseSync(filename);
  connection.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (filename !== ':memory:') connection.exec('PRAGMA journal_mode = WAL;');
  if (initialize && connection.prepare('PRAGMA user_version').get().user_version === 0) {
    const schema = readFileSync(schemaPath || fileURLToPath(new URL('../../db/schema.sql', import.meta.url)), 'utf8');
    connection.exec('BEGIN IMMEDIATE');
    try {
      connection.exec(schema); connection.exec('PRAGMA user_version = 1'); connection.exec('COMMIT');
    } catch (error) { connection.exec('ROLLBACK'); connection.close(); throw error; }
  }
  class Statement {
    constructor(sql, values = []) { this.sql = sql; this.values = values; }
    bind(...values) { return new Statement(this.sql, values); }
    _execute() {
      const statement = connection.prepare(this.sql);
      if (statement.columns().length) {
        const results = statement.all(...this.values).map(row => ({ ...row }));
        const meta = connection.prepare('SELECT changes() AS changes, last_insert_rowid() AS last_row_id').get();
        return { results, success: true, meta: { changes: Number(meta.changes), last_row_id: Number(meta.last_row_id) } };
      }
      const result = statement.run(...this.values);
      return { results: [], success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
    }
    async first(column) { const row = connection.prepare(this.sql).get(...this.values); return row ? column ? row[column] : { ...row } : null; }
    async all() { return this._execute(); }
    async run() { return this._execute(); }
    async raw() { return connection.prepare(this.sql).all(...this.values).map(row => Object.values(row)); }
  }
  return {
    prepare(sql) { return new Statement(sql); },
    async batch(statements) {
      connection.exec('BEGIN IMMEDIATE');
      try { const results = statements.map(statement => statement._execute()); connection.exec('COMMIT'); return results; }
      catch (error) { connection.exec('ROLLBACK'); throw error; }
    },
    async exec(sql) { connection.exec(sql); return { count: 1, duration: 0 }; },
    executeScript(sql) { connection.exec(sql); },
    close() { connection.close(); }
  };
}
