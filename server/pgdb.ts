/**
 * Postgres access layer — AWS migration stage 2 (groundwork only).
 *
 * Nothing imports this yet. server/db.ts still owns the live SQLite handle;
 * stage 3 converts the modules over one at a time. The job here is to make
 * that conversion as close to mechanical as possible, so the helpers
 * deliberately imitate better-sqlite3's call shapes:
 *
 *     db.prepare(sql).get(a, b)   ->   await q.get(sql, a, b)
 *     db.prepare(sql).all(a, b)   ->   await q.all(sql, a, b)
 *     db.prepare(sql).run(a, b)   ->   await q.run(sql, a, b)
 *     db.transaction(fn)()        ->   await tx(async c => { ... })
 *
 * Two translations happen automatically so existing SQL text can move across
 * unchanged:
 *
 *  1. `?` placeholders become `$1..$n` (literals and comments are skipped).
 *  2. Result-row keys are mapped back to camelCase. Postgres folds unquoted
 *     identifiers to lowercase, so `SELECT patientId ...` returns `patientid`;
 *     COLUMN_CASE in pgschema.ts maps it back, which keeps every API payload
 *     and the client bundle byte-identical.
 *
 * What is deliberately NOT translated (stage 3 has to hand-fix these — the
 * whole set is small and known):
 *  - `INSERT OR REPLACE` (4 sites: server/seed.ts:45, server/geo.ts:82,88,122)
 *    throws with a pointer rather than guessing an ON CONFLICT target.
 *  - `julianday()` (server/engines.ts:284, server/routes.ts:894).
 *  - `sqlite_master` / `PRAGMA` reads in server/db.ts, which do not carry over
 *    at all — pgschema.ts is the authoritative schema on Postgres.
 */

import fs from 'node:fs';
import pg from 'pg';
import { COLUMN_CASE, IDENTITY_TABLES, PG_SCHEMA } from './pgschema.js';

/* --------------------------------------------------------------------------
 * Type parsing
 * ------------------------------------------------------------------------ */
// int8/COUNT(*) arrives as a string by default so 64-bit values survive. The
// app treats every count as a JS number, and no counter here goes near 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, (v: string) => parseInt(v, 10));

/* --------------------------------------------------------------------------
 * Pool
 * ------------------------------------------------------------------------ */
let pool: pg.Pool | null = null;

function sslConfig(): pg.PoolConfig['ssl'] {
  const url = process.env.DATABASE_URL || '';
  const wants = /[?&]sslmode=(require|verify-ca|verify-full)/.test(url) || process.env.PGSSL === '1';
  if (!wants) return undefined;
  // RDS: point PGSSLROOTCERT at the AWS bundle for real verification. Without
  // it we still encrypt, but can't verify the peer — fine inside the VPC,
  // and stage 5 sets the cert path in the task definition.
  const ca = process.env.PGSSLROOTCERT;
  if (ca) return { ca: fs.readFileSync(ca, 'utf8'), rejectUnauthorized: true };
  return { rejectUnauthorized: false };
}

/** Lazily created so importing this module never opens a connection. */
export function getPool(): pg.Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set — pgdb cannot connect.');
  pool = new pg.Pool({
    connectionString,
    ssl: sslConfig(),
    max: Number(process.env.PGPOOL_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'trilogy-arc',
  });
  // An idle client erroring out must not take the process down.
  pool.on('error', err => console.error('[pgdb] idle client error:', err.message));
  return pool;
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end();
}

/* --------------------------------------------------------------------------
 * SQL translation
 * ------------------------------------------------------------------------ */

/**
 * Rewrite better-sqlite3 `?` placeholders as `$1..$n`, skipping anything inside
 * single- or double-quoted strings, `--` line comments, and block comments, so
 * a literal question mark in the SQL text is never renumbered.
 */
