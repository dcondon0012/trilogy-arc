import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  db, nowMST, nextId, addNote, audit,
  fullPatient, fullProvider, fullInsurer, patientSummaries,
  insAutoStats, branchStats, UPLOAD_DIR, recordStage, computeBillEconomics,
} from './db.js';
import { requireAuth, requireAdmin, requireStaff } from './auth.js';
import {
  billChecks, duplicateBillIds, envelope, rankProviders, caseHealth, stripExtras,
  driftReport, carrierTier, providerScore, carrierReport, outboundDrafts, normFor,
} from './engines.js';

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, _file, cb) => cb(null, crypto.randomUUID()),
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const fmtDate = (iso?: string | null) => {
  if (!iso) return '—';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : String(iso);
};
const fmt$ = (n: number) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const api = Router();
api.use(requireAuth);
api.use(requireStaff); // portal users (provider/carrier) use /api/portal — never this router

/* ================= bootstrap & search ================= */
api.get('/bootstrap', (req, res) => {
  res.json({
    user: req.user,
    users: db.prepare('SELECT id,name,email,role FROM users').all(),
    patients: patientSummaries(),
    providers: (db.prepare('SELECT id FROM providers').all() as any[]).map(r => fullProvider(r.id)),
    insurers: (db.prepare('SELECT id FROM insurers').all() as any[]).map(r => fullInsurer(r.id)),
    prefs: db.prepare('SELECT key,color,size FROM widget_prefs WHERE userId=?').all(req.user!.id),
  });
});

/* ================= intake queue (the communication hub) ================= */
api.get('/intake', (_req, res) => {
  const items = db.prepare(`SELECT i.*, p.name AS patientName, pr.name AS providerName
    FROM intake_items i LEFT JOIN patients p ON p.id=i.patientId LEFT JOIN providers pr ON pr.id=i.providerId
    ORDER BY CASE i.status WHEN 'triage' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END, i.id DESC LIMIT 300`).all();
  const counts = db.prepare(`SELECT status, COUNT(*) c FROM intake_items GROUP BY status`).all();
  res.json({ items, counts });
});

api.post('/intake/simulate-inbound', requireAdmin, upload.single('file'), (req, res) => {
  // Testing stand-in for the SES (email) and Faxage (fax) webhooks below.
  if (!req.file) return res.status(400).json({ error: 'Attach a file' });
  const fid = req.file.filename;
  db.prepare('INSERT INTO files(id,name,mime,size,uploadedBy,time) VALUES(?,?,?,?,?,?)')
    .run(fid, req.file.originalname, req.file.mimetype, req.file.size, 'inbound', nowMST());
  db.prepare(`INSERT INTO intake_items(channel,kind,status,fileId,fileName,fromInfo,note,receivedAt)
    VALUES(?,?,'triage',?,?,?,?,?)`)
    .run(req.body?.channel === 'fax' ? 'fax' : 'email', 'bill', fid, req.file.originalname,
      req.body?.fromInfo || 'simulated@example.com', req.body?.note || '(simulated inbound)', nowMST());
  audit(req.user!, 'intake.simulate', undefined, undefined, req.file.originalname);
  res.json({ ok: true });
});

api.post('/intake/:iid/assign', (req, res) => {
  const it = db.prepare('SELECT * FROM intake_items WHERE id=?').get(req.params.iid) as any;
  if (!it) return res.status(404).json({ error: 'Not found' });
  const { patientId, providerId } = req.body || {};
  if (patientId && !db.prepare('SELECT 1 FROM patients WHERE id=?').get(patientId)) return res.status(400).json({ error: 'Unknown patient' });
  if (providerId && !db.prepare('SELECT 1 FROM providers WHERE id=?').get(providerId)) return res.status(400).json({ error: 'Unknown provider' });
  db.prepare("UPDATE intake_items SET patientId=?, providerId=?, status='queued' WHERE id=?")
    .run(patientId || it.patientId, providerId || it.providerId, it.id);
  if (patientId) addNote(patientId, `Inbound ${it.channel} document assigned to this case: "${it.fileName}"`, req.user!.name);
  audit(req.user!, 'intake.assign', 'intake', String(it.id));
  res.json({ ok: true });
});

api.post('/intake/:iid/parse', (req, res) => {
  const it = db.prepare('SELECT * FROM intake_items WHERE id=?').get(req.params.iid) as any;
  if (!it) return res.status(404).json({ error: 'Not found' });
  // v1 STUB — at deployment this calls Textract + Bedrock (Claude) on the PDF in S3.
  // Returns a skeleton the coordinator corrects in the review UI; structure matches the real parser's output.
  const parsed = {
    engine: 'stub-v1 (Textract+Bedrock at deployment)',
    confidence: 'low',
    dos: null, total: null,
    lines: [{ cpt: '', icd: '', units: 1, charge: 0 }],
    notes: 'Stub parse — enter values from the PDF. The deployed parser pre-fills these fields.',
  };
  db.prepare('UPDATE intake_items SET parsed=? WHERE id=?').run(JSON.stringify(parsed), it.id);
  audit(req.user!, 'intake.parse', 'intake', String(it.id));
  res.json(parsed);
});

api.post('/intake/:iid/process', (req, res) => {
  const it = db.prepare('SELECT * FROM intake_items WHERE id=?').get(req.params.iid) as any;
  if (!it) return res.status(404).json({ error: 'Not found' });
  if (it.status === 'processed') return res.status(400).json({ error: 'Already processed' });
  const v = req.body || {};
  const patientId = v.patientId || it.patientId;
  const providerId = v.providerId || it.providerId;
  if (it.kind === 'referral') {
    db.prepare("UPDATE intake_items SET status='processed', processedBy=? WHERE id=?").run(req.user!.name, it.id);
    if (it.patientId) addNote(it.patientId, 'Referral reviewed — intake accepted', req.user!.name);
    audit(req.user!, 'intake.referralReviewed', 'patient', it.patientId || undefined);
    return res.json({ ok: true });
  }
  if (it.kind === 'bill') {
    if (!patientId || !providerId) return res.status(400).json({ error: 'Assign patient and provider first' });
    const link = db.prepare('SELECT * FROM prov_links WHERE patientId=? AND providerId=?').get(patientId, providerId) as any;
    if (!link) return res.status(400).json({ error: 'Provider is not linked to this patient yet' });
    const items: any[] = Array.isArray(v.items) ? v.items.filter((x: any) => x.cpt || x.charge) : [];
    const billed = Number(v.billed) || items.reduce((s, x) => s + (Number(x.charge) || 0) * (Number(x.units) || 1), 0);
    if (!(billed > 0)) return res.status(400).json({ error: 'Billed amount (or line items) required' });
    let rate = Number(v.rate) || 0;
    if (!rate) {
      const branch = db.prepare('SELECT * FROM branches WHERE providerId=? AND (name=? OR (SELECT COUNT(*) FROM branches WHERE providerId=?)=1)')
        .get(providerId, link.branch || '', providerId) as any;
      if (branch?.ratePct) rate = Math.round(Math.min(billed * branch.ratePct / 100, branch.rateCap || Infinity) * 100) / 100;
    }
    const bid = 'b' + Date.now() + Math.floor(Math.random() * 1000);
    db.prepare(`INSERT INTO bills(id,patientId,providerId,dos,billed,rate,hasBill,billFileId,billFileName)
      VALUES(?,?,?,?,?,?,1,?,?)`).run(bid, patientId, providerId, v.dos || null, billed, rate, it.fileId, it.fileName);
    for (const x of items)
      db.prepare('INSERT INTO bill_items(billId,cpt,icd,units,charge,modifier) VALUES(?,?,?,?,?,?)')
        .run(bid, x.cpt || null, x.icd || null, Number(x.units) || 1, Number(x.charge) || 0, x.modifier || null);
    db.prepare('UPDATE prov_links SET billed=billed+? WHERE patientId=? AND providerId=?').run(billed, patientId, providerId);
    // Fee-schedule check
    const state = (db.prepare('SELECT state FROM patients WHERE id=?').get(patientId) as any)?.state;
    const flags: string[] = [];
    if (state) for (const x of items) {
      const fs = db.prepare('SELECT allowed FROM fee_schedules WHERE state=? AND cpt=?').get(state, x.cpt) as any;
      if (fs && Number(x.charge) > fs.allowed) flags.push(`${x.cpt} billed ${fmt$(Number(x.charge))} vs ${state} allowed ${fmt$(fs.allowed)}`);
    }
    db.prepare("UPDATE intake_items SET status='processed', patientId=?, providerId=?, processedBy=? WHERE id=?")
      .run(patientId, providerId, req.user!.name, it.id);
    addNote(patientId, `Bill processed from ${it.channel} intake: DOS ${fmtDate(v.dos)} · ${fmt$(billed)}${items.length ? ` · ${items.length} CPT line${items.length === 1 ? '' : 's'}` : ''}${flags.length ? ' ⚠ fee schedule: ' + flags.join('; ') : ''}`, req.user!.name);
    audit(req.user!, 'intake.process', 'bill', bid);
    return res.json({ ok: true, billId: bid, feeFlags: flags });
  }
  // records / other → attach as document
  if (!patientId) return res.status(400).json({ error: 'Assign a patient first' });
  db.prepare('INSERT INTO documents(patientId,name,cat,meta,fileId) VALUES(?,?,?,?,?)')
    .run(patientId, it.fileName, 'Medical', nowMST() + ' · via ' + it.channel, it.fileId);
  db.prepare("UPDATE intake_items SET status='processed', patientId=?, processedBy=? WHERE id=?").run(patientId, req.user!.name, it.id);
  addNote(patientId, `Document filed from ${it.channel} intake: "${it.fileName}"`, req.user!.name);
  audit(req.user!, 'intake.process', 'document', String(it.id));
  res.json({ ok: true });
});

api.post('/intake/:iid/reject', (req, res) => {
  const it = db.prepare('SELECT * FROM intake_items WHERE id=?').get(req.params.iid) as any;
  if (!it) return res.status(404).json({ error: 'Not found' });
  const reason = String(req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'Reason required' });
  db.prepare("UPDATE intake_items SET status='rejected', note=COALESCE(note,'')||' · rejected: '||?, processedBy=? WHERE id=?")
    .run(reason, req.user!.name, it.id);
  audit(req.user!, 'intake.reject', 'intake', String(it.id), reason);
  res.json({ ok: true });
});

/* ---- bill denial / appeal tracking ---- */
api.post('/bills/:bid/denial', (req, res) => {
  const b = db.prepare('SELECT * FROM bills WHERE id=?').get(req.params.bid) as any;
  if (!b) return res.status(404).json({ error: 'Not found' });
  const { denied, denialReason, appealStatus } = req.body || {};
  const okStatus = ['none', 'appealing', 'won', 'lost', 'written-off'];
  if (appealStatus && !okStatus.includes(appealStatus)) return res.status(400).json({ error: 'Bad appeal status' });
  if (denied && !String(denialReason || '').trim()) return res.status(400).json({ error: 'Denial reason required' });
  db.prepare('UPDATE bills SET denied=?, denialReason=?, appealStatus=? WHERE id=?')
    .run(denied ? 1 : 0, denialReason || null, appealStatus || (denied ? 'none' : 'none'), b.id);
  addNote(b.patientId, denied
    ? `Bill DENIED by carrier (DOS ${fmtDate(b.dos)}): ${denialReason}${appealStatus && appealStatus !== 'none' ? ' — appeal: ' + appealStatus : ''}`
    : `Denial cleared on DOS ${fmtDate(b.dos)} bill`, req.user!.name);
  audit(req.user!, 'bill.denial', 'bill', b.id, denied ? denialReason : 'cleared');
  res.json(fullPatient(b.patientId));
});

/* ---- contracted rates (carrier prices & provider payouts per CPT) ---- */
api.get('/rates/:kind(carrier|provider)/:id', (req, res) => {
  const t = req.params.kind === 'carrier' ? 'carrier_rates' : 'provider_rates';
  const col = req.params.kind === 'carrier' ? 'insurerId' : 'providerId';
  res.json(db.prepare(`SELECT * FROM ${t} WHERE ${col}=? ORDER BY cpt`).all(req.params.id));
});
api.post('/rates/:kind(carrier|provider)/:id', requireAdmin, (req, res) => {
  // Bulk paste: rows of "CPT amount" (one per line) or array [{cpt, amount}]
  const kind = req.params.kind;
  let rows: Array<{ cpt: string; amount: number }> = [];
  if (Array.isArray(req.body?.rows)) rows = req.body.rows;
  else if (typeof req.body?.paste === 'string')
    rows = req.body.paste.split('\n').map((l: string) => {
      const m = l.trim().match(/^(\S+)[\s,\t]+\$?([\d,.]+)$/);
      return m ? { cpt: m[1], amount: parseFloat(m[2].replace(/,/g, '')) } : null;
    }).filter(Boolean) as any;
  if (!rows.length) return res.status(400).json({ error: 'No valid rows — format: one "CPT amount" per line' });
  const t = kind === 'carrier' ? 'carrier_rates' : 'provider_rates';
  const col = kind === 'carrier' ? 'insurerId' : 'providerId';
  const val = kind === 'carrier' ? 'price' : 'payout';
  const tx = db.transaction(() => {
    for (const r of rows) if (r.cpt && r.amount > 0)
      db.prepare(`INSERT INTO ${t}(${col},cpt,${val}) VALUES(?,?,?) ON CONFLICT(${col},cpt) DO UPDATE SET ${val}=excluded.${val}`)
        .run(req.params.id, String(r.cpt).trim(), r.amount);
  });
  tx();
  audit(req.user!, `rates.${kind}.set`, kind, req.params.id, rows.length + ' rows');
  res.json(db.prepare(`SELECT * FROM ${t} WHERE ${col}=? ORDER BY cpt`).all(req.params.id));
});

/* ---- state minimum coverage (intake auto-populate) ---- */
api.get('/state-minimums', (_req, res) => res.json(db.prepare('SELECT * FROM state_minimums ORDER BY state').all()));
api.post('/admin/state-minimums', requireAdmin, (req, res) => {
  const { state, coverageType, amount, note } = req.body || {};
  if (!state || !coverageType || !(Number(amount) > 0)) return res.status(400).json({ error: 'State, type, amount required' });
  db.prepare('INSERT INTO state_minimums(state,coverageType,amount,note) VALUES(?,?,?,?) ON CONFLICT(state,coverageType) DO UPDATE SET amount=excluded.amount, note=excluded.note')
    .run(state, coverageType, Number(amount), note || null);
  res.json(db.prepare('SELECT * FROM state_minimums ORDER BY state').all());
});

