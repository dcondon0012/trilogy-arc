import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  q, tx, nowMST, nextId, addNote, audit,
  fullPatient, fullProvider, fullInsurer, patientSummaries,
  insAutoStats, branchStats, UPLOAD_DIR, recordStage, computeBillEconomics,
} from './db.js';
import { requireAuth, requireAdmin, requireStaff } from './auth.js';
import {
  billChecks, duplicateBillIds, envelope, rankProviders, caseHealth, stripExtras,
  driftReport, carrierTier, providerScore, carrierReport, outboundDrafts, normFor,
} from './engines.js';
import { medicareFor } from './fees.js';
import {
  sendMail, integrationStatus, secretsMasked, setSecret, SECRET_KEYS, parseBillFile, ocrReady, emailReady,
  sesSetupDomain, sesStatus, sesVerifyAddress, pollInboundFaxes,
} from './integrations.js';
import { geocode, geoBatch, route } from './geo.js';
import { persistUploads, openStored } from './storage.js';

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

/* Payout secrecy: outside the admin-only Financials tab, provider payments display as
   paid-in-full at the billed amount. Non-admin staff payloads never carry payout (rate)
   or contracted-revenue figures — the backend still pays at the contracted rate. */
function stripPayout(p: any, role: string) {
  if (!p || role === 'admin') return p;
  p.bills = (p.bills || []).map(({ rate, revenue, ...b }: any) => b);
  return p;
}
type Rq = { user?: { role: string } };
const sendPatient = async (req: any, res: any, pid: string, extra?: Record<string, any>) =>
  res.json({ ...stripPayout(await fullPatient(pid), req.user!.role), ...(extra || {}) });

export const api = Router();
api.use(requireAuth);
api.use(requireStaff); // portal users (provider/carrier) use /api/portal — never this router

/* ================= bootstrap & search ================= */
api.get('/bootstrap', async (req, res) => {
  res.json({
    user: req.user,
    users: await q.all('SELECT id,name,email,role FROM users'),
    patients: await patientSummaries(),
    providers: await Promise.all((await q.all('SELECT id FROM providers') as any[]).map(async r => await fullProvider(r.id))),
    insurers: await Promise.all((await q.all('SELECT id FROM insurers') as any[]).map(async r => await fullInsurer(r.id))),
    prefs: await q.all('SELECT key,color,size FROM widget_prefs WHERE userId=?', req.user!.id),
  });
});

/* ================= intake queue (the communication hub) ================= */
api.get('/intake', async (_req, res) => {
  const items = await q.all(`SELECT i.*, p.name AS patientName, pr.name AS providerName
    FROM intake_items i LEFT JOIN patients p ON p.id=i.patientId LEFT JOIN providers pr ON pr.id=i.providerId
    ORDER BY CASE i.status WHEN 'triage' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END, i.id DESC LIMIT 300`);
  const counts = await q.all(`SELECT status, COUNT(*) c FROM intake_items GROUP BY status`, );
  res.json({ items, counts });
});

api.post('/intake/simulate-inbound', requireAdmin, upload.single('file'), persistUploads, async (req, res) => {
  // Testing stand-in for the SES (email) and Faxage (fax) webhooks below.
  if (!req.file) return res.status(400).json({ error: 'Attach a file' });
  const fid = req.file.filename;
  await q.run('INSERT INTO files(id,name,mime,size,uploadedBy,time) VALUES(?,?,?,?,?,?)', fid, req.file.originalname, req.file.mimetype, req.file.size, 'inbound', nowMST());
  await q.run(`INSERT INTO intake_items(channel,kind,status,fileId,fileName,fromInfo,note,receivedAt)
    VALUES(?,?,'triage',?,?,?,?,?)`, req.body?.channel === 'fax' ? 'fax' : 'email', 'bill', fid, req.file.originalname,
      req.body?.fromInfo || 'simulated@example.com', req.body?.note || '(simulated inbound)', nowMST());
  await audit(req.user!, 'intake.simulate', undefined, undefined, req.file.originalname);
  res.json({ ok: true });
});

api.post('/intake/:iid/assign', async (req, res) => {
  const it = await q.get('SELECT * FROM intake_items WHERE id=?', req.params.iid) as any;
  if (!it) return res.status(404).json({ error: 'Not found' });
  const { patientId, providerId } = req.body || {};
  if (patientId && !await q.get('SELECT 1 FROM patients WHERE id=?', patientId)) return res.status(400).json({ error: 'Unknown patient' });
  if (providerId && !await q.get('SELECT 1 FROM providers WHERE id=?', providerId)) return res.status(400).json({ error: 'Unknown provider' });
  await q.run("UPDATE intake_items SET patientId=?, providerId=?, status='queued' WHERE id=?", patientId || it.patientId, providerId || it.providerId, it.id);
  if (patientId) await addNote(patientId, `Inbound ${it.channel} document assigned to this case: "${it.fileName}"`, req.user!.name);
  await audit(req.user!, 'intake.assign', 'intake', String(it.id));
  res.json({ ok: true });
});

api.post('/intake/:iid/parse', async (req, res) => {
  const it = await q.get('SELECT * FROM intake_items WHERE id=?', req.params.iid) as any;
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
  await q.run('UPDATE intake_items SET parsed=? WHERE id=?', JSON.stringify(parsed), it.id);
  await audit(req.user!, 'intake.parse', 'intake', String(it.id));
  res.json(parsed);
});

api.post('/intake/:iid/process', async (req, res) => {
  const it = await q.get('SELECT * FROM intake_items WHERE id=?', req.params.iid) as any;
  if (!it) return res.status(404).json({ error: 'Not found' });
  if (it.status === 'processed') return res.status(400).json({ error: 'Already processed' });
  const v = req.body || {};
  const patientId = v.patientId || it.patientId;
  const providerId = v.providerId || it.providerId;
  if (it.kind === 'referral') {
    await q.run("UPDATE intake_items SET status='processed', processedBy=? WHERE id=?", req.user!.name, it.id);
    if (it.patientId) await addNote(it.patientId, 'Referral reviewed — intake accepted', req.user!.name);
    await audit(req.user!, 'intake.referralReviewed', 'patient', it.patientId || undefined);
    return res.json({ ok: true });
  }
  if (it.kind === 'bill') {
    if (!patientId || !providerId) return res.status(400).json({ error: 'Assign patient and provider first' });
    const link = await q.get('SELECT * FROM prov_links WHERE patientId=? AND providerId=?', patientId, providerId) as any;
    if (!link) return res.status(400).json({ error: 'Provider is not linked to this patient yet' });
    const items: any[] = Array.isArray(v.items) ? v.items.filter((x: any) => x.cpt || x.charge) : [];
    const billed = Number(v.billed) || items.reduce((s, x) => s + (Number(x.charge) || 0) * (Number(x.units) || 1), 0);
    if (!(billed > 0)) return res.status(400).json({ error: 'Billed amount (or line items) required' });
    let rate = Number(v.rate) || 0;
    if (!rate) {
      const branch = await q.get('SELECT * FROM branches WHERE providerId=? AND (name=? OR (SELECT COUNT(*) FROM branches WHERE providerId=?)=1)', providerId, link.branch || '', providerId) as any;
      if (branch?.ratePct) rate = Math.round(Math.min(billed * branch.ratePct / 100, branch.rateCap || Infinity) * 100) / 100;
    }
    const bid = 'b' + Date.now() + Math.floor(Math.random() * 1000);
    await q.run(`INSERT INTO bills(id,patientId,providerId,dos,billed,rate,hasBill,billFileId,billFileName)
      VALUES(?,?,?,?,?,?,1,?,?)`, bid, patientId, providerId, v.dos || null, billed, rate, it.fileId, it.fileName);
    for (const x of items)
      await q.run('INSERT INTO bill_items(billId,cpt,icd,units,charge,modifier) VALUES(?,?,?,?,?,?)', bid, x.cpt || null, x.icd || null, Number(x.units) || 1, Number(x.charge) || 0, x.modifier || null);
    await q.run('UPDATE prov_links SET billed=billed+? WHERE patientId=? AND providerId=?', billed, patientId, providerId);
    // Fee-schedule check
    const state = (await q.get('SELECT state FROM patients WHERE id=?', patientId) as any)?.state;
    const flags: string[] = [];
    if (state) for (const x of items) {
      const fs = await q.get('SELECT allowed FROM fee_schedules WHERE state=? AND cpt=?', state, x.cpt) as any;
      if (fs && Number(x.charge) > fs.allowed) flags.push(`${x.cpt} billed ${fmt$(Number(x.charge))} vs ${state} allowed ${fmt$(fs.allowed)}`);
    }
    await q.run("UPDATE intake_items SET status='processed', patientId=?, providerId=?, processedBy=? WHERE id=?", patientId, providerId, req.user!.name, it.id);
    await addNote(patientId, `Bill processed from ${it.channel} intake: DOS ${fmtDate(v.dos)} · ${fmt$(billed)}${items.length ? ` · ${items.length} CPT line${items.length === 1 ? '' : 's'}` : ''}${flags.length ? ' fee schedule: ' + flags.join('; ') : ''}`, req.user!.name);
    await audit(req.user!, 'intake.process', 'bill', bid);
    return res.json({ ok: true, billId: bid, feeFlags: flags });
  }
  // records / other → attach as document
  if (!patientId) return res.status(400).json({ error: 'Assign a patient first' });
  await q.run('INSERT INTO documents(patientId,name,cat,meta,fileId) VALUES(?,?,?,?,?)', patientId, it.fileName, 'Medical', nowMST() + ' · via ' + it.channel, it.fileId);
  await q.run("UPDATE intake_items SET status='processed', patientId=?, processedBy=? WHERE id=?", patientId, req.user!.name, it.id);
  await addNote(patientId, `Document filed from ${it.channel} intake: "${it.fileName}"`, req.user!.name);
  await audit(req.user!, 'intake.process', 'document', String(it.id));
  res.json({ ok: true });
});

api.post('/intake/:iid/reject', async (req, res) => {
  const it = await q.get('SELECT * FROM intake_items WHERE id=?', req.params.iid) as any;
  if (!it) return res.status(404).json({ error: 'Not found' });
  const reason = String(req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'Reason required' });
  await q.run("UPDATE intake_items SET status='rejected', note=COALESCE(note,'')||' · rejected: '||?, processedBy=? WHERE id=?", reason, req.user!.name, it.id);
  await audit(req.user!, 'intake.reject', 'intake', String(it.id), reason);
  res.json({ ok: true });
});

/* ---- bill denial / appeal tracking ---- */
api.post('/bills/:bid/denial', async (req, res) => {
  const b = await q.get('SELECT * FROM bills WHERE id=?', req.params.bid) as any;
  if (!b) return res.status(404).json({ error: 'Not found' });
  const { denied, denialReason, appealStatus } = req.body || {};
  const okStatus = ['none', 'appealing', 'won', 'lost', 'written-off'];
  if (appealStatus && !okStatus.includes(appealStatus)) return res.status(400).json({ error: 'Bad appeal status' });
  if (denied && !String(denialReason || '').trim()) return res.status(400).json({ error: 'Denial reason required' });
  await q.run('UPDATE bills SET denied=?, denialReason=?, appealStatus=? WHERE id=?', denied ? 1 : 0, denialReason || null, appealStatus || (denied ? 'none' : 'none'), b.id);
  await addNote(b.patientId, denied
    ? `Bill DENIED by carrier (DOS ${fmtDate(b.dos)}): ${denialReason}${appealStatus && appealStatus !== 'none' ? ' — appeal: ' + appealStatus : ''}`
    : `Denial cleared on DOS ${fmtDate(b.dos)} bill`, req.user!.name);
  await audit(req.user!, 'bill.denial', 'bill', b.id, denied ? denialReason : 'cleared');
  await sendPatient(req, res, b.patientId);
});

/* ---- contracted rates (carrier prices & provider payouts per CPT) ---- */
api.get('/rates/:kind(carrier|provider)/:id', requireAdmin, async (req, res) => {
  const t = req.params.kind === 'carrier' ? 'carrier_rates' : 'provider_rates';
  const col = req.params.kind === 'carrier' ? 'insurerId' : 'providerId';
  res.json(await q.all(`SELECT * FROM ${t} WHERE ${col}=? ORDER BY cpt`, req.params.id));
});
api.post('/rates/:kind(carrier|provider)/:id', requireAdmin, async (req, res) => {
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
  await tx(async c => {
    for (const r of rows) if (r.cpt && r.amount > 0)
      await c.run(`INSERT INTO ${t}(${col},cpt,${val}) VALUES(?,?,?) ON CONFLICT(${col},cpt) DO UPDATE SET ${val}=excluded.${val}`, req.params.id, String(r.cpt).trim(), r.amount);
  });

  await audit(req.user!, `rates.${kind}.set`, kind, req.params.id, rows.length + ' rows');
  res.json(await q.all(`SELECT * FROM ${t} WHERE ${col}=? ORDER BY cpt`, req.params.id));
});

/* ---- state minimum coverage (intake auto-populate) ---- */
api.get('/state-minimums', async (_req, res) => res.json(await q.all('SELECT * FROM state_minimums ORDER BY state')));
api.post('/admin/state-minimums', requireAdmin, async (req, res) => {
  const { state, coverageType, amount, note } = req.body || {};
  if (!state || !coverageType || !(Number(amount) > 0)) return res.status(400).json({ error: 'State, type, amount required' });
  await q.run('INSERT INTO state_minimums(state,coverageType,amount,note) VALUES(?,?,?,?) ON CONFLICT(state,coverageType) DO UPDATE SET amount=excluded.amount, note=excluded.note', state, coverageType, Number(amount), note || null);
  res.json(await q.all('SELECT * FROM state_minimums ORDER BY state'));
});

