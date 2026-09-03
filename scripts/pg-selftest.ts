/**
 * Postgres groundwork self-test (AWS migration stage 2).
 *
 *     DATABASE_URL=postgres://... npx tsx scripts/pg-selftest.ts
 *
 * Deliberately NOT part of scripts/api-test.ts: the API suite must stay
 * runnable with no database server, and it still is. This one exercises the
 * pieces stage 3 will lean on — the DDL applies, the placeholder rewrite is
 * correct, camelCase survives a round trip, lastInsertRowid works, and
 * transactions roll back — so stage 3 starts from verified ground instead of
 * code that has only ever been typechecked.
 *
 * With no DATABASE_URL it exits 0 with a skip notice, so it is safe to wire
 * into CI before staging exists.
 */

import { q, tx, applySchema, closePool, getPool, translate, recase, withAdvisoryLock } from '../server/pgdb.js';
import { TABLES, IDENTITY_TABLES, COLUMN_CASE, PG_SCHEMA } from '../server/pgschema.js';

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; return; }
  failures.push(`${name}${detail ? ' — ' + detail : ''}`);
  console.error(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

/* ---------------- offline checks (no database needed) ---------------- */

function offlineChecks(): void {
  console.log('schema + translation (no database)');

  // Every table in the DDL is listed in TABLES, and vice versa.
  const ddlTables = [...PG_SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)\(/g)].map(m => m[1]);
  const inDdlNotList = ddlTables.filter(t => !TABLES.includes(t));
  const inListNotDdl = TABLES.filter(t => !ddlTables.includes(t));
  eq('TABLES covers every CREATE TABLE', inDdlNotList, []);
  eq('TABLES has no phantom entries', inListNotDdl, []);
  check('no duplicate table names', new Set(ddlTables).size === ddlTables.length);

  // Identity detection.
  check('identity tables detected', IDENTITY_TABLES.has('notes') && IDENTITY_TABLES.has('fee_rates'));
  check('non-identity tables excluded', !IDENTITY_TABLES.has('patients') && !IDENTITY_TABLES.has('counters'));

  // Column case map.
  eq('COLUMN_CASE maps patientid', COLUMN_CASE.get('patientid'), 'patientId');
  eq('COLUMN_CASE maps pwhash', COLUMN_CASE.get('pwhash'), 'pwHash');
  eq('COLUMN_CASE maps rateagreementsignedat', COLUMN_CASE.get('rateagreementsignedat'), 'rateAgreementSignedAt');
  eq('COLUMN_CASE covers query-only aliases', COLUMN_CASE.get('patientname'), 'patientName');
  eq('COLUMN_CASE leaves lowercase alone', COLUMN_CASE.get('billed'), undefined);

  // No SQLite REAL leaked through: 4-byte float would silently round money.
  eq('no bare REAL columns in the DDL', /\bREAL\b/.test(PG_SCHEMA), false);
  eq('no AUTOINCREMENT left in the DDL', /AUTOINCREMENT/i.test(PG_SCHEMA), false);
  eq("no sqlite datetime('now') left", /datetime\('now'\)/i.test(PG_SCHEMA), false);

  // Placeholder rewriting.
  eq('rewrites ? to $n', translate('SELECT * FROM t WHERE a=? AND b=?'), 'SELECT * FROM t WHERE a=$1 AND b=$2');
  eq('skips ? inside string literals',
    translate("SELECT * FROM t WHERE a=? AND b LIKE '%?%' AND c=?"),
    "SELECT * FROM t WHERE a=$1 AND b LIKE '%?%' AND c=$2");
  eq('skips ? inside double-quoted identifiers',
    translate('SELECT descr as "we?rd", x FROM t WHERE a=?'),
    'SELECT descr as "we?rd", x FROM t WHERE a=$1');
  eq('skips ? inside line comments',
    translate('SELECT 1 -- why?\nWHERE a=?'),
    'SELECT 1 -- why?\nWHERE a=$1');
  eq('handles doubled quote escapes',
    translate("SELECT 'it''s ?' , ? FROM t"),
    "SELECT 'it''s ?' , $1 FROM t");
  eq('INSERT OR IGNORE becomes ON CONFLICT DO NOTHING',
    translate('INSERT OR IGNORE INTO counters(k,v) VALUES(?,?)'),
    'INSERT INTO counters(k,v) VALUES($1,$2) ON CONFLICT DO NOTHING');
  eq('INSERT OR IGNORE keeps ON CONFLICT before RETURNING',
    translate('INSERT OR IGNORE INTO state_minimums(state) VALUES(?) RETURNING id'),
    'INSERT INTO state_minimums(state) VALUES($1) ON CONFLICT DO NOTHING RETURNING id');
  let threw = false;
  try { translate('INSERT OR REPLACE INTO geo_cache(k) VALUES(?)'); } catch { threw = true; }
  check('INSERT OR REPLACE throws rather than guessing', threw);

  // Row recasing.
  eq('recase rewrites keys', recase({ patientid: 'PT-1', billed: 5 }), { patientId: 'PT-1', billed: 5 });
  eq('recase passes unknown keys through', recase({ days: 3, s: 1 }), { days: 3, s: 1 });
}