/* ---- batch bill packet (Oregon strategy: send all bills as one) ---- */
api.get('/patients/:id/batch-packet', (req, res) => {
  const p = fullPatient(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const bills = p.bills.filter((b: any) => !b.voided);
  const total = bills.reduce((s: number, b: any) => s + b.billed, 0);
  const rows = bills.map((b: any) => {
    const pr = db.prepare('SELECT name FROM providers WHERE id=?').get(b.providerId) as any;
    return `<tr><td>${pr?.name || ''}</td><td>${b.dos || ''}</td><td style="text-align:right">$${b.billed.toFixed(2)}</td><td>${b.hasNote ? 'attached' : 'MISSING'}</td></tr>`;
  }).join('');
  audit(req.user!, 'batchPacket.generate', 'patient', p.id);
  res.setHeader('Content-Type', 'text/html');
  res.send(`<html><head><title>Trilogy Batch Bill Submission — ${p.name}</title>
<style>body{font-family:-apple-system,sans-serif;max-width:700px;margin:40px auto;color:#1a2332}table{width:100%;border-collapse:collapse;margin:16px 0}td,th{border:1px solid #ccc;padding:8px;text-align:left;font-size:14px}h1{font-size:20px}@media print{button{display:none}}</style></head><body>
<h1>TRILOGY MEDICAL NETWORKS — Consolidated Bill Submission</h1>
<p><b>Patient:</b> ${p.name} · <b>Claim:</b> ${p.claimNumber || '—'} · <b>Policy:</b> ${p.policyNumber || '—'} · <b>DOI:</b> ${p.doi || '—'}</p>
<table><tr><th>Provider</th><th>DOS</th><th>Billed</th><th>Visit note</th></tr>${rows}
<tr><th colspan="2">TOTAL</th><th style="text-align:right">$${total.toFixed(2)}</th><th></th></tr></table>
<p>All itemized bills and treatment records for the above dates of service are enclosed. Please remit one payment for the total to Trilogy Medical Networks per the master services agreement.</p>
<button onclick="print()">🖨 Print / Save as PDF</button></body></html>`);
});

/* ---- fee schedule admin ---- */
api.get('/admin/fee-schedule', requireAdmin, (_req, res) =>
  res.json(db.prepare('SELECT * FROM fee_schedules ORDER BY state, cpt').all()));
api.post('/admin/fee-schedule', requireAdmin, (req, res) => {
  const { state, cpt, allowed } = req.body || {};
  if (!state || !cpt || !(Number(allowed) > 0)) return res.status(400).json({ error: 'State, CPT, and allowed amount required' });
  db.prepare('INSERT INTO fee_schedules(state,cpt,allowed) VALUES(?,?,?) ON CONFLICT(state,cpt) DO UPDATE SET allowed=excluded.allowed')
    .run(String(state).trim(), String(cpt).trim(), Number(allowed));
  audit(req.user!, 'feeSchedule.set', undefined, undefined, `${state} ${cpt} ${allowed}`);
  res.json(db.prepare('SELECT * FROM fee_schedules ORDER BY state, cpt').all());
});

/* ================= the Decision Deck (Today) ================= */
api.get('/deck', (req, res) => {
  const mine = req.user!.role === 'coordinator';
  const myPts = (db.prepare('SELECT id,name,caseType,coordinator,insurerId,stage,uwLimit,carrierConfirmed,attorneyRetained FROM patients' + (mine ? ' WHERE coordinator=?' : ''))
    .all(...(mine ? [req.user!.id] : [])) as any[]);
  const pidSet = new Set(myPts.map(p => p.id));
  const pName = (id: string) => myPts.find(p => p.id === id)?.name || id;
  const today = new Date().toISOString().slice(0, 10);
  const cards: any[] = [];
  const tile = (v: string, l: string) => ({ v, l });

  // 1 · Bills through the four-check → one-click release; failures → typed exception cards
  const dupIds = duplicateBillIds();
  for (const b of db.prepare(`SELECT b.*, pr.name AS prName FROM bills b JOIN providers pr ON pr.id=b.providerId
    WHERE b.status='unpaid' AND b.voided=0 AND b.hasBill=1 AND b.hasNote=1 AND b.rate>0`).all() as any[]) {
    if (!pidSet.has(b.patientId) || dupIds.has(b.id)) continue;
    const fc = billChecks(b);
    const ckTiles = fc.checks.map(c => tile(c.status === 'pass' ? '✓' : c.status === 'warn' ? '~' : '✕', c.label.toLowerCase().replace('coverage ', '').replace(' vs contract', '≤contract').replace(' on file', '')));
    if (fc.verdict === 'green') {
      cards.push({
        id: 'pay-' + b.id, type: '⚡ Four-check clear · payment release', stripe: 'green', actor: 'sys',
        title: `Pay ${b.prName} — ${fmt$(b.rate)}`, patientId: b.patientId, patientName: pName(b.patientId),
        sub: `DOS ${fmtDate(b.dos)} · billed ${fmt$(b.billed)} · auth ✓ envelope ✓ rate ✓ agreement ✓`,
        outcome: `Provider paid on time at the contracted rate — relationship protected, no over-payment.`,
        recommend: `Release ${fmt$(b.rate)}. All four checks green${b.revenue ? `, margin ${fmt$(b.revenue - b.rate)} locked` : ''}.`,
        tiles: ckTiles,
        actions: [
          { label: `✓ Pay ${fmt$(b.rate)}`, method: 'POST', path: `/bills/${b.id}/pay`, style: 'primary' },
          { label: 'Void', method: 'PROMPT-VOID', path: `/bills/${b.id}/void` },
        ],
        chips: ['Open the case', 'View the bill'],
        age: b.dos,
      });
    } else {
      const f = fc.checks.find(c => c.status === 'fail')!;
      const acts: any[] = [];
      if (f.fix?.reduceTo) acts.push({ label: `✂ Reduce to contracted ${fmt$(f.fix.reduceTo)}`, method: 'POST', path: `/bills/${b.id}/reduce-to-contract`, style: 'primary' });
      if (f.fix?.startAgreement) acts.push({ label: '⎘ Start one-time agreement', method: 'POST', path: `/agreements`, body: { patientId: b.patientId, providerId: b.providerId, providerName: b.prName, service: `DOS ${fmtDate(b.dos)}`, amount: b.billed }, style: 'primary' });
      if (f.key === 'auth') acts.push({ label: '✓ Authorize retroactively', method: 'POST', path: `/patients/${b.patientId}/notes`, body: { text: `Retro-auth review started for ${b.prName} DOS ${fmtDate(b.dos)}` }, style: 'primary' });
      acts.push({ label: 'Void', method: 'PROMPT-VOID', path: `/bills/${b.id}/void` });
      cards.push({
        id: 'exc-' + b.id, type: `◉ Payment exception · ${f.label.toLowerCase()}`, stripe: 'amber', actor: 'you',
        title: `${b.prName} — ${f.detail}`, patientId: b.patientId, patientName: pName(b.patientId),
        sub: `DOS ${fmtDate(b.dos)} · billed ${fmt$(b.billed)} · blocked by check: ${f.label}`,
        outcome: `Not a dollar leaves above contract, without auth, or without an agreement on file.`,
        recommend: f.fix?.reduceTo ? `Reduce and release — the contract is the price.` : f.fix?.startAgreement ? `One-time agreement locks the rate before payment.` : f.detail,
        tiles: ckTiles, actions: acts, chips: ['Open the case'], age: b.dos,
      });
    }
  }

  // 1b · Duplicate bills (containment: never pay twice)
  for (const b of db.prepare(`SELECT b.*, pr.name AS prName FROM bills b JOIN providers pr ON pr.id=b.providerId
    WHERE b.status='unpaid' AND b.voided=0`).all() as any[]) {
    if (!pidSet.has(b.patientId) || !dupIds.has(b.id)) continue;
    cards.push({
      id: 'dup-' + b.id, type: '◉ Duplicate bill suspected', stripe: 'red', actor: 'sys',
      title: `${b.prName} — ${fmt$(b.billed)} looks like a duplicate`, patientId: b.patientId, patientName: pName(b.patientId),
      sub: `Same provider, DOS ${fmtDate(b.dos)}, same amount as an earlier bill`,
      outcome: `The carrier never pays twice for the same visit.`,
      recommend: `Void the duplicate (reason auto-noted) — or keep it if the visits were genuinely separate.`,
      tiles: [tile(fmt$(b.billed), 'billed'), tile(fmtDate(b.dos), 'dos'), tile('dup?', 'flag'), tile(b.prName.split(' ')[0], 'provider')],
      actions: [
        { label: '🗑 Void as duplicate', method: 'POST', path: `/bills/${b.id}/void`, body: { reason: 'Duplicate bill — same provider/DOS/amount' }, style: 'primary' },
        { label: 'Keep — separate visit', method: 'POST', path: `/patients/${b.patientId}/notes`, body: { text: `Duplicate flag reviewed on ${b.prName} DOS ${fmtDate(b.dos)} ${fmt$(b.billed)} — kept as a separate visit` } },
      ],
      chips: ['Open the case'], age: b.dos,
    });
  }

  // 2 · Bills blocked on records
  for (const b of db.prepare(`SELECT b.*, pr.name AS prName FROM bills b JOIN providers pr ON pr.id=b.providerId
    WHERE b.status='unpaid' AND b.voided=0 AND (b.hasBill=0 OR b.hasNote=0)`).all() as any[]) {
    if (!pidSet.has(b.patientId)) continue;
    const missing = b.hasBill ? 'visit note' : 'bill document';
    cards.push({
      id: 'rec-' + b.id, type: '↪ Records needed · payment blocked', stripe: 'amber', actor: 'handed',
      title: `Chase the ${missing} — ${b.prName}`, patientId: b.patientId, patientName: pName(b.patientId),
      sub: `DOS ${fmtDate(b.dos)} · ${fmt$(b.billed)} held until the ${missing} arrives`,
      outcome: `Bill clears the four-check and pays without a human touching it again.`,
      recommend: `Send the records request — one templated chase, logged to the case.`,
      tiles: [tile(fmt$(b.billed), 'billed'), tile(fmtDate(b.dos), 'dos'), tile(missing, 'missing'), tile(b.prName.split(' ')[0], 'provider')],
      actions: [{ label: '✉ Log records chase', method: 'POST', path: `/patients/${b.patientId}/notes`, body: { text: `Records chase sent to ${b.prName} for DOS ${fmtDate(b.dos)} (${missing})` }, style: 'primary' }],
      chips: ['Open the case', 'Call the office instead'], age: b.dos,
    });
  }

  // 3 · Auth requests from providers (tasks created by portal)
  for (const t of db.prepare(`SELECT * FROM tasks WHERE title LIKE 'Auth request from%'`).all() as any[]) {
    if (!pidSet.has(t.patientId)) continue;
    const amtMatch = t.title.match(/\$([\d,]+(?:\.\d{2})?)/);
    const amt = amtMatch ? parseFloat(amtMatch[1].replace(/,/g, '')) : 0;
    const link = db.prepare('SELECT l.*, pr.name AS prName FROM prov_links l JOIN providers pr ON pr.id=l.providerId WHERE l.patientId=? LIMIT 1').get(t.patientId) as any;
    const pt = myPts.find(p => p.id === t.patientId);
    const outside = (db.prepare('SELECT COALESCE(SUM(amt),0) s FROM outside_bills WHERE patientId=?').get(t.patientId) as any).s;
    const usage = (db.prepare('SELECT COALESCE(SUM(billed),0) s FROM bills WHERE patientId=? AND voided=0').get(t.patientId) as any).s;
    const remaining = (pt?.uwLimit || 0) - outside - usage;
    const fits = amt > 0 && amt <= remaining;
    cards.push({
      id: 'auth-' + t.id, type: fits ? '⚡ Auth request · within envelope' : '◉ Auth request · utilization check', stripe: fits ? 'blue' : 'amber', actor: fits ? 'sys' : 'you',
      title: t.title.replace('Auth request from ', 'More auth — '), patientId: t.patientId, patientName: pName(t.patientId),
      sub: `Coverage remaining ${fmt$(remaining)}${amt ? ` · request ${fmt$(amt)}` : ''}`,
      outcome: `Care continues without delay — and only as much as the coverage supports.`,
      recommend: fits
        ? `Approve — fits the envelope with ${fmt$(remaining - amt)} to spare. Containment intact.`
        : `Review utilization first: request ${amt ? fmt$(amt) : '—'} vs ${fmt$(remaining)} remaining. Ask for the treatment plan before extending.`,
      tiles: (() => {
        const visits = link ? (db.prepare('SELECT COUNT(*) c FROM bills WHERE patientId=? AND providerId=? AND voided=0').get(t.patientId, link.providerId) as any).c : 0;
        const prType = link ? (db.prepare('SELECT type FROM providers WHERE id=?').get(link.providerId) as any)?.type : null;
        return [tile(fmt$(remaining), 'remaining'), tile(amt ? fmt$(amt) : '—', 'requested'), tile(`${visits}/${normFor(prType)}`, 'visits vs norm'), tile(fmt$(usage), 'used')];
      })(),
      actions: (link && amt > 0 ? [{ label: `✓ Approve ${fmt$(amt)}`, method: 'POST', path: `/provlinks/${link.id}/action`, body: { kind: 'addauth', amount: amt }, then: { method: 'POST', path: `/tasks/${t.id}/complete` }, style: 'primary' }] as any[] : [])
        .concat([{ label: 'Decline / discuss', method: 'POST', path: `/tasks/${t.id}/complete` }]),
      chips: ['Open the case', 'Message the provider'], age: t.due,
    });
  }

  // 4 · New referrals awaiting intake review (SLA clock)
  for (const i of db.prepare(`SELECT * FROM intake_items WHERE kind='referral' AND status='triage'`).all() as any[]) {
    cards.push({
      id: 'ref-' + i.id, type: '↪ New referral · SLA clock running', stripe: 'red', actor: 'handed',
      title: `Intake review — ${i.note || 'new referral'}`, patientId: i.patientId, patientName: i.patientId ? pName(i.patientId) : '—',
      sub: `From ${i.fromInfo} · received ${i.receivedAt}`,
      outcome: `Referral becomes an active case inside the 1-hour SLA — carrier sees speed.`,
      recommend: `Confirm coverage with the carrier, assign a coordinator, mark reviewed.`,
      tiles: [tile(i.channel, 'channel'), tile('1 hr', 'sla'), tile(i.receivedAt.split(',')[0], 'received'), tile(i.patientId || '—', 'case')],
      actions: [{ label: '✓ Mark intake reviewed', method: 'POST', path: `/intake/${i.id}/process`, body: {}, style: 'primary' }],
      chips: ['Open the case'], age: today,
    });
  }

  // 5 · Overdue tasks (non-auth-request)
  for (const t of db.prepare(`SELECT * FROM tasks WHERE due IS NOT NULL AND due<? AND title NOT LIKE 'Auth request from%'`).all(today) as any[]) {
    if (!pidSet.has(t.patientId)) continue;
    cards.push({
      id: 'task-' + t.id, type: '◉ Overdue task', stripe: 'red', actor: 'you',
      title: t.title, patientId: t.patientId, patientName: pName(t.patientId),
      sub: `Due ${fmtDate(t.due)} · created by ${t.by}`,
      outcome: `Nothing on this case is silently aging.`,
      recommend: `Do it now or push it out with a reason — either way it stops being invisible.`,
      tiles: [tile(fmtDate(t.due), 'was due'), tile(t.by, 'from'), tile(t.created.split(',')[0], 'created'), tile('—', '')],
      actions: [
        { label: '✓ Done', method: 'POST', path: `/tasks/${t.id}/complete`, style: 'primary' },
        { label: '⏩ Push out', method: 'PROMPT-SNOOZE', path: `/tasks/${t.id}/snooze` },
      ],
      chips: ['Open the case'], age: t.due,
    });
  }

  // 6 · Coverage exceeded / nearly exhausted (containment reds)
  for (const p of myPts) {
    if (!p.uwLimit || p.stage >= 4) continue;
    const outside = (db.prepare('SELECT COALESCE(SUM(amt),0) s FROM outside_bills WHERE patientId=?').get(p.id) as any).s;
    const usage = (db.prepare('SELECT COALESCE(SUM(billed),0) s FROM bills WHERE patientId=? AND voided=0').get(p.id) as any).s;
    const remaining = p.uwLimit - outside - usage;
    if (remaining < p.uwLimit * 0.15) {
      cards.push({
        id: 'cov-' + p.id, type: '◉ Cost control · coverage ' + (remaining < 0 ? 'EXCEEDED' : 'nearly exhausted'), stripe: 'red', actor: 'you',
        title: `${p.name} — ${remaining < 0 ? fmt$(-remaining) + ' over coverage' : fmt$(remaining) + ' remaining'}`,
        patientId: p.id, patientName: p.name,
        sub: `Limit ${fmt$(p.uwLimit)} · used ${fmt$(usage)} · outside ${fmt$(outside)}`,
        outcome: `The carrier never sees a surprise — treatment lands inside coverage or gets a decision first.`,
        recommend: remaining < 0 ? `Stop further authorizations; review the treatment plan with the provider today.` : `Flag discharge-readiness with the provider; no new auths without review.`,
        tiles: [tile(fmt$(p.uwLimit), 'limit'), tile(fmt$(usage), 'used'), tile(fmt$(outside), 'outside'), tile(fmt$(remaining), 'remaining')],
        actions: [{ label: '✓ Reviewed — note it', method: 'POST', path: `/patients/${p.id}/notes`, body: { text: 'Coverage-exhaustion review completed — treatment plan checked against remaining coverage' }, style: 'primary' }],
        chips: ['Open the case', 'Message the provider'], age: today,
      });
    }
    if (p.attorneyRetained && p.caseType === 'trilopay') {
      cards.push({
        id: 'atty-' + p.id, type: '◉ Attorney involved · PIP', stripe: 'red', actor: 'you',
        title: `${p.name} — attorney on a PIP case`, patientId: p.id, patientName: p.name,
        sub: 'Verify where the flow of funds is going',
        outcome: `Funds flow stays with Trilogy per the agreements — or we know today that it doesn't.`,
        recommend: `Call the adjuster; confirm payment routing; document.`,
        tiles: [tile('PIP', 'line'), tile('⚠', 'risk'), tile('—', ''), tile('—', '')],
        actions: [{ label: '✓ Verified — note it', method: 'POST', path: `/patients/${p.id}/notes`, body: { text: 'Attorney-involvement funds-flow verification completed' }, style: 'primary' }],
        chips: ['Open the case'], age: today,
      });
    }
  }

  // 7 · Receipts pending 14+ days (chase the carrier)
  const cutoff14 = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  for (const r of db.prepare(`SELECT * FROM receipts WHERE status='Pending' AND voided=0 AND date<?`).all(cutoff14) as any[]) {
    if (!pidSet.has(r.patientId)) continue;
    cards.push({
      id: 'rcpt-' + r.id, type: '↪ Carrier payment aging', stripe: 'amber', actor: 'handed',
      title: `Chase ${fmt$(r.amount)} — pending since ${fmtDate(r.date)}`, patientId: r.patientId, patientName: pName(r.patientId),
      sub: r.ref || '', outcome: `Float stays small — carrier days-to-pay stays honest.`,
      recommend: `Nudge the adjuster; every day of float is working capital.`,
      tiles: [tile(fmt$(r.amount), 'amount'), tile(fmtDate(r.date), 'since'), tile(r.ref?.slice(0, 12) || '—', 'ref'), tile('—', '')],
      actions: [
        { label: '✓ Mark cleared', method: 'POST', path: `/receipts/${r.id}/toggle`, style: 'primary' },
        { label: 'Log a chase', method: 'POST', path: `/patients/${r.patientId}/notes`, body: { text: `Payment chase logged: ${fmt$(r.amount)} (${r.ref || ''})` } },
      ],
      chips: ['Open the case'], age: r.date,
    });
  }

  // 8 · Portal access approvals (admin only)
  if (req.user!.role === 'admin') {
    for (const u of db.prepare('SELECT * FROM users WHERE approved=0').all() as any[]) {
      const orgName = (db.prepare('SELECT name FROM providers WHERE id=?').get(u.orgId) as any)?.name
        || (db.prepare('SELECT name FROM insurers WHERE id=?').get(u.orgId) as any)?.name || u.orgId;
      cards.push({
        id: 'appr-' + u.id, type: '◉ Portal access request', stripe: 'blue', actor: 'you',
        title: `${u.name} wants portal access`, patientId: null, patientName: orgName,
        sub: `${u.email} · ${u.role} @ ${orgName}`,
        outcome: `Partners get in fast — and only the right people get in.`,
        recommend: `Verify against the office line on file, then approve as worker (org-admin only for owners/managers).`,
        tiles: [tile(u.role, 'type'), tile(orgName?.split(' ')[0] || '—', 'org'), tile('worker', 'suggested'), tile('—', '')],
        actions: [
          { label: '✓ Approve as worker', method: 'POST', path: `/admin/users/${u.id}/approve`, body: { approve: true, orgRole: 'worker' }, style: 'primary' },
          { label: 'As org admin', method: 'POST', path: `/admin/users/${u.id}/approve`, body: { approve: true, orgRole: 'admin' } },
          { label: '✕ Deny', method: 'POST', path: `/admin/users/${u.id}/approve`, body: { approve: false } },
        ],
        chips: [], age: today,
      });
    }
  }

  // 9 · Denied bills with no appeal decision
  for (const b of db.prepare(`SELECT b.*, pr.name AS prName FROM bills b JOIN providers pr ON pr.id=b.providerId
    WHERE b.denied=1 AND b.appealStatus='none' AND b.voided=0`).all() as any[]) {
    if (!pidSet.has(b.patientId)) continue;
    cards.push({
      id: 'deny-' + b.id, type: '◉ Denial · appeal decision', stripe: 'amber', actor: 'you',
      title: `Carrier denied ${fmt$(b.billed)} — appeal?`, patientId: b.patientId, patientName: pName(b.patientId),
      sub: `${b.prName} · DOS ${fmtDate(b.dos)} · "${b.denialReason}"`,
      outcome: `Every denial gets a deliberate answer — appealed, corrected, or written off on purpose.`,
      recommend: `If the denial reason is documentation, fix and appeal; if rate, check the contract.`,
      tiles: [tile(fmt$(b.billed), 'billed'), tile(fmtDate(b.dos), 'dos'), tile(b.denialReason?.slice(0, 14) || '—', 'reason'), tile('—', '')],
      actions: [
        { label: 'Appeal it', method: 'POST', path: `/bills/${b.id}/denial`, body: { denied: 1, denialReason: b.denialReason, appealStatus: 'appealing' }, style: 'primary' },
        { label: 'Write off', method: 'POST', path: `/bills/${b.id}/denial`, body: { denied: 1, denialReason: b.denialReason, appealStatus: 'written-off' } },
      ],
      chips: ['Open the case'], age: b.dos,
    });
  }

  // 10 · One-time agreements to chase (draft/sent)
  for (const a of db.prepare(`SELECT a.*, p.name ptName FROM agreements a JOIN patients p ON p.id=a.patientId
    WHERE a.status IN ('draft','sent')`).all() as any[]) {
    if (!pidSet.has(a.patientId)) continue;
    cards.push({
      id: 'ota-' + a.id, type: '⎘ One-time agreement · ' + a.status, stripe: 'amber', actor: 'handed',
      title: `${a.providerName} — one-time agreement ${a.status === 'draft' ? 'ready to send' : 'awaiting signature'}`,
      patientId: a.patientId, patientName: a.ptName,
      sub: `${a.service || 'service'} · ${fmt$(a.amount || 0)} · started ${a.createdAt}`,
      outcome: `The rate is locked in writing before a dollar moves — check #4 turns green.`,
      recommend: a.status === 'draft' ? `Send it — the terms template is one click.` : `Chase the signature; unsigned agreements don't contain anything.`,
      tiles: [tile(fmt$(a.amount || 0), 'amount'), tile(a.status, 'status'), tile(a.service?.slice(0, 12) || '—', 'service'), tile(a.createdAt?.split(',')[0] || '—', 'started')],
      actions: a.status === 'draft'
        ? [{ label: '✉ Mark sent', method: 'POST', path: `/agreements/${a.id}/status`, body: { status: 'sent' }, style: 'primary' }]
        : [{ label: '✓ Mark signed', method: 'POST', path: `/agreements/${a.id}/status`, body: { status: 'signed' }, style: 'primary' },
           { label: '✕ Declined', method: 'POST', path: `/agreements/${a.id}/status`, body: { status: 'declined' } }],
      chips: ['Open the case'], age: today,
    });
  }

  // 11 · Recurring gap → worth a full contract (growth escalation, admin)
  if (req.user!.role === 'admin') {
    for (const g of db.prepare(`SELECT providerName, COUNT(*) c, SUM(amount) amt FROM agreements
      GROUP BY providerName HAVING c>=2`).all() as any[]) {
      const already = db.prepare('SELECT 1 FROM campaigns WHERE name=?').get(g.providerName);
      if (already) continue;
      cards.push({
        id: 'gap-' + g.providerName.replace(/\W/g, ''), type: '⇗ Network gap · recurring', stripe: 'blue', actor: 'sys',
        title: `${g.providerName} — ${g.c} one-time agreements. Worth a full contract?`,
        patientId: null, patientName: 'Growth',
        sub: `${fmt$(g.amt || 0)} routed through one-off paper so far`,
        outcome: `Recurring gaps become contracted network — locked rates replace one-off negotiations.`,
        recommend: `Send to the Growth queue — Miles picks it up with the volume story attached.`,
        tiles: [tile(String(g.c), 'agreements'), tile(fmt$(g.amt || 0), 'volume'), tile('gap', 'signal'), tile('—', '')],
        actions: [{ label: '⇗ Add to Growth queue', method: 'POST', path: `/campaigns`, body: { name: g.providerName, kind: 'provider', stage: 'identify', notes: `${g.c} one-time agreements, ${fmt$(g.amt || 0)} volume — auto-flagged from gap engine` }, style: 'primary' }],
        chips: [], age: today,
      });
    }

    // 12 · Drift findings (admin)
    for (const [i, d] of driftReport().entries()) {
      cards.push({
        id: 'drift-' + i, type: `◉ Drift · ${d.kind}`, stripe: 'amber', actor: 'sys',
        title: `${d.who} — ${d.kind} drift`, patientId: null, patientName: d.who,
        sub: d.text,
        outcome: `Drift gets caught in weeks, not at renewal.`,
        recommend: d.action,
        tiles: [tile(d.kind, 'kind'), tile(d.who.split(' ')[0], 'who'), tile('60d', 'window'), tile('—', '')],
        actions: [{ label: '✓ Acknowledged', method: 'POST', path: `/drift/ack`, body: { text: `${d.who}: ${d.text}` }, style: 'primary' }],
        chips: [], age: today,
      });
    }

    // 12b · Fee benchmark pipeline failed (admin) — never silently serve stale rates
    const lastFeeRef = db.prepare('SELECT * FROM fee_refreshes ORDER BY id DESC LIMIT 1').get() as any;
    if (lastFeeRef?.status === 'failed') {
      cards.push({
        id: 'fee-' + lastFeeRef.id, type: '◉ Fee benchmark · refresh failed', stripe: 'red', actor: 'sys',
        title: 'Medicare fee data refresh failed — rates may be stale', patientId: null, patientName: 'Fee tool',
        sub: String(lastFeeRef.detail || '').slice(0, 140),
        outcome: `The fee tool never quietly serves outdated numbers — a human sees every failure.`,
        recommend: `Open the fee tool status panel; if CMS changed their page, use the manual crosswalk upload.`,
        tiles: [tile(lastFeeRef.at?.split(',')[0] || '—', 'failed'), tile(String(lastFeeRef.year || '—'), 'year'), tile('CMS', 'source'), tile('—', '')],
        actions: [{ label: '↻ Retry refresh now', method: 'POST', path: `/fees/admin/refresh`, style: 'primary' }],
        chips: [], age: today,
      });
    }
  }

  // 13 · Cost-saver redirect: cheaper preferred equivalent exists for an active link
  for (const p of myPts) {
    if (p.stage >= 3) continue;
    for (const l of db.prepare(`SELECT l.*, pr.name prName, pr.type prType FROM prov_links l
      JOIN providers pr ON pr.id=l.providerId WHERE l.patientId=? AND l.status='authorized'`).all(p.id) as any[]) {
      const ranked = rankProviders(l.prType, null);
      const current = ranked.find(r => r.id === l.providerId);
      const better = ranked.find(r => r.id !== l.providerId && r.preferred && r.costProxy != null
        && current?.costProxy != null && r.costProxy < current.costProxy * 0.8);
      if (!better || !current) continue;
      cards.push({
        id: 'save-' + l.id, type: '⇄ Cost-saver · cheaper contracted equivalent', stripe: 'blue', actor: 'sys',
        title: `${better.name} runs ~${Math.round((1 - better.costProxy! / current.costProxy!) * 100)}% below ${l.prName}`,
        patientId: p.id, patientName: p.name,
        sub: `Same specialty (${l.prType}) · preferred network · conservative-care ${better.conservative ? '✓' : '—'}`,
        outcome: `Future referrals go to the lowest contracted cost that still treats well — savings without touching care in progress.`,
        recommend: `Keep current care undisturbed; note ${better.name} as first choice for the next referral of this type.`,
        tiles: [tile(fmt$(current.costProxy!), 'current cost'), tile(fmt$(better.costProxy!), 'alternative'), tile(better.preferred ? '★' : '—', 'preferred'), tile(better.conservative ? '✓' : '—', 'conservative')],
        actions: [{ label: '✓ Note for next referral', method: 'POST', path: `/patients/${p.id}/notes`, body: { text: `Optimizer: ${better.name} noted as preferred ${l.prType} choice for future referrals (~${Math.round((1 - better.costProxy! / current.costProxy!) * 100)}% below ${l.prName} on contracted cost)` }, style: 'primary' }],
        chips: ['Open the case'], age: today,
      });
      break; // one per patient
    }
  }

  // 14 · Auto-status suggestion: quiet treating case → suggest Done Treating
  const d30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  for (const p of myPts) {
    if (p.stage !== 2) continue;
    const recentBill = db.prepare('SELECT 1 FROM bills WHERE patientId=? AND voided=0 AND dos>=?').get(p.id, d30);
    const upcoming = db.prepare('SELECT 1 FROM appointments WHERE patientId=? AND whenAt>=?').get(p.id, today);
    if (recentBill || upcoming) continue;
    cards.push({
      id: 'stat-' + p.id, type: '◈ Auto-status · discharge signal', stripe: 'blue', actor: 'sys',
      title: `${p.name} — quiet for 30+ days. Done treating?`, patientId: p.id, patientName: p.name,
      sub: 'No new bills and no upcoming appointments in 30 days',
      outcome: `Cases close when treatment actually ends — not months later when someone notices.`,
      recommend: `Confirm discharge with the provider, then advance the case. Faster closes are the carrier's favorite metric.`,
      tiles: [tile('30d+', 'quiet'), tile('Treating', 'stage'), tile('→ Done', 'suggest'), tile('—', '')],
      actions: [
        { label: '✓ Mark Done Treating', method: 'POST', path: `/patients/${p.id}/stage`, body: { stage: 3 }, style: 'primary' },
        { label: 'Still treating — note it', method: 'POST', path: `/patients/${p.id}/notes`, body: { text: 'Auto-status check: confirmed still treating despite 30-day quiet period' } },
      ],
      chips: ['Open the case', 'Message the provider'], age: today,
    });
  }

  const sev = (s: string) => s === 'red' ? 0 : s === 'amber' ? 1 : 2;
  cards.sort((a, b) => sev(a.stripe) - sev(b.stripe));

  // Outcomes strip (the ends, cost-containment edition)
  const readyToPay = cards.filter(c => c.id.startsWith('pay-')).length;
  const notInCare = myPts.filter(p => p.stage < 2).length;
  const costRisk = cards.filter(c => c.id.startsWith('cov-')).length;
  const readyToClose = myPts.filter(p => p.stage === 3).length;
  const attorneyRisk = myPts.filter(p => p.attorneyRetained).length;

  // Overnight receipts from the audit trail (last 24h)
  const since = new Date(Date.now() - 86400000).toISOString();
  const recent = db.prepare('SELECT * FROM audit_log WHERE time>? ORDER BY id DESC LIMIT 200').all(since) as any[];
  const FRIENDLY: Record<string, string> = {
    'bill.pay': 'released a provider payment', 'bill.create': 'filed a bill', 'bill.attach.bill': 'attached a bill document',
    'bill.attach.note': 'attached a visit note', 'note.add': 'logged a note', 'task.create': 'created a task',
    'task.complete': 'closed a task', 'portal.provider.submitBill': 'took in a portal bill', 'portal.carrier.refer': 'opened a carrier referral',
    'portal.access': 'served a portal session', 'sentdoc.create': 'sent a document', 'message.send': 'delivered a case message',
    'receipt.create': 'recorded a carrier receipt', 'intake.process': 'processed an intake item', 'login.success': 'signed someone in',
    'auth.autoApprove': 'auto-approved an in-envelope auth', 'bill.reduceToContract': 'reduced a bill to the contracted rate',
    'agreement.create': 'started a one-time agreement', 'agreement.status': 'moved a one-time agreement forward',
    'outbound.send': 'sent a consolidated daily update', 'campaign.create': 'queued a growth target',
  };
  const counts: Record<string, number> = {};
  for (const a of recent) counts[a.action] = (counts[a.action] || 0) + 1;
  const receipts = Object.entries(counts)
    .map(([action, n]) => ({ n, what: FRIENDLY[action] || action.replace(/\./g, ' ') }))
    .sort((a, b) => b.n - a.n).slice(0, 8);

  res.json({
    cards,
    outcomes: { readyToClose, notInCare, costRisk, readyToPay, attorneyRisk },
    receipts: { total: recent.length, items: receipts },
    aboveBeyond: [
      { title: 'Pre-verify coverage on tomorrow\'s intakes', why: 'Cuts the SLA clock before it starts' },
      { title: 'Thank a provider office that sent clean bills', why: 'Clean bills auto-pay — reward the behavior' },
      { title: 'Check on a quiet patient', why: 'Patients who feel cared for don\'t call attorneys' },
    ],
  });
});

/* ================= carrier partnership configuration (the digitized onboarding packet) ================= */
api.get('/insurers/:id/onboarding', (req, res) => {
  const c = db.prepare('SELECT onboarding FROM insurers WHERE id=?').get(req.params.id) as any;
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json(c.onboarding ? JSON.parse(c.onboarding) : {});
});
api.post('/insurers/:id/onboarding', (req, res) => {
  const c = db.prepare('SELECT id,name FROM insurers WHERE id=?').get(req.params.id) as any;
  if (!c) return res.status(404).json({ error: 'Not found' });
  const cfg = req.body || {};
  cfg._meta = { savedBy: req.user!.name, savedAt: nowMST(), role: req.user!.role };
  db.prepare('UPDATE insurers SET onboarding=? WHERE id=?').run(JSON.stringify(cfg), c.id);
  audit(req.user!, 'insurer.onboarding.save', 'insurer', c.id, `${Object.keys(cfg).length} sections`);
  res.json({ ok: true });
});
/* ================= phase 4-6 engines ================= */

/* Four-check verdicts + health + strip extras for one case (staff-only; never portal). */
api.get('/patients/:id/insights', (req, res) => {
  const p = db.prepare('SELECT * FROM patients WHERE id=?').get(req.params.id) as any;
  if (!p) return res.status(404).json({ error: 'Not found' });
  const dups = duplicateBillIds(p.id);
  const checks: Record<string, any> = {};
  for (const b of db.prepare('SELECT * FROM bills WHERE patientId=?').all(p.id) as any[])
    checks[b.id] = { ...billChecks(b), dup: dups.has(b.id) };
  res.json({ checks, health: caseHealth(p), strip: stripExtras(p), tier: p.insurerId ? carrierTier(p.insurerId).tier : null });
});

/* Health summaries for the roster. */
api.get('/health-summaries', (_req, res) => {
  const out: Record<string, any> = {};
  for (const p of db.prepare('SELECT * FROM patients').all() as any[]) {
    const h = caseHealth(p);
    out[p.id] = { score: h.score, band: h.band, status: h.status, redCount: h.reds.length };
  }
  res.json(out);
});

/* Exception fix: reduce billed to the contracted price. */
api.post('/bills/:bid/reduce-to-contract', (req, res) => {
  const b = db.prepare('SELECT * FROM bills WHERE id=?').get(req.params.bid) as any;
  if (!b) return res.status(404).json({ error: 'Not found' });
  if (!(b.revenue > 0) || b.billed <= b.revenue) return res.status(400).json({ error: 'Nothing to reduce — billed is at or under contract' });
  const old = b.billed;
  db.prepare('UPDATE bills SET billed=? WHERE id=?').run(b.revenue, b.id);
  db.prepare('UPDATE prov_links SET billed=billed-? WHERE patientId=? AND providerId=?').run(old - b.revenue, b.patientId, b.providerId);
  const prName = (db.prepare('SELECT name FROM providers WHERE id=?').get(b.providerId) as any)?.name || b.providerId;
  addNote(b.patientId, `Bill reduced to contracted rate: ${prName} DOS ${fmtDate(b.dos)} — ${fmt$(old)} → ${fmt$(b.revenue)} (contract is the price)`, req.user!.name);
  audit(req.user!, 'bill.reduceToContract', 'bill', b.id, `${old} -> ${b.revenue}`);
  res.json(fullPatient(b.patientId));
});

/* EOB capture (Trilopay side). */
api.post('/bills/:bid/eob', (req, res) => {
  const b = db.prepare('SELECT * FROM bills WHERE id=?').get(req.params.bid) as any;
  if (!b) return res.status(404).json({ error: 'Not found' });
  const v = req.body || {};
  db.prepare('UPDATE bills SET eobAllowed=?, eobPaid=?, eobNote=?, eobAt=? WHERE id=?')
    .run(Number(v.allowed) || null, Number(v.paid) || null, v.note || null, nowMST(), b.id);
  addNote(b.patientId, `EOB recorded on DOS ${fmtDate(b.dos)}: allowed ${fmt$(Number(v.allowed) || 0)} · paid ${fmt$(Number(v.paid) || 0)}${v.note ? ' — ' + v.note : ''}`, req.user!.name);
  audit(req.user!, 'bill.eob', 'bill', b.id);
  res.json(fullPatient(b.patientId));
});

/* One-time agreements. */
api.get('/agreements', (_req, res) => {
  res.json(db.prepare(`SELECT a.*, p.name ptName FROM agreements a JOIN patients p ON p.id=a.patientId ORDER BY a.id DESC`).all());
});
api.post('/agreements', (req, res) => {
  const v = req.body || {};
  if (!v.patientId || !String(v.providerName || '').trim()) return res.status(400).json({ error: 'patientId and providerName required' });
  const dupe = db.prepare(`SELECT 1 FROM agreements WHERE patientId=? AND providerName=? AND status IN ('draft','sent')`).get(v.patientId, v.providerName);
  if (dupe) return res.status(409).json({ error: 'An open agreement with this provider already exists on this case' });
  const info = db.prepare(`INSERT INTO agreements(patientId,providerId,providerName,service,amount,terms,status,createdAt,createdBy)
    VALUES(?,?,?,?,?,?,'draft',?,?)`)
    .run(v.patientId, v.providerId || null, v.providerName, v.service || null, Number(v.amount) || 0,
      v.terms || `One-time agreement: services at ${Number(v.amount) ? fmt$(Number(v.amount)) : 'negotiated rate'}, payment within 30 days of clean bill + records, no balance billing.`,
      nowMST(), req.user!.name);
  addNote(v.patientId, `One-time agreement started with ${v.providerName}${v.amount ? ' · ' + fmt$(Number(v.amount)) : ''} — locks the rate before payment (four-check #4)`, req.user!.name);
  audit(req.user!, 'agreement.create', 'agreement', String(info.lastInsertRowid), v.providerName);
  res.json({ ok: true, id: info.lastInsertRowid });
});
api.post('/agreements/:id/status', (req, res) => {
  const a = db.prepare('SELECT * FROM agreements WHERE id=?').get(req.params.id) as any;
  if (!a) return res.status(404).json({ error: 'Not found' });
  const status = String(req.body?.status);
  if (!['sent', 'signed', 'declined'].includes(status)) return res.status(400).json({ error: 'Bad status' });
  db.prepare('UPDATE agreements SET status=?, signedAt=? WHERE id=?').run(status, status === 'signed' ? nowMST() : a.signedAt, a.id);
  addNote(a.patientId, `One-time agreement with ${a.providerName}: ${status}${status === 'signed' ? ' — payments to this provider unblocked' : ''}`, req.user!.name);
  audit(req.user!, 'agreement.status', 'agreement', String(a.id), status);
  res.json({ ok: true });
});

/* Provider optimizer. */
api.get('/optimizer', (req, res) => {
  const type = (req.query.type as string) || null;
  const pt = req.query.patientId ? db.prepare('SELECT address FROM patients WHERE id=?').get(req.query.patientId) as any : null;
  res.json(rankProviders(type, pt?.address || null));
});

/* Consolidated daily outbound. */
api.get('/outbound', (_req, res) => res.json(outboundDrafts()));
api.post('/outbound/send', (req, res) => {
  const v = req.body || {};
  for (const pid of v.patientIds || []) {
    db.prepare('INSERT INTO sent_docs(patientId,name,toStr,time,status,method) VALUES(?,?,?,?,?,?)')
      .run(pid, `Daily consolidated update — ${v.subject || 'status'}`, v.toName || '', nowMST(), 'Sent', 'Email');
    addNote(pid, `Consolidated daily outbound sent to ${v.toName}: ${v.subject}`, req.user!.name);
  }
  audit(req.user!, 'outbound.send', v.kind, v.toId, v.subject);
  res.json({ ok: true });
});

/* Scheduling board. */
api.get('/schedule', (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const horizon = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  const upcoming = db.prepare(`SELECT a.*, p.name ptName, pr.name prName FROM appointments a
    JOIN patients p ON p.id=a.patientId LEFT JOIN providers pr ON pr.id=a.providerId
    WHERE a.whenAt>=? AND a.whenAt<=? ORDER BY a.whenAt`).all(today, horizon);
  const gaps = (db.prepare(`SELECT p.* FROM patients p WHERE p.stage=2`).all() as any[])
    .filter(p => !db.prepare('SELECT 1 FROM appointments WHERE patientId=? AND whenAt>=?').get(p.id, today))
    .map(p => ({ id: p.id, name: p.name, caseType: p.caseType, coordinator: p.coordinator }));
  res.json({ upcoming, gaps });
});
api.post('/patients/:id/appointments', (req, res) => {
  const v = req.body || {};
  if (!v.whenAt) return res.status(400).json({ error: 'Date required' });
  db.prepare('INSERT INTO appointments(patientId,providerId,whenAt,note,createdBy,createdAt) VALUES(?,?,?,?,?,?)')
    .run(req.params.id, v.providerId || null, v.whenAt, v.note || null, req.user!.name, nowMST());
  addNote(req.params.id, `Appointment scheduled ${fmtDate(v.whenAt)}${v.note ? ' — ' + v.note : ''}`, req.user!.name);
  audit(req.user!, 'appointment.create', 'patient', req.params.id);
  res.json(fullPatient(req.params.id));
});

/* Growth workspace. */
api.get('/growth', requireAdmin, (_req, res) => {
  const d30 = new Date(Date.now() - 30 * 86400000).toISOString();
  const d30d = d30.slice(0, 10);
  const coldCarriers = (db.prepare('SELECT id,name FROM insurers').all() as any[])
    .filter(c => !(db.prepare('SELECT 1 FROM patients WHERE insurerId=? AND createdAt>=?').get(c.id, d30)))
    .map(c => ({ ...c, why: 'No new referrals in 30 days' }));
  const coldProviders = (db.prepare('SELECT id,name,type FROM providers').all() as any[])
    .filter(pr => !(db.prepare('SELECT 1 FROM bills WHERE providerId=? AND dos>=? AND voided=0').get(pr.id, d30d)))
    .map(pr => ({ ...pr, why: 'No bills in 30 days — relationship cooling' }));
  const gaps = db.prepare(`SELECT providerName, COUNT(*) c, SUM(amount) amt FROM agreements GROUP BY providerName ORDER BY c DESC`).all();
  const campaigns = db.prepare('SELECT * FROM campaigns ORDER BY id DESC').all();
  const queue = [
    ...coldCarriers.map(c => ({ kind: 'carrier', id: c.id, name: c.name, why: c.why, priority: 2 })),
    ...(gaps as any[]).filter(g => g.c >= 2).map(g => ({ kind: 'gap', id: g.providerName, name: g.providerName, why: `${g.c} one-time agreements — contract candidate`, priority: 1 })),
    ...coldProviders.map(p => ({ kind: 'provider', id: p.id, name: p.name, why: p.why, priority: 3 })),
  ].sort((a, b) => a.priority - b.priority);
  res.json({ queue, campaigns, gaps, coldCarriers, coldProviders });
});
api.post('/campaigns', (req, res) => {
  const v = req.body || {};
  if (!String(v.name || '').trim()) return res.status(400).json({ error: 'Name required' });
  const info = db.prepare('INSERT INTO campaigns(name,kind,region,stage,contact,notes,updatedAt,by) VALUES(?,?,?,?,?,?,?,?)')
    .run(v.name, v.kind || 'carrier', v.region || null, v.stage || 'identify', v.contact || null, v.notes || null, nowMST(), req.user!.name);
  audit(req.user!, 'campaign.create', 'campaign', String(info.lastInsertRowid), v.name);
  res.json({ ok: true, id: info.lastInsertRowid });
});
api.post('/campaigns/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM campaigns WHERE id=?').get(req.params.id) as any;
  if (!c) return res.status(404).json({ error: 'Not found' });
  const v = req.body || {};
  db.prepare('UPDATE campaigns SET stage=?, notes=?, contact=?, region=?, updatedAt=?, by=? WHERE id=?')
    .run(v.stage || c.stage, v.notes ?? c.notes, v.contact ?? c.contact, v.region ?? c.region, nowMST(), req.user!.name, c.id);
  audit(req.user!, 'campaign.update', 'campaign', String(c.id), v.stage || '');
  res.json({ ok: true });
});

