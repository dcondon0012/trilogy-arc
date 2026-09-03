/**
 * SQLite -> Postgres data migration (AWS migration stage 2).
 *
 *     DATABASE_URL=postgres://... npx tsx scripts/migrate-to-pg.ts [--dry-run] [--truncate]
 *
 * Cutover decision (recorded 09/03/2026): a HARD SWITCH, not dual-write. The
 * app writes to exactly one database at a time. At the cutover minute we take
 * a short write freeze (~10 min per stage 6), run this script once against the
 * quiesced SQLite file, verify, and point the app at Postgres. Dual-write was
 * rejected: it doubles every write path in stage 3, and reconciling divergence
 * between two live stores is strictly harder than a ten-minute freeze on a
 * platform with no signed carriers and no live claim traffic yet.
 *
 * What it does
 *   1. Creates the schema (pgschema.ts) if absent.
 *   2. Copies every table in TABLES order, so foreign keys are satisfied as it
 *      goes. Identity ids are carried across verbatim with OVERRIDING SYSTEM
 *      VALUE, then each identity sequence is restarted past the highest id.
 *   3. Verifies: row count per table, plus a content checksum computed the same
 *      way on both sides — an order-independent sum of per-row MD5s over
 *      canonically normalised values. Any drift fails the run loudly.
 *
 * better-sqlite3 appears here and nowhere else after stage 3. This script is
 * the only remaining reader of the old database.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { getPool, closePool, applySchema } from '../server/pgdb.js';
import { TABLES, IDENTITY_TABLES } from '../server/pgschema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DRY_RUN = process.argv.includes('--dry-run');
const TRUNCATE = process.argv.includes('--truncate');
const CHUNK = 500;

const DATA_DIR = process.env.TRILOGY_DATA_DIR || path.join(__dirname, '..', 'data');
const SQLITE_PATH = process.env.SQLITE_PATH || path.join(DATA_DIR, 'trilogy.db');

/* -------------------------------------------------------------------------
 * Canonical row hashing — must produce identical bytes for the same logical
 * row whichever driver read it.
 * ----------------------------------------------------------------------- */

function normValue(v: unknown): string {
  if (v === null || v === undefined) return '\u0000null';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return 'num:' + String(v);
    // Both drivers hand back IEEE doubles for these columns; toPrecision(15)
    // absorbs the last-bit formatting differences without hiding real drift.
    return 'num:' + (Number.isInteger(v) ? v.toFixed(0) : Number(v).toPrecision(15));
  }
  if (typeof v === 'bigint') return 'num:' + v.toString();
  if (typeof v === 'boolean') return 'num:' + (v ? '1' : '0');
  if (v instanceof Date) return 'str:' + v.toISOString();
  if (Buffer.isBuffer(v)) return 'buf:' + v.toString('base64');
  return 'str:' + String(v);
}

/** Order-independent, duplicate-sensitive digest over a set of rows. */
class RowDigest {
  private sum = 0n;
  private static readonly MOD = 1n << 128n;
  count = 0;

  add(row: Record<string, unknown>, columns: readonly string[]): void {
    const h = crypto.createHash('md5');
    for (const c of columns) { h.update(c); h.update('\u0001'); h.update(normValue(row[c])); h.update('\u0002'); }
    this.sum = (this.sum + BigInt('0x' + h.digest('hex'))) % RowDigest.MOD;
    this.count++;
  }

  get hex(): string { return this.sum.toString(16).padStart(32, '0'); }
}

/* -------------------------------------------------------------------------
 * Main
 * ----------------------------------------------------------------------- */

