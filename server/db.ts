/**
 * Database access layer.
 * Stage 3: async conversion — helpers now run against pgdb (Postgres) instead of better-sqlite3.
 * better-sqlite3 stays in migrate-to-pg.ts only.
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { q, tx } from './pgdb.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.TRILOGY_DATA_DIR || path.join(__dirname, '..', 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ---------- helpers ---------- */
export const nowMST = () =>
  new Date().toLocaleString('en-US', {
    month: '2-digit', day: '2-digit', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZone: 'America/Denver',
  }) + ' MST';

export async function nextId(kind: 'pt' | 'md' | 'ins'): Promise<string> {
  const prefix = { pt: 'PT-', md: 'MD-', ins: 'INS-' }[kind];
  const row = await q.get<{ v: number }>('SELECT v FROM counters WHERE k=?', kind);
  const v = (row?.v ?? { pt: 10000, md: 2000, ins: 3000 }[kind]) + 1;
  await q.run('INSERT INTO counters(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=?', kind, v, v);
  return prefix + v;
}

export async function addNote(patientId: string, text: string, by: string, sys = true, kind?: string) {
  await q.run('INSERT INTO notes(patientId,text,by,time,sys,kind) VALUES(?,?,?,?,?,?)',
    patientId, text, by, nowMST(), sys ? 1 : 0, kind || (sys ? 'sys' : 'user'));
}

export async function audit(user: { id: string; name: string } | null, action: string, entity?: string, entityId?: string, detail?: string) {
  await q.run('INSERT INTO audit_log(time,userId,userName,action,entity,entityId,detail) VALUES(?,?,?,?,?,?,?)',
    new Date().toISOString(), user?.id ?? null, user?.name ?? 'system', action, entity ?? null, entityId ?? null, detail ?? null);
}

const J = (s: any) => { try { return JSON.parse(s || '[]'); } catch { return []; } };

/* ---------- assemblers (shape matches the validated v1 UI) ---------- */
export async function fullInsurer(id: string) {
  const c = await q.get<any>('SELECT * FROM insurers WHERE id=?', id);
  if (!c) return null;
  c.states = J(c.states); c.rules = J(c.rules);
  c.adjusters = await q.all('SELECT * FROM adjusters WHERE insurerId=?', id);
  // rate deliberately excluded — contract rates are admin-only (fetched via /insurers/:id/contract-rates)
  c.contracts = await q.all('SELECT id,insurerId,name,meta,status,scope,adjusterId FROM ins_contracts WHERE insurerId=?', id);
  return c;
}

export async function fullProvider(id: string) {
  const p = await q.get<any>('SELECT * FROM providers WHERE id=?', id);
  if (!p) return null;
  p.status = J(p.status); p.rules = J(p.rules);
  p.branches = await q.all('SELECT * FROM branches WHERE providerId=?', id);
  p.underContract = !!(p.baaSignedAt && p.rateAgreementSignedAt);
  delete p.contractedRate;   // admin-only — never in the general staff payload
  return p;
}

export async function fullPatient(id: string) {
  const p = await q.get<any>('SELECT * FROM patients WHERE id=?', id);
  if (!p) return null;
  p.uw = {
    status: p.uwStatus, coverage: p.uwCoverage, limit: p.uwLimit,
    riskFlags: p.uwRiskFlags, approvedBy: p.uwApprovedBy,
    outsideBills: await q.all('SELECT id, descr as "desc", amt FROM outside_bills WHERE patientId=?', id),
  };
  p.notes = await q.all('SELECT * FROM notes WHERE patientId=? ORDER BY id DESC', id);
  const tasks = await q.all<any>('SELECT * FROM tasks WHERE patientId=? ORDER BY due IS NULL, due', id);
  p.tasks = await Promise.all(tasks.map(async t => ({
    ...t,
    comments: await q.all('SELECT * FROM task_comments WHERE taskId=? ORDER BY id', t.id)
  })));
  p.provLinks = await q.all('SELECT * FROM prov_links WHERE patientId=?', id);
  const bills = await q.all<any>('SELECT * FROM bills WHERE patientId=? ORDER BY dos', id);
  p.bills = await Promise.all(bills.map(async b => {
    const coveredBy = await q.all<any>('SELECT receiptId FROM receipt_bills WHERE billId=?', b.id);
    const items = await q.all('SELECT * FROM bill_items WHERE billId=?', b.id);
    return { ...b, coveredBy: coveredBy.map(x => x.receiptId), items };
  }));
  const receipts = await q.all<any>('SELECT * FROM receipts WHERE patientId=? ORDER BY date', id);
  p.receipts = await Promise.all(receipts.map(async r => {
    const billIds = await q.all<any>('SELECT billId FROM receipt_bills WHERE receiptId=?', r.id);
    return { ...r, billIds: billIds.map(x => x.billId) };
  }));
  p.sentDocs = await q.all('SELECT id, name, toStr as "to", time, status, method FROM sent_docs WHERE patientId=? ORDER BY id', id);
  p.documents = await q.all('SELECT * FROM documents WHERE patientId=? ORDER BY id DESC', id);
  p.messages = await q.all('SELECT * FROM case_messages WHERE patientId=? ORDER BY id DESC', id);
  p.appointments = await q.all('SELECT * FROM appointments WHERE patientId=? ORDER BY whenAt DESC', id);
  return p;
}