/* Drift, tiers, scores, enterprise report. */
api.get('/drift', requireAdmin, (_req, res) => res.json(driftReport()));
api.post('/drift/ack', (req, res) => {
  audit(req.user!, 'drift.ack', 'drift', undefined, req.body?.text);
  res.json({ ok: true });
});
api.get('/insurers/:id/tier', (req, res) => res.json(carrierTier(req.params.id)));
api.get('/providers/:id/score', (req, res) => res.json(providerScore(req.params.id)));
api.get('/insurers/:id/report', (req, res) => {
  const c = db.prepare('SELECT id,name FROM insurers WHERE id=?').get(req.params.id) as any;
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json({ carrier: c.name, ...carrierReport(c.id), tier: carrierTier(c.id) });
});

api.get('/roster/patients', (_req, res) => {
  res.json(db.prepare(`SELECT p.id, p.name, p.caseType, p.stage, p.coordinator, p.doi, p.insurerId,
    (SELECT COUNT(*) FROM tasks t WHERE t.patientId=p.id) AS openTasks,
    (SELECT COUNT(*) FROM bills b WHERE b.patientId=p.id AND b.status='unpaid' AND b.voided=0) AS unpaidBills
    FROM patients p`).all());
});

api.get('/dashboard', requireAdmin, (_req, res) => {
  const payable = (db.prepare("SELECT COALESCE(SUM(rate),0) s, COUNT(*) c FROM bills WHERE status='unpaid' AND voided=0 AND rate>0").get() as any);
  const pendingIn = (db.prepare("SELECT COALESCE(SUM(amount),0) s, COUNT(*) c FROM receipts WHERE status='Pending' AND voided=0").get() as any);
  const received = (db.prepare("SELECT COALESCE(SUM(amount),0) s FROM receipts WHERE status='Cleared' AND voided=0").get() as any).s;
  const paid = (db.prepare("SELECT COALESCE(SUM(rate),0) s FROM bills WHERE status='paid' AND voided=0").get() as any).s;
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const aging = (db.prepare("SELECT COALESCE(SUM(rate),0) s, COUNT(*) c FROM bills WHERE status='unpaid' AND voided=0 AND dos < ?").get(cutoff) as any);
  const byStage = db.prepare('SELECT stage, COUNT(*) c FROM patients GROUP BY stage').all();
  const byCarrier = (db.prepare('SELECT id, name FROM insurers').all() as any[]).map(c => ({ id: c.id, name: c.name, ...insAutoStats(c.id) }));
  const byCaseType = db.prepare(`SELECT caseType, COUNT(*) c FROM patients WHERE stage<4 GROUP BY caseType`).all();
  const coordinators = (db.prepare('SELECT id, name FROM users WHERE active=1').all() as any[]).map(u => ({
    id: u.id, name: u.name,
    activeCases: (db.prepare('SELECT COUNT(*) c FROM patients WHERE coordinator=? AND stage<4').get(u.id) as any).c,
    openTasks: (db.prepare('SELECT COUNT(*) c FROM tasks t JOIN patients p ON p.id=t.patientId WHERE p.coordinator=?').get(u.id) as any).c,
  })).filter(x => x.activeCases || x.openTasks);
  // Thesis metrics
  const ptCount = (db.prepare('SELECT COUNT(*) c FROM patients').get() as any).c;
  const attyCount = (db.prepare('SELECT COUNT(*) c FROM patients WHERE attorneyRetained=1').get() as any).c;
  // Avg days intake → treating from stage timestamps
  const velocityRows = db.prepare(`SELECT s0.patientId, julianday(s2.at)-julianday(s0.at) AS days
    FROM stage_times s0 JOIN stage_times s2 ON s2.patientId=s0.patientId AND s2.stage=2
    WHERE s0.stage=0`).all() as any[];
  const avgIntakeToTreating = velocityRows.length
    ? Math.round(velocityRows.reduce((s, r) => s + r.days, 0) / velocityRows.length * 10) / 10 : null;
  const byCarrierAR = byCarrier.map((c: any) => {
    const billedTotal = (db.prepare(`SELECT COALESCE(SUM(b.billed),0) s FROM bills b
      JOIN patients p ON p.id=b.patientId WHERE p.insurerId=? AND b.voided=0`).get(c.id) as any).s;
    return { ...c, billedTotal, outstanding: Math.max(0, billedTotal - c.received) };
  });
  res.json({
    payable: payable.s, payableCount: payable.c,
    pendingIn: pendingIn.s, pendingInCount: pendingIn.c,
    received, paid, margin: received - paid,
    marginPct: received ? Math.round(((received - paid) / received) * 100) : 0,
    agingSum: aging.s, agingCount: aging.c,
    byStage, byCarrier: byCarrierAR, byCaseType, coordinators,
    attorneyRate: ptCount ? Math.round((attyCount / ptCount) * 1000) / 10 : 0,
    attorneyCount: attyCount, patientCount: ptCount,
    avgIntakeToTreating,
    intakeQueue: (db.prepare("SELECT COUNT(*) c FROM intake_items WHERE status IN ('triage','queued')").get() as any).c,
    pendingApprovals: (db.prepare('SELECT COUNT(*) c FROM users WHERE approved=0').get() as any).c,
    // Board pack extras
    byLob: (db.prepare(`SELECT p.caseType, COALESCE(SUM(CASE WHEN r.status='Cleared' AND r.voided=0 THEN r.amount END),0) recv
      FROM patients p LEFT JOIN receipts r ON r.patientId=p.id GROUP BY p.caseType`).all() as any[]).map((x: any) => {
      const paidL = (db.prepare(`SELECT COALESCE(SUM(b.rate),0) s FROM bills b JOIN patients p ON p.id=b.patientId
        WHERE p.caseType=? AND b.status='paid' AND b.voided=0`).get(x.caseType) as any).s;
      return { caseType: x.caseType, received: x.recv, paidOut: paidL, margin: x.recv - paidL };
    }),
    costPerCase: (() => {
      const closed = db.prepare('SELECT COUNT(*) c FROM patients WHERE stage>=3').get() as any;
      const totBilled = (db.prepare(`SELECT COALESCE(SUM(b.billed),0) s FROM bills b JOIN patients p ON p.id=b.patientId WHERE p.stage>=3 AND b.voided=0`).get() as any).s;
      return closed.c ? Math.round(totBilled / closed.c) : null;
    })(),
    concentration: (() => {
      const rows = db.prepare(`SELECT p.insurerId, COALESCE(SUM(r.amount),0) s FROM receipts r JOIN patients p ON p.id=r.patientId
        WHERE r.voided=0 GROUP BY p.insurerId ORDER BY s DESC`).all() as any[];
      const tot = rows.reduce((s, r) => s + r.s, 0);
      return tot && rows[0] ? Math.round(rows[0].s / tot * 100) : null;
    })(),
    writtenOff: (db.prepare(`SELECT COALESCE(SUM(billed),0) s, COUNT(*) c FROM bills WHERE appealStatus='written-off' AND voided=0`).get() as any),
    driftCount: driftReport().length,
  });
});