interface TableReport {
  table: string;
  sqliteRows: number;
  pgRows: number;
  sqliteHash: string;
  pgHash: string;
  ok: boolean;
  skipped?: string;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Example:\n' +
      '  DATABASE_URL=postgres://user:pw@host:5432/trilogy npx tsx scripts/migrate-to-pg.ts');
    process.exit(2);
  }
  if (!fs.existsSync(SQLITE_PATH)) {
    console.error(`No SQLite database at ${SQLITE_PATH}. Set SQLITE_PATH or TRILOGY_DATA_DIR.`);
    process.exit(2);
  }

  console.log(`source  ${SQLITE_PATH}`);
  console.log(`target  ${String(process.env.DATABASE_URL).replace(/:[^:@/]+@/, ':***@')}`);
  if (DRY_RUN) console.log('mode    DRY RUN — reads and verifies, writes nothing');

  const sqlite = new Database(SQLITE_PATH, { readonly: true });
  const pool = getPool();

  if (!DRY_RUN) {
    await applySchema();
    console.log('schema  applied (idempotent)');
  }

  // Which tables actually exist on each side. The SQLite file predates several
  // tables in older backups, and a fresh Postgres has them all but empty.
  const sqliteTables = new Set(
    (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
      .map(r => r.name),
  );

  if (TRUNCATE && !DRY_RUN) {
    const present = TABLES.filter(t => t !== 'sqlite_sequence');
    await pool.query(`TRUNCATE TABLE ${present.join(', ')} RESTART IDENTITY CASCADE`);
    console.log(`truncated ${present.length} target tables`);
  }

  const reports: TableReport[] = [];

  for (const table of TABLES) {
    if (!sqliteTables.has(table)) {
      reports.push({ table, sqliteRows: 0, pgRows: 0, sqliteHash: '-', pgHash: '-', ok: true, skipped: 'absent in source' });
      continue;
    }

    // Column intersection: source columns that the Postgres schema also has.
    // A column present only in SQLite means pgschema.ts has drifted behind
    // db.ts — that is a hard error, not something to quietly drop.
    const srcCols = (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name);
    const pgColsRes = await pool.query(
      'SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1',
      [table],
    );
    const pgCols = new Set<string>(pgColsRes.rows.map((r: any) => String(r.column_name)));
    if (!pgCols.size) {
      if (DRY_RUN) {
        reports.push({ table, sqliteRows: 0, pgRows: 0, sqliteHash: '-', pgHash: '-', ok: true, skipped: 'target table not created yet' });
        continue;
      }
      throw new Error(`Table ${table} is missing from the target after applySchema() — check PG_SCHEMA/TABLES agreement.`);
    }
    const missing = srcCols.filter(c => !pgCols.has(c.toLowerCase()));
    if (missing.length) {
      throw new Error(
        `Table ${table}: column(s) [${missing.join(', ')}] exist in SQLite but not in ` +
        'server/pgschema.ts. Add them to PG_SCHEMA before migrating — dropping ' +
        'columns silently would lose data.',
      );
    }

    const cols = srcCols;
    const identity = IDENTITY_TABLES.has(table);
    const colList = cols.map(c => c.toLowerCase()).join(',');
    const overriding = identity && cols.some(c => c.toLowerCase() === 'id') ? ' OVERRIDING SYSTEM VALUE' : '';

    // ---- copy ----
    const srcDigest = new RowDigest();
    let batch: any[][] = [];
    const flush = async () => {
      if (!batch.length || DRY_RUN) { batch = []; return; }
      const values: any[] = [];
      const tuples = batch.map((row, r) => {
        const ph = row.map((_, c) => `$${r * cols.length + c + 1}`);
        values.push(...row);
        return `(${ph.join(',')})`;
      });
      await pool.query(`INSERT INTO ${table}(${colList})${overriding} VALUES ${tuples.join(',')}`, values);
      batch = [];
    };

    for (const row of sqlite.prepare(`SELECT * FROM ${table}`).iterate() as Iterable<Record<string, unknown>>) {
      srcDigest.add(row, cols);
      batch.push(cols.map(c => row[c] ?? null));
      if (batch.length >= CHUNK) await flush();
    }
    await flush();

    // ---- reset the identity sequence past the copied ids ----
    if (identity && !DRY_RUN) {
      await pool.query(
        `SELECT setval(pg_get_serial_sequence($1,'id'), COALESCE((SELECT MAX(id) FROM ${table}), 0) + 1, false)`,
        [table],
      );
    }

    // ---- verify: read back from Postgres and hash the same way ----
    const dstDigest = new RowDigest();
    const readBack = await pool.query(`SELECT ${colList} FROM ${table}`);
    const lowerToSrc = new Map(cols.map(c => [c.toLowerCase(), c]));
    for (const r of readBack.rows) {
      const row: Record<string, unknown> = {};
      for (const k in r) row[lowerToSrc.get(k) ?? k] = r[k];
      dstDigest.add(row, cols);
    }

    const ok = DRY_RUN
      ? true
      : srcDigest.count === dstDigest.count && srcDigest.hex === dstDigest.hex;

    reports.push({
      table,
      sqliteRows: srcDigest.count,
      pgRows: dstDigest.count,
      sqliteHash: srcDigest.hex.slice(0, 12),
      pgHash: dstDigest.hex.slice(0, 12),
      ok,
    });
  }

  sqlite.close();
  await closePool();

  // ---- report ----
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log('');
  console.log(`${pad('table', 18)}${pad('sqlite', 9)}${pad('pg', 9)}${pad('checksum', 30)}status`);
  console.log('-'.repeat(72));
  let failures = 0;
  for (const r of reports) {
    if (r.skipped) {
      console.log(`${pad(r.table, 18)}${pad('-', 9)}${pad('-', 9)}${pad('-', 30)}skipped (${r.skipped})`);
      continue;
    }
    if (!r.ok) failures++;
    const match = r.sqliteHash === r.pgHash ? r.sqliteHash : `${r.sqliteHash}!=${r.pgHash}`;
    console.log(`${pad(r.table, 18)}${pad(String(r.sqliteRows), 9)}${pad(String(r.pgRows), 9)}${pad(match, 30)}${r.ok ? 'ok' : 'MISMATCH'}`);
  }
  const totalRows = reports.reduce((s, r) => s + r.sqliteRows, 0);
  console.log('-'.repeat(72));
  console.log(`${reports.filter(r => !r.skipped).length} tables · ${totalRows} rows · ${failures} mismatch(es)`);

  if (failures) {
    console.error('\nMigration FAILED verification. The target is not safe to cut over to.');
    process.exit(1);
  }
  console.log(DRY_RUN ? '\nDry run complete — nothing written.' : '\nMigration verified.');
}

main().catch(err => {
  console.error('\nMigration aborted:', err instanceof Error ? err.message : err);
  process.exit(1);
});