export function toPgPlaceholders(sql: string): string {
  let out = '';
  let n = 0;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) { j += 2; continue; }  // '' / "" escape
          break;
        }
        j++;
      }
      out += sql.slice(i, Math.min(j + 1, sql.length));
      i = j + 1;
    } else if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      out += sql.slice(i, stop);
      i = stop;
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += sql.slice(i, stop);
      i = stop;
    } else if (c === '?') {
      out += '$' + (++n);
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const INSERT_TABLE = /^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+"?(\w+)"?/i;

/** SQLite-only INSERT forms. IGNORE is mechanical; REPLACE is not. */
function translateInsert(sql: string): string {
  if (/^\s*INSERT\s+OR\s+REPLACE\s+INTO/i.test(sql)) {
    throw new Error(
      'pgdb: `INSERT OR REPLACE` has no safe generic Postgres equivalent — it ' +
      'replaces on ANY unique constraint. Write an explicit ' +
      '`INSERT ... ON CONFLICT (<key>) DO UPDATE SET ...` for this statement. ' +
      `SQL: ${sql.slice(0, 120)}`,
    );
  }
  if (/^\s*INSERT\s+OR\s+IGNORE\s+INTO/i.test(sql)) {
    const base = sql.replace(/^(\s*)INSERT\s+OR\s+IGNORE\s+INTO/i, '$1INSERT INTO');
    // ON CONFLICT must precede RETURNING (run() appends `RETURNING id` for
    // identity tables BEFORE translation). On conflict, RETURNING yields no
    // row, so lastInsertRowid is 0 and changes is 0 — matching better-sqlite3.
    const ret = /\bRETURNING\b/i.exec(base);
    if (ret) return `${base.slice(0, ret.index)}ON CONFLICT DO NOTHING ${base.slice(ret.index)}`;
    return base + ' ON CONFLICT DO NOTHING';
  }
  return sql;
}

/** The full text rewrite applied to every statement. Exported for tests. */
export function translate(sql: string): string {
  return toPgPlaceholders(translateInsert(sql));
}

/* --------------------------------------------------------------------------
 * Result shaping
 * ------------------------------------------------------------------------ */

/**
 * Map lowercased Postgres column names back to the camelCase the app uses.
 * Keys not in the map (aliases like `s`, `days`, already-lowercase columns)
 * pass through untouched.
 */
export function recase<T extends Record<string, any>>(row: T): T {
  let changed = false;
  for (const k in row) {
    const camel = COLUMN_CASE.get(k);
    if (camel && camel !== k) { changed = true; break; }
  }
  if (!changed) return row;
  const out: Record<string, any> = {};
  for (const k in row) out[COLUMN_CASE.get(k) ?? k] = row[k];
  return out as T;
}

export interface RunResult {
  /** Rows affected — better-sqlite3's `changes`. */
  changes: number;
  /** Generated id for inserts into identity tables, else 0. */
  lastInsertRowid: number;
}

type Queryable = Pick<pg.PoolClient, 'query'>;

async function exec(client: Queryable | null, sql: string, params: any[]): Promise<pg.QueryResult<any>> {
  const runner: Queryable = client ?? getPool();
  return runner.query(translate(sql), params);
}

/* --------------------------------------------------------------------------
 * Query helpers
 * ------------------------------------------------------------------------ */

function makeQ(client: Queryable | null) {
  return {
    /** First row, or undefined. Mirrors `db.prepare(sql).get(...)`. */
    async get<T = any>(sql: string, ...params: any[]): Promise<T | undefined> {
      const r = await exec(client, sql, params);
      return r.rows.length ? (recase(r.rows[0]) as T) : undefined;
    },

    /** All rows. Mirrors `db.prepare(sql).all(...)`. */
    async all<T = any>(sql: string, ...params: any[]): Promise<T[]> {
      const r = await exec(client, sql, params);
      return r.rows.map(recase) as T[];
    },

    /**
     * Mirrors `db.prepare(sql).run(...)`. For an INSERT into a table whose id
     * is GENERATED ALWAYS AS IDENTITY, `RETURNING id` is appended so
     * `lastInsertRowid` behaves the way the 14 existing call sites expect.
     */
    async run(sql: string, ...params: any[]): Promise<RunResult> {
      const table = INSERT_TABLE.exec(sql)?.[1]?.toLowerCase();
      const wantsId = !!table && IDENTITY_TABLES.has(table) && !/\bRETURNING\b/i.test(sql);
      const r = await exec(client, wantsId ? `${sql.replace(/;\s*$/, '')} RETURNING id` : sql, params);
      const id = wantsId && r.rows.length ? Number(r.rows[0].id) : 0;
      return { changes: r.rowCount ?? 0, lastInsertRowid: id };
    },

    /** Statements with no result — DDL, SET, etc. */
    async exec(sql: string): Promise<void> {
      await (client ?? getPool()).query(sql);
    },
  };
}

/** Pool-backed helpers. Each call takes and returns a connection. */
export const q = makeQ(null);

export type Q = ReturnType<typeof makeQ>;

/**
 * Run `fn` inside a single transaction on one pinned connection, committing on
 * return and rolling back on throw. The `c` handed to `fn` has the same
 * get/all/run/exec surface as `q`; use it for every statement inside, or the
 * statement runs on a different connection and outside the transaction.
 *
 *     await tx(async c => {
 *       const { lastInsertRowid } = await c.run('INSERT INTO receipts(...) VALUES(?,?)', a, b);
 *       await c.run('INSERT INTO receipt_bills(receiptId,billId) VALUES(?,?)', lastInsertRowid, billId);
 *     });
 */
export async function tx<T>(fn: (c: Q) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(makeQ(client));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    throw err;
  } finally {
    client.release();
  }
}

/** Advisory-lock helper for stage 4: only one node runs the scheduler tick. */
export async function withAdvisoryLock<T>(key: number, fn: () => Promise<T>): Promise<T | null> {
  const client = await getPool().connect();
  try {
    const got = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [key]);
    if (!got.rows[0]?.ok) return null;
    try { return await fn(); } finally { await client.query('SELECT pg_advisory_unlock($1)', [key]); }
  } finally {
    client.release();
  }
}

/** Create the schema if it isn't there. Idempotent. */
export async function applySchema(): Promise<void> {
  await getPool().query(PG_SCHEMA);
}

/** Cheap liveness probe for /api/health and the ECS container check. */
export async function ping(): Promise<boolean> {
  try { await getPool().query('SELECT 1'); return true; } catch { return false; }
}