api.get('/alerts', (req, res) => {
  const mine = req.user!.role === 'coordinator';
  const pts = (db.prepare('SELECT * FROM patients' + (mine ? ' WHERE coordinator=?' : '')).all(...(mine ? [req.user!.id] : [])) as any[]);
  const today = new Date().toISOString().slice(0, 10);
  const cutoff30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const cutoff14 = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  const alerts: any[] = [];
  if (req.user!.role === 'admin') {
    const lastFeeRef = db.prepare('SELECT * FROM fee_refreshes ORDER BY id DESC LIMIT 1').get() as any;
    if (lastFeeRef?.status === 'failed')
      alerts.push({ severity: 'high', patientId: 'FEES', patientName: 'Fee tool', text: `Medicare fee refresh failed: ${String(lastFeeRef.detail || '').slice(0, 90)}` });
  }
  for (const p of pts) {
    for (const t of db.prepare('SELECT * FROM tasks WHERE patientId=? AND due IS NOT NULL AND due<?').all(p.id, today) as any[])
      alerts.push({ severity: 'high', patientId: p.id, patientName: p.name, text: `Overdue task: "${t.title}" (due ${fmtDate(t.due)})` });
    for (const b of db.prepare("SELECT * FROM bills WHERE patientId=? AND status='unpaid' AND voided=0 AND dos<?").all(p.id, cutoff30) as any[])
      alerts.push({ severity: 'high', patientId: p.id, patientName: p.name, text: `Bill unpaid 30+ days: DOS ${fmtDate(b.dos)} · ${fmt$(b.billed)}` });
    for (const r of db.prepare("SELECT * FROM receipts WHERE patientId=? AND status='Pending' AND voided=0 AND date<?").all(p.id, cutoff14) as any[])
      alerts.push({ severity: 'med', patientId: p.id, patientName: p.name, text: `Receipt pending 14+ days: ${fmt$(r.amount)} (${r.ref || ''})` });
    // Carrier-configured thresholds (from the partnership onboarding — config that executes)
    if (p.insurerId && p.stage < 4) {
      const cfgRow = db.prepare('SELECT onboarding FROM insurers WHERE id=?').get(p.insurerId) as any;
      if (cfgRow?.onboarding) {
        try {
          const cfg = JSON.parse(cfgRow.onboarding);
          const usageAll = (db.prepare('SELECT COALESCE(SUM(billed),0) s FROM bills WHERE patientId=? AND voided=0').get(p.id) as any).s;
          const pct = Number(cfg.thresholds?.coveragePct);
          if (pct > 0 && p.uwLimit > 0 && usageAll / p.uwLimit * 100 >= pct)
            alerts.push({ severity: 'high', patientId: p.id, patientName: p.name, text: `Carrier threshold hit: ${Math.round(usageAll / p.uwLimit * 100)}% of coverage used (their flag: ${pct}%) — notify per protocol` });
          const balFlag = Number(cfg.thresholds?.balanceFlag);
          if (balFlag > 0 && usageAll >= balFlag)
            alerts.push({ severity: 'high', patientId: p.id, patientName: p.name, text: `Carrier threshold hit: balance ${fmt$(usageAll)} ≥ their ${fmt$(balFlag)} flag — notify per protocol` });
        } catch { /* bad config */ }
      }
    }
    if (p.stage >= 2 && p.stage < 4 && !p.carrierConfirmed)
      alerts.push({ severity: 'high', patientId: p.id, patientName: p.name, text: 'Treating without carrier coverage confirmation — verify with carrier now' });
    if (p.attorneyRetained && p.caseType === 'trilopay' && p.stage < 4)
      alerts.push({ severity: 'high', patientId: p.id, patientName: p.name, text: 'Attorney involved on PIP case — verify where the flow of funds is going' });
    if (p.uwLimit > 0 && p.stage < 4) {
      const outside = (db.prepare('SELECT COALESCE(SUM(amt),0) s FROM outside_bills WHERE patientId=?').get(p.id) as any).s;
      const usage = (db.prepare('SELECT COALESCE(SUM(billed),0) s FROM bills WHERE patientId=? AND voided=0').get(p.id) as any).s;
      const remaining = p.uwLimit - outside - usage;
      if (remaining < 0)
        alerts.push({ severity: 'high', patientId: p.id, patientName: p.name, text: `Coverage exceeded by ${fmt$(-remaining)} — stop treatment authorization review needed` });
      else if (remaining < p.uwLimit * 0.15)
        alerts.push({ severity: 'med', patientId: p.id, patientName: p.name, text: `Coverage nearly exhausted: ${fmt$(remaining)} remaining` });
    }
  }
  res.json(alerts);
});