/** Contracted-rate computation for one bill's CPT lines.
 *  revenue = carrier price per CPT (what they pay us) · payout = provider per-CPT rate,
 *  else branch % (timely-filing tier applies) · margin locked regardless of billed. */
export async function computeBillEconomics(insurerId: string | null, providerId: string, branchName: string | null,
  items: Array<{ cpt?: string; units?: number; charge?: number }>, billed: number, dos: string | null) {
  let revenue = 0, payout = 0, revenueMissing: string[] = [], payoutFromPct = false;
  for (const x of items) {
    const u = Number(x.units) || 1;
    if (insurerId && x.cpt) {
      const cr = await q.get<any>('SELECT price FROM carrier_rates WHERE insurerId=? AND cpt=?', insurerId, x.cpt);
      if (cr) revenue += cr.price * u; else revenueMissing.push(x.cpt);
    }
    if (x.cpt) {
      const pr = await q.get<any>('SELECT payout FROM provider_rates WHERE providerId=? AND cpt=?', providerId, x.cpt);
      if (pr) payout += pr.payout * u;
    }
  }
  if (!payout) {
    const branch = await q.get<any>(
      'SELECT * FROM branches WHERE providerId=? AND (name=? OR (SELECT COUNT(*) FROM branches WHERE providerId=?)=1)',
      providerId, branchName || '', providerId
    );
    let pct = branch?.ratePct;
    // Timely-filing tier: submitted 30+ days after DOS → late rate if configured.
    if (branch?.latePct && dos) {
      const days = (Date.now() - new Date(dos + 'T00:00:00').getTime()) / 86400000;
      if (days > 30) pct = branch.latePct;
    }
    if (pct) { payout = Math.round(Math.min(billed * pct / 100, branch.rateCap || Infinity) * 100) / 100; payoutFromPct = true; }
  }
  return { revenue: Math.round(revenue * 100) / 100, payout, revenueMissing, payoutFromPct };
}

export async function recordStage(patientId: string, stage: number) {
  await q.run('INSERT INTO stage_times(patientId,stage,at) VALUES(?,?,?)', patientId, stage, new Date().toISOString());
}

export async function patientSummaries() {
  return await q.all<any>('SELECT id,name,caseType,stage,insurerId,adjusterId,coordinator,phone,email FROM patients');
}

/* ---------- computed stats ---------- */
export async function insAutoStats(insurerId: string) {
  const pts = await q.all<any>('SELECT id, stage FROM patients WHERE insurerId=?', insurerId);
  let received = 0, paidOut = 0;
  for (const p of pts) {
    const r = await q.get<any>("SELECT COALESCE(SUM(amount),0) s FROM receipts WHERE patientId=? AND status='Cleared' AND voided=0", p.id);
    received += r?.s || 0;
    const po = await q.get<any>("SELECT COALESCE(SUM(rate),0) s FROM bills WHERE patientId=? AND status='paid' AND voided=0", p.id);
    paidOut += po?.s || 0;
  }
  const profit = received - paidOut;
  return {
    all: pts.length, act: pts.filter(p => p.stage < 4).length,
    received, paidOut, profit,
    margin: received ? Math.round((profit / received) * 100) : 0,
  };
}

export async function branchStats(providerId: string, branchName: string, branchCount: number) {
  let pts = 0, billed = 0, paid = 0, authSent = 0, billCount = 0, missing = 0;
  const links = await q.all<any>('SELECT * FROM prov_links WHERE providerId=?', providerId);
  for (const l of links) {
    if (branchCount > 1 && l.branch !== branchName) continue;
    pts++; authSent += l.authAmount || 0;
    const bs = await q.all<any>('SELECT * FROM bills WHERE patientId=? AND providerId=? AND voided=0', l.patientId, providerId);
    for (const b of bs) {
      billCount++; billed += b.billed || 0;
      if (b.status === 'paid') paid += b.rate || 0;
      if (!b.hasNote) missing++;
    }
  }
  return { pts, billed, paid, authSent, missNotes: billCount ? Math.round((missing / billCount) * 100) + '%' : '0%' };
}

// Re-export pgdb helpers for use in other modules
export { q, tx } from './pgdb.js';