/* ---------------- live checks (need a database) ---------------- */

async function liveChecks(): Promise<void> {
  console.log('live Postgres');

  await applySchema();
  check('applySchema is idempotent', true);
  await applySchema();

  const present = await getPool().query(
    'SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema()',
  );
  const names = new Set(present.rows.map((r: any) => String(r.table_name)));
  const absent = TABLES.filter(t => !names.has(t));
  eq('every table exists after applySchema', absent, []);

  // Round trip through the helpers, on a real table with awkward column names
  // (`by`, `time`, `text`) and a camelCase FK.
  await q.run("INSERT INTO users(id,name,email,pwHash,role) VALUES(?,?,?,?,?)",
    'u-selftest', 'Self Test', 'selftest@example.com', 'x', 'admin');
  await q.run("INSERT INTO patients(id,name,caseType) VALUES(?,?,?)", 'PT-selftest', 'Test Patient', 'trilogy');

  const ins = await q.run('INSERT INTO notes(patientId,text,by,time,sys,kind) VALUES(?,?,?,?,?,?)',
    'PT-selftest', 'hello', 'tester', '09/03/2026, 1:00 PM MST', 1, 'sys');
  eq('run reports changes', ins.changes, 1);
  check('run reports lastInsertRowid on identity tables', ins.lastInsertRowid > 0, `got ${ins.lastInsertRowid}`);

  const note = await q.get<any>('SELECT * FROM notes WHERE patientId=?', 'PT-selftest');
  eq('camelCase key survives the round trip', note?.patientId, 'PT-selftest');
  eq('reserved-ish column `by` reads back', note?.by, 'tester');
  eq('reserved-ish column `time` reads back', note?.time, '09/03/2026, 1:00 PM MST');
  eq('reserved-ish column `text` reads back', note?.text, 'hello');

  const all = await q.all<any>('SELECT * FROM notes WHERE patientId=? ORDER BY id DESC', 'PT-selftest');
  eq('all returns rows', all.length, 1);

  // COUNT(*) must be a number, not the int8 string node-postgres defaults to.
  const c = await q.get<any>('SELECT COUNT(*) AS n FROM notes WHERE patientId=?', 'PT-selftest');
  check('COUNT(*) parses as a number', typeof c?.n === 'number', `got ${typeof c?.n}`);

  // DOUBLE PRECISION keeps cents exactly; PG REAL (float4) would not.
  await q.run('INSERT INTO receipts(patientId,date,ref,amount) VALUES(?,?,?,?)',
    'PT-selftest', '2026-09-03', 'R-1', 12345.67);
  const r = await q.get<any>('SELECT amount FROM receipts WHERE patientId=?', 'PT-selftest');
  eq('money survives without float4 rounding', r?.amount, 12345.67);

  // Quoted aliases behave the way fullPatient() relies on.
  await q.run('INSERT INTO outside_bills(patientId,descr,amt) VALUES(?,?,?)', 'PT-selftest', 'MRI', 900.5);
  const ob = await q.get<any>('SELECT id, descr as "desc", amt FROM outside_bills WHERE patientId=?', 'PT-selftest');
  eq('quoted `desc` alias preserved', ob?.desc, 'MRI');

  // Query-only camelCase alias, unquoted — the COLUMN_CASE extras path.
  const aliased = await q.get<any>(
    'SELECT n.id, p.name AS patientName FROM notes n JOIN patients p ON p.id=n.patientId WHERE n.patientId=?',
    'PT-selftest');
  eq('unquoted camelCase alias recased', aliased?.patientName, 'Test Patient');

  // Transactions.
  const before = await q.get<any>('SELECT COUNT(*) AS n FROM notes');
  try {
    await tx(async cx => {
      await cx.run('INSERT INTO notes(patientId,text,by,time) VALUES(?,?,?,?)', 'PT-selftest', 'rollback me', 't', 'now');
      throw new Error('deliberate');
    });
  } catch { /* expected */ }
  const after = await q.get<any>('SELECT COUNT(*) AS n FROM notes');
  eq('transaction rolls back on throw', after?.n, before?.n);

  await tx(async cx => {
    await cx.run('INSERT INTO notes(patientId,text,by,time) VALUES(?,?,?,?)', 'PT-selftest', 'commit me', 't', 'now');
  });
  const after2 = await q.get<any>('SELECT COUNT(*) AS n FROM notes');
  eq('transaction commits on return', after2?.n, before!.n + 1);

  // FK cascade behaves as it does in SQLite (PG enforces FKs unconditionally).
  await q.run('DELETE FROM patients WHERE id=?', 'PT-selftest');
  const orphans = await q.get<any>('SELECT COUNT(*) AS n FROM notes WHERE patientId=?', 'PT-selftest');
  eq('ON DELETE CASCADE removes child rows', orphans?.n, 0);

  // CHECK constraints carried across.
  let rejected = false;
  try { await q.run("INSERT INTO users(id,name,email,pwHash,role) VALUES(?,?,?,?,?)", 'u-bad', 'B', 'b@x.com', 'x', 'wizard'); }
  catch { rejected = true; }
  check('role CHECK constraint rejects unknown roles', rejected);

  // INSERT OR IGNORE into an identity table — the db.ts:199 seed pattern.
  // run() appends RETURNING id, translate() must slot ON CONFLICT before it.
  const ig1 = await q.run('INSERT OR IGNORE INTO state_minimums(state,coverageType,amount,note) VALUES(?,?,?,?)',
    'Selftest', 'PIP', 15000, 'selftest');
  check('INSERT OR IGNORE on identity table inserts', ig1.changes === 1 && ig1.lastInsertRowid > 0,
    `got changes=${ig1.changes}, id=${ig1.lastInsertRowid}`);
  const ig2 = await q.run('INSERT OR IGNORE INTO state_minimums(state,coverageType,amount,note) VALUES(?,?,?,?)',
    'Selftest', 'PIP', 99999, 'conflict');
  check('INSERT OR IGNORE on identity table ignores conflicts', ig2.changes === 0 && ig2.lastInsertRowid === 0,
    `got changes=${ig2.changes}, id=${ig2.lastInsertRowid}`);
  await q.run('DELETE FROM state_minimums WHERE state=?', 'Selftest');

  // Stage 4 groundwork.
  const locked = await withAdvisoryLock(918273, async () => 'ran');
  eq('advisory lock runs its callback', locked, 'ran');

  await q.run('DELETE FROM users WHERE id=?', 'u-selftest');
}

/* ---------------- run ---------------- */

async function main(): Promise<void> {
  offlineChecks();

  if (!process.env.DATABASE_URL) {
    console.log('\nDATABASE_URL not set — live Postgres checks skipped.');
  } else {
    try {
      await liveChecks();
    } finally {
      await closePool();
    }
  }

  console.log('');
  if (failures.length) {
    console.error(`${passed} passed, ${failures.length} FAILED`);
    process.exit(1);
  }
  console.log(`${passed} assertions passed.`);
}

main().catch(err => { console.error('self-test aborted:', err); process.exit(1); });