api.get('/tasks', (_req, res) => {
  res.json(db.prepare(`SELECT t.id, t.patientId, p.name as patientName, t.title, t.due, t.created, t.by
    FROM tasks t JOIN patients p ON p.id=t.patientId ORDER BY t.due IS NULL, t.due`).all());
});

api.get('/search', (req, res) => {
  const q = String(req.query.q || '').toLowerCase();
  if (!q) return res.json([]);
  const like = `%${q}%`;
  res.json({
    patients: db.prepare("SELECT id,name,caseType,stage FROM patients WHERE lower(name||id||COALESCE(phone,'')||COALESCE(email,'')) LIKE ? LIMIT 8").all(like),
    providers: db.prepare("SELECT id,name,type,status FROM providers WHERE lower(name||id||COALESCE(type,'')) LIKE ? LIMIT 8").all(like),
    insurers: db.prepare('SELECT id,name FROM insurers WHERE lower(name||id) LIKE ? LIMIT 8').all(like),
  });
});

/* ================= patients ================= */
api.get('/patients/:id', (req, res) => {
  const p = fullPatient(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json(p);
});

api.post('/patients', (req, res) => {
  const v = req.body || {};
  if (!String(v.name || '').trim()) return res.status(400).json({ error: 'Name is required' });
  // Duplicate detection: same name, or same DOB + same last name. Pass force:true to create anyway.
  if (!v.force) {
    const nameL = v.name.trim().toLowerCase();
    const lastWord = nameL.split(/\s+/).pop();
    const dups = (db.prepare('SELECT id,name,dob,phone FROM patients').all() as any[]).filter(p => {
      const pn = String(p.name || '').toLowerCase();
      return pn === nameL || (v.dob && p.dob === v.dob && lastWord && pn.includes(lastWord));
    });
    if (dups.length) {
      audit(req.user!, 'patient.duplicateWarning', 'patient', undefined, v.name);
      return res.status(409).json({ error: 'Possible duplicate patient', duplicates: dups });
    }
  }
  const id = nextId('pt');
  let adjusterId: string | null = v.adjusterId || null;
  if (!adjusterId && v.adjusterName && v.insurerId) {
    const existing = db.prepare('SELECT id FROM adjusters WHERE insurerId=? AND lower(name)=lower(?)').get(v.insurerId, v.adjusterName) as any;
    if (existing) adjusterId = existing.id;
    else {
      adjusterId = 'a' + Date.now();
      db.prepare('INSERT INTO adjusters(id,insurerId,name) VALUES(?,?,?)').run(adjusterId, v.insurerId, v.adjusterName);
    }
  }
  db.prepare(`INSERT INTO patients(id,name,caseType,phone,email,address,dob,doi,state,insurerId,claimNumber,policyNumber,adjusterId,coordinator,companionId,accident)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, v.name, v.caseType || 'trilopay', v.phone || null, v.email || null, v.address || null,
      v.dob || null, v.doi || null, v.state || null, v.insurerId || null, v.claimNumber || null,
      v.policyNumber || null, adjusterId, v.coordinator || req.user!.id, v.companionId || null, v.accident || null);
  if (v.companionId) db.prepare('UPDATE patients SET companionId=? WHERE id=?').run(id, v.companionId);
  for (const c of ['agentName', 'agentContact', 'agentAuth', 'referralSource'])
    if (v[c] !== undefined) db.prepare(`UPDATE patients SET ${c}=? WHERE id=?`).run(v[c] || null, id);
  recordStage(id, 0);
  // Coverage auto-populate: assume the state minimum until verified with the carrier.
  if (v.state) {
    const covType = (v.caseType === 'trilogy') ? 'BI' : 'PIP';
    const sm = db.prepare('SELECT * FROM state_minimums WHERE lower(state)=lower(?) AND coverageType=?').get(v.state.trim(), covType) as any;
    if (sm) {
      db.prepare("UPDATE patients SET uwLimit=?, uwCoverage=?, uwStatus='Assumed minimum' WHERE id=?")
        .run(sm.amount, `${covType} — assumed ${v.state} minimum ($${sm.amount.toLocaleString()})`, id);
      addNote(id, `Coverage auto-populated: assumed ${v.state} ${covType} minimum $${sm.amount.toLocaleString()} — verify with carrier`, req.user!.name);
    }
  }
  addNote(id, 'Profile created', req.user!.name);
  audit(req.user!, 'patient.create', 'patient', id, v.name);
  res.json(fullPatient(id));
});

api.patch('/patients/:id', (req, res) => {
  const id = req.params.id;
  const p = db.prepare('SELECT * FROM patients WHERE id=?').get(id) as any;
  if (!p) return res.status(404).json({ error: 'Not found' });
  const v = req.body || {};
  const cols = ['name', 'caseType', 'phone', 'email', 'address', 'dob', 'doi', 'state', 'insurerId', 'claimNumber', 'policyNumber', 'adjusterId', 'accident', 'attorneyRetained', 'attorneyDate', 'attorneyFirm', 'escalated', 'agentName', 'agentContact', 'agentAuth', 'referralSource', 'carrierConfirmed', 'consentSharing'];
  if ('carrierConfirmed' in v && Number(v.carrierConfirmed) === 1)
    addNote(id, '✓ Coverage verified with carrier — case cleared to proceed', req.user!.name);
  if ('attorneyRetained' in v && Number(v.attorneyRetained) === 1 && !(db.prepare('SELECT attorneyRetained FROM patients WHERE id=?').get(id) as any).attorneyRetained)
    addNote(id, `⚠ ATTORNEY RETAINED${v.attorneyFirm ? ': ' + v.attorneyFirm : ''}${v.attorneyDate ? ' (as of ' + fmtDate(v.attorneyDate) + ')' : ''} — thesis metric recorded`, req.user!.name);
  for (const c of cols) if (c in v) db.prepare(`UPDATE patients SET ${c}=? WHERE id=?`).run(v[c] === '' ? null : v[c], id);
  addNote(id, 'Profile details edited', req.user!.name);
  audit(req.user!, 'patient.update', 'patient', id);
  res.json(fullPatient(id));
});

api.post('/patients/:id/stage', (req, res) => {
  const STAGES = ['Intake', 'Underwriting', 'Treating', 'Done Treating', 'Paid Out'];
  const id = req.params.id;
  const p = db.prepare('SELECT stage FROM patients WHERE id=?').get(id) as any;
  if (!p) return res.status(404).json({ error: 'Not found' });
  const stage = Number(req.body?.stage);
  if (!(stage >= 0 && stage < STAGES.length)) return res.status(400).json({ error: 'Bad stage' });
  db.prepare('UPDATE patients SET stage=? WHERE id=?').run(stage, id);
  recordStage(id, stage);
  addNote(id, `Status changed: ${STAGES[p.stage]} → ${STAGES[stage]}`, req.user!.name);
  audit(req.user!, 'patient.stage', 'patient', id, STAGES[stage]);
  res.json(fullPatient(id));
});

api.post('/patients/:id/coordinator', (req, res) => {
  const id = req.params.id;
  const u = db.prepare('SELECT name FROM users WHERE id=?').get(req.body?.coordinator) as any;
  if (!u) return res.status(400).json({ error: 'Unknown coordinator' });
  db.prepare('UPDATE patients SET coordinator=? WHERE id=?').run(req.body.coordinator, id);
  addNote(id, 'Coordinator assigned: ' + u.name, req.user!.name);
  audit(req.user!, 'patient.coordinator', 'patient', id, u.name);
  res.json(fullPatient(id));
});

api.post('/patients/:id/companion', (req, res) => {
  const id = req.params.id;
  const p = db.prepare('SELECT companionId FROM patients WHERE id=?').get(id) as any;
  if (!p) return res.status(404).json({ error: 'Not found' });
  if (p.companionId) db.prepare('UPDATE patients SET companionId=NULL WHERE id=?').run(p.companionId);
  const cid = req.body?.companionId || null;
  db.prepare('UPDATE patients SET companionId=? WHERE id=?').run(cid, id);
  if (cid) {
    const c = db.prepare('SELECT name FROM patients WHERE id=?').get(cid) as any;
    db.prepare('UPDATE patients SET companionId=? WHERE id=?').run(id, cid);
    addNote(id, `Companion claim linked: ${c?.name} (${cid})`, req.user!.name);
  } else addNote(id, 'Companion claim unlinked', req.user!.name);
  audit(req.user!, 'patient.companion', 'patient', id, cid ?? 'unlinked');
  res.json(fullPatient(id));
});

/* ---- case messages (staff side of portal threads) ---- */
api.post('/patients/:id/messages', (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text || text.length > 5000) return res.status(400).json({ error: 'Message required (max 5,000 chars)' });
  db.prepare('INSERT INTO case_messages(patientId,authorName,authorType,text,time) VALUES(?,?,?,?,?)')
    .run(req.params.id, req.user!.name, 'staff', text, nowMST());
  audit(req.user!, 'message.send', 'patient', req.params.id);
  res.json(fullPatient(req.params.id));
});

/* ---- notes ---- */
api.post('/patients/:id/notes', (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Empty note' });
  if (text.length > 10000) return res.status(400).json({ error: 'Note too long (10,000 character max)' });
  addNote(req.params.id, text, req.user!.name, false);
  db.prepare('UPDATE notes SET sys=0 WHERE id=(SELECT MAX(id) FROM notes WHERE patientId=?)').run(req.params.id);
  audit(req.user!, 'note.add', 'patient', req.params.id);
  res.json(fullPatient(req.params.id));
});

/* ---- tasks ---- */
api.post('/patients/:id/tasks', (req, res) => {
  const title = String(req.body?.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Title required' });
  const tid = 't' + Date.now() + Math.floor(Math.random() * 1000);
  db.prepare('INSERT INTO tasks(id,patientId,title,due,created,by) VALUES(?,?,?,?,?,?)')
    .run(tid, req.params.id, title, req.body?.due || null, nowMST(), req.user!.name);
  addNote(req.params.id, `Task created: "${title}"` + (req.body?.due ? ` (due ${fmtDate(req.body.due)})` : ''), req.user!.name);
  audit(req.user!, 'task.create', 'task', tid, title);
  res.json(fullPatient(req.params.id));
});

api.post('/tasks/:tid/snooze', (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.tid) as any;
  if (!t) return res.status(404).json({ error: 'Not found' });
  const due = String(req.body?.due || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return res.status(400).json({ error: 'Pick a date' });
  db.prepare('UPDATE tasks SET due=? WHERE id=?').run(due, t.id);
  addNote(t.patientId, `Task pushed out: "${t.title}" — ${fmtDate(t.due)} → ${fmtDate(due)}`, req.user!.name);
  audit(req.user!, 'task.snooze', 'task', t.id, due);
  res.json(fullPatient(t.patientId));
});

api.post('/tasks/:tid/complete', (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.tid) as any;
  if (!t) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM tasks WHERE id=?').run(t.id);
  addNote(t.patientId, `Task completed: "${t.title}"`, req.user!.name);
  audit(req.user!, 'task.complete', 'task', t.id, t.title);
  res.json(fullPatient(t.patientId));
});

api.post('/tasks/:tid/comments', (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.tid) as any;
  if (!t) return res.status(404).json({ error: 'Not found' });
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Empty comment' });
  db.prepare('INSERT INTO task_comments(taskId,text,by,time) VALUES(?,?,?,?)').run(t.id, text, req.user!.name, nowMST());
  audit(req.user!, 'task.comment', 'task', t.id);
  res.json(fullPatient(t.patientId));
});

/* ---- underwriting ---- */
api.patch('/patients/:id/uw', (req, res) => {
  const v = req.body || {};
  db.prepare('UPDATE patients SET uwStatus=?,uwCoverage=?,uwLimit=?,uwRiskFlags=?,uwApprovedBy=? WHERE id=?')
    .run(v.status ?? 'Not started', v.coverage ?? null, Number(v.limit) || 0, v.riskFlags ?? null, v.approvedBy ?? null, req.params.id);
  addNote(req.params.id, `Underwriting updated (${v.status})`, req.user!.name);
  audit(req.user!, 'uw.update', 'patient', req.params.id);
  res.json(fullPatient(req.params.id));
});

api.post('/patients/:id/outside-bills', (req, res) => {
  const descr = String(req.body?.desc || '').trim();
  const amt = Number(req.body?.amt);
  if (!descr || !(amt > 0)) return res.status(400).json({ error: 'A note and a positive amount are required' });
  db.prepare('INSERT INTO outside_bills(patientId,descr,amt) VALUES(?,?,?)').run(req.params.id, descr, amt);
  addNote(req.params.id, `Outside medical bill added: ${descr} ${fmt$(amt)} — coverage remaining recalculated`, req.user!.name);
  audit(req.user!, 'uw.outsideBill.add', 'patient', req.params.id, `${descr} ${amt}`);
  res.json(fullPatient(req.params.id));
});

api.delete('/outside-bills/:obid', (req, res) => {
  const ob = db.prepare('SELECT * FROM outside_bills WHERE id=?').get(req.params.obid) as any;
  if (!ob) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM outside_bills WHERE id=?').run(ob.id);
  addNote(ob.patientId, `Outside medical bill removed: ${ob.descr} ${fmt$(ob.amt)}`, req.user!.name);
  audit(req.user!, 'uw.outsideBill.remove', 'patient', ob.patientId);
  res.json(fullPatient(ob.patientId));
});

/* ---- provider links & authorizations ---- */
api.post('/patients/:id/provlinks', (req, res) => {
  const { providerId, branch } = req.body || {};
  const pr = db.prepare('SELECT name FROM providers WHERE id=?').get(providerId) as any;
  if (!pr) return res.status(400).json({ error: 'Unknown provider' });
  try {
    db.prepare('INSERT INTO prov_links(patientId,providerId,branch) VALUES(?,?,?)').run(req.params.id, providerId, branch || null);
  } catch { return res.status(400).json({ error: 'Provider already linked' }); }
  addNote(req.params.id, `Provider linked: ${pr.name}${branch ? ` (${branch})` : ''} — status: Pending`, req.user!.name);
  audit(req.user!, 'provlink.create', 'patient', req.params.id, providerId);
  res.json(fullPatient(req.params.id));
});

api.post('/provlinks/:lid/action', (req, res) => {
  const l = db.prepare('SELECT * FROM prov_links WHERE id=?').get(req.params.lid) as any;
  if (!l) return res.status(404).json({ error: 'Not found' });
  const pr = db.prepare('SELECT name FROM providers WHERE id=?').get(l.providerId) as any;
  const kind = String(req.body?.kind);
  const amount = Number(req.body?.amount) || 0;
  const sd = (name: string) => db.prepare('INSERT INTO sent_docs(patientId,name,toStr,time,status,method) VALUES(?,?,?,?,?,?)')
    .run(l.patientId, name, pr.name, nowMST(), 'Sent', 'Email');

  if (kind === 'auth' || kind === 'addauth') {
    if (!(amount > 0)) return res.status(400).json({ error: 'Authorization amount must be positive' });
    db.prepare('UPDATE prov_links SET authAmount=authAmount+?, authCount=authCount+1, status=? WHERE id=?').run(amount, 'authorized', l.id);
    addNote(l.patientId, `${kind === 'auth' ? 'Authorization' : 'Additional authorization'} sent to ${pr.name}: ${fmt$(amount)} (total ${fmt$(l.authAmount + amount)}) — status: Authorized`, req.user!.name);
    sd(kind === 'auth' ? 'Authorization' : "Add'l Authorization");
  } else if (kind === 'reqform') {
    addNote(l.patientId, `Add'l auth request form sent to ${pr.name} (for provider to fill & return)`, req.user!.name);
    sd("Add'l Authorization Request Form");
  } else if (kind === 'cxl') {
    if (l.status === 'finalized') return res.status(400).json({ error: 'Already finalized' });
    db.prepare("UPDATE prov_links SET status='canceled' WHERE id=?").run(l.id);
    addNote(l.patientId, `Cancel-authorization form sent to ${pr.name} (verifies all transactions; awaiting signature) — status: Canceled`, req.user!.name);
    sd('Cancellation of Authorization Form');
  } else if (kind === 'cxlback') {
    if (l.status !== 'canceled') return res.status(400).json({ error: 'Send the cancel form first' });
    db.prepare("UPDATE prov_links SET status='finalized' WHERE id=?").run(l.id);
    addNote(l.patientId, `Signed cancel-auth form received from ${pr.name} — status: Finalized`, req.user!.name);
  } else return res.status(400).json({ error: 'Unknown action' });

  audit(req.user!, 'provlink.' + kind, 'patient', l.patientId, pr.name);
  res.json(fullPatient(l.patientId));
});

/* ---- bills / receipts / payments ---- */
api.post('/patients/:id/bills', (req, res) => {
  const v = req.body || {};
  const pr = db.prepare('SELECT name FROM providers WHERE id=?').get(v.providerId) as any;
  if (!pr) return res.status(400).json({ error: 'Unknown provider' });
  const lineItems: any[] = Array.isArray(v.items) ? v.items.filter((x: any) => x.cpt || Number(x.charge)) : [];
  const billedIn = Number(v.billed) || lineItems.reduce((s, x) => s + (Number(x.charge) || 0) * (Number(x.units) || 1), 0);
  v.billed = billedIn;
  if (!(billedIn > 0)) return res.status(400).json({ error: 'Billed amount (or CPT line items) required' });
  if (Number(v.rate) < 0) return res.status(400).json({ error: 'Payout cannot be negative' });
  const link = db.prepare('SELECT * FROM prov_links WHERE patientId=? AND providerId=?').get(req.params.id, v.providerId) as any;
  if (!link) return res.status(400).json({ error: 'Link this provider to the patient first (Medical Providers tab)' });

  // Contracted-rate engine: revenue from carrier CPT prices, payout from provider CPT rates or branch % (w/ timely-filing tier).
  const pRow = db.prepare('SELECT insurerId FROM patients WHERE id=?').get(req.params.id) as any;
  const eco = computeBillEconomics(pRow?.insurerId || null, v.providerId, link.branch, lineItems, billedIn, v.dos || null);
  let rate = Number(v.rate) || eco.payout || 0;
  let rateNote = '';
  if (!Number(v.rate) && eco.payout) rateNote = ` · payout auto: ${fmt$(eco.payout)}`;
  if (eco.revenue) rateNote += ` · contracted revenue: ${fmt$(eco.revenue)} (margin ${fmt$(eco.revenue - rate)})`;
  if (eco.revenueMissing.length) rateNote += ` ⚠ no carrier rate on file for CPT ${eco.revenueMissing.join(', ')}`;
  const bid = 'b' + Date.now() + Math.floor(Math.random() * 1000);
  db.prepare('INSERT INTO bills(id,patientId,providerId,dos,billed,rate,revenue) VALUES(?,?,?,?,?,?,?)')
    .run(bid, req.params.id, v.providerId, v.dos || null, Number(v.billed), rate, eco.revenue);
  for (const x of lineItems)
    db.prepare('INSERT INTO bill_items(billId,cpt,icd,units,charge,modifier) VALUES(?,?,?,?,?,?)')
      .run(bid, x.cpt || null, x.icd || null, Number(x.units) || 1, Number(x.charge) || 0, x.modifier || null);
  db.prepare('UPDATE prov_links SET billed=billed+? WHERE patientId=? AND providerId=?').run(Number(v.billed), req.params.id, v.providerId);
  addNote(req.params.id, `Bill added: ${pr.name} · DOS ${fmtDate(v.dos)} · ${fmt$(Number(v.billed))}${rateNote} — attach the bill + visit note files to unlock payment`, req.user!.name);
  audit(req.user!, 'bill.create', 'bill', bid);
  res.json(fullPatient(req.params.id));
});

/* Set/correct the payout on an unpaid bill. */
api.patch('/bills/:bid', (req, res) => {
  const b = db.prepare('SELECT * FROM bills WHERE id=?').get(req.params.bid) as any;
  if (!b) return res.status(404).json({ error: 'Not found' });
  if (b.status === 'paid') return res.status(400).json({ error: 'Bill already paid — void it and re-enter instead' });
  if (b.voided) return res.status(400).json({ error: 'Bill is voided' });
  const rate = Number(req.body?.rate);
  if (!(rate >= 0)) return res.status(400).json({ error: 'Payout must be zero or more' });
  db.prepare('UPDATE bills SET rate=? WHERE id=?').run(rate, b.id);
  addNote(b.patientId, `Payout corrected on DOS ${fmtDate(b.dos)} bill: ${fmt$(b.rate)} → ${fmt$(rate)}`, req.user!.name);
  audit(req.user!, 'bill.rateChange', 'bill', b.id, `${b.rate} → ${rate}`);
  res.json(fullPatient(b.patientId));
});

/* Void a bill (correction flow — never deletes, always audited). */
api.post('/bills/:bid/void', (req, res) => {
  const b = db.prepare('SELECT * FROM bills WHERE id=?').get(req.params.bid) as any;
  if (!b) return res.status(404).json({ error: 'Not found' });
  if (b.voided) return res.status(400).json({ error: 'Already voided' });
  const reason = String(req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'A reason is required to void' });
  db.prepare('UPDATE bills SET voided=1, voidReason=? WHERE id=?').run(reason, b.id);
  db.prepare('UPDATE prov_links SET billed=MAX(0,billed-?) WHERE patientId=? AND providerId=?').run(b.billed, b.patientId, b.providerId);
  db.prepare('DELETE FROM receipt_bills WHERE billId=?').run(b.id);
  const pr = db.prepare('SELECT name FROM providers WHERE id=?').get(b.providerId) as any;
  addNote(b.patientId, `Bill VOIDED: ${pr?.name} · DOS ${fmtDate(b.dos)} · ${fmt$(b.billed)} — reason: ${reason}` +
    (b.status === 'paid' ? ` ⚠ this bill was already PAID ${fmt$(b.rate)} — recover the payment separately` : ''), req.user!.name);
  audit(req.user!, 'bill.void', 'bill', b.id, reason);
  res.json(fullPatient(b.patientId));
});