/* ---- batch bill packet (Oregon strategy: send all bills as one) ---- */
api.get('/patients/:id/batch-packet', async (req, res) => {
  const p = await fullPatient(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const bills = p.bills.filter((b: any) => !b.voided);
  const total = bills.reduce((s: number, b: any) => s + b.billed, 0);
  const rows = (await Promise.all(bills.map(async (b: any) => {
    const pr = await q.get('SELECT name FROM providers WHERE id=?', b.providerId) as any;
    return `<tr><td>${pr?.name || ''}</td><td>${b.dos || ''}</td><td style="text-align:right">$${b.billed.toFixed(2)}</td><td>${b.hasNote ? 'attached' : 'MISSING'}</td></tr>`;
  }))).join('');
  await audit(req.user!, 'batchPacket.generate', 'patient', p.id);
  res.setHeader('Content-Type', 'text/html');
  res.send(`<html><head><title>Trilogy Batch Bill Submission — ${p.name}</title>
<style>body{font-family:-apple-system,sans-serif;max-width:700px;margin:40px auto;color:#1a2332}table{width:100%;border-collapse:collapse;margin:16px 0}td,th{border:1px solid #ccc;padding:8px;text-align:left;font-size:14px}h1{font-size:20px}@media print{button{display:none}}</style></head><body>
<h1>TRILOGY MEDICAL NETWORKS — Consolidated Bill Submission</h1>
<p><b>Patient:</b> ${p.name} · <b>Claim:</b> ${p.claimNumber || '—'} · <b>Policy:</b> ${p.policyNumber || '—'} · <b>DOI:</b> ${p.doi || '—'}</p>
<table><tr><th>Provider</th><th>DOS</th><th>Billed</th><th>Visit note</th></tr>${rows}
<tr><th colspan="2">TOTAL</th><th style="text-align:right">$${total.toFixed(2)}</th><th></th></tr></table>
<p>All itemized bills and treatment records for the above dates of service are enclosed. Please remit one payment for the total to Trilogy Medical Networks per the master services agreement.</p>
<button onclick="print()">Print / Save as PDF</button></body></html>`);
});

/* ---- fee schedule admin ---- */
api.get('/admin/fee-schedule', requireAdmin, async (req, res) =>
  res.json(await q.all('SELECT * FROM fee_schedules ORDER BY state, cpt')));
api.post('/admin/fee-schedule', requireAdmin, async (req, res) => {
  const { state, cpt, allowed } = req.body || {};
  if (!state || !cpt || !(Number(allowed) > 0)) return res.status(400).json({ error: 'State, CPT, and allowed amount required' });
  await q.run('INSERT INTO fee_schedules(state,cpt,allowed) VALUES(?,?,?) ON CONFLICT(state,cpt) DO UPDATE SET allowed=excluded.allowed', String(state).trim(), String(cpt).trim(), Number(allowed));
  await audit(req.user!, 'feeSchedule.set', undefined, undefined, `${state} ${cpt} ${allowed}`);
  res.json(await q.all('SELECT * FROM fee_schedules ORDER BY state, cpt'));
});

/* ================= the Decision Deck (Today) ================= */
api.get('/deck', async (req, res) => {
  const mine = req.user!.role === 'coordinator';
  const myPts = (await q.all('SELECT id,name,caseType,coordinator,insurerId,stage,uwLimit,carrierConfirmed,attorneyRetained FROM patients' + (mine ? ' WHERE coordinator=?' : ''), ...(mine ? [req.user!.id] : [])) as any[]);
  const pidSet = new Set(myPts.map(p => p.id));
  const pName = (id: string) => myPts.find(p => p.id === id)?.name || id;
  const today = new Date().toISOString().slice(0, 10);
  const cards: any[] = [];
  const tile = (v: string, l: string) => ({ v, l });

  // 1 · Bills through the four-check → one-click release; failures → typed exception cards
  const dupIds = await duplicateBillIds();
  for (const b of await q.all(`SELECT b.*, pr.name AS prName FROM bills b JOIN providers pr ON pr.id=b.providerId
    WHERE b.status='unpaid' AND b.voided=0 AND b.hasBill=1 AND b.hasNote=1 AND b.rate>0`) as any[]) {
    if (!pidSet.has(b.patientId) || dupIds.has(b.id)) continue;
    const fc = await billChecks(b);
    const ckTiles = fc.checks.map(c => tile(c.status === 'pass' ? '✓' : c.status === 'warn' ? '~' : '✕', c.label.toLowerCase().replace('coverage ', '').replace(' vs contract', '≤contract').replace(' on file', '')));
    if (fc.verdict === 'green') {
      // Payout figures are admin-only; coordinators release at the contracted rate without seeing it.
      const showMoney = req.user!.role === 'admin';
      cards.push({
        id: 'pay-' + b.id, type: 'Four-check clear · payment release', stripe: 'green', actor: 'sys',
        title: showMoney ? `Pay ${b.prName} — ${fmt$(b.rate)}` : `Pay ${b.prName} — contracted rate`,
        patientId: b.patientId, patientName: pName(b.patientId),
        sub: `DOS ${fmtDate(b.dos)} · billed ${fmt$(b.billed)} · auth ✓ envelope ✓ rate ✓ agreement ✓`,
        outcome: `Provider paid on time at the contracted rate — relationship protected, no over-payment.`,
        recommend: showMoney
          ? `Release ${fmt$(b.rate)}. All four checks green${b.revenue ? `, margin ${fmt$(b.revenue - b.rate)} locked` : ''}.`
          : `Release the payment — all four checks green, rate locked by contract.`,
        tiles: ckTiles,
        actions: [
          { label: showMoney ? `✓ Pay ${fmt$(b.rate)}` : '✓ Release payment', method: 'POST', path: `/bills/${b.id}/pay`, style: 'primary' },
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
  for (const b of await q.all(`SELECT b.*, pr.name AS prName FROM bills b JOIN providers pr ON pr.id=b.providerId
    WHERE b.status='unpaid' AND b.voided=0`) as any[]) {
    if (!pidSet.has(b.patientId) || !dupIds.has(b.id)) continue;
    cards.push({
      id: 'dup-' + b.id, type: '◉ Duplicate bill suspected', stripe: 'red', actor: 'sys',
      title: `${b.prName} — ${fmt$(b.billed)} looks like a duplicate`, patientId: b.patientId, patientName: pName(b.patientId),
      sub: `Same provider, DOS ${fmtDate(b.dos)}, same amount as an earlier bill`,
      outcome: `The carrier never pays twice for the same visit.`,
      recommend: `Void the duplicate (reason auto-noted) — or keep it if the visits were genuinely separate.`,
      tiles: [tile(fmt$(b.billed), 'billed'), tile(fmtDate(b.dos), 'dos'), tile('dup?', 'flag'), tile(b.prName.split(' ')[0], 'provider')],
      actions: [
        { label: 'Void as duplicate', method: 'POST', path: `/bills/${b.id}/void`, body: { reason: 'Duplicate bill — same provider/DOS/amount' }, style: 'primary' },
        { label: 'Keep — separate visit', method: 'POST', path: `/patients/${b.patientId}/notes`, body: { text: `Duplicate flag reviewed on ${b.prName} DOS ${fmtDate(b.dos)} ${fmt$(b.billed)} — kept as a separate visit` } },
      ],
      chips: ['Open the case'], age: b.dos,
    });
  }

  // 2 · Bills blocked on records
  for (const b of await q.all(`SELECT b.*, pr.name AS prName FROM bills b JOIN providers pr ON pr.id=b.providerId
    WHERE b.status='unpaid' AND b.voided=0 AND (b.hasBill=0 OR b.hasNote=0)`) as any[]) {
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
  for (const t of await q.all(`SELECT * FROM tasks WHERE title LIKE 'Auth request from%'`) as any[]) {
    if (!pidSet.has(t.patientId)) continue;
    const amtMatch = t.title.match(/\$([\d,]+(?:\.\d{2})?)/);
    const amt = amtMatch ? parseFloat(amtMatch[1].replace(/,/g, '')) : 0;
    const link = await q.get('SELECT l.*, pr.name AS prName FROM prov_links l JOIN providers pr ON pr.id=l.providerId WHERE l.patientId=? LIMIT 1', t.patientId) as any;
    const env = await envelope(t.patientId);
    const remaining = env.remaining, usage = env.usage;
    const basisWord = env.basis === 'auth' ? 'Carrier auth' : 'Coverage';
    const fits = amt > 0 && amt <= remaining;
    cards.push({
      id: 'auth-' + t.id, type: fits ? 'Auth request · within envelope' : '◉ Auth request · utilization check', stripe: fits ? 'blue' : 'amber', actor: fits ? 'sys' : 'you',
      title: t.title.replace('Auth request from ', 'More auth — '), patientId: t.patientId, patientName: pName(t.patientId),
      sub: `${basisWord} remaining ${fmt$(remaining)}${amt ? ` · request ${fmt$(amt)}` : ''}`,
      outcome: `Care continues without delay — and only as much as the coverage supports.`,
      recommend: fits
        ? `Approve — fits the envelope with ${fmt$(remaining - amt)} to spare. Containment intact.`
        : `Review utilization first: request ${amt ? fmt$(amt) : '—'} vs ${fmt$(remaining)} remaining. Ask for the treatment plan before extending.`,
      tiles: await (async () => {
        const visits = link ? (await q.get('SELECT COUNT(*) c FROM bills WHERE patientId=? AND providerId=? AND voided=0', t.patientId, link.providerId) as any).c : 0;
        const prType = link ? (await q.get('SELECT type FROM providers WHERE id=?', link.providerId) as any)?.type : null;
        return [tile(fmt$(remaining), 'remaining'), tile(amt ? fmt$(amt) : '—', 'requested'), tile(`${visits}/${await normFor(prType)}`, 'visits vs norm'), tile(fmt$(usage), 'used')];
      })(),
      actions: (link && amt > 0 ? [{ label: `✓ Approve ${fmt$(amt)}`, method: 'POST', path: `/provlinks/${link.id}/action`, body: { kind: 'addauth', amount: amt }, then: { method: 'POST', path: `/tasks/${t.id}/complete` }, style: 'primary' }] as any[] : [])
        .concat([{ label: 'Decline / discuss', method: 'POST', path: `/tasks/${t.id}/complete` }]),
      chips: ['Open the case', 'Message the provider'], age: t.due,
    });
  }

  // 4 · New referrals awaiting intake review (SLA clock)
  for (const i of await q.all(`SELECT * FROM intake_items WHERE kind='referral' AND status='triage'`) as any[]) {
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
  for (const t of await q.all(`SELECT * FROM tasks WHERE due IS NOT NULL AND due<? AND title NOT LIKE 'Auth request from%'`, today) as any[]) {
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
        { label: 'Push out', method: 'PROMPT-SNOOZE', path: `/tasks/${t.id}/snooze` },
      ],
      chips: ['Open the case'], age: t.due,
    });
  }

  // 6 · Authorization/coverage exceeded / nearly exhausted (containment reds)
  for (const p of myPts) {
    if (p.stage >= 4) continue;
    const env = await envelope(p.id);
    if (!env.cap) continue;
    const remaining = env.remaining, usage = env.usage, outside = env.outside;
    const basisWord = env.basis === 'auth' ? 'carrier authorization' : 'coverage';
    if (remaining < env.cap * 0.15) {
      cards.push({
        id: 'cov-' + p.id, type: `◉ Cost control · ${basisWord} ` + (remaining < 0 ? 'EXCEEDED' : 'nearly exhausted'), stripe: 'red', actor: 'you',
        title: `${p.name} — ${remaining < 0 ? fmt$(-remaining) + ' over ' + basisWord : fmt$(remaining) + ' remaining'}`,
        patientId: p.id, patientName: p.name,
        sub: `${env.basis === 'auth' ? 'Authorized' : 'Limit'} ${fmt$(env.cap)} · used ${fmt$(usage)}${env.basis === 'auth' ? '' : ` · outside ${fmt$(outside)}`}`,
        outcome: `The carrier never sees a surprise — treatment lands inside its authorization or gets a decision first.`,
        recommend: remaining < 0 ? `Stop further authorizations; review the treatment plan with the provider today.` : `${env.basis === 'auth' ? 'Request additional authorization from the carrier or flag' : 'Flag'} discharge-readiness with the provider; no new auths without review.`,
        tiles: [tile(fmt$(env.cap), env.basis === 'auth' ? 'authorized' : 'limit'), tile(fmt$(usage), 'used'), tile(fmt$(outside), 'outside'), tile(fmt$(remaining), 'remaining')],
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
        tiles: [tile('PIP', 'line'), tile('', 'risk'), tile('—', ''), tile('—', '')],
        actions: [{ label: '✓ Verified — note it', method: 'POST', path: `/patients/${p.id}/notes`, body: { text: 'Attorney-involvement funds-flow verification completed' }, style: 'primary' }],
        chips: ['Open the case'], age: today,
      });
    }
  }

  // 7 · Receipts pending 14+ days (chase the carrier)
  const cutoff14 = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  for (const r of await q.all(`SELECT * FROM receipts WHERE status='Pending' AND voided=0 AND date<?`, cutoff14) as any[]) {
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
    for (const u of await q.all('SELECT * FROM users WHERE approved=0') as any[]) {
      const orgName = (await q.get('SELECT name FROM providers WHERE id=?', u.orgId) as any)?.name
        || (await q.get('SELECT name FROM insurers WHERE id=?', u.orgId) as any)?.name || u.orgId;
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
  for (const b of await q.all(`SELECT b.*, pr.name AS prName FROM bills b JOIN providers pr ON pr.id=b.providerId
    WHERE b.denied=1 AND b.appealStatus='none' AND b.voided=0`) as any[]) {
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
  for (const a of await q.all(`SELECT a.*, p.name "ptName" FROM agreements a JOIN patients p ON p.id=a.patientId
    WHERE a.status IN ('draft','sent')`, ) as any[]) {
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
    for (const g of await q.all(`SELECT providerName, COUNT(*) c, SUM(amount) amt FROM agreements
      GROUP BY providerName HAVING COUNT(*)>=2`, ) as any[]) {
      const already = await q.get('SELECT 1 FROM crm_targets WHERE lower(name)=lower(?)', g.providerName)
        || await q.get('SELECT 1 FROM campaigns WHERE name=?', g.providerName);
      if (already) continue;
      cards.push({
        id: 'gap-' + g.providerName.replace(/\W/g, ''), type: '⇗ Network gap · recurring', stripe: 'blue', actor: 'sys',
        title: `${g.providerName} — ${g.c} one-time agreements. Worth a full contract?`,
        patientId: null, patientName: 'Growth',
        sub: `${fmt$(g.amt || 0)} routed through one-off paper so far`,
        outcome: `Recurring gaps become contracted network — locked rates replace one-off negotiations.`,
        recommend: `Send to the CRM pipeline — Miles picks it up with the volume story attached.`,
        tiles: [tile(String(g.c), 'agreements'), tile(fmt$(g.amt || 0), 'volume'), tile('gap', 'signal'), tile('—', '')],
        actions: [{ label: '⇗ Add to CRM pipeline', method: 'POST', path: `/crm/targets`, body: { name: g.providerName, kind: 'provider', stage: 'identify', source: 'gap-engine', notes: `${g.c} one-time agreements, ${fmt$(g.amt || 0)} volume — auto-flagged from gap engine` }, style: 'primary' }],
        chips: [], age: today,
      });
    }

    // 12 · Drift findings (admin)
    for (const [i, d] of Object.entries(await driftReport())) {
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
    const lastFeeRef = await q.get('SELECT * FROM fee_refreshes ORDER BY id DESC LIMIT 1') as any;
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
    for (const l of await q.all(`SELECT l.*, pr.name prName, pr.type prType FROM prov_links l
      JOIN providers pr ON pr.id=l.providerId WHERE l.patientId=? AND l.status='authorized'`, p.id) as any[]) {
      const ranked = await rankProviders(l.prType, null);
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
    const recentBill = await q.get('SELECT 1 FROM bills WHERE patientId=? AND voided=0 AND dos>=?', p.id, d30);
    const upcoming = await q.get('SELECT 1 FROM appointments WHERE patientId=? AND whenAt>=?', p.id, today);
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
  const recent = await q.all('SELECT * FROM audit_log WHERE time>? ORDER BY id DESC LIMIT 200', since) as any[];
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
api.get('/insurers/:id/onboarding', async (req, res) => {
  const c = await q.get('SELECT onboarding FROM insurers WHERE id=?', req.params.id) as any;
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json(c.onboarding ? JSON.parse(c.onboarding) : {});
});
api.post('/insurers/:id/onboarding', async (req, res) => {
  const c = await q.get('SELECT id,name FROM insurers WHERE id=?', req.params.id) as any;
  if (!c) return res.status(404).json({ error: 'Not found' });
  const cfg = req.body || {};
  cfg._meta = { savedBy: req.user!.name, savedAt: nowMST(), role: req.user!.role };
  await q.run('UPDATE insurers SET onboarding=? WHERE id=?', JSON.stringify(cfg), c.id);
  await audit(req.user!, 'insurer.onboarding.save', 'insurer', c.id, `${Object.keys(cfg).length} sections`);
  res.json({ ok: true });
});
/* ================= phase 4-6 engines ================= */

/* Four-check verdicts + health + strip extras for one case (staff-only; never portal). */
api.get('/patients/:id/insights', async (req, res) => {
  const p = await q.get('SELECT * FROM patients WHERE id=?', req.params.id) as any;
  if (!p) return res.status(404).json({ error: 'Not found' });
  const dups = await duplicateBillIds(p.id);
  const checks: Record<string, any> = {};
  for (const b of await q.all('SELECT * FROM bills WHERE patientId=?', p.id) as any[])
    checks[b.id] = { ...await billChecks(b), dup: dups.has(b.id) };
  res.json({ checks, health: await caseHealth(p), strip: await stripExtras(p), tier: p.insurerId ? (await carrierTier(p.insurerId)).tier : null });
});

/* Health summaries for the roster. */
api.get('/health-summaries', async (_req, res) => {
  const out: Record<string, any> = {};
  for (const p of await q.all('SELECT * FROM patients') as any[]) {
    const h = await caseHealth(p);
    out[p.id] = { score: h.score, band: h.band, status: h.status, redCount: h.reds.length };
  }
  res.json(out);
});

/* Exception fix: reduce billed to the contracted price. */
api.post('/bills/:bid/reduce-to-contract', async (req, res) => {
  const b = await q.get('SELECT * FROM bills WHERE id=?', req.params.bid) as any;
  if (!b) return res.status(404).json({ error: 'Not found' });
  if (!(b.revenue > 0) || b.billed <= b.revenue) return res.status(400).json({ error: 'Nothing to reduce — billed is at or under contract' });
  const old = b.billed;
  await q.run('UPDATE bills SET billed=? WHERE id=?', b.revenue, b.id);
  await q.run('UPDATE prov_links SET billed=billed-? WHERE patientId=? AND providerId=?', old - b.revenue, b.patientId, b.providerId);
  const prName = (await q.get('SELECT name FROM providers WHERE id=?', b.providerId) as any)?.name || b.providerId;
  await addNote(b.patientId, `Bill reduced to contracted rate: ${prName} DOS ${fmtDate(b.dos)} — ${fmt$(old)} → ${fmt$(b.revenue)} (contract is the price)`, req.user!.name);
  await audit(req.user!, 'bill.reduceToContract', 'bill', b.id, `${old} -> ${b.revenue}`);
  await sendPatient(req, res, b.patientId);
});

/* EOB capture (Trilopay side). */
api.post('/bills/:bid/eob', async (req, res) => {
  const b = await q.get('SELECT * FROM bills WHERE id=?', req.params.bid) as any;
  if (!b) return res.status(404).json({ error: 'Not found' });
  const v = req.body || {};
  await q.run('UPDATE bills SET eobAllowed=?, eobPaid=?, eobNote=?, eobAt=? WHERE id=?', Number(v.allowed) || null, Number(v.paid) || null, v.note || null, nowMST(), b.id);
  await addNote(b.patientId, `EOB recorded on DOS ${fmtDate(b.dos)}: allowed ${fmt$(Number(v.allowed) || 0)} · paid ${fmt$(Number(v.paid) || 0)}${v.note ? ' — ' + v.note : ''}`, req.user!.name);
  await audit(req.user!, 'bill.eob', 'bill', b.id);
  await sendPatient(req, res, b.patientId);
});

/* One-time agreements. */
api.get('/agreements', async (_req, res) => {
  res.json(await q.all(`SELECT a.*, p.name "ptName" FROM agreements a JOIN patients p ON p.id=a.patientId ORDER BY a.id DESC`));
});
api.post('/agreements', async (req, res) => {
  const v = req.body || {};
  if (!v.patientId || !String(v.providerName || '').trim()) return res.status(400).json({ error: 'patientId and providerName required' });
  const dupe = await q.get(`SELECT 1 FROM agreements WHERE patientId=? AND providerName=? AND status IN ('draft','sent')`, v.patientId, v.providerName);
  if (dupe) return res.status(409).json({ error: 'An open agreement with this provider already exists on this case' });
  const info = await q.run(`INSERT INTO agreements(patientId,providerId,providerName,service,amount,terms,status,createdAt,createdBy)
    VALUES(?,?,?,?,?,?,'draft',?,?)`, v.patientId, v.providerId || null, v.providerName, v.service || null, Number(v.amount) || 0,
      v.terms || `One-time agreement: services at ${Number(v.amount) ? fmt$(Number(v.amount)) : 'negotiated rate'}, payment within 30 days of clean bill + records, no balance billing.`,
      nowMST(), req.user!.name);
  await addNote(v.patientId, `One-time agreement started with ${v.providerName}${v.amount ? ' · ' + fmt$(Number(v.amount)) : ''} — locks the rate before payment (four-check #4)`, req.user!.name);
  await audit(req.user!, 'agreement.create', 'agreement', String(info.lastInsertRowid), v.providerName);
  res.json({ ok: true, id: info.lastInsertRowid });
});
api.post('/agreements/:id/status', async (req, res) => {
  const a = await q.get('SELECT * FROM agreements WHERE id=?', req.params.id) as any;
  if (!a) return res.status(404).json({ error: 'Not found' });
  const status = String(req.body?.status);
  if (!['sent', 'signed', 'declined'].includes(status)) return res.status(400).json({ error: 'Bad status' });
  await q.run('UPDATE agreements SET status=?, signedAt=? WHERE id=?', status, status === 'signed' ? nowMST() : a.signedAt, a.id);
  await addNote(a.patientId, `One-time agreement with ${a.providerName}: ${status}${status === 'signed' ? ' — payments to this provider unblocked' : ''}`, req.user!.name);
  await audit(req.user!, 'agreement.status', 'agreement', String(a.id), status);
  res.json({ ok: true });
});

/* Provider optimizer. */
api.get('/optimizer', async (req, res) => {
  const type = (req.query.type as string) || null;
  const pt = req.query.patientId ? await q.get('SELECT address FROM patients WHERE id=?', req.query.patientId) as any : null;
  res.json(await rankProviders(type, pt?.address || null));
});

/* Consolidated daily outbound. */
api.get('/outbound', async (_req, res) => res.json(await outboundDrafts()));
api.post('/outbound/send', async (req, res) => {
  const v = req.body || {};
  for (const pid of v.patientIds || []) {
    await q.run('INSERT INTO sent_docs(patientId,name,toStr,time,status,method) VALUES(?,?,?,?,?,?)', pid, `Daily consolidated update — ${v.subject || 'status'}`, v.toName || '', nowMST(), 'Sent', 'Email');
    await addNote(pid, `Consolidated daily outbound sent to ${v.toName}: ${v.subject}`, req.user!.name);
  }
  await audit(req.user!, 'outbound.send', v.kind, v.toId, v.subject);
  res.json({ ok: true });
});

/* Scheduling board. */
api.get('/schedule', async (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const horizon = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  const upcoming = await q.all(`SELECT a.*, p.name "ptName", pr.name "prName" FROM appointments a
    JOIN patients p ON p.id=a.patientId LEFT JOIN providers pr ON pr.id=a.providerId
    WHERE a.whenAt>=? AND a.whenAt<=? ORDER BY a.whenAt`, today, horizon);
  // NOT EXISTS in SQL — .filter(async …) returns Promises, which are always truthy.
  const gaps = (await q.all(`SELECT p.id, p.name, p.caseType, p.coordinator FROM patients p WHERE p.stage=2
    AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.patientId=p.id AND a.whenAt>=?)`, today) as any[])
    .map(p => ({ id: p.id, name: p.name, caseType: p.caseType, coordinator: p.coordinator }));
  res.json({ upcoming, gaps });
});
api.post('/patients/:id/appointments', async (req, res) => {
  const v = req.body || {};
  if (!v.whenAt) return res.status(400).json({ error: 'Date required' });
  await q.run('INSERT INTO appointments(patientId,providerId,whenAt,note,createdBy,createdAt) VALUES(?,?,?,?,?,?)', req.params.id, v.providerId || null, v.whenAt, v.note || null, req.user!.name, nowMST());
  await addNote(req.params.id, `Appointment scheduled ${fmtDate(v.whenAt)}${v.note ? ' — ' + v.note : ''}`, req.user!.name);
  await audit(req.user!, 'appointment.create', 'patient', req.params.id);
  await sendPatient(req, res, req.params.id);
});

/* Growth workspace. */
api.get('/growth', requireAdmin, async (req, res) => {
  const d30 = new Date(Date.now() - 30 * 86400000).toISOString();
  const d30d = d30.slice(0, 10);
  // NOT EXISTS in SQL — .filter(async …) returns Promises, which are always truthy.
  const coldCarriers = (await q.all(`SELECT id,name FROM insurers i
    WHERE NOT EXISTS (SELECT 1 FROM patients p WHERE p.insurerId=i.id AND p.createdAt>=?)`, d30) as any[])
    .map(c => ({ ...c, why: 'No new referrals in 30 days' }));
  const coldProviders = (await q.all(`SELECT id,name,type FROM providers pr
    WHERE NOT EXISTS (SELECT 1 FROM bills b WHERE b.providerId=pr.id AND b.dos>=? AND b.voided=0)`, d30d) as any[])
    .map(pr => ({ ...pr, why: 'No bills in 30 days — relationship cooling' }));
  const gaps = await q.all(`SELECT providerName, COUNT(*) c, SUM(amount) amt FROM agreements GROUP BY providerName ORDER BY c DESC`, );
  const campaigns = await q.all('SELECT * FROM campaigns ORDER BY id DESC');
  const queue = [
    ...coldCarriers.map(c => ({ kind: 'carrier', id: c.id, name: c.name, why: c.why, priority: 2 })),
    ...(gaps as any[]).filter(g => g.c >= 2).map(g => ({ kind: 'gap', id: g.providerName, name: g.providerName, why: `${g.c} one-time agreements — contract candidate`, priority: 1 })),
    ...coldProviders.map(p => ({ kind: 'provider', id: p.id, name: p.name, why: p.why, priority: 3 })),
  ].sort((a, b) => a.priority - b.priority);
  res.json({ queue, campaigns, gaps, coldCarriers, coldProviders });
});
api.post('/campaigns', async (req, res) => {
  const v = req.body || {};
  if (!String(v.name || '').trim()) return res.status(400).json({ error: 'Name required' });
  const info = await q.run('INSERT INTO campaigns(name,kind,region,stage,contact,notes,updatedAt,by) VALUES(?,?,?,?,?,?,?,?)', v.name, v.kind || 'carrier', v.region || null, v.stage || 'identify', v.contact || null, v.notes || null, nowMST(), req.user!.name);
  await audit(req.user!, 'campaign.create', 'campaign', String(info.lastInsertRowid), v.name);
  res.json({ ok: true, id: info.lastInsertRowid });
});
api.post('/campaigns/:id', async (req, res) => {
  const c = await q.get('SELECT * FROM campaigns WHERE id=?', req.params.id) as any;
  if (!c) return res.status(404).json({ error: 'Not found' });
  const v = req.body || {};
  await q.run('UPDATE campaigns SET stage=?, notes=?, contact=?, region=?, updatedAt=?, by=? WHERE id=?', v.stage || c.stage, v.notes ?? c.notes, v.contact ?? c.contact, v.region ?? c.region, nowMST(), req.user!.name, c.id);
  await audit(req.user!, 'campaign.update', 'campaign', String(c.id), v.stage || '');
  res.json({ ok: true });
});

/* Drift, tiers, scores, enterprise report. */
api.get('/drift', requireAdmin, async (req, res) => res.json(await driftReport()));
api.post('/drift/ack', async (req, res) => {
  await audit(req.user!, 'drift.ack', 'drift', undefined, req.body?.text);
  res.json({ ok: true });
});
api.get('/insurers/:id/tier', async (req, res) => res.json(await carrierTier(req.params.id)));
api.get('/providers/:id/score', async (req, res) => res.json(await providerScore(req.params.id)));
api.get('/insurers/:id/report', async (req, res) => {
  const c = await q.get('SELECT id,name FROM insurers WHERE id=?', req.params.id) as any;
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json({ carrier: c.name, ...await carrierReport(c.id), tier: await carrierTier(c.id) });
});

api.get('/roster/patients', async (_req, res) => {
  res.json(await q.all(`SELECT p.id, p.name, p.caseType, p.stage, p.coordinator, p.doi, p.insurerId,
    (SELECT COUNT(*) FROM tasks t WHERE t.patientId=p.id) AS openTasks,
    (SELECT COUNT(*) FROM bills b WHERE b.patientId=p.id AND b.status='unpaid' AND b.voided=0) AS unpaidBills
    FROM patients p`, ));
});

api.get('/dashboard', requireAdmin, async (req, res) => {
  const payable = (await q.get("SELECT COALESCE(SUM(rate),0) s, COUNT(*) c FROM bills WHERE status='unpaid' AND voided=0 AND rate>0", ) as any);
  const pendingIn = (await q.get("SELECT COALESCE(SUM(amount),0) s, COUNT(*) c FROM receipts WHERE status='Pending' AND voided=0", ) as any);
  const received = (await q.get("SELECT COALESCE(SUM(amount),0) s FROM receipts WHERE status='Cleared' AND voided=0", ) as any).s;
  const paid = (await q.get("SELECT COALESCE(SUM(rate),0) s FROM bills WHERE status='paid' AND voided=0", ) as any).s;
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const aging = (await q.get("SELECT COALESCE(SUM(rate),0) s, COUNT(*) c FROM bills WHERE status='unpaid' AND voided=0 AND dos < ?", cutoff) as any);
  const byStage = await q.all('SELECT stage, COUNT(*) c FROM patients GROUP BY stage', );
  const byCarrier = await Promise.all((await q.all('SELECT id, name FROM insurers') as any[]).map(async c => ({ id: c.id, name: c.name, ...await insAutoStats(c.id) })));
  const byCaseType = await q.all(`SELECT caseType, COUNT(*) c FROM patients WHERE stage<4 GROUP BY caseType`, );
  const coordinators = (await Promise.all((await q.all('SELECT id, name FROM users WHERE active=1') as any[]).map(async u => ({
    id: u.id, name: u.name,
    activeCases: (await q.get('SELECT COUNT(*) c FROM patients WHERE coordinator=? AND stage<4', u.id) as any).c,
    openTasks: (await q.get('SELECT COUNT(*) c FROM tasks t JOIN patients p ON p.id=t.patientId WHERE p.coordinator=?', u.id) as any).c,
  })))).filter(x => x.activeCases || x.openTasks);
  // Thesis metrics
  const ptCount = (await q.get('SELECT COUNT(*) c FROM patients') as any).c;
  const attyCount = (await q.get('SELECT COUNT(*) c FROM patients WHERE attorneyRetained=1') as any).c;
  // Avg days intake → treating from stage timestamps
  const velocityRows = await q.all(`SELECT s0.patientId, (s2.at::date - s0.at::date) AS days
    FROM stage_times s0 JOIN stage_times s2 ON s2.patientId=s0.patientId AND s2.stage=2
    WHERE s0.stage=0`, ) as any[];
  const avgIntakeToTreating = velocityRows.length
    ? Math.round(velocityRows.reduce((s, r) => s + r.days, 0) / velocityRows.length * 10) / 10 : null;
  const byCarrierAR = await Promise.all(byCarrier.map(async (c: any) => {
    const billedTotal = (await q.get(`SELECT COALESCE(SUM(b.billed),0) s FROM bills b
      JOIN patients p ON p.id=b.patientId WHERE p.insurerId=? AND b.voided=0`, c.id) as any).s;
    return { ...c, billedTotal, outstanding: Math.max(0, billedTotal - c.received) };
  }));
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
    intakeQueue: (await q.get("SELECT COUNT(*) c FROM intake_items WHERE status IN ('triage','queued')", ) as any).c,
    pendingApprovals: (await q.get('SELECT COUNT(*) c FROM users WHERE approved=0') as any).c,
    // Board pack extras
    byLob: await Promise.all((await q.all(`SELECT p.caseType, COALESCE(SUM(CASE WHEN r.status='Cleared' AND r.voided=0 THEN r.amount END),0) recv
      FROM patients p LEFT JOIN receipts r ON r.patientId=p.id GROUP BY p.caseType`, ) as any[]).map(async (x: any) => {
      const paidL = (await q.get(`SELECT COALESCE(SUM(b.rate),0) s FROM bills b JOIN patients p ON p.id=b.patientId
        WHERE p.caseType=? AND b.status='paid' AND b.voided=0`, x.caseType) as any).s;
      return { caseType: x.caseType, received: x.recv, paidOut: paidL, margin: x.recv - paidL };
    })),
    costPerCase: await (async () => {
      const closed = await q.get('SELECT COUNT(*) c FROM patients WHERE stage>=3') as any;
      const totBilled = (await q.get(`SELECT COALESCE(SUM(b.billed),0) s FROM bills b JOIN patients p ON p.id=b.patientId WHERE p.stage>=3 AND b.voided=0`, ) as any).s;
      return closed.c ? Math.round(totBilled / closed.c) : null;
    })(),
    concentration: await (async () => {
      const rows = await q.all(`SELECT p.insurerId, COALESCE(SUM(r.amount),0) s FROM receipts r JOIN patients p ON p.id=r.patientId
        WHERE r.voided=0 GROUP BY p.insurerId ORDER BY s DESC`, ) as any[];
      const tot = rows.reduce((s, r) => s + r.s, 0);
      return tot && rows[0] ? Math.round(rows[0].s / tot * 100) : null;
    })(),
    writtenOff: (await q.get(`SELECT COALESCE(SUM(billed),0) s, COUNT(*) c FROM bills WHERE appealStatus='written-off' AND voided=0`, ) as any),
    driftCount: (await driftReport()).length,
  });
});

api.get('/alerts', async (req, res) => {
  const mine = req.user!.role === 'coordinator';
  const pts = (await q.all('SELECT * FROM patients' + (mine ? ' WHERE coordinator=?' : ''), ...(mine ? [req.user!.id] : [])) as any[]);
  const today = new Date().toISOString().slice(0, 10);
  const cutoff30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const cutoff14 = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  const alerts: any[] = [];
  if (req.user!.role === 'admin') {
    const lastFeeRef = await q.get('SELECT * FROM fee_refreshes ORDER BY id DESC LIMIT 1') as any;
    if (lastFeeRef?.status === 'failed')
      alerts.push({ severity: 'high', patientId: 'FEES', patientName: 'Fee tool', text: `Medicare fee refresh failed: ${String(lastFeeRef.detail || '').slice(0, 90)}` });
  }
  for (const p of pts) {
    for (const t of await q.all('SELECT * FROM tasks WHERE patientId=? AND due IS NOT NULL AND due<?', p.id, today) as any[])
      alerts.push({ severity: 'high', patientId: p.id, patientName: p.name, text: `Overdue task: "${t.title}" (due ${fmtDate(t.due)})` });
    for (const b of await q.all("SELECT * FROM bills WHERE patientId=? AND status='unpaid' AND voided=0 AND dos<?", p.id, cutoff30) as any[])
      alerts.push({ severity: 'high', patientId: p.id, patientName: p.name, text: `Bill unpaid 30+ days: DOS ${fmtDate(b.dos)} · ${fmt$(b.billed)}` });
    for (const r of await q.all("SELECT * FROM receipts WHERE patientId=? AND status='Pending' AND voided=0 AND date<?", p.id, cutoff14) as any[])
      alerts.push({ severity: 'med', patientId: p.id, patientName: p.name, text: `Receipt pending 14+ days: ${fmt$(r.amount)} (${r.ref || ''})` });
    // Carrier-configured thresholds (from the partnership onboarding — config that executes)
    if (p.insurerId && p.stage < 4) {
      const cfgRow = await q.get('SELECT onboarding FROM insurers WHERE id=?', p.insurerId) as any;
      if (cfgRow?.onboarding) {
        try {
          const cfg = JSON.parse(cfgRow.onboarding);
          const usageAll = (await q.get('SELECT COALESCE(SUM(billed),0) s FROM bills WHERE patientId=? AND voided=0', p.id) as any).s;
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
      const outside = (await q.get('SELECT COALESCE(SUM(amt),0) s FROM outside_bills WHERE patientId=?', p.id) as any).s;
      const usage = (await q.get('SELECT COALESCE(SUM(billed),0) s FROM bills WHERE patientId=? AND voided=0', p.id) as any).s;
      const remaining = p.uwLimit - outside - usage;
      if (remaining < 0)
        alerts.push({ severity: 'high', patientId: p.id, patientName: p.name, text: `Coverage exceeded by ${fmt$(-remaining)} — stop treatment authorization review needed` });
      else if (remaining < p.uwLimit * 0.15)
        alerts.push({ severity: 'med', patientId: p.id, patientName: p.name, text: `Coverage nearly exhausted: ${fmt$(remaining)} remaining` });
    }
  }
  res.json(alerts);
});

api.get('/tasks', async (_req, res) => {
  res.json(await q.all(`SELECT t.id, t.patientId, p.name as patientName, t.title, t.due, t.created, t.by
    FROM tasks t JOIN patients p ON p.id=t.patientId ORDER BY t.due IS NULL, t.due`));
});

api.get('/search', async (req, res) => {
  const query = String(req.query.q || '').toLowerCase();
  if (!q) return res.json([]);
  const like = `%${query}%`;
  res.json({
    patients: await q.all("SELECT id,name,caseType,stage FROM patients WHERE lower(name||id||COALESCE(phone,'')||COALESCE(email,'')) LIKE ? LIMIT 8", like),
    providers: await q.all("SELECT id,name,type,status FROM providers WHERE lower(name||id||COALESCE(type,'')) LIKE ? LIMIT 8", like),
    insurers: await q.all('SELECT id,name FROM insurers WHERE lower(name||id) LIKE ? LIMIT 8', like),
  });
});

/* ================= patients ================= */
api.get('/patients/:id', async (req, res) => {
  const p = await fullPatient(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json(stripPayout(p, req.user!.role));
});

api.post('/patients', async (req, res) => {
  const v = req.body || {};
  if (!String(v.name || '').trim()) return res.status(400).json({ error: 'Name is required' });
  // Duplicate detection: same name, or same DOB + same last name. Pass force:true to create anyway.
  if (!v.force) {
    const nameL = v.name.trim().toLowerCase();
    const lastWord = nameL.split(/\s+/).pop();
    const dups = (await q.all('SELECT id,name,dob,phone FROM patients') as any[]).filter(p => {
      const pn = String(p.name || '').toLowerCase();
      return pn === nameL || (v.dob && p.dob === v.dob && lastWord && pn.includes(lastWord));
    });
    if (dups.length) {
      await audit(req.user!, 'patient.duplicateWarning', 'patient', undefined, v.name);
      return res.status(409).json({ error: 'Possible duplicate patient', duplicates: dups });
    }
  }
  const id = await nextId('pt');
  let adjusterId: string | null = v.adjusterId || null;
  if (!adjusterId && v.adjusterName && v.insurerId) {
    const existing = await q.get('SELECT id FROM adjusters WHERE insurerId=? AND lower(name)=lower(?)', v.insurerId, v.adjusterName) as any;
    if (existing) adjusterId = existing.id;
    else {
      adjusterId = 'a' + Date.now();
      await q.run('INSERT INTO adjusters(id,insurerId,name) VALUES(?,?,?)', adjusterId, v.insurerId, v.adjusterName);
    }
  }
  await q.run(`INSERT INTO patients(id,name,caseType,phone,email,address,dob,doi,state,insurerId,claimNumber,policyNumber,adjusterId,coordinator,companionId,accident)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, v.name, v.caseType || 'trilopay', v.phone || null, v.email || null, v.address || null,
      v.dob || null, v.doi || null, v.state || null, v.insurerId || null, v.claimNumber || null,
      v.policyNumber || null, adjusterId, v.coordinator || req.user!.id, v.companionId || null, v.accident || null);
  if (v.companionId) await q.run('UPDATE patients SET companionId=? WHERE id=?', id, v.companionId);
  for (const c of ['agentName', 'agentContact', 'agentAuth', 'referralSource'])
    if (v[c] !== undefined) await q.run(`UPDATE patients SET ${c}=? WHERE id=?`, v[c] || null, id);
  await recordStage(id, 0);
  // Coverage auto-populate: assume the state minimum until verified with the carrier.
  if (v.state) {
    const covType = (v.caseType === 'trilogy') ? 'BI' : 'PIP';
    const sm = await q.get('SELECT * FROM state_minimums WHERE lower(state)=lower(?) AND coverageType=?', v.state.trim(), covType) as any;
    if (sm) {
      await q.run("UPDATE patients SET uwLimit=?, uwCoverage=?, uwStatus='Assumed minimum' WHERE id=?", sm.amount, `${covType} — assumed ${v.state} minimum ($${sm.amount.toLocaleString()})`, id);
      await addNote(id, `Coverage auto-populated: assumed ${v.state} ${covType} minimum $${sm.amount.toLocaleString()} — verify with carrier`, req.user!.name);
    }
  }
  await addNote(id, 'Profile created', req.user!.name);
  await audit(req.user!, 'patient.create', 'patient', id, v.name);
  await sendPatient(req, res, id);
});

api.patch('/patients/:id', async (req, res) => {
  const id = req.params.id;
  const p = await q.get('SELECT * FROM patients WHERE id=?', id) as any;
  if (!p) return res.status(404).json({ error: 'Not found' });
  const v = req.body || {};
  const cols = ['name', 'caseType', 'phone', 'email', 'address', 'dob', 'doi', 'state', 'insurerId', 'claimNumber', 'policyNumber', 'adjusterId', 'accident', 'attorneyRetained', 'attorneyDate', 'attorneyFirm', 'escalated', 'agentName', 'agentContact', 'agentAuth', 'referralSource', 'carrierConfirmed', 'consentSharing', 'carrierAuthorized'];
  if ('carrierConfirmed' in v && Number(v.carrierConfirmed) === 1)
    await addNote(id, '✓ Coverage verified with carrier — case cleared to proceed', req.user!.name);
  if ('attorneyRetained' in v && Number(v.attorneyRetained) === 1 && !(await q.get('SELECT attorneyRetained FROM patients WHERE id=?', id) as any).attorneyRetained)
    await addNote(id, `ATTORNEY RETAINED${v.attorneyFirm ? ': ' + v.attorneyFirm : ''}${v.attorneyDate ? ' (as of ' + fmtDate(v.attorneyDate) + ')' : ''} — thesis metric recorded`, req.user!.name);
  for (const c of cols) if (c in v) await q.run(`UPDATE patients SET ${c}=? WHERE id=?`, v[c] === '' ? null : v[c], id);
  await addNote(id, 'Profile details edited', req.user!.name);
  await audit(req.user!, 'patient.update', 'patient', id);
  await sendPatient(req, res, id);
});

api.post('/patients/:id/stage', async (req, res) => {
  const STAGES = ['Intake', 'Underwriting', 'Treating', 'Done Treating', 'Paid Out'];
  const id = req.params.id;
  const p = await q.get('SELECT stage FROM patients WHERE id=?', id) as any;
  if (!p) return res.status(404).json({ error: 'Not found' });
  const stage = Number(req.body?.stage);
  if (!(stage >= 0 && stage < STAGES.length)) return res.status(400).json({ error: 'Bad stage' });
  await q.run('UPDATE patients SET stage=? WHERE id=?', stage, id);
  await recordStage(id, stage);
  await addNote(id, `Status changed: ${STAGES[p.stage]} → ${STAGES[stage]}`, req.user!.name);
  await audit(req.user!, 'patient.stage', 'patient', id, STAGES[stage]);
  await sendPatient(req, res, id);
});

api.post('/patients/:id/coordinator', async (req, res) => {
  const id = req.params.id;
  const u = await q.get('SELECT name FROM users WHERE id=?', req.body?.coordinator) as any;
  if (!u) return res.status(400).json({ error: 'Unknown coordinator' });
  await q.run('UPDATE patients SET coordinator=? WHERE id=?', req.body.coordinator, id);
  await addNote(id, 'Coordinator assigned: ' + u.name, req.user!.name);
  await audit(req.user!, 'patient.coordinator', 'patient', id, u.name);
  await sendPatient(req, res, id);
});

api.post('/patients/:id/companion', async (req, res) => {
  const id = req.params.id;
  const p = await q.get('SELECT companionId FROM patients WHERE id=?', id) as any;
  if (!p) return res.status(404).json({ error: 'Not found' });
  if (p.companionId) await q.run('UPDATE patients SET companionId=NULL WHERE id=?', p.companionId);
  const cid = req.body?.companionId || null;
  await q.run('UPDATE patients SET companionId=? WHERE id=?', cid, id);
  if (cid) {
    const c = await q.get('SELECT name FROM patients WHERE id=?', cid) as any;
    await q.run('UPDATE patients SET companionId=? WHERE id=?', id, cid);
    await addNote(id, `Companion claim linked: ${c?.name} (${cid})`, req.user!.name);
  } else await addNote(id, 'Companion claim unlinked', req.user!.name);
  await audit(req.user!, 'patient.companion', 'patient', id, cid ?? 'unlinked');
  await sendPatient(req, res, id);
});

/* ---- case messages (staff side of portal threads) ---- */
api.post('/patients/:id/messages', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text || text.length > 5000) return res.status(400).json({ error: 'Message required (max 5,000 chars)' });
  await q.run('INSERT INTO case_messages(patientId,authorName,authorType,text,time) VALUES(?,?,?,?,?)', req.params.id, req.user!.name, 'staff', text, nowMST());
  await audit(req.user!, 'message.send', 'patient', req.params.id);
  await sendPatient(req, res, req.params.id);
});

/* ---- notes ---- */
api.post('/patients/:id/notes', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Empty note' });
  if (text.length > 10000) return res.status(400).json({ error: 'Note too long (10,000 character max)' });
  await addNote(req.params.id, text, req.user!.name, false);
  await q.run('UPDATE notes SET sys=0 WHERE id=(SELECT MAX(id) FROM notes WHERE patientId=?)', req.params.id);
  await audit(req.user!, 'note.add', 'patient', req.params.id);
  await sendPatient(req, res, req.params.id);
});

/* ---- tasks ---- */
api.post('/patients/:id/tasks', async (req, res) => {
  const title = String(req.body?.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Title required' });
  const tid = 't' + Date.now() + Math.floor(Math.random() * 1000);
  await q.run('INSERT INTO tasks(id,patientId,title,due,created,by) VALUES(?,?,?,?,?,?)', tid, req.params.id, title, req.body?.due || null, nowMST(), req.user!.name);
  await addNote(req.params.id, `Task created: "${title}"` + (req.body?.due ? ` (due ${fmtDate(req.body.due)})` : ''), req.user!.name);
  await audit(req.user!, 'task.create', 'task', tid, title);
  await sendPatient(req, res, req.params.id);
});

api.post('/tasks/:tid/snooze', async (req, res) => {
  const t = await q.get('SELECT * FROM tasks WHERE id=?', req.params.tid) as any;
  if (!t) return res.status(404).json({ error: 'Not found' });
  const due = String(req.body?.due || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return res.status(400).json({ error: 'Pick a date' });
  await q.run('UPDATE tasks SET due=? WHERE id=?', due, t.id);
  await addNote(t.patientId, `Task pushed out: "${t.title}" — ${fmtDate(t.due)} → ${fmtDate(due)}`, req.user!.name);
  await audit(req.user!, 'task.snooze', 'task', t.id, due);
  await sendPatient(req, res, t.patientId);
});

api.post('/tasks/:tid/complete', async (req, res) => {
  const t = await q.get('SELECT * FROM tasks WHERE id=?', req.params.tid) as any;
  if (!t) return res.status(404).json({ error: 'Not found' });
  await q.run('DELETE FROM tasks WHERE id=?', t.id);
  await addNote(t.patientId, `Task completed: "${t.title}"`, req.user!.name);
  await audit(req.user!, 'task.complete', 'task', t.id, t.title);
  await sendPatient(req, res, t.patientId);
});

api.post('/tasks/:tid/comments', async (req, res) => {
  const t = await q.get('SELECT * FROM tasks WHERE id=?', req.params.tid) as any;
  if (!t) return res.status(404).json({ error: 'Not found' });
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Empty comment' });
  await q.run('INSERT INTO task_comments(taskId,text,by,time) VALUES(?,?,?,?)', t.id, text, req.user!.name, nowMST());
  await audit(req.user!, 'task.comment', 'task', t.id);
  await sendPatient(req, res, t.patientId);
});

/* ---- underwriting ---- */
api.patch('/patients/:id/uw', async (req, res) => {
  const v = req.body || {};
  await q.run('UPDATE patients SET uwStatus=?,uwCoverage=?,uwLimit=?,uwRiskFlags=?,uwApprovedBy=? WHERE id=?', v.status ?? 'Not started', v.coverage ?? null, Number(v.limit) || 0, v.riskFlags ?? null, v.approvedBy ?? null, req.params.id);
  // Carrier authorization for the case — the operative number the case works off.
  if ('carrierAuthorized' in v) {
    const amt = Number(v.carrierAuthorized) || 0;
    const prev = (await q.get('SELECT carrierAuthorized FROM patients WHERE id=?', req.params.id) as any)?.carrierAuthorized || 0;
    await q.run('UPDATE patients SET carrierAuthorized=? WHERE id=?', amt, req.params.id);
    if (amt !== prev) await addNote(req.params.id, `Carrier authorization for this case set to ${fmt$(amt)}${prev ? ` (was ${fmt$(prev)})` : ''} — case now works off this number`, req.user!.name);
  }
  await addNote(req.params.id, `Underwriting updated (${v.status})`, req.user!.name);
  await audit(req.user!, 'uw.update', 'patient', req.params.id);
  await sendPatient(req, res, req.params.id);
});

api.post('/patients/:id/outside-bills', async (req, res) => {
  const descr = String(req.body?.desc || '').trim();
  const amt = Number(req.body?.amt);
  if (!descr || !(amt > 0)) return res.status(400).json({ error: 'A note and a positive amount are required' });
  await q.run('INSERT INTO outside_bills(patientId,descr,amt) VALUES(?,?,?)', req.params.id, descr, amt);
  await addNote(req.params.id, `Outside medical bill added: ${descr} ${fmt$(amt)} — coverage remaining recalculated`, req.user!.name);
  await audit(req.user!, 'uw.outsideBill.add', 'patient', req.params.id, `${descr} ${amt}`);
  await sendPatient(req, res, req.params.id);
});

api.delete('/outside-bills/:obid', async (req, res) => {
  const ob = await q.get('SELECT * FROM outside_bills WHERE id=?', req.params.obid) as any;
  if (!ob) return res.status(404).json({ error: 'Not found' });
  await q.run('DELETE FROM outside_bills WHERE id=?', ob.id);
  await addNote(ob.patientId, `Outside medical bill removed: ${ob.descr} ${fmt$(ob.amt)}`, req.user!.name);
  await audit(req.user!, 'uw.outsideBill.remove', 'patient', ob.patientId);
  await sendPatient(req, res, ob.patientId);
});

/* ---- provider links & authorizations ---- */
api.post('/patients/:id/provlinks', async (req, res) => {
  const { providerId, branch } = req.body || {};
  const pr = await q.get('SELECT name FROM providers WHERE id=?', providerId) as any;
  if (!pr) return res.status(400).json({ error: 'Unknown provider' });
  try {
    await q.run('INSERT INTO prov_links(patientId,providerId,branch) VALUES(?,?,?)', req.params.id, providerId, branch || null);
  } catch { return res.status(400).json({ error: 'Provider already linked' }); }
  await addNote(req.params.id, `Provider linked: ${pr.name}${branch ? ` (${branch})` : ''} — status: Pending`, req.user!.name);
  await audit(req.user!, 'provlink.create', 'patient', req.params.id, providerId);
  await sendPatient(req, res, req.params.id);
});

api.post('/provlinks/:lid/action', async (req, res) => {
  const l = await q.get('SELECT * FROM prov_links WHERE id=?', req.params.lid) as any;
  if (!l) return res.status(404).json({ error: 'Not found' });
  const pr = await q.get('SELECT name, corpEmail FROM providers WHERE id=?', l.providerId) as any;
  const kind = String(req.body?.kind);
  const amount = Number(req.body?.amount) || 0;
  // Each send creates the actual document (printable at the returned URL) and a
  // prewritten email draft (mailto) — the client opens both. Attachment rides
  // automatically once the email integration lands.
  let sentId: number | null = null;
  const sd = async (name: string) => {
    const info = await q.run('INSERT INTO sent_docs(patientId,name,toStr,time,status,method,meta) VALUES(?,?,?,?,?,?,?)', l.patientId, name, pr.name, nowMST(), 'Sent', 'Email',
        JSON.stringify({ kind, amount: amount || null, providerId: l.providerId, branch: l.branch || null }));
    sentId = Number(info.lastInsertRowid);
  };

  if (kind === 'auth' || kind === 'addauth') {
    if (!(amount > 0)) return res.status(400).json({ error: 'Authorization amount must be positive' });
    await q.run('UPDATE prov_links SET authAmount=authAmount+?, authCount=authCount+1, status=? WHERE id=?', amount, 'authorized', l.id);
    await addNote(l.patientId, `${kind === 'auth' ? 'Authorization' : 'Additional authorization'} sent to ${pr.name}: ${fmt$(amount)} (total ${fmt$(l.authAmount + amount)}) — status: Authorized`, req.user!.name);
    sd(kind === 'auth' ? 'Authorization' : "Add'l Authorization");
  } else if (kind === 'reqform') {
    await addNote(l.patientId, `Add'l auth request form sent to ${pr.name} (for provider to fill & return)`, req.user!.name);
    sd("Add'l Authorization Request Form");
  } else if (kind === 'cxl') {
    if (l.status === 'finalized') return res.status(400).json({ error: 'Already finalized' });
    await q.run("UPDATE prov_links SET status='canceled' WHERE id=?", l.id);
    await addNote(l.patientId, `Cancel-authorization form sent to ${pr.name} (verifies all transactions; awaiting signature) — status: Canceled`, req.user!.name);
    sd('Cancellation of Authorization Form');
  } else if (kind === 'cxlback') {
    if (l.status !== 'canceled') return res.status(400).json({ error: 'Send the cancel form first' });
    await q.run("UPDATE prov_links SET status='finalized' WHERE id=?", l.id);
    await addNote(l.patientId, `Signed cancel-auth form received from ${pr.name} — status: Finalized`, req.user!.name);
  } else return res.status(400).json({ error: 'Unknown action' });

  await audit(req.user!, 'provlink.' + kind, 'patient', l.patientId, pr.name);
  const pt = await q.get('SELECT name FROM patients WHERE id=?', l.patientId) as any;
  const docName = kind === 'auth' ? 'Authorization' : kind === 'addauth' ? "Add'l Authorization" : kind === 'reqform' ? "Add'l Authorization Request Form" : 'Cancellation of Authorization Form';
  const emailed = sentId ? await emailSentDoc(l.patientId, sentId, pr.corpEmail || null, (req.user as any)?.email || null) : false;
  await sendPatient(req, res, l.patientId, sentId ? {
    _emailed: emailed,
    _doc: {
      url: `/api/patients/${l.patientId}/sentdoc/${sentId}/print`,
      mailto: `mailto:${encodeURIComponent(pr.corpEmail || '')}`
        + `?subject=${encodeURIComponent(`${docName} — ${pt?.name} (${l.patientId}) — Trilogy Medical Networks`)}`
        + `&body=${encodeURIComponent(`Hi ${pr.name} team,\n\nPlease find attached the ${docName.toLowerCase()} for ${pt?.name} (case ${l.patientId})${amount ? ` in the amount of ${fmt$(amount)}` : ''}.\n\n${kind === 'cxl' ? 'Please verify all transactions on the case, sign, and return the form.\n\n' : kind === 'reqform' ? 'Please complete and return the form so we can process the additional authorization.\n\n' : 'Treatment within this authorization is payable at the contracted rate as bills and visit notes are received.\n\n'}Thank you,\nTrilogy Medical Networks\ntrilogyconnections.com`)}`,
    },
  } : undefined);
});

/* Edit the authorized total after the fact (audited; the four-check recalculates). */
api.patch('/provlinks/:lid', async (req, res) => {
  const l = await q.get('SELECT * FROM prov_links WHERE id=?', req.params.lid) as any;
  if (!l) return res.status(404).json({ error: 'Not found' });
  const authAmount = Number(req.body?.authAmount);
  if (!(authAmount >= 0)) return res.status(400).json({ error: 'Authorization total must be zero or more' });
  const pr = await q.get('SELECT name FROM providers WHERE id=?', l.providerId) as any;
  await q.run('UPDATE prov_links SET authAmount=? WHERE id=?', authAmount, l.id);
  await addNote(l.patientId, `Authorization total for ${pr?.name} corrected: ${fmt$(l.authAmount)} → ${fmt$(authAmount)}`, req.user!.name);
  await audit(req.user!, 'provlink.authEdit', 'patient', l.patientId, `${pr?.name}: ${l.authAmount} → ${authAmount}`);
  await sendPatient(req, res, l.patientId);
});

/* One renderer for sent docs: the print view AND the email body are the same document. */
function renderSentDocHtml(p: any, d: any): string {
  let meta: any = {}; try { meta = JSON.parse(d.meta || '{}'); } catch { /* older rows */ }
  const esc = (s: any) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const row = (k: string, v: any) => v ? `<tr><td class="k">${k}</td><td>${esc(v)}</td></tr>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(d.name)} — ${esc(p.name)}</title>
<style>body{font:14px/1.6 Arial,Helvetica,sans-serif;color:#2A3346;max-width:720px;margin:0 auto;padding:48px 40px}
h1{font-size:24px;color:#2D3647;margin:0 0 2px} .tri{color:#45A8EB}
.sub{color:#5A6474;font-size:12.5px;margin-bottom:26px}
table{width:100%;border-collapse:collapse;margin:18px 0}
td{border:1px solid #E5E2D6;padding:9px 12px;font-size:13.5px} td.k{width:210px;background:#F7F6F1;font-weight:700}
.body{margin:20px 0;font-size:14px} .sig{margin-top:56px;display:flex;gap:40px}
.sig div{flex:1;border-top:1px solid #2A3346;padding-top:6px;font-size:12px;color:#5A6474}
.print{margin-top:30px} @media print{.print{display:none}}</style></head><body>
<h1>tril<span class="tri">△</span>gy &nbsp;·&nbsp; ${esc(d.name)}</h1>
<div class="sub">Trilogy Medical Networks · trilogyconnections.com · Document #SD-${d.id} · ${esc(d.time)}</div>
<table>
${row('Patient', `${p.name} (${p.id})`)}${row('Date of injury', p.doi)}${row('Claim #', p.claimNumber)}
${row('Provider', d.toStr)}${row('Branch', meta.branch)}
${meta.amount ? row('Authorized amount', fmt$(meta.amount)) : ''}
${row('Case type', p.caseType === 'trilogy' ? 'Third-party bodily injury' : 'PIP / first party')}
</table>
<div class="body">${meta.kind === 'cxl'
    ? 'This document cancels the outstanding treatment authorization for the patient above. Please verify all dates of service and outstanding balances on this case, sign below, and return this form to Trilogy Medical Networks. No further treatment under the prior authorization is payable after the cancellation date.'
    : meta.kind === 'reqform'
    ? 'Use this form to request additional treatment authorization for the patient above. Complete the requested amount and anticipated treatment plan, sign, and return to Trilogy Medical Networks for processing.'
    : meta.amount
    ? `Trilogy Medical Networks authorizes treatment for the patient above up to the amount shown. Services within this authorization are payable at the contracted rate upon receipt of the itemized bill and corresponding visit note. This authorization does not direct care — treatment decisions remain with the clinician.`
    : `This document accompanies the ${esc(d.name)} for the patient above, sent by Trilogy Medical Networks.`}</div>
<div class="sig"><div>Trilogy Medical Networks — authorized signature</div><div>Provider acknowledgment — signature &amp; date</div></div>
<button class="print" onclick="print()">Print / Save as PDF</button>
</body></html>`;
}

api.get('/patients/:id/sentdoc/:sid/print', async (req, res) => {
  const d = await q.get('SELECT * FROM sent_docs WHERE id=? AND patientId=?', req.params.sid, req.params.id) as any;
  const p = await q.get('SELECT * FROM patients WHERE id=?', req.params.id) as any;
  if (!d || !p) return res.status(404).json({ error: 'Not found' });
  res.send(renderSentDocHtml(p, d));
});

/** When email is live, a sent doc really goes out — document in the body and attached.
    replyTo = the coordinator who sent it, so the provider's reply lands with them. */
async function emailSentDoc(patientId: string, sid: number, toEmail: string | null, replyTo?: string | null): Promise<boolean> {
  if (!toEmail || !await emailReady()) return false;
  const d = await q.get('SELECT * FROM sent_docs WHERE id=?', sid) as any;
  const p = await q.get('SELECT * FROM patients WHERE id=?', patientId) as any;
  if (!d || !p) return false;
  const html = renderSentDocHtml(p, d);
  const r = await sendMail({
    to: toEmail, subject: `${d.name} — ${p.name} (${p.id}) — Trilogy Medical Networks`,
    html, attachments: [{ filename: `${d.name.replace(/[^A-Za-z0-9 ]/g, '')} - ${p.id}.html`, content: html, contentType: 'text/html' }],
    patientId, meta: { kind: 'sentdoc', sid }, replyTo: replyTo || null,
  });
  if (r.sent) {
    await q.run("UPDATE sent_docs SET method='Email (sent by Arc)' WHERE id=?", sid);
    await addNote(patientId, `Emailed "${d.name}" to ${toEmail} — document included and attached`, 'system');
  }
  return r.sent;
}

/* ---- bills / receipts / payments ---- */
api.post('/patients/:id/bills', async (req, res) => {
  const v = req.body || {};
  const pr = await q.get('SELECT name FROM providers WHERE id=?', v.providerId) as any;
  if (!pr) return res.status(400).json({ error: 'Unknown provider' });
  const lineItems: any[] = Array.isArray(v.items) ? v.items.filter((x: any) => x.cpt || Number(x.charge)) : [];
  const billedIn = Number(v.billed) || lineItems.reduce((s, x) => s + (Number(x.charge) || 0) * (Number(x.units) || 1), 0);
  v.billed = billedIn;
  if (!(billedIn > 0)) return res.status(400).json({ error: 'Billed amount (or CPT line items) required' });
  if (Number(v.rate) < 0) return res.status(400).json({ error: 'Payout cannot be negative' });
  const link = await q.get('SELECT * FROM prov_links WHERE patientId=? AND providerId=?', req.params.id, v.providerId) as any;
  if (!link) return res.status(400).json({ error: 'Link this provider to the patient first (Medical Providers tab)' });

  // Contracted-rate engine: revenue from carrier CPT prices, payout from provider CPT rates or branch % (w/ timely-filing tier).
  const pRow = await q.get('SELECT insurerId FROM patients WHERE id=?', req.params.id) as any;
  const eco = await computeBillEconomics(pRow?.insurerId || null, v.providerId, link.branch, lineItems, billedIn, v.dos || null);
  let rate = Number(v.rate) || eco.payout || 0;
  // Note text stays payout-free — financial detail lives in the admin Financials tab.
  let rateNote = eco.revenueMissing.length ? ` — no carrier rate on file for CPT ${eco.revenueMissing.join(', ')}` : '';
  const bid = 'b' + Date.now() + Math.floor(Math.random() * 1000);
  await q.run('INSERT INTO bills(id,patientId,providerId,dos,billed,rate,revenue) VALUES(?,?,?,?,?,?,?)', bid, req.params.id, v.providerId, v.dos || null, Number(v.billed), rate, eco.revenue);
  for (const x of lineItems)
    await q.run('INSERT INTO bill_items(billId,cpt,icd,units,charge,modifier) VALUES(?,?,?,?,?,?)', bid, x.cpt || null, x.icd || null, Number(x.units) || 1, Number(x.charge) || 0, x.modifier || null);
  await q.run('UPDATE prov_links SET billed=billed+? WHERE patientId=? AND providerId=?', Number(v.billed), req.params.id, v.providerId);
  await addNote(req.params.id, `Bill added: ${pr.name} · DOS ${fmtDate(v.dos)} · ${fmt$(Number(v.billed))}${rateNote} — attach the bill + visit note files to unlock payment`, req.user!.name);
  await audit(req.user!, 'bill.create', 'bill', bid);
  await sendPatient(req, res, req.params.id);
});

/* Set/correct the payout on an unpaid bill — admin only (payout is auto-calculated;
   corrections are the exception, and payout figures never reach non-admin staff). */
api.patch('/bills/:bid', requireAdmin, async (req, res) => {
  const b = await q.get('SELECT * FROM bills WHERE id=?', req.params.bid) as any;
  if (!b) return res.status(404).json({ error: 'Not found' });
  if (b.status === 'paid') return res.status(400).json({ error: 'Bill already paid — void it and re-enter instead' });
  if (b.voided) return res.status(400).json({ error: 'Bill is voided' });
  const rate = Number(req.body?.rate);
  if (!(rate >= 0)) return res.status(400).json({ error: 'Payout must be zero or more' });
  await q.run('UPDATE bills SET rate=? WHERE id=?', rate, b.id);
  await addNote(b.patientId, `Payout terms corrected on the DOS ${fmtDate(b.dos)} bill (admin adjustment — details in Financials)`, req.user!.name);
  await audit(req.user!, 'bill.rateChange', 'bill', b.id, `${b.rate} → ${rate}`);
  await sendPatient(req, res, b.patientId);
});

/* Void a bill (correction flow — never deletes, always audited). */
api.post('/bills/:bid/void', async (req, res) => {
  const b = await q.get('SELECT * FROM bills WHERE id=?', req.params.bid) as any;
  if (!b) return res.status(404).json({ error: 'Not found' });
  if (b.voided) return res.status(400).json({ error: 'Already voided' });
  const reason = String(req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'A reason is required to void' });
  await q.run('UPDATE bills SET voided=1, voidReason=? WHERE id=?', reason, b.id);
  await q.run('UPDATE prov_links SET billed=GREATEST(0,billed-?) WHERE patientId=? AND providerId=?', b.billed, b.patientId, b.providerId);
  await q.run('DELETE FROM receipt_bills WHERE billId=?', b.id);
  const pr = await q.get('SELECT name FROM providers WHERE id=?', b.providerId) as any;
  await addNote(b.patientId, `Bill VOIDED: ${pr?.name} · DOS ${fmtDate(b.dos)} · ${fmt$(b.billed)} — reason: ${reason}` +
    (b.status === 'paid' ? ` this bill was already PAID ${fmt$(b.rate)} — recover the payment separately` : ''), req.user!.name);
  await audit(req.user!, 'bill.void', 'bill', b.id, reason);
  await sendPatient(req, res, b.patientId);
});

/* Void a receipt. */
api.post('/receipts/:rid/void', async (req, res) => {
  const r = await q.get('SELECT * FROM receipts WHERE id=?', req.params.rid) as any;
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (r.voided) return res.status(400).json({ error: 'Already voided' });
  const reason = String(req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'A reason is required to void' });
  await q.run('UPDATE receipts SET voided=1, voidReason=? WHERE id=?', reason, r.id);
  await q.run('DELETE FROM receipt_bills WHERE receiptId=?', r.id);
  await addNote(r.patientId, `Receipt VOIDED: ${fmt$(r.amount)} (${r.ref || ''}) — reason: ${reason}`, req.user!.name);
  await audit(req.user!, 'receipt.void', 'receipt', String(r.id), reason);
  await sendPatient(req, res, r.patientId);
});

/* Reconciliation: link a receipt to the bills it covers. */
api.post('/receipts/:rid/link', async (req, res) => {
  const r = await q.get('SELECT * FROM receipts WHERE id=?', req.params.rid) as any;
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (r.voided) return res.status(400).json({ error: 'Receipt is voided' });
  const billIds: string[] = Array.isArray(req.body?.billIds) ? req.body.billIds : [];
  for (const bid of billIds) {
    const b = await q.get('SELECT patientId FROM bills WHERE id=?', bid) as any;
    if (!b || b.patientId !== r.patientId) return res.status(400).json({ error: 'Bill ' + bid + ' does not belong to this patient' });
  }
  await tx(async c => {
    await c.run('DELETE FROM receipt_bills WHERE receiptId=?', r.id);
    for (const bid of billIds) await c.run('INSERT INTO receipt_bills(receiptId,billId) VALUES(?,?)', r.id, bid);
  });

  await addNote(r.patientId, `Receipt ${fmt$(r.amount)} (${r.ref || ''}) reconciled to ${billIds.length} bill${billIds.length === 1 ? '' : 's'}`, req.user!.name);
  await audit(req.user!, 'receipt.link', 'receipt', String(r.id), billIds.join(','));
  await sendPatient(req, res, r.patientId);
});

api.post('/bills/:bid/attach/:field', upload.single('file'), persistUploads, async (req, res) => {
  const b = await q.get('SELECT * FROM bills WHERE id=?', req.params.bid) as any;
  if (!b) return res.status(404).json({ error: 'Not found' });
  if (b.voided) return res.status(400).json({ error: 'Bill is voided' });
  const field = req.params.field === 'bill' ? 'bill' : 'note';
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const fid = req.file.filename;
  await q.run('INSERT INTO files(id,name,mime,size,uploadedBy,time) VALUES(?,?,?,?,?,?)', fid, req.file.originalname, req.file.mimetype, req.file.size, req.user!.name, nowMST());
  if (field === 'bill') await q.run('UPDATE bills SET hasBill=1,billFileId=?,billFileName=? WHERE id=?', fid, req.file.originalname, b.id);
  else await q.run('UPDATE bills SET hasNote=1,noteFileId=?,noteFileName=? WHERE id=?', fid, req.file.originalname, b.id);
  const pr = await q.get('SELECT name FROM providers WHERE id=?', b.providerId) as any;
  await addNote(b.patientId, `${field === 'bill' ? 'Bill file' : 'Visit note file'} attached: "${req.file.originalname}" for DOS ${fmtDate(b.dos)} (${pr?.name || ''})`, req.user!.name);
  await audit(req.user!, 'bill.attach.' + field, 'bill', b.id, req.file.originalname);
  await sendPatient(req, res, b.patientId);
});

/* Uploaded files render inline only for types that can't carry scripts —
   anything else (HTML, SVG, unknown) downloads instead of executing on our origin. */
export const SAFE_INLINE_MIME = /^(application\/pdf|image\/(png|jpe?g|gif|webp)|text\/plain)$/i;
api.get('/files/:fid', async (req, res) => {
  const f = await q.get('SELECT * FROM files WHERE id=?', req.params.fid) as any;
  if (!f) return res.status(404).json({ error: 'Not found' });
  const stream = await openStored(f.id);
  if (!stream) return res.status(404).json({ error: 'File missing from storage' });
  res.setHeader('Content-Type', f.mime || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `${SAFE_INLINE_MIME.test(f.mime || '') ? 'inline' : 'attachment'}; filename="${encodeURIComponent(f.name)}"`);
  stream.pipe(res);
});

api.post('/bills/:bid/pay', async (req, res) => {
  const b = await q.get('SELECT * FROM bills WHERE id=?', req.params.bid) as any;
  if (!b) return res.status(404).json({ error: 'Not found' });
  if (b.voided) return res.status(400).json({ error: 'Bill is voided' });
  if (b.status === 'paid') return res.status(400).json({ error: 'Already paid' });
  if (!b.hasBill || !b.hasNote) return res.status(400).json({ error: 'Attach bill + visit note before paying' });
  if (!(b.rate > 0)) return res.status(400).json({ error: 'Set the payout amount first (auto-calculates when the branch has a numeric rate)' });
  const paidDate = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
  await q.run("UPDATE bills SET status='paid',paidDate=? WHERE id=?", paidDate, b.id);
  const pr = await q.get('SELECT name FROM providers WHERE id=?', b.providerId) as any;
  // Notes are visible to all staff — payments display as satisfied in full at the billed
  // amount; the actual contracted payout lives only in the admin Financials tab.
  await addNote(b.patientId, `Payment sent to ${pr?.name} — DOS ${fmtDate(b.dos)} bill (${fmt$(b.billed)}) paid in full at the contracted terms`, req.user!.name);
  await audit(req.user!, 'bill.pay', 'bill', b.id, String(b.rate));
  await sendPatient(req, res, b.patientId);
});

api.post('/patients/:id/receipts', async (req, res) => {
  const v = req.body || {};
  if (!(Number(v.amount) > 0)) return res.status(400).json({ error: 'Amount must be a positive number' });
  await q.run('INSERT INTO receipts(patientId,date,ref,amount,status) VALUES(?,?,?,?,?)', req.params.id, v.date || null, v.ref || null, Number(v.amount), v.status || 'Pending');
  await addNote(req.params.id, `Insurance receipt recorded: ${fmt$(Number(v.amount))} (${v.ref || ''})`, req.user!.name);
  await audit(req.user!, 'receipt.create', 'patient', req.params.id, String(v.amount));
  await sendPatient(req, res, req.params.id);
});

api.post('/receipts/:rid/toggle', async (req, res) => {
  const r = await q.get('SELECT * FROM receipts WHERE id=?', req.params.rid) as any;
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (r.voided) return res.status(400).json({ error: 'Receipt is voided' });
  const status = r.status === 'Cleared' ? 'Pending' : 'Cleared';
  await q.run('UPDATE receipts SET status=? WHERE id=?', status, r.id);
  await addNote(r.patientId, `Receipt ${status.toLowerCase()}: ${fmt$(r.amount)} (${r.ref || ''})`, req.user!.name);
  await audit(req.user!, 'receipt.toggle', 'receipt', String(r.id), status);
  await sendPatient(req, res, r.patientId);
});

/* ---- sent docs & documents ---- */
api.post('/patients/:id/sentdocs', async (req, res) => {
  const v = req.body || {};
  if (!v.name) return res.status(400).json({ error: 'Template required' });
  const info = await q.run('INSERT INTO sent_docs(patientId,name,toStr,time,status,method,meta) VALUES(?,?,?,?,?,?,?)', req.params.id, v.name, v.to || '—', nowMST(), 'Sent', v.method || 'Email',
      JSON.stringify({ kind: 'template', email: v.email || null }));
  await addNote(req.params.id, `Contract sent: "${v.name}" to ${v.to || '—'} via ${v.method || 'Email'}`, req.user!.name);
  await audit(req.user!, 'sentdoc.create', 'patient', req.params.id, v.name);
  const pt = await q.get('SELECT name FROM patients WHERE id=?', req.params.id) as any;
  await sendPatient(req, res, req.params.id, {
    _doc: {
      url: `/api/patients/${req.params.id}/sentdoc/${info.lastInsertRowid}/print`,
      mailto: `mailto:${encodeURIComponent(v.email || '')}`
        + `?subject=${encodeURIComponent(`${v.name} — ${pt?.name} (${req.params.id}) — Trilogy Medical Networks`)}`
        + `&body=${encodeURIComponent(`Hi,\n\nPlease find attached the ${v.name} for ${pt?.name} (case ${req.params.id}). Sign and return at your convenience — reach out with any questions.\n\nThank you,\nTrilogy Medical Networks\ntrilogyconnections.com`)}`,
    },
  });
});

api.post('/sentdocs/:sid/advance', async (req, res) => {
  const d = await q.get('SELECT * FROM sent_docs WHERE id=?', req.params.sid) as any;
  if (!d) return res.status(404).json({ error: 'Not found' });
  const status = d.status === 'Sent' ? 'Viewed' : 'Signed';
  await q.run('UPDATE sent_docs SET status=? WHERE id=?', status, d.id);
  if (status === 'Signed') {
    await addNote(d.patientId, `Contract signed: "${d.name}" by ${d.toStr}`, req.user!.name);
    if (/bill pay|mbpa|mppa|lac|consent/i.test(d.name)) {
      await q.run('UPDATE patients SET consentSharing=1 WHERE id=?', d.patientId);
      await addNote(d.patientId, '✓ Patient consent on file — carrier portal may now access bills & records for this case', req.user!.name);
    }
  }
  await audit(req.user!, 'sentdoc.advance', 'sentdoc', String(d.id), status);
  await sendPatient(req, res, d.patientId);
});

api.post('/patients/:id/documents', upload.single('file'), persistUploads, async (req, res) => {
  const name = req.file?.originalname || String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name or file required' });
  let fid: string | null = null;
  if (req.file) {
    fid = req.file.filename;
    await q.run('INSERT INTO files(id,name,mime,size,uploadedBy,time) VALUES(?,?,?,?,?,?)', fid, name, req.file.mimetype, req.file.size, req.user!.name, nowMST());
  }
  await q.run('INSERT INTO documents(patientId,name,cat,meta,fileId) VALUES(?,?,?,?,?)', req.params.id, name, req.body?.cat || 'Other', nowMST() + ' · ' + req.user!.name, fid);
  await addNote(req.params.id, `Document added: "${name}"`, req.user!.name);
  await audit(req.user!, 'document.create', 'patient', req.params.id, name);
  await sendPatient(req, res, req.params.id);
});

/* ================= providers ================= */
api.post('/providers', async (req, res) => {
  const v = req.body || {};
  if (!String(v.name || '').trim()) return res.status(400).json({ error: 'Name required' });
  const id = await nextId('md');
  await q.run('INSERT INTO providers(id,name,type,status,corpAddress,corpPhone,corpEmail,taxId,rules) VALUES(?,?,?,?,?,?,?,?,?)', id, v.name, v.type || null, JSON.stringify(v.status || []), v.corpAddress || null, v.corpPhone || null, v.corpEmail || null, v.taxId || null, JSON.stringify(v.rules || []));
  if (v.branch?.name) {
    const b = v.branch;
    await q.run('INSERT INTO branches(providerId,name,address,phone,email,contacts,rate,status,ratePct,rateCap) VALUES(?,?,?,?,?,?,?,?,?,?)', id, b.name, b.address || null, b.phone || null, b.email || null, b.contacts || null, b.rate || null, (v.status || [])[0] || 'Under contract',
        Number(b.ratePct) || null, Number(b.rateCap) || null);
  }
  await audit(req.user!, 'provider.create', 'provider', id, v.name);
  res.json(await fullProvider(id));
});

api.patch('/providers/:id', async (req, res) => {
  const v = req.body || {};
  const pr = await q.get('SELECT * FROM providers WHERE id=?', req.params.id) as any;
  if (!pr) return res.status(404).json({ error: 'Not found' });
  // "Under contract" is DERIVED from the BAA + rate agreement being signed — a status
  // edit can neither grant it (without the signatures) nor accidentally remove it.
  let status: string[] = Array.isArray(v.status) ? v.status.filter(Boolean) : [];
  const gate = !!(pr.baaSignedAt && pr.rateAgreementSignedAt);
  status = status.filter(s => s !== 'Under contract');
  if (gate) status.push('Under contract');
  await q.run('UPDATE providers SET name=?,type=?,status=?,corpAddress=?,corpPhone=?,corpEmail=?,taxId=?,rules=? WHERE id=?', v.name, v.type || null, JSON.stringify(status), v.corpAddress || null, v.corpPhone || null, v.corpEmail || null, v.taxId || null, JSON.stringify(v.rules || []), req.params.id);
  for (const c of ['npi', 'licenseNo', 'licenseExp', 'malpracticeCarrier', 'malpracticeExp', 'w9OnFile', 'baaSigned', 'conservative', 'orgType'])
    if (c in v) await q.run(`UPDATE providers SET ${c}=? WHERE id=?`, v[c] || null, req.params.id);
  await audit(req.user!, 'provider.update', 'provider', req.params.id);
  res.json(await fullProvider(req.params.id));
});

api.get('/providers/:id/stats', async (req, res) => {
  const pr = await fullProvider(req.params.id);
  if (!pr) return res.status(404).json({ error: 'Not found' });
  res.json(await Promise.all(pr.branches.map(async (b: any) => ({ branchId: b.id, ...await branchStats(pr.id, b.name, pr.branches.length), disputes: b.disputes }))))
});

api.post('/providers/:id/branches', async (req, res) => {
  const v = req.body || {};
  if (!String(v.name || '').trim()) return res.status(400).json({ error: 'Name required' });
  await q.run('INSERT INTO branches(providerId,name,address,phone,email,contacts,rate,status,ratePct,rateCap) VALUES(?,?,?,?,?,?,?,?,?,?)', req.params.id, v.name, v.address || null, v.phone || null, v.email || null, v.contacts || null, v.rate || null,
      v.status || 'Under contract', Number(v.ratePct) || null, Number(v.rateCap) || null);
  await audit(req.user!, 'branch.create', 'provider', req.params.id, v.name);
  res.json(await fullProvider(req.params.id));
});

api.patch('/branches/:bid', async (req, res) => {
  const b = await q.get('SELECT * FROM branches WHERE id=?', req.params.bid) as any;
  if (!b) return res.status(404).json({ error: 'Not found' });
  const v = req.body || {};
  await q.run('UPDATE branches SET name=?,address=?,phone=?,email=?,contacts=?,rate=?,status=?,contract=?,disputes=?,ratePct=?,rateCap=? WHERE id=?', v.name ?? b.name, v.address ?? b.address, v.phone ?? b.phone, v.email ?? b.email, v.contacts ?? b.contacts,
      v.rate ?? b.rate, v.status ?? b.status, v.contract ?? b.contract, Number(v.disputes ?? b.disputes) || 0,
      v.ratePct !== undefined ? (Number(v.ratePct) || null) : b.ratePct,
      v.rateCap !== undefined ? (Number(v.rateCap) || null) : b.rateCap, b.id);
  if (v.name && v.name !== b.name)
    await q.run('UPDATE prov_links SET branch=? WHERE providerId=? AND branch=?', v.name, b.providerId, b.name);
  await audit(req.user!, 'branch.update', 'branch', String(b.id));
  res.json(await fullProvider(b.providerId));
});

/* ================= insurers ================= */
api.post('/insurers', async (req, res) => {
  const v = req.body || {};
  if (!String(v.name || '').trim()) return res.status(400).json({ error: 'Name required' });
  const id = await nextId('ins');
  await q.run('INSERT INTO insurers(id,name,hq,phone,email,relationship,payRate,states,rules) VALUES(?,?,?,?,?,?,?,?,?)', id, v.name, v.hq || null, v.phone || null, v.email || null, v.relationship || null, v.payRate || null,
      JSON.stringify(v.states || []), JSON.stringify(v.rules || []));
  if (v.adjuster?.name)
    await q.run('INSERT INTO adjusters(id,insurerId,name,phone,email) VALUES(?,?,?,?,?)', 'a' + Date.now(), id, v.adjuster.name, v.adjuster.phone || null, v.adjuster.email || null);
  await audit(req.user!, 'insurer.create', 'insurer', id, v.name);
  res.json(await fullInsurer(id));
});

api.patch('/insurers/:id', async (req, res) => {
  const c = await q.get('SELECT id FROM insurers WHERE id=?', req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const v = req.body || {};
  await q.run('UPDATE insurers SET name=?,hq=?,phone=?,email=?,relationship=?,payRate=?,states=?,rules=? WHERE id=?', v.name, v.hq || null, v.phone || null, v.email || null, v.relationship || null, v.payRate || null,
      JSON.stringify(v.states || []), JSON.stringify(v.rules || []), req.params.id);
  await audit(req.user!, 'insurer.update', 'insurer', req.params.id);
  res.json(await fullInsurer(req.params.id));
});

api.patch('/insurers/:id/manual-stats', async (req, res) => {
  const v = req.body || {};
  await q.run('UPDATE insurers SET avgDays=?,disputes=?,denialRate=? WHERE id=?', Number(v.avgDays) || 0, Number(v.disputes) || 0, Number(v.denialRate) || 0, req.params.id);
  await audit(req.user!, 'insurer.manualStats', 'insurer', req.params.id);
  res.json(await fullInsurer(req.params.id));
});

api.get('/insurers/:id/stats', requireAdmin, async (req, res) => {
  const c = await fullInsurer(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json({ ...await insAutoStats(c.id), avgDays: c.avgDays, disputes: c.disputes, denialRate: c.denialRate });
});

api.post('/insurers/:id/adjusters', async (req, res) => {
  const v = req.body || {};
  if (!String(v.name || '').trim()) return res.status(400).json({ error: 'Name required' });
  await q.run('INSERT INTO adjusters(id,insurerId,name,phone,email,contract,notes) VALUES(?,?,?,?,?,?,?)', 'a' + Date.now(), req.params.id, v.name, v.phone || null, v.email || null, v.contract || null, v.notes || null);
  await audit(req.user!, 'adjuster.create', 'insurer', req.params.id, v.name);
  res.json(await fullInsurer(req.params.id));
});

api.patch('/adjusters/:aid', async (req, res) => {
  const a = await q.get('SELECT * FROM adjusters WHERE id=?', req.params.aid) as any;
  if (!a) return res.status(404).json({ error: 'Not found' });
  const v = req.body || {};
  await q.run('UPDATE adjusters SET name=?,phone=?,email=?,contract=?,notes=? WHERE id=?', v.name ?? a.name, v.phone ?? a.phone, v.email ?? a.email, v.contract ?? a.contract, v.notes ?? a.notes, a.id);
  await audit(req.user!, 'adjuster.update', 'adjuster', a.id);
  res.json(await fullInsurer(a.insurerId));
});

api.post('/insurers/:id/contracts', async (req, res) => {
  const v = req.body || {};
  if (!String(v.name || '').trim()) return res.status(400).json({ error: 'Name required' });
  const scope = v.scope === 'adjuster' ? 'adjuster' : 'carrier';
  if (scope === 'adjuster' && !v.adjusterId) return res.status(400).json({ error: 'Pick the adjuster for an adjuster-scope contract' });
  // Contract rate (% of billed the carrier pays us) is admin-only — silently ignored otherwise.
  const rate = req.user!.role === 'admin' && v.rate !== '' && v.rate != null ? Number(v.rate) : null;
  await q.run('INSERT INTO ins_contracts(insurerId,name,meta,status,scope,adjusterId,rate) VALUES(?,?,?,?,?,?,?)', req.params.id, v.name, v.meta || null, v.status || 'Active', scope, scope === 'adjuster' ? v.adjusterId : null, rate);
  await audit(req.user!, 'insContract.create', 'insurer', req.params.id, `${v.name} (${scope})`);
  res.json(await fullInsurer(req.params.id));
});

/* ================= AI requests ================= */
api.get('/ai', async (_req, res) => res.json(await q.all('SELECT * FROM ai_requests ORDER BY id DESC')));
api.post('/ai', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Empty' });
  await q.run('INSERT INTO ai_requests(text,time,status,by) VALUES(?,?,?,?)', text, nowMST(), 'pending', req.user!.name);
  await audit(req.user!, 'ai.request', undefined, undefined, text);
  res.json(await q.all('SELECT * FROM ai_requests ORDER BY id DESC'));
});
api.post('/ai/:aid/decide', requireAdmin, async (req, res) => {
  const status = req.body?.status === 'approved' ? 'approved' : 'denied';
  await q.run('UPDATE ai_requests SET status=? WHERE id=?', status, req.params.aid);
  await audit(req.user!, 'ai.' + status, 'ai', req.params.aid);
  res.json(await q.all('SELECT * FROM ai_requests ORDER BY id DESC'));
});

/* ================= widget prefs ================= */
api.put('/prefs/:key', async (req, res) => {
  const { color, size } = req.body || {};
  const existing = await q.get('SELECT * FROM widget_prefs WHERE userId=? AND key=?', req.user!.id, req.params.key) as any;
  await q.run(`INSERT INTO widget_prefs(userId,key,color,size) VALUES(?,?,?,?)
    ON CONFLICT(userId,key) DO UPDATE SET color=?, size=?`, req.user!.id, req.params.key,
      color ?? existing?.color ?? null, size ?? existing?.size ?? null,
      color ?? existing?.color ?? null, size ?? existing?.size ?? null);
  res.json(await q.all('SELECT key,color,size FROM widget_prefs WHERE userId=?', req.user!.id));
});

/* ================= admin: user management ================= */
api.get('/admin/users', requireAdmin, async (req, res) =>
  res.json(await Promise.all((await q.all('SELECT id,name,email,role,active,totpSecret,orgId,approved,perms FROM users') as any[])
    .map(async u => ({
      id: u.id, name: u.name, email: u.email, role: u.role, active: u.active,
      perms: (() => { try { return JSON.parse(u.perms || '[]'); } catch { return []; } })(),
      mfaEnrolled: !!u.totpSecret, approved: u.approved, orgId: u.orgId,
      orgName: u.orgId
        ? ((await q.get('SELECT name FROM providers WHERE id=?', u.orgId) as any)?.name
          || (await q.get('SELECT name FROM insurers WHERE id=?', u.orgId) as any)?.name || u.orgId)
        : null,
    })))));
api.post('/admin/users/:uid/approve', requireAdmin, async (req, res) => {
  const u = await q.get('SELECT * FROM users WHERE id=?', req.params.uid) as any;
  if (!u) return res.status(404).json({ error: 'Not found' });
  const approve = req.body?.approve !== false;
  const orgRole = req.body?.orgRole === 'admin' ? 'admin' : 'worker';
  if (approve) await q.run('UPDATE users SET approved=1, orgRole=? WHERE id=?', orgRole, u.id);
  else await q.run('UPDATE users SET approved=0, active=0 WHERE id=?', u.id);
  await audit(req.user!, approve ? 'admin.user.approve' : 'admin.user.denyAccess', 'user', u.id, u.email);
  res.json({ ok: true });
});

api.post('/admin/users', requireAdmin, async (req, res) => {
  const { name, email, role, password } = req.body || {};
  if (!String(name || '').trim() || !String(email || '').trim()) return res.status(400).json({ error: 'Name and email required' });
  if (!['admin', 'coordinator', 'sales'].includes(role)) return res.status(400).json({ error: 'Role must be admin, coordinator, or sales' });
  if (password && String(password).length < 8) return res.status(400).json({ error: 'Temporary password must be at least 8 characters' });
  if (await q.get('SELECT 1 FROM users WHERE lower(email)=lower(?)', email)) return res.status(400).json({ error: 'That email already has an account' });
  const bcrypt = (await import('bcryptjs')).default;
  // No password given → generate a temp code and email it to the new user.
  // Either way the account is locked to /api/auth/* until they set their own password.
  const temp = password || 'T-' + crypto.randomBytes(5).toString('hex');
  const id = 'u' + Date.now();
  await q.run('INSERT INTO users(id,name,email,pwHash,role,active,mustChangePw) VALUES(?,?,?,?,?,1,1)', id, name.trim(), email.trim(), bcrypt.hashSync(temp, 10), role);
  await audit(req.user!, 'admin.user.create', 'user', id, `${name} (${role})${password ? '' : ' · temp code emailed'}`);
  let emailed = false;
  if (!password) {
    const r = await sendMail({
      to: email.trim(), subject: 'Your Trilogy account',
      text: `Hi ${name.trim()},\n\nAn account was created for you on the Trilogy platform.\n\nSign in at https://trilogyconnections.com with this email address and the temporary code below — you'll be asked to set your own password immediately:\n\n${temp}\n\n— Trilogy Medical Networks`,
      meta: { kind: 'temp-code', userId: id },
      replyTo: (req.user as any)?.email || null,   // "I can't log in" goes to the admin who made the account
    });
    emailed = r.sent;
  }
  // Until email is live, hand the code back to the admin exactly once so they can relay it.
  res.json({ ok: true, id, emailed, ...(password || emailed ? {} : { tempPassword: temp }) });
});

api.patch('/admin/users/:uid', requireAdmin, async (req, res) => {
  const u = await q.get('SELECT * FROM users WHERE id=?', req.params.uid) as any;
  if (!u) return res.status(404).json({ error: 'Not found' });
  const { role, active } = req.body || {};
  if (u.id === req.user!.id && ((role && role !== 'admin') || active === 0))
    return res.status(400).json({ error: "You can't demote or deactivate your own account" });
  if (role) {
    if (!['admin', 'coordinator', 'sales'].includes(role)) return res.status(400).json({ error: 'Bad role' });
    await q.run('UPDATE users SET role=? WHERE id=?', role, u.id);
    await audit(req.user!, 'admin.user.role', 'user', u.id, role);
  }
  if (active === 0 || active === 1) {
    await q.run('UPDATE users SET active=? WHERE id=?', active, u.id);
    await audit(req.user!, active ? 'admin.user.reactivate' : 'admin.user.deactivate', 'user', u.id, u.name);
  }
  res.json({ ok: true });
});

/* Per-user tool grants (currently: 'fees'). Any admin can grant or revoke. */
api.post('/admin/users/:uid/perms', requireAdmin, async (req, res) => {
  const u = await q.get('SELECT * FROM users WHERE id=?', req.params.uid) as any;
  if (!u) return res.status(404).json({ error: 'Not found' });
  const perm = String(req.body?.perm || '');
  if (!['fees', 'crm'].includes(perm)) return res.status(400).json({ error: 'Unknown permission' });
  let perms: string[] = [];
  try { perms = JSON.parse(u.perms || '[]'); } catch { /* reset */ }
  const grant = req.body?.grant !== false;
  perms = perms.filter(p => p !== perm);
  if (grant) perms.push(perm);
  await q.run('UPDATE users SET perms=? WHERE id=?', JSON.stringify(perms), u.id);
  await audit(req.user!, grant ? 'admin.user.grantPerm' : 'admin.user.revokePerm', 'user', u.id, `${perm} — ${u.email}`);
  res.json({ ok: true, perms });
});

api.post('/admin/users/:uid/reset-password', requireAdmin, async (req, res) => {
  const u = await q.get('SELECT * FROM users WHERE id=?', req.params.uid) as any;
  if (!u) return res.status(404).json({ error: 'Not found' });
  const pw = String(req.body?.password || '');
  if (pw.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const bcrypt = (await import('bcryptjs')).default;
  await q.run('UPDATE users SET pwHash=?, mustChangePw=1 WHERE id=?', bcrypt.hashSync(pw, 10), u.id);
  await audit(req.user!, 'admin.user.resetPassword', 'user', u.id, u.name);
  res.json({ ok: true });
});

api.post('/admin/users/:uid/reset-mfa', requireAdmin, async (req, res) => {
  const u = await q.get('SELECT * FROM users WHERE id=?', req.params.uid) as any;
  if (!u) return res.status(404).json({ error: 'Not found' });
  await q.run('UPDATE users SET totpSecret=NULL WHERE id=?', u.id);
  await audit(req.user!, 'admin.user.resetMfa', 'user', u.id, u.name);
  res.json({ ok: true, note: 'User will enroll a fresh authenticator at next login' });
});

/* ================= bill entry v2 — files inline, payout always auto ================= */
api.post('/patients/:id/bills2', upload.fields([{ name: 'bill', maxCount: 1 }, { name: 'note', maxCount: 1 }]), persistUploads, async (req, res) => {
  const v = req.body || {};
  const files = req.files as Record<string, Express.Multer.File[]> | undefined;
  const billFile = files?.bill?.[0]; const noteFile = files?.note?.[0];
  const pr = await q.get('SELECT name FROM providers WHERE id=?', v.providerId) as any;
  if (!pr) return res.status(400).json({ error: 'Unknown provider' });
  const link = await q.get('SELECT * FROM prov_links WHERE patientId=? AND providerId=?', req.params.id, v.providerId) as any;
  if (!link) return res.status(400).json({ error: 'Link this provider to the patient first (Treating Providers tab)' });
  if (!v.dos) return res.status(400).json({ error: 'Date of service required' });
  if (!billFile) return res.status(400).json({ error: 'Attach the bill document' });
  const billed = Number(v.billed);
  if (!(billed > 0)) return res.status(400).json({ error: 'Billed amount required' });

  const mode = v.mode === 'invoice' ? 'invoice' : 'itemized';
  let items: any[] = [];
  if (mode === 'itemized') {
    try { items = JSON.parse(v.items || '[]'); } catch { /* handled below */ }
    items = (Array.isArray(items) ? items : []).filter(x => String(x.cpt || '').trim());
    if (!items.length) return res.status(400).json({ error: 'Itemized bills need at least one CPT line (or switch to General invoice)' });
    const sum = items.reduce((s, x) => s + (Number(x.charge) || 0) * (Number(x.units) || 1), 0);
    if (Math.abs(sum - billed) > 0.01)
      return res.status(400).json({ error: `CPT lines total ${fmt$(sum)} but the billed amount is ${fmt$(billed)} — they must match exactly` });
  } else if (!String(v.descr || '').trim()) {
    return res.status(400).json({ error: 'General invoices need a description' });
  }

  const store = async (f: Express.Multer.File) => {
    await q.run('INSERT INTO files(id,name,mime,size,uploadedBy,time) VALUES(?,?,?,?,?,?)', f.filename, f.originalname, f.mimetype, f.size, req.user!.name, nowMST());
    return f.filename;
  };
  const bfid = await store(billFile);
  const nfid = noteFile ? await store(noteFile) : null;
  // Payout is ALWAYS computed from contracted terms — never entered by hand here.
  const pRow = await q.get('SELECT insurerId FROM patients WHERE id=?', req.params.id) as any;
  const eco = await computeBillEconomics(pRow?.insurerId || null, v.providerId, link.branch, items, billed, v.dos || null);
  const bid = 'b' + Date.now() + Math.floor(Math.random() * 1000);
  await q.run(`INSERT INTO bills(id,patientId,providerId,dos,billed,rate,revenue,descr,hasBill,hasNote,billFileId,billFileName,noteFileId,noteFileName)
    VALUES(?,?,?,?,?,?,?,?,1,?,?,?,?,?)`, bid, req.params.id, v.providerId, v.dos, billed, eco.payout || 0, eco.revenue, v.descr || null,
      nfid ? 1 : 0, bfid, billFile.originalname, nfid, noteFile?.originalname || null);
  for (const x of items)
    await q.run('INSERT INTO bill_items(billId,cpt,icd,units,charge,modifier) VALUES(?,?,?,?,?,?)', bid, String(x.cpt).trim(), x.icd || null, Number(x.units) || 1, Number(x.charge) || 0, x.modifier || null);
  await q.run('UPDATE prov_links SET billed=billed+? WHERE patientId=? AND providerId=?', billed, req.params.id, v.providerId);
  await addNote(req.params.id, `${mode === 'invoice' ? 'Invoice' : 'Bill'} added: ${pr.name} · DOS ${fmtDate(v.dos)} · ${fmt$(billed)}${mode === 'invoice' ? ` — ${v.descr}` : ` · ${items.length} CPT line${items.length === 1 ? '' : 's'}`}${nfid ? '' : ' — visit note still needed to unlock payment'}`, req.user!.name);
  await audit(req.user!, 'bill.create2', 'bill', bid, `${mode} ${billed}`);
  await sendPatient(req, res, req.params.id);
});

/* ================= per-case financials — ADMIN ONLY (the margins tab) ================= */
api.get('/patients/:id/financials', requireAdmin, async (req, res) => {
  const p = await q.get('SELECT * FROM patients WHERE id=?', req.params.id) as any;
  if (!p) return res.status(404).json({ error: 'Not found' });
  const zip = (String(p.address || '').match(/\b(\d{5})(?:-\d{4})?\b/) || [])[1] || '';
  const bills = await q.all('SELECT * FROM bills WHERE patientId=? AND voided=0', p.id) as any[];
  const byProv = new Map<string, any[]>();
  for (const b of bills) (byProv.get(b.providerId) || byProv.set(b.providerId, []).get(b.providerId)!).push(b);
  const providers = await Promise.all([...byProv.entries()].map(async ([pid, bs]) => {
    const pr = await q.get('SELECT name, type FROM providers WHERE id=?', pid) as any;
    const billedTotal = bs.reduce((s, b) => s + b.billed, 0);
    const payoutTotal = bs.reduce((s, b) => s + (b.rate || 0), 0);
    const payoutPaid = bs.filter(b => b.status === 'paid').reduce((s, b) => s + (b.rate || 0), 0);
    const revenueTotal = bs.reduce((s, b) => s + (b.revenue || 0), 0);
    // Medicare comparison: sum current Medicare-allowed for every CPT line at the patient's ZIP
    let medicareTotal = 0, medicareLines = 0, totalLines = 0;
    for (const b of bs) {
      for (const it of await q.all('SELECT * FROM bill_items WHERE billId=?', b.id) as any[]) {
        totalLines++;
        const m = it.cpt ? await medicareFor(zip, it.cpt) : null;
        if (m != null) { medicareTotal += m * (Number(it.units) || 1); medicareLines++; }
      }
    }
    return {
      providerId: pid, name: pr?.name || pid, type: pr?.type || null, bills: bs.length,
      billedTotal, payoutTotal, payoutPaid,
      payoutPctOfBilled: billedTotal ? Math.round(payoutTotal / billedTotal * 1000) / 10 : null,
      revenueTotal,
      carrierPctOfBilled: billedTotal && revenueTotal ? Math.round(revenueTotal / billedTotal * 1000) / 10 : null,
      medicareTotal: medicareLines ? Math.round(medicareTotal * 100) / 100 : null,
      medicareMultiple: medicareLines && medicareTotal > 0 ? Math.round(payoutTotal / medicareTotal * 100) / 100 : null,
      medicareCoverage: totalLines ? `${medicareLines}/${totalLines} CPT lines benchmarked` : 'no CPT lines entered',
      marginProjected: Math.round(((bs.reduce((s, b) => s + (b.revenue || b.billed), 0)) - payoutTotal) * 100) / 100,
    };
  }));
  const received = (await q.get("SELECT COALESCE(SUM(amount),0) s FROM receipts WHERE patientId=? AND status='Cleared' AND voided=0", p.id) as any).s;
  const pendingIn = (await q.get("SELECT COALESCE(SUM(amount),0) s FROM receipts WHERE patientId=? AND status!='Cleared' AND voided=0", p.id) as any).s;
  const payoutPaid = bills.filter(b => b.status === 'paid').reduce((s, b) => s + (b.rate || 0), 0);
  const payoutProjected = bills.reduce((s, b) => s + (b.rate || 0), 0);
  const revenueProjected = bills.reduce((s, b) => s + (b.revenue || b.billed), 0);
  const billedTotal = bills.reduce((s, b) => s + b.billed, 0);
  res.json({
    zip: zip || null, providers,
    case: {
      billedTotal, received, pendingIn, payoutPaid, payoutProjected, revenueProjected,
      marginRealized: Math.round((received - payoutPaid) * 100) / 100,
      marginProjected: Math.round((revenueProjected - payoutProjected) * 100) / 100,
      marginRealizedPct: received ? Math.round((received - payoutPaid) / received * 100) : null,
      marginProjectedPct: revenueProjected ? Math.round((revenueProjected - payoutProjected) / revenueProjected * 100) : null,
      carrierPctOfBilled: billedTotal ? Math.round(revenueProjected / billedTotal * 1000) / 10 : null,
    },
  });
});

/* ================= geocoding & drive time (OpenStreetMap / OSRM via server/geo.ts) ================= */
api.get('/geo/code', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'q required' });
  const g = await geocode(q);
  if (!g) return res.status(404).json({ error: 'Address not found' });
  res.json(g);
});
/* Batch: answers from cache immediately and queues the rest (Nominatim allows 1 lookup/sec
   globally, so a fresh map fills in over ~1s per new address). Client polls while pending>0. */
api.post('/geo/batch', async (req, res) => {
  const addresses = Array.isArray(req.body?.addresses) ? req.body.addresses : [];
  if (!addresses.length) return res.status(400).json({ error: 'addresses[] required' });
  res.json(await geoBatch(addresses));
});
api.get('/geo/route', async (req, res) => {
  const { flat, flon, tlat, tlon } = req.query as any;
  if (![flat, flon, tlat, tlon].every(x => Number.isFinite(parseFloat(x)))) return res.status(400).json({ error: 'flat/flon/tlat/tlon required' });
  const rt = await route(parseFloat(flat), parseFloat(flon), parseFloat(tlat), parseFloat(tlon));
  if (!rt) return res.status(404).json({ error: 'No route found' });
  res.json(rt);
});

/* ================= provider contracts: BAA + rate agreement gate ================= */
api.post('/providers/:id/contract/:kind(baa|rate)', upload.single('file'), persistUploads, async (req, res) => {
  const pr = await q.get('SELECT * FROM providers WHERE id=?', req.params.id) as any;
  if (!pr) return res.status(404).json({ error: 'Not found' });
  const kind = req.params.kind;
  const fileCol = kind === 'baa' ? 'baaFileId' : 'rateAgreementFileId';
  const signCol = kind === 'baa' ? 'baaSignedAt' : 'rateAgreementSignedAt';
  if (req.file) {
    await q.run('INSERT INTO files(id,name,mime,size,uploadedBy,time) VALUES(?,?,?,?,?,?)', req.file.filename, req.file.originalname, req.file.mimetype, req.file.size, req.user!.name, nowMST());
    await q.run(`UPDATE providers SET ${fileCol}=? WHERE id=?`, req.file.filename, pr.id);
  }
  if (req.body?.signed === '1' || req.body?.signed === 1 || req.body?.signed === true) {
    await q.run(`UPDATE providers SET ${signCol}=? WHERE id=?`, `Signed · ${nowMST()} · recorded by ${req.user!.name}`, pr.id);
  }
  const after = await q.get('SELECT baaSignedAt, rateAgreementSignedAt, status FROM providers WHERE id=?', pr.id) as any;
  // Both signed → the provider becomes Under contract (this is the only path to that status).
  if (after.baaSignedAt && after.rateAgreementSignedAt) {
    let st: string[] = []; try { st = JSON.parse(after.status || '[]'); } catch { /* reset */ }
    if (!st.includes('Under contract')) {
      st = st.filter(s => s !== 'Single case agreement'); st.push('Under contract');
      await q.run('UPDATE providers SET status=? WHERE id=?', JSON.stringify(st), pr.id);
      await audit(req.user!, 'provider.underContract', 'provider', pr.id, 'BAA + rate agreement both signed');
    }
  }
  await audit(req.user!, `provider.contract.${kind}`, 'provider', pr.id, req.file?.originalname || 'marked signed');
  res.json(await fullProvider(pr.id));
});

/* Admin-only provider business terms (contracted rate + contract files). */
api.get('/providers/:id/admin', requireAdmin, async (req, res) => {
  const pr = await q.get('SELECT id, name, contractedRate, baaFileId, baaSignedAt, rateAgreementFileId, rateAgreementSignedAt, orgType FROM providers WHERE id=?', req.params.id) as any;
  if (!pr) return res.status(404).json({ error: 'Not found' });
  res.json(pr);
});
api.post('/providers/:id/contracted-rate', requireAdmin, async (req, res) => {
  const pr = await q.get('SELECT id, name FROM providers WHERE id=?', req.params.id) as any;
  if (!pr) return res.status(404).json({ error: 'Not found' });
  await q.run('UPDATE providers SET contractedRate=? WHERE id=?', String(req.body?.rate || '').trim() || null, pr.id);
  await audit(req.user!, 'provider.contractedRate', 'provider', pr.id);
  res.json({ ok: true });
});

/* ================= insurer contracts: master vs per-adjuster, admin-only rates ================= */
api.patch('/ins-contracts/:cid', async (req, res) => {
  const c = await q.get('SELECT * FROM ins_contracts WHERE id=?', req.params.cid) as any;
  if (!c) return res.status(404).json({ error: 'Not found' });
  const v = req.body || {};
  if (v.status) await q.run('UPDATE ins_contracts SET status=? WHERE id=?', String(v.status), c.id);
  if ('rate' in v) {
    if (req.user!.role !== 'admin') return res.status(403).json({ error: 'Contract rates are admin-only' });
    await q.run('UPDATE ins_contracts SET rate=? WHERE id=?', v.rate === '' || v.rate == null ? null : Number(v.rate), c.id);
  }
  await audit(req.user!, 'insContract.update', 'insurer', c.insurerId, `${c.name}: ${v.status || ''}${'rate' in v ? ' rate set' : ''}`);
  res.json({ ok: true });
});
api.get('/insurers/:id/contract-rates', requireAdmin, async (req, res) =>
  res.json(await q.all('SELECT id, name, scope, adjusterId, rate FROM ins_contracts WHERE insurerId=?', req.params.id)));

/* ================= admin: delete account (deactivate's permanent sibling) ================= */
api.delete('/admin/users/:uid', requireAdmin, async (req, res) => {
  const u = await q.get('SELECT * FROM users WHERE id=?', req.params.uid) as any;
  if (!u) return res.status(404).json({ error: 'Not found' });
  if (u.id === req.user!.id) return res.status(400).json({ error: "You can't delete your own account" });
  const assigned = (await q.get('SELECT COUNT(*) c FROM patients WHERE coordinator=? AND stage<4', u.id) as any).c;
  if (assigned) return res.status(400).json({ error: `${u.name} is the coordinator on ${assigned} active case${assigned === 1 ? '' : 's'} — reassign them first, then delete` });
  await q.run('UPDATE patients SET coordinator=NULL WHERE coordinator=?', u.id);
  await q.run('DELETE FROM widget_prefs WHERE userId=?', u.id);
  await q.run('DELETE FROM users WHERE id=?', u.id);
  await audit(req.user!, 'admin.user.delete', 'user', u.id, `${u.name} <${u.email}> permanently deleted`);
  res.json({ ok: true });
});

/* ================= admin: audit & data ================= */
api.get('/admin/audit', requireAdmin, async (req, res) =>
  res.json(await q.all('SELECT * FROM audit_log ORDER BY id DESC LIMIT 500')));

api.get('/admin/export', requireAdmin, async (req, res) => {
  const dump: any = {};
  for (const t of ['users', 'counters', 'insurers', 'adjusters', 'ins_contracts', 'providers', 'branches', 'patients', 'outside_bills', 'notes', 'tasks', 'task_comments', 'prov_links', 'bills', 'receipts', 'sent_docs', 'documents', 'files', 'ai_requests', 'widget_prefs', 'crm_targets', 'crm_contacts', 'crm_activities'])
    dump[t] = await q.all(`SELECT * FROM ${t}`);
  // Never export credentials: password hashes and TOTP secrets stay in the database.
  dump.users = dump.users.map(({ pwHash, totpSecret, ...u }: any) => u);
  res.setHeader('Content-Disposition', `attachment; filename="trilogy-export-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(dump);
});

/* ================= admin: integrations (the API layer's control panel) =================
   Status of each external service, masked view of stored keys, and write-only key entry.
   Secrets are NEVER returned in full — masked last-4 only. Env vars of the same name win. */
api.get('/admin/integrations', requireAdmin, async (req, res) =>
  res.json({ services: await integrationStatus(), secrets: await secretsMasked() }));

api.post('/admin/secrets', requireAdmin, async (req, res) => {
  const entries = Object.entries((req.body || {}) as Record<string, string>)
    .filter(([k, v]) => (SECRET_KEYS as readonly string[]).includes(k) && typeof v === 'string' && v.trim());
  if (!entries.length) return res.status(400).json({ error: 'Nothing to save' });
  for (const [k, v] of entries) await setSecret(k, v.trim(), req.user!.name);
  // Audit the keys touched, never the values.
  await audit(req.user!, 'admin.secrets.set', undefined, undefined, entries.map(([k]) => k).join(', '));
  res.json({ services: await integrationStatus(), secrets: await secretsMasked() });
});

/* SES go-live tools — domain DNS records, verification status, sandbox address verify, test send. */
api.post('/admin/integrations/ses/domain', requireAdmin, async (req, res) => {
  if (!await emailReady()) return res.status(503).json({ error: 'Save the AWS keys and SES_FROM first' });
  try {
    const r = await sesSetupDomain();
    await audit(req.user!, 'admin.ses.domainSetup', undefined, undefined, r.domain);
    res.json(r);
  } catch (err: any) { res.status(502).json({ error: 'AWS said: ' + String(err?.message || err).slice(0, 200) }); }
});
api.get('/admin/integrations/ses/status', requireAdmin, async (_req, res) => {
  if (!await emailReady()) return res.status(503).json({ error: 'Save the AWS keys and SES_FROM first' });
  try { res.json(await sesStatus()); }
  catch (err: any) { res.status(502).json({ error: 'AWS said: ' + String(err?.message || err).slice(0, 200) }); }
});
api.post('/admin/integrations/ses/verify-address', requireAdmin, async (req, res) => {
  const email = String(req.body?.email || '').trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Valid email required' });
  if (!await emailReady()) return res.status(503).json({ error: 'Save the AWS keys and SES_FROM first' });
  try {
    await sesVerifyAddress(email);
    await audit(req.user!, 'admin.ses.verifyAddress', undefined, undefined, email);
    res.json({ ok: true, message: `AWS is emailing ${email} a verification link — click it, then test sends can deliver there even in sandbox mode.` });
  } catch (err: any) { res.status(502).json({ error: 'AWS said: ' + String(err?.message || err).slice(0, 200) }); }
});
api.post('/admin/integrations/ses/test', requireAdmin, async (req, res) => {
  const to = String(req.body?.to || '').trim();
  if (!/^\S+@\S+\.\S+$/.test(to)) return res.status(400).json({ error: 'Valid email required' });
  const r = await sendMail({
    to, subject: 'Trilogy platform — test email',
    text: `This is a test from the Trilogy platform's email integration.\n\nIf you're reading this in your inbox, outbound email is working.\n\nSent ${nowMST()} by ${req.user!.name} from Admin → Integrations.`,
    meta: { kind: 'test', by: req.user!.id },
    replyTo: (req.user as any)?.email || null,
  });
  const row = await q.get('SELECT status, detail FROM outbox WHERE id=?', r.outboxId) as any;
  await audit(req.user!, 'admin.ses.testEmail', undefined, undefined, `${to} — ${row?.status}`);
  res.json({ sent: r.sent, status: row?.status, detail: row?.detail || null });
});

/* Fax: pull inbound faxes on demand (the poller also runs every 5 min in production). */
api.post('/admin/integrations/fax/poll', requireAdmin, async (req, res) => {
  const r = await pollInboundFaxes();
  if (!r) return res.status(503).json({ error: 'Fax polling failed or Faxage keys are missing — see the audit log for the reason' });
  await audit(req.user!, 'admin.fax.poll', undefined, undefined, `${r.imported} imported`);
  res.json({ ok: true, imported: r.imported, message: r.imported ? `${r.imported} new fax${r.imported === 1 ? '' : 'es'} added to the Requests queue` : 'No new faxes waiting' });
});

/* Outbox: what tried to send. Queued = waiting on credentials; failed = live but the vendor errored. */
api.get('/admin/outbox', requireAdmin, async (req, res) =>
  res.json(await q.all('SELECT id,kind,toAddr,subject,substr(body,1,400) body,patientId,status,detail,createdAt,sentAt FROM outbox ORDER BY id DESC LIMIT 200', )));

/* ================= bill OCR — reads an uploaded bill into CPT lines ================= */
api.post('/bills/parse', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Attach the bill to read' });
  if (!await ocrReady()) return res.status(503).json({ error: 'Bill reading needs the AWS keys — an admin can add them under Admin → Integrations' });
  try {
    const parsed = await parseBillFile(fs.readFileSync(req.file.path), req.file.mimetype);
    fs.unlinkSync(req.file.path);   // parse-only upload; the real file goes in with the bill itself
    if (!parsed) return res.status(422).json({ error: "Couldn't find a date, total, or line items on that document — enter them by hand" });
    res.json(parsed);
  } catch (err: any) {
    try { fs.unlinkSync(req.file.path); } catch { /* already gone */ }
    const msg = String(err?.name || '').includes('UnsupportedDocument')
      ? 'That file type couldn\'t be read — a PDF, PNG, or JPEG of the bill will work'
      : String(err?.name || '').includes('ProvisionedThroughput') || String(err?.name || '').includes('Throttling')
        ? 'The document reader is busy — try again in a few seconds'
        : 'Bill reading failed: ' + String(err?.message || err).slice(0, 120);
    res.status(502).json({ error: msg });
  }
});

api.post('/admin/wipe-demo', requireAdmin, async (req, res) => {
  // audit_log deliberately NOT wiped — the audit trail survives data resets.
  const tables = ['notes', 'task_comments', 'tasks', 'outside_bills', 'prov_links', 'bills', 'receipts', 'sent_docs', 'documents', 'files', 'patients', 'branches', 'providers', 'ins_contracts', 'adjusters', 'insurers', 'ai_requests'];
  await tx(async c => { for (const t of tables) await c.run(`DELETE FROM ${t}`); });
  await audit(req.user!, 'admin.wipeDemo');
  res.json({ ok: true });
});