/* Void a receipt. */
api.post('/receipts/:rid/void', (req, res) => {
  const r = db.prepare('SELECT * FROM receipts WHERE id=?').get(req.params.rid) as any;
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (r.voided) return res.status(400).json({ error: 'Already voided' });
  const reason = String(req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'A reason is required to void' });
  db.prepare('UPDATE receipts SET voided=1, voidReason=? WHERE id=?').run(reason, r.id);
  db.prepare('DELETE FROM receipt_bills WHERE receiptId=?').run(r.id);
  addNote(r.patientId, `Receipt VOIDED: ${fmt$(r.amount)} (${r.ref || ''}) — reason: ${reason}`, req.user!.name);
  audit(req.user!, 'receipt.void', 'receipt', String(r.id), reason);
  res.json(fullPatient(r.patientId));
});

/* Reconciliation: link a receipt to the bills it covers. */
api.post('/receipts/:rid/link', (req, res) => {
  const r = db.prepare('SELECT * FROM receipts WHERE id=?').get(req.params.rid) as any;
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (r.voided) return res.status(400).json({ error: 'Receipt is voided' });
  const billIds: string[] = Array.isArray(req.body?.billIds) ? req.body.billIds : [];
  for (const bid of billIds) {
    const b = db.prepare('SELECT patientId FROM bills WHERE id=?').get(bid) as any;
    if (!b || b.patientId !== r.patientId) return res.status(400).json({ error: 'Bill ' + bid + ' does not belong to this patient' });
  }
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM receipt_bills WHERE receiptId=?').run(r.id);
    for (const bid of billIds) db.prepare('INSERT INTO receipt_bills(receiptId,billId) VALUES(?,?)').run(r.id, bid);
  });
  tx();
  addNote(r.patientId, `Receipt ${fmt$(r.amount)} (${r.ref || ''}) reconciled to ${billIds.length} bill${billIds.length === 1 ? '' : 's'}`, req.user!.name);
  audit(req.user!, 'receipt.link', 'receipt', String(r.id), billIds.join(','));
  res.json(fullPatient(r.patientId));
});

api.post('/bills/:bid/attach/:field', upload.single('file'), (req, res) => {
  const b = db.prepare('SELECT * FROM bills WHERE id=?').get(req.params.bid) as any;
  if (!b) return res.status(404).json({ error: 'Not found' });
  if (b.voided) return res.status(400).json({ error: 'Bill is voided' });
  const field = req.params.field === 'bill' ? 'bill' : 'note';
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const fid = req.file.filename;
  db.prepare('INSERT INTO files(id,name,mime,size,uploadedBy,time) VALUES(?,?,?,?,?,?)')
    .run(fid, req.file.originalname, req.file.mimetype, req.file.size, req.user!.name, nowMST());
  if (field === 'bill') db.prepare('UPDATE bills SET hasBill=1,billFileId=?,billFileName=? WHERE id=?').run(fid, req.file.originalname, b.id);
  else db.prepare('UPDATE bills SET hasNote=1,noteFileId=?,noteFileName=? WHERE id=?').run(fid, req.file.originalname, b.id);
  const pr = db.prepare('SELECT name FROM providers WHERE id=?').get(b.providerId) as any;
  addNote(b.patientId, `${field === 'bill' ? 'Bill file' : 'Visit note file'} attached: "${req.file.originalname}" for DOS ${fmtDate(b.dos)} (${pr?.name || ''})`, req.user!.name);
  audit(req.user!, 'bill.attach.' + field, 'bill', b.id, req.file.originalname);
  res.json(fullPatient(b.patientId));
});

api.get('/files/:fid', (req, res) => {
  const f = db.prepare('SELECT * FROM files WHERE id=?').get(req.params.fid) as any;
  if (!f) return res.status(404).json({ error: 'Not found' });
  const p = path.join(UPLOAD_DIR, f.id);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'File missing on disk' });
  res.setHeader('Content-Type', f.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(f.name)}"`);
  fs.createReadStream(p).pipe(res);
});

api.post('/bills/:bid/pay', (req, res) => {
  const b = db.prepare('SELECT * FROM bills WHERE id=?').get(req.params.bid) as any;
  if (!b) return res.status(404).json({ error: 'Not found' });
  if (b.voided) return res.status(400).json({ error: 'Bill is voided' });
  if (b.status === 'paid') return res.status(400).json({ error: 'Already paid' });
  if (!b.hasBill || !b.hasNote) return res.status(400).json({ error: 'Attach bill + visit note before paying' });
  if (!(b.rate > 0)) return res.status(400).json({ error: 'Set the payout amount first (auto-calculates when the branch has a numeric rate)' });
  const paidDate = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
  db.prepare("UPDATE bills SET status='paid',paidDate=? WHERE id=?").run(paidDate, b.id);
  const pr = db.prepare('SELECT name FROM providers WHERE id=?').get(b.providerId) as any;
  addNote(b.patientId, `Payment sent: ${fmt$(b.rate)} to ${pr?.name} (DOS ${fmtDate(b.dos)})`, req.user!.name);
  audit(req.user!, 'bill.pay', 'bill', b.id, String(b.rate));
  res.json(fullPatient(b.patientId));
});

api.post('/patients/:id/receipts', (req, res) => {
  const v = req.body || {};
  if (!(Number(v.amount) > 0)) return res.status(400).json({ error: 'Amount must be a positive number' });
  db.prepare('INSERT INTO receipts(patientId,date,ref,amount,status) VALUES(?,?,?,?,?)')
    .run(req.params.id, v.date || null, v.ref || null, Number(v.amount), v.status || 'Pending');
  addNote(req.params.id, `Insurance receipt recorded: ${fmt$(Number(v.amount))} (${v.ref || ''})`, req.user!.name);
  audit(req.user!, 'receipt.create', 'patient', req.params.id, String(v.amount));
  res.json(fullPatient(req.params.id));
});

api.post('/receipts/:rid/toggle', (req, res) => {
  const r = db.prepare('SELECT * FROM receipts WHERE id=?').get(req.params.rid) as any;
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (r.voided) return res.status(400).json({ error: 'Receipt is voided' });
  const status = r.status === 'Cleared' ? 'Pending' : 'Cleared';
  db.prepare('UPDATE receipts SET status=? WHERE id=?').run(status, r.id);
  addNote(r.patientId, `Receipt ${status.toLowerCase()}: ${fmt$(r.amount)} (${r.ref || ''})`, req.user!.name);
  audit(req.user!, 'receipt.toggle', 'receipt', String(r.id), status);
  res.json(fullPatient(r.patientId));
});

/* ---- sent docs & documents ---- */
api.post('/patients/:id/sentdocs', (req, res) => {
  const v = req.body || {};
  if (!v.name) return res.status(400).json({ error: 'Template required' });
  db.prepare('INSERT INTO sent_docs(patientId,name,toStr,time,status,method) VALUES(?,?,?,?,?,?)')
    .run(req.params.id, v.name, v.to || '—', nowMST(), 'Sent', v.method || 'Email');
  addNote(req.params.id, `Contract sent: "${v.name}" to ${v.to || '—'} via ${v.method || 'Email'}`, req.user!.name);
  audit(req.user!, 'sentdoc.create', 'patient', req.params.id, v.name);
  res.json(fullPatient(req.params.id));
});

api.post('/sentdocs/:sid/advance', (req, res) => {
  const d = db.prepare('SELECT * FROM sent_docs WHERE id=?').get(req.params.sid) as any;
  if (!d) return res.status(404).json({ error: 'Not found' });
  const status = d.status === 'Sent' ? 'Viewed' : 'Signed';
  db.prepare('UPDATE sent_docs SET status=? WHERE id=?').run(status, d.id);
  if (status === 'Signed') {
    addNote(d.patientId, `Contract signed: "${d.name}" by ${d.toStr}`, req.user!.name);
    if (/bill pay|mbpa|mppa|lac|consent/i.test(d.name)) {
      db.prepare('UPDATE patients SET consentSharing=1 WHERE id=?').run(d.patientId);
      addNote(d.patientId, '✓ Patient consent on file — carrier portal may now access bills & records for this case', req.user!.name);
    }
  }
  audit(req.user!, 'sentdoc.advance', 'sentdoc', String(d.id), status);
  res.json(fullPatient(d.patientId));
});

api.post('/patients/:id/documents', upload.single('file'), (req, res) => {
  const name = req.file?.originalname || String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name or file required' });
  let fid: string | null = null;
  if (req.file) {
    fid = req.file.filename;
    db.prepare('INSERT INTO files(id,name,mime,size,uploadedBy,time) VALUES(?,?,?,?,?,?)')
      .run(fid, name, req.file.mimetype, req.file.size, req.user!.name, nowMST());
  }
  db.prepare('INSERT INTO documents(patientId,name,cat,meta,fileId) VALUES(?,?,?,?,?)')
    .run(req.params.id, name, req.body?.cat || 'Misc', nowMST() + ' · ' + req.user!.name, fid);
  addNote(req.params.id, `Document added: "${name}"`, req.user!.name);
  audit(req.user!, 'document.create', 'patient', req.params.id, name);
  res.json(fullPatient(req.params.id));
});

/* ================= providers ================= */
api.post('/providers', (req, res) => {
  const v = req.body || {};
  if (!String(v.name || '').trim()) return res.status(400).json({ error: 'Name required' });
  const id = nextId('md');
  db.prepare('INSERT INTO providers(id,name,type,status,corpAddress,corpPhone,corpEmail,taxId,rules) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, v.name, v.type || null, JSON.stringify(v.status || []), v.corpAddress || null, v.corpPhone || null, v.corpEmail || null, v.taxId || null, JSON.stringify(v.rules || []));
  if (v.branch?.name) {
    const b = v.branch;
    db.prepare('INSERT INTO branches(providerId,name,address,phone,email,contacts,rate,status,ratePct,rateCap) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(id, b.name, b.address || null, b.phone || null, b.email || null, b.contacts || null, b.rate || null, (v.status || [])[0] || 'Under contract',
        Number(b.ratePct) || null, Number(b.rateCap) || null);
  }
  audit(req.user!, 'provider.create', 'provider', id, v.name);
  res.json(fullProvider(id));
});

api.patch('/providers/:id', (req, res) => {
  const v = req.body || {};
  const pr = db.prepare('SELECT id FROM providers WHERE id=?').get(req.params.id);
  if (!pr) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE providers SET name=?,type=?,status=?,corpAddress=?,corpPhone=?,corpEmail=?,taxId=?,rules=? WHERE id=?')
    .run(v.name, v.type || null, JSON.stringify(v.status || []), v.corpAddress || null, v.corpPhone || null, v.corpEmail || null, v.taxId || null, JSON.stringify(v.rules || []), req.params.id);
  for (const c of ['npi', 'licenseNo', 'licenseExp', 'malpracticeCarrier', 'malpracticeExp', 'w9OnFile', 'baaSigned', 'conservative'])
    if (c in v) db.prepare(`UPDATE providers SET ${c}=? WHERE id=?`).run(v[c] || null, req.params.id);
  audit(req.user!, 'provider.update', 'provider', req.params.id);
  res.json(fullProvider(req.params.id));
});

api.get('/providers/:id/stats', (req, res) => {
  const pr = fullProvider(req.params.id);
  if (!pr) return res.status(404).json({ error: 'Not found' });
  res.json(pr.branches.map((b: any) => ({ branchId: b.id, ...branchStats(pr.id, b.name, pr.branches.length), disputes: b.disputes })));
});

api.post('/providers/:id/branches', (req, res) => {
  const v = req.body || {};
  if (!String(v.name || '').trim()) return res.status(400).json({ error: 'Name required' });
  db.prepare('INSERT INTO branches(providerId,name,address,phone,email,contacts,rate,status,ratePct,rateCap) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(req.params.id, v.name, v.address || null, v.phone || null, v.email || null, v.contacts || null, v.rate || null,
      v.status || 'Under contract', Number(v.ratePct) || null, Number(v.rateCap) || null);
  audit(req.user!, 'branch.create', 'provider', req.params.id, v.name);
  res.json(fullProvider(req.params.id));
});

api.patch('/branches/:bid', (req, res) => {
  const b = db.prepare('SELECT * FROM branches WHERE id=?').get(req.params.bid) as any;
  if (!b) return res.status(404).json({ error: 'Not found' });
  const v = req.body || {};
  db.prepare('UPDATE branches SET name=?,address=?,phone=?,email=?,contacts=?,rate=?,status=?,contract=?,disputes=?,ratePct=?,rateCap=? WHERE id=?')
    .run(v.name ?? b.name, v.address ?? b.address, v.phone ?? b.phone, v.email ?? b.email, v.contacts ?? b.contacts,
      v.rate ?? b.rate, v.status ?? b.status, v.contract ?? b.contract, Number(v.disputes ?? b.disputes) || 0,
      v.ratePct !== undefined ? (Number(v.ratePct) || null) : b.ratePct,
      v.rateCap !== undefined ? (Number(v.rateCap) || null) : b.rateCap, b.id);
  if (v.name && v.name !== b.name)
    db.prepare('UPDATE prov_links SET branch=? WHERE providerId=? AND branch=?').run(v.name, b.providerId, b.name);
  audit(req.user!, 'branch.update', 'branch', String(b.id));
  res.json(fullProvider(b.providerId));
});

/* ================= insurers ================= */
api.post('/insurers', (req, res) => {
  const v = req.body || {};
  if (!String(v.name || '').trim()) return res.status(400).json({ error: 'Name required' });
  const id = nextId('ins');
  db.prepare('INSERT INTO insurers(id,name,hq,phone,email,relationship,payRate,states,rules) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, v.name, v.hq || null, v.phone || null, v.email || null, v.relationship || null, v.payRate || null,
      JSON.stringify(v.states || []), JSON.stringify(v.rules || []));
  if (v.adjuster?.name)
    db.prepare('INSERT INTO adjusters(id,insurerId,name,phone,email) VALUES(?,?,?,?,?)')
      .run('a' + Date.now(), id, v.adjuster.name, v.adjuster.phone || null, v.adjuster.email || null);
  audit(req.user!, 'insurer.create', 'insurer', id, v.name);
  res.json(fullInsurer(id));
});

api.patch('/insurers/:id', (req, res) => {
  const c = db.prepare('SELECT id FROM insurers WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const v = req.body || {};
  db.prepare('UPDATE insurers SET name=?,hq=?,phone=?,email=?,relationship=?,payRate=?,states=?,rules=? WHERE id=?')
    .run(v.name, v.hq || null, v.phone || null, v.email || null, v.relationship || null, v.payRate || null,
      JSON.stringify(v.states || []), JSON.stringify(v.rules || []), req.params.id);
  audit(req.user!, 'insurer.update', 'insurer', req.params.id);
  res.json(fullInsurer(req.params.id));
});

api.patch('/insurers/:id/manual-stats', (req, res) => {
  const v = req.body || {};
  db.prepare('UPDATE insurers SET avgDays=?,disputes=?,denialRate=? WHERE id=?')
    .run(Number(v.avgDays) || 0, Number(v.disputes) || 0, Number(v.denialRate) || 0, req.params.id);
  audit(req.user!, 'insurer.manualStats', 'insurer', req.params.id);
  res.json(fullInsurer(req.params.id));
});

api.get('/insurers/:id/stats', requireAdmin, (req, res) => {
  const c = fullInsurer(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json({ ...insAutoStats(c.id), avgDays: c.avgDays, disputes: c.disputes, denialRate: c.denialRate });
});

api.post('/insurers/:id/adjusters', (req, res) => {
  const v = req.body || {};
  if (!String(v.name || '').trim()) return res.status(400).json({ error: 'Name required' });
  db.prepare('INSERT INTO adjusters(id,insurerId,name,phone,email,contract,notes) VALUES(?,?,?,?,?,?,?)')
    .run('a' + Date.now(), req.params.id, v.name, v.phone || null, v.email || null, v.contract || null, v.notes || null);
  audit(req.user!, 'adjuster.create', 'insurer', req.params.id, v.name);
  res.json(fullInsurer(req.params.id));
});

api.patch('/adjusters/:aid', (req, res) => {
  const a = db.prepare('SELECT * FROM adjusters WHERE id=?').get(req.params.aid) as any;
  if (!a) return res.status(404).json({ error: 'Not found' });
  const v = req.body || {};
  db.prepare('UPDATE adjusters SET name=?,phone=?,email=?,contract=?,notes=? WHERE id=?')
    .run(v.name ?? a.name, v.phone ?? a.phone, v.email ?? a.email, v.contract ?? a.contract, v.notes ?? a.notes, a.id);
  audit(req.user!, 'adjuster.update', 'adjuster', a.id);
  res.json(fullInsurer(a.insurerId));
});

api.post('/insurers/:id/contracts', (req, res) => {
  const v = req.body || {};
  if (!String(v.name || '').trim()) return res.status(400).json({ error: 'Name required' });
  db.prepare('INSERT INTO ins_contracts(insurerId,name,meta,status) VALUES(?,?,?,?)')
    .run(req.params.id, v.name, v.meta || null, v.status || 'Active');
  audit(req.user!, 'insContract.create', 'insurer', req.params.id, v.name);
  res.json(fullInsurer(req.params.id));
});

/* ================= AI requests ================= */
api.get('/ai', (_req, res) => res.json(db.prepare('SELECT * FROM ai_requests ORDER BY id DESC').all()));
api.post('/ai', (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Empty' });
  db.prepare('INSERT INTO ai_requests(text,time,status,by) VALUES(?,?,?,?)').run(text, nowMST(), 'pending', req.user!.name);
  audit(req.user!, 'ai.request', undefined, undefined, text);
  res.json(db.prepare('SELECT * FROM ai_requests ORDER BY id DESC').all());
});
api.post('/ai/:aid/decide', requireAdmin, (req, res) => {
  const status = req.body?.status === 'approved' ? 'approved' : 'denied';
  db.prepare('UPDATE ai_requests SET status=? WHERE id=?').run(status, req.params.aid);
  audit(req.user!, 'ai.' + status, 'ai', req.params.aid);
  res.json(db.prepare('SELECT * FROM ai_requests ORDER BY id DESC').all());
});

/* ================= widget prefs ================= */
api.put('/prefs/:key', (req, res) => {
  const { color, size } = req.body || {};
  const existing = db.prepare('SELECT * FROM widget_prefs WHERE userId=? AND key=?').get(req.user!.id, req.params.key) as any;
  db.prepare(`INSERT INTO widget_prefs(userId,key,color,size) VALUES(?,?,?,?)
    ON CONFLICT(userId,key) DO UPDATE SET color=?, size=?`)
    .run(req.user!.id, req.params.key,
      color ?? existing?.color ?? null, size ?? existing?.size ?? null,
      color ?? existing?.color ?? null, size ?? existing?.size ?? null);
  res.json(db.prepare('SELECT key,color,size FROM widget_prefs WHERE userId=?').all(req.user!.id));
});

/* ================= admin: user management ================= */
api.get('/admin/users', requireAdmin, (_req, res) =>
  res.json((db.prepare('SELECT id,name,email,role,active,totpSecret,orgId,approved,perms FROM users').all() as any[])
    .map(u => ({
      id: u.id, name: u.name, email: u.email, role: u.role, active: u.active,
      perms: (() => { try { return JSON.parse(u.perms || '[]'); } catch { return []; } })(),
      mfaEnrolled: !!u.totpSecret, approved: u.approved, orgId: u.orgId,
      orgName: u.orgId
        ? ((db.prepare('SELECT name FROM providers WHERE id=?').get(u.orgId) as any)?.name
          || (db.prepare('SELECT name FROM insurers WHERE id=?').get(u.orgId) as any)?.name || u.orgId)
        : null,
    }))));

api.post('/admin/users/:uid/approve', requireAdmin, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.uid) as any;
  if (!u) return res.status(404).json({ error: 'Not found' });
  const approve = req.body?.approve !== false;
  const orgRole = req.body?.orgRole === 'admin' ? 'admin' : 'worker';
  if (approve) db.prepare('UPDATE users SET approved=1, orgRole=? WHERE id=?').run(orgRole, u.id);
  else db.prepare('UPDATE users SET approved=0, active=0 WHERE id=?').run(u.id);
  audit(req.user!, approve ? 'admin.user.approve' : 'admin.user.denyAccess', 'user', u.id, u.email);
  res.json({ ok: true });
});

api.post('/admin/users', requireAdmin, async (req, res) => {
  const { name, email, role, password } = req.body || {};
  if (!String(name || '').trim() || !String(email || '').trim()) return res.status(400).json({ error: 'Name and email required' });
  if (!['admin', 'coordinator', 'sales'].includes(role)) return res.status(400).json({ error: 'Role must be admin, coordinator, or sales' });
  if (String(password || '').length < 8) return res.status(400).json({ error: 'Temporary password must be at least 8 characters' });
  if (db.prepare('SELECT 1 FROM users WHERE lower(email)=lower(?)').get(email)) return res.status(400).json({ error: 'That email already has an account' });
  const bcrypt = (await import('bcryptjs')).default;
  const id = 'u' + Date.now();
  db.prepare('INSERT INTO users(id,name,email,pwHash,role,active,mustChangePw) VALUES(?,?,?,?,?,1,1)')
    .run(id, name.trim(), email.trim(), bcrypt.hashSync(password, 10), role);
  audit(req.user!, 'admin.user.create', 'user', id, `${name} (${role})`);
  res.json({ ok: true, id });
});

api.patch('/admin/users/:uid', requireAdmin, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.uid) as any;
  if (!u) return res.status(404).json({ error: 'Not found' });
  const { role, active } = req.body || {};
  if (u.id === req.user!.id && ((role && role !== 'admin') || active === 0))
    return res.status(400).json({ error: "You can't demote or deactivate your own account" });
  if (role) {
    if (!['admin', 'coordinator', 'sales'].includes(role)) return res.status(400).json({ error: 'Bad role' });
    db.prepare('UPDATE users SET role=? WHERE id=?').run(role, u.id);
    audit(req.user!, 'admin.user.role', 'user', u.id, role);
  }
  if (active === 0 || active === 1) {
    db.prepare('UPDATE users SET active=? WHERE id=?').run(active, u.id);
    audit(req.user!, active ? 'admin.user.reactivate' : 'admin.user.deactivate', 'user', u.id, u.name);
  }
  res.json({ ok: true });
});

/* Per-user tool grants (currently: 'fees'). Any admin can grant or revoke. */
api.post('/admin/users/:uid/perms', requireAdmin, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.uid) as any;
  if (!u) return res.status(404).json({ error: 'Not found' });
  const perm = String(req.body?.perm || '');
  if (perm !== 'fees') return res.status(400).json({ error: 'Unknown permission' });
  let perms: string[] = [];
  try { perms = JSON.parse(u.perms || '[]'); } catch { /* reset */ }
  const grant = req.body?.grant !== false;
  perms = perms.filter(p => p !== perm);
  if (grant) perms.push(perm);
  db.prepare('UPDATE users SET perms=? WHERE id=?').run(JSON.stringify(perms), u.id);
  audit(req.user!, grant ? 'admin.user.grantPerm' : 'admin.user.revokePerm', 'user', u.id, `${perm} — ${u.email}`);
  res.json({ ok: true, perms });
});

api.post('/admin/users/:uid/reset-password', requireAdmin, async (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.uid) as any;
  if (!u) return res.status(404).json({ error: 'Not found' });
  const pw = String(req.body?.password || '');
  if (pw.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const bcrypt = (await import('bcryptjs')).default;
  db.prepare('UPDATE users SET pwHash=?, mustChangePw=1 WHERE id=?').run(bcrypt.hashSync(pw, 10), u.id);
  audit(req.user!, 'admin.user.resetPassword', 'user', u.id, u.name);
  res.json({ ok: true });
});

api.post('/admin/users/:uid/reset-mfa', requireAdmin, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.uid) as any;
  if (!u) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE users SET totpSecret=NULL WHERE id=?').run(u.id);
  audit(req.user!, 'admin.user.resetMfa', 'user', u.id, u.name);
  res.json({ ok: true, note: 'User will enroll a fresh authenticator at next login' });
});

/* ================= admin: audit & data ================= */
api.get('/admin/audit', requireAdmin, (_req, res) =>
  res.json(db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 500').all()));

api.get('/admin/export', requireAdmin, (_req, res) => {
  const dump: any = {};
  for (const t of ['users', 'counters', 'insurers', 'adjusters', 'ins_contracts', 'providers', 'branches', 'patients', 'outside_bills', 'notes', 'tasks', 'task_comments', 'prov_links', 'bills', 'receipts', 'sent_docs', 'documents', 'files', 'ai_requests', 'widget_prefs'])
    dump[t] = db.prepare(`SELECT * FROM ${t}`).all();
  res.setHeader('Content-Disposition', `attachment; filename="trilogy-export-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(dump);
});

api.post('/admin/wipe-demo', requireAdmin, (req, res) => {
  const tables = ['notes', 'task_comments', 'tasks', 'outside_bills', 'prov_links', 'bills', 'receipts', 'sent_docs', 'documents', 'files', 'patients', 'branches', 'providers', 'ins_contracts', 'adjusters', 'insurers', 'ai_requests', 'audit_log'];
  const wipe = db.transaction(() => { for (const t of tables) db.prepare(`DELETE FROM ${t}`).run(); });
  wipe();
  audit(req.user!, 'admin.wipeDemo');
  res.json({ ok: true });
});
