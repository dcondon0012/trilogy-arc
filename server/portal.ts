import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { db, nowMST, addNote, audit, UPLOAD_DIR, fullInsurer } from './db.js';
import { requireAuth } from './auth.js';
import { envelope } from './engines.js';

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, _file, cb) => cb(null, crypto.randomUUID()),
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const fmt$ = (n: number) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function saveFile(req: any): string | null {
  if (!req.file) return null;
  db.prepare('INSERT INTO files(id,name,mime,size,uploadedBy,time) VALUES(?,?,?,?,?,?)')
    .run(req.file.filename, req.file.originalname, req.file.mimetype, req.file.size, req.user!.name, nowMST());
  return req.file.filename;
}

/* Which patients can this portal user see? */
function providerPatientIds(orgId: string): string[] {
  return (db.prepare('SELECT DISTINCT patientId FROM prov_links WHERE providerId=?').all(orgId) as any[]).map(r => r.patientId);
}
function carrierPatientIds(orgId: string): string[] {
  return (db.prepare('SELECT id FROM patients WHERE insurerId=?').all(orgId) as any[]).map(r => r.id);
}
function consentOnFile(pid: string): boolean {
  return !!(db.prepare('SELECT consentSharing FROM patients WHERE id=?').get(pid) as any)?.consentSharing;
}
function canSeeFile(user: any, fid: string): boolean {
  const ids = user.role === 'provider' ? providerPatientIds(user.orgId) : carrierPatientIds(user.orgId);
  const b = db.prepare('SELECT patientId, providerId FROM bills WHERE billFileId=? OR noteFileId=?').get(fid, fid) as any;
  if (b) {
    if (!ids.includes(b.patientId)) return false;
    if (user.role === 'provider' && b.providerId !== user.orgId) return false;
    // Hard consent gate: carriers get documents only after the patient's sharing consent is signed.
    if (user.role === 'carrier' && !consentOnFile(b.patientId)) return false;
    return true;
  }
  const d = db.prepare('SELECT patientId FROM documents WHERE fileId=?').get(fid) as any;
  if (d) return user.role === 'carrier' && ids.includes(d.patientId) && consentOnFile(d.patientId);
  const it = db.prepare('SELECT patientId, providerId FROM intake_items WHERE fileId=?').get(fid) as any;
  if (it) return user.role === 'provider' ? it.providerId === user.orgId : (it.patientId ? ids.includes(it.patientId) : false);
  return false;
}

export const portal = Router();
portal.use(requireAuth);
portal.use((req, res, next) => {
  if (req.user!.role !== 'provider' && req.user!.role !== 'carrier') return res.status(403).json({ error: 'Portal accounts only' });
  if (!req.user!.orgId) return res.status(403).json({ error: 'Account not linked to an organization — contact Trilogy' });
  audit(req.user!, 'portal.access', undefined, undefined, req.method + ' ' + req.path);
  next();
});

/* ================= shared: files & messages ================= */
portal.get('/files/:fid', (req, res) => {
  if (!canSeeFile(req.user, req.params.fid)) return res.status(403).json({ error: 'Not available' });
  const f = db.prepare('SELECT * FROM files WHERE id=?').get(req.params.fid) as any;
  if (!f) return res.status(404).json({ error: 'Not found' });
  const p = path.join(UPLOAD_DIR, f.id);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'File missing' });
  res.setHeader('Content-Type', f.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(f.name)}"`);
  fs.createReadStream(p).pipe(res);
});

function accessiblePatient(user: any, pid: string): boolean {
  return (user.role === 'provider' ? providerPatientIds(user.orgId) : carrierPatientIds(user.orgId)).includes(pid);
}

portal.get('/messages/:pid', (req, res) => {
  if (!accessiblePatient(req.user, req.params.pid)) return res.status(403).json({ error: 'Not your case' });
  res.json(db.prepare('SELECT * FROM case_messages WHERE patientId=? ORDER BY id DESC').all(req.params.pid));
});
portal.post('/messages/:pid', (req, res) => {
  if (!accessiblePatient(req.user, req.params.pid)) return res.status(403).json({ error: 'Not your case' });
  const text = String(req.body?.text || '').trim();
  if (!text || text.length > 5000) return res.status(400).json({ error: 'Message required (max 5,000 chars)' });
  db.prepare('INSERT INTO case_messages(patientId,authorName,authorType,text,time) VALUES(?,?,?,?,?)')
    .run(req.params.pid, req.user!.name, req.user!.role, text, nowMST());
  addNote(req.params.pid, `💬 ${req.user!.role === 'provider' ? 'Provider' : 'Carrier'} message from ${req.user!.name}: "${text.slice(0, 160)}${text.length > 160 ? '…' : ''}"`, req.user!.name, true, 'portal');
  // Every portal message becomes a same-day task for the case coordinator.
  const tid = 't' + Date.now() + Math.floor(Math.random() * 1000);
  db.prepare('INSERT INTO tasks(id,patientId,title,due,created,by) VALUES(?,?,?,?,?,?)')
    .run(tid, req.params.pid, `Reply to ${req.user!.name} (${req.user!.role}): "${text.slice(0, 90)}${text.length > 90 ? '…' : ''}"`,
      new Date().toISOString().slice(0, 10), nowMST(), req.user!.name);
  res.json(db.prepare('SELECT * FROM case_messages WHERE patientId=? ORDER BY id DESC').all(req.params.pid));
});

/* ================= provider portal ================= */
portal.get('/provider/overview', (req, res) => {
  if (req.user!.role !== 'provider') return res.status(403).json({ error: 'Providers only' });
  const orgId = req.user!.orgId!;
  const org = db.prepare('SELECT id,name,type FROM providers WHERE id=?').get(orgId) as any;
  const links = db.prepare(`SELECT l.*, p.name AS patientName, p.stage FROM prov_links l
    JOIN patients p ON p.id=l.patientId WHERE l.providerId=?`).all(orgId) as any[];
  const patients = links.map(l => ({
    patientId: l.patientId, patientName: l.patientName, stage: l.stage,
    branch: l.branch, authAmount: l.authAmount, authCount: l.authCount,
    billed: l.billed, authRemaining: Math.max(0, l.authAmount - l.billed), status: l.status,
  }));
  const bills = db.prepare(`SELECT b.id, b.patientId, p.name AS patientName, b.dos, b.billed, b.status, b.paidDate,
      b.denied, b.denialReason, b.appealStatus, b.hasBill, b.hasNote, b.voided
    FROM bills b JOIN patients p ON p.id=b.patientId
    WHERE b.providerId=? ORDER BY b.dos DESC`).all(orgId) as any[];
  // Payment status pipeline — never expose the payout rate to providers here; show THEIR billed amount.
  const paymentStatus = bills.filter(b => !b.voided).map(b => ({
    ...b,
    stage: b.status === 'paid' ? 'paid'
      : b.denied ? 'denied'
      : (b.hasBill && b.hasNote) ? 'approved-pending-payment'
      : 'received-needs-records',
  }));
  // Contract/rate details are for provider ORG ADMINS only — workers never see percentages.
  const isOrgAdmin = req.user!.orgRole === 'admin';
  const branches = isOrgAdmin
    ? db.prepare('SELECT name, rate, ratePct, rateCap FROM branches WHERE providerId=?').all(orgId)
    : (db.prepare('SELECT name FROM branches WHERE providerId=?').all(orgId) as any[]).map(b => ({ name: b.name }));
  const cred = db.prepare('SELECT npi, licenseNo, licenseExp, malpracticeCarrier, malpracticeExp, w9OnFile, baaSigned FROM providers WHERE id=?').get(orgId);
  res.json({ org, orgRole: req.user!.orgRole || 'worker', patients, paymentStatus, branches, credentialing: cred });
});

/* Provider-facing patient detail — their slice of the case only. */
portal.get('/provider/patients/:pid', (req, res) => {
  if (req.user!.role !== 'provider') return res.status(403).json({ error: 'Providers only' });
  const orgId = req.user!.orgId!;
  const l = db.prepare('SELECT * FROM prov_links WHERE providerId=? AND patientId=?').get(orgId, req.params.pid) as any;
  if (!l) return res.status(404).json({ error: 'Not your patient' });
  const p = db.prepare('SELECT id,name,dob,doi,stage FROM patients WHERE id=?').get(req.params.pid) as any;
  const bills = db.prepare(`SELECT id,dos,billed,status,paidDate,denied,denialReason,appealStatus,hasBill,hasNote,
      billFileId,billFileName,noteFileId,noteFileName,voided,source
    FROM bills WHERE patientId=? AND providerId=? ORDER BY dos DESC`).all(req.params.pid, orgId);
  res.json({
    ...p, branch: l.branch, authStatus: l.status,
    authAmount: l.authAmount, authCount: l.authCount, billed: l.billed,
    authRemaining: Math.max(0, l.authAmount - l.billed), bills,
  });
});

/* Multi bill+note pair submission — creates real, flagged bills directly on the patient. */
portal.post('/provider/submit', upload.fields([{ name: 'bill', maxCount: 1 }, { name: 'note', maxCount: 1 }]), (req, res) => {
  if (req.user!.role !== 'provider') return res.status(403).json({ error: 'Providers only' });
  const orgId = req.user!.orgId!;
  const { patientId, dos, amount, billType } = req.body || {};
  const files = req.files as Record<string, Express.Multer.File[]> | undefined;
  const billFile = files?.bill?.[0]; const noteFile = files?.note?.[0];
  if (!patientId) return res.status(400).json({ error: 'Choose the patient — every submission must be assigned' });
  if (!providerPatientIds(orgId).includes(patientId)) return res.status(400).json({ error: 'Not your patient' });
  if (!billFile) return res.status(400).json({ error: 'Attach the bill document' });
  if (!(Number(amount) > 0)) return res.status(400).json({ error: 'Billed amount is required' });
  const link = db.prepare('SELECT * FROM prov_links WHERE patientId=? AND providerId=?').get(patientId, orgId) as any;
  const store = (f: Express.Multer.File) => {
    db.prepare('INSERT INTO files(id,name,mime,size,uploadedBy,time) VALUES(?,?,?,?,?,?)')
      .run(f.filename, f.originalname, f.mimetype, f.size, req.user!.name, nowMST());
    return f.filename;
  };
  const bfid = store(billFile);
  const nfid = noteFile ? store(noteFile) : null;
  let rate = 0;
  const branch = db.prepare('SELECT * FROM branches WHERE providerId=? AND (name=? OR (SELECT COUNT(*) FROM branches WHERE providerId=?)=1)')
    .get(orgId, link.branch || '', orgId) as any;
  if (branch?.ratePct) rate = Math.round(Math.min(Number(amount) * branch.ratePct / 100, branch.rateCap || Infinity) * 100) / 100;
  const bid = 'b' + Date.now() + Math.floor(Math.random() * 1000);
  db.prepare(`INSERT INTO bills(id,patientId,providerId,dos,billed,rate,hasBill,hasNote,billFileId,billFileName,noteFileId,noteFileName,source)
    VALUES(?,?,?,?,?,?,1,?,?,?,?,?,'portal')`)
    .run(bid, patientId, orgId, dos || null, Number(amount), rate,
      nfid ? 1 : 0, bfid, billFile.originalname, nfid, noteFile?.originalname || null);
  db.prepare('UPDATE prov_links SET billed=billed+? WHERE patientId=? AND providerId=?').run(Number(amount), patientId, orgId);
  addNote(patientId, `💬 Bill submitted via provider portal by ${req.user!.name}: ${billType || 'bill'} · DOS ${dos || '?'} · ${fmt$(Number(amount))}${nfid ? ' (visit note attached)' : ' ⚠ no visit note — payment blocked until received'}`, req.user!.name, true, 'portal');
  audit(req.user!, 'portal.provider.submitBill', 'bill', bid, `${patientId} ${amount}`);
  res.json({ ok: true, billId: bid, message: nfid ? 'Bill + note received and filed to the patient.' : 'Bill received — send the visit note to unlock payment.' });
});

/* Orders & estimates form. */
portal.post('/provider/order', upload.single('file'), (req, res) => {
  if (req.user!.role !== 'provider') return res.status(403).json({ error: 'Providers only' });
  const { patientId, type, details, amount } = req.body || {};
  if (!patientId || !providerPatientIds(req.user!.orgId!).includes(patientId)) return res.status(400).json({ error: 'Choose your patient' });
  if (!String(details || '').trim()) return res.status(400).json({ error: 'Describe the order/estimate' });
  let fid: string | null = null;
  if (req.file) fid = saveFile(req);
  if (fid) db.prepare('INSERT INTO documents(patientId,name,cat,meta,fileId) VALUES(?,?,?,?,?)')
    .run(patientId, req.file!.originalname, 'Medical', nowMST() + ' · ' + (type || 'order') + ' via portal', fid);
  addNote(patientId, `💬 ${type === 'estimate' ? 'Estimate' : 'Order'} submitted via portal by ${req.user!.name}: ${details}${amount ? ' · ' + fmt$(Number(amount)) : ''}`, req.user!.name, true, 'portal');
  const tid = 't' + Date.now() + Math.floor(Math.random() * 1000);
  db.prepare('INSERT INTO tasks(id,patientId,title,due,created,by) VALUES(?,?,?,?,?,?)')
    .run(tid, patientId, `Review ${type === 'estimate' ? 'estimate' : 'order'} from ${req.user!.name}: ${String(details).slice(0, 80)}`,
      new Date().toISOString().slice(0, 10), nowMST(), req.user!.name);
  audit(req.user!, 'portal.provider.order', 'patient', patientId, type);
  res.json({ ok: true, message: 'Sent to your Trilogy coordinator for review.' });
});

portal.post('/provider/auth-request', (req, res) => {
  if (req.user!.role !== 'provider') return res.status(403).json({ error: 'Providers only' });
  const { patientId, amount, note } = req.body || {};
  if (!accessiblePatient(req.user, patientId)) return res.status(403).json({ error: 'Not your patient' });
  const pr = db.prepare('SELECT name FROM providers WHERE id=?').get(req.user!.orgId) as any;
  const p = db.prepare('SELECT coordinator FROM patients WHERE id=?').get(patientId) as any;
  const coordName = (db.prepare('SELECT name FROM users WHERE id=?').get(p?.coordinator) as any)?.name || 'Donny C.';

  /* Envelope guardrail: in-envelope requests auto-approve in seconds; the envelope never
     silently grows — anything over it goes to a human with the utilization context. */
  const amt = Number(amount) || 0;
  const env = envelope(patientId);
  const link = db.prepare('SELECT * FROM prov_links WHERE patientId=? AND providerId=?').get(patientId, req.user!.orgId) as any;
  if (amt > 0 && env.limit > 0 && amt <= env.remaining && link && link.status !== 'canceled') {
    db.prepare("UPDATE prov_links SET authAmount=authAmount+?, authCount=authCount+1, status='authorized' WHERE id=?").run(amt, link.id);
    db.prepare('INSERT INTO sent_docs(patientId,name,toStr,time,status,method) VALUES(?,?,?,?,?,?)')
      .run(patientId, "Add'l Authorization (auto — within envelope)", pr.name, nowMST(), 'Sent', 'Email');
    addNote(patientId, `⚡ Auth auto-approved: ${fmt$(amt)} to ${pr.name} — within the coverage envelope (${fmt$(env.remaining - amt)} remains). No human wait.`, 'system');
    audit(req.user!, 'auth.autoApprove', 'patient', patientId, `${amt} to ${pr.name}`);
    return res.json({ ok: true, auto: true, message: `Approved automatically — ${fmt$(amt)} fits the coverage envelope. Authorization is on its way.` });
  }

  const tid = 't' + Date.now() + Math.floor(Math.random() * 1000);
  db.prepare('INSERT INTO tasks(id,patientId,title,due,created,by) VALUES(?,?,?,?,?,?)')
    .run(tid, patientId, `Auth request from ${pr.name}: ${amount ? fmt$(Number(amount)) : 'amount TBD'}${note ? ' — ' + note : ''}`,
      new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10), nowMST(), req.user!.name);
  addNote(patientId, `Additional authorization requested via portal by ${pr.name}${amount ? ': ' + fmt$(Number(amount)) : ''}${note ? ' — ' + note : ''} (task created for ${coordName})`, req.user!.name);
  audit(req.user!, 'portal.provider.authRequest', 'patient', patientId);
  res.json({ ok: true, message: 'Request sent to your Trilogy coordinator.' });
});

/* ================= carrier portal ================= */
/* Adjuster-role users see only their own linked cases; carrier org admins see all. */
function myAdjusterId(user: any): string | null {
  const a = db.prepare('SELECT id FROM adjusters WHERE insurerId=? AND lower(email)=lower(?)').get(user.orgId, user.email) as any;
  return a?.id || null;
}

portal.get('/carrier/overview', (req, res) => {
  if (req.user!.role !== 'carrier') return res.status(403).json({ error: 'Carriers only' });
  const orgId = req.user!.orgId!;
  const c = fullInsurer(orgId);
  const isOrgAdmin = req.user!.orgRole === 'admin';
  const adjId = myAdjusterId(req.user);
  let rows = db.prepare('SELECT * FROM patients WHERE insurerId=?').all(orgId) as any[];
  if (!isOrgAdmin) rows = rows.filter(p => adjId && p.adjusterId === adjId && p.stage < 4);
  const cases = rows.map(p => {
    const adj = c.adjusters.find((a: any) => a.id === p.adjusterId);
    const billed = (db.prepare('SELECT COALESCE(SUM(billed),0) s FROM bills WHERE patientId=? AND voided=0').get(p.id) as any).s;
    const provs = (db.prepare('SELECT pr.name FROM prov_links l JOIN providers pr ON pr.id=l.providerId WHERE l.patientId=?').all(p.id) as any[]).map(x => x.name);
    return {
      id: p.id, name: p.name, claimNumber: p.claimNumber, stage: p.stage,
      caseType: p.caseType, doi: p.doi, adjusterName: adj?.name || null,
      billedTotal: billed, providers: provs,
    };
  });
  const allCases = db.prepare('SELECT adjusterId, stage FROM patients WHERE insurerId=?').all(orgId) as any[];
  const roster = c.adjusters.map((a: any) => ({
    id: a.id, name: a.name, phone: a.phone, email: a.email,
    activeCases: allCases.filter(x => x.adjusterId === a.id && x.stage < 4).length,
    totalCases: allCases.filter(x => x.adjusterId === a.id).length,
  }));
  res.json({
    org: { id: c.id, name: c.name }, cases, roster,
    orgRole: req.user!.orgRole || 'worker',
    myAdjusterName: adjId ? (c.adjusters.find((a: any) => a.id === adjId)?.name || null) : null,
  });
});

/* Carrier org admins can complete/see their own partnership configuration. */
portal.get('/carrier/onboarding', (req, res) => {
  if (req.user!.role !== 'carrier' || req.user!.orgRole !== 'admin') return res.status(403).json({ error: 'Carrier admins only' });
  const c = db.prepare('SELECT onboarding FROM insurers WHERE id=?').get(req.user!.orgId) as any;
  res.json(c?.onboarding ? JSON.parse(c.onboarding) : {});
});
portal.post('/carrier/onboarding', (req, res) => {
  if (req.user!.role !== 'carrier' || req.user!.orgRole !== 'admin') return res.status(403).json({ error: 'Carrier admins only' });
  const cfg = req.body || {};
  cfg._meta = { savedBy: req.user!.name, savedAt: nowMST(), role: 'carrier-self-serve' };
  db.prepare('UPDATE insurers SET onboarding=? WHERE id=?').run(JSON.stringify(cfg), req.user!.orgId);
  audit(req.user!, 'portal.carrier.onboarding.save', 'insurer', req.user!.orgId!);
  res.json({ ok: true });
});

/* Carrier org admins manage the adjuster roster. */
portal.post('/carrier/adjusters', (req, res) => {
  if (req.user!.role !== 'carrier') return res.status(403).json({ error: 'Carriers only' });
  if (req.user!.orgRole !== 'admin') return res.status(403).json({ error: 'Carrier admins only' });
  const { name, phone, email } = req.body || {};
  if (!String(name || '').trim()) return res.status(400).json({ error: 'Name required' });
  db.prepare('INSERT INTO adjusters(id,insurerId,name,phone,email) VALUES(?,?,?,?,?)')
    .run('a' + Date.now(), req.user!.orgId, name.trim(), phone || null, email || null);
  audit(req.user!, 'portal.carrier.addAdjuster', 'insurer', req.user!.orgId!, name);
  res.json({ ok: true });
});

portal.get('/carrier/cases/:pid', (req, res) => {
  if (req.user!.role !== 'carrier') return res.status(403).json({ error: 'Carriers only' });
  const p = db.prepare('SELECT * FROM patients WHERE id=? AND insurerId=?').get(req.params.pid, req.user!.orgId) as any;
  if (!p) return res.status(404).json({ error: 'Not found' });
  if (req.user!.orgRole !== 'admin' && p.adjusterId !== myAdjusterId(req.user)) return res.status(404).json({ error: 'Not found' });
  const c = fullInsurer(req.user!.orgId!);
  const adj = c.adjusters.find((a: any) => a.id === p.adjusterId);
  // Carrier-safe projection: billed amounts and documents; NEVER payout rates or internal notes.
  const consent = consentOnFile(p.id);
  let bills = (db.prepare(`SELECT b.id, b.dos, b.billed, b.denied, b.voided, pr.name AS providerName,
      b.billFileId, b.billFileName, b.noteFileId, b.noteFileName
    FROM bills b JOIN providers pr ON pr.id=b.providerId WHERE b.patientId=? AND b.voided=0 ORDER BY b.dos`).all(p.id) as any[]);
  if (!consent) bills = bills.map(b => ({ ...b, billFileId: null, noteFileId: null, billFileName: null, noteFileName: null }));
  const provs = (db.prepare(`SELECT pr.name, pr.type, l.status FROM prov_links l JOIN providers pr ON pr.id=l.providerId WHERE l.patientId=?`).all(p.id) as any[]);
  res.json({
    id: p.id, name: p.name, dob: p.dob, doi: p.doi, state: p.state,
    claimNumber: p.claimNumber, policyNumber: p.policyNumber, stage: p.stage, caseType: p.caseType,
    adjuster: adj ? { name: adj.name, email: adj.email } : null,
    providers: provs, bills, consentOnFile: consent,
    billedTotal: bills.reduce((s, b) => s + b.billed, 0),
  });
});

/* Provider reports a booked appointment (scheduling flow: provider calls patient, books, tells us). */
portal.post('/provider/appointment', (req, res) => {
  if (req.user!.role !== 'provider') return res.status(403).json({ error: 'Providers only' });
  const { patientId, whenAt, note } = req.body || {};
  if (!patientId || !providerPatientIds(req.user!.orgId!).includes(patientId)) return res.status(400).json({ error: 'Choose your patient' });
  if (!whenAt) return res.status(400).json({ error: 'Appointment date/time required' });
  db.prepare('INSERT INTO appointments(patientId,providerId,whenAt,note,createdBy,createdAt) VALUES(?,?,?,?,?,?)')
    .run(patientId, req.user!.orgId, whenAt, note || null, req.user!.name, nowMST());
  const pr = db.prepare('SELECT name FROM providers WHERE id=?').get(req.user!.orgId) as any;
  addNote(patientId, `💬 Appointment booked by ${pr?.name}: ${whenAt}${note ? ' — ' + note : ''} (reported by ${req.user!.name})`, req.user!.name, true, 'portal');
  audit(req.user!, 'portal.provider.appointment', 'patient', patientId, whenAt);
  res.json({ ok: true, message: 'Appointment recorded — Trilogy sees it on the case.' });
});

portal.post('/carrier/refer', upload.array('files', 10), (req, res) => {
  if (req.user!.role !== 'carrier') return res.status(403).json({ error: 'Carriers only' });
  const v = req.body || {};
  if (!String(v.name || '').trim()) return res.status(400).json({ error: 'Patient name required' });
  const orgId = req.user!.orgId!;
  const isOrgAdmin = req.user!.orgRole === 'admin';

  // Adjuster rules: workers refer only as themselves; admins can assign anyone.
  let adjusterId: string | null = null;
  if (!isOrgAdmin) {
    adjusterId = myAdjusterId(req.user);
    if (!adjusterId) return res.status(400).json({ error: 'Your login is not linked to an adjuster on the roster — ask your carrier admin to add you (with this email).' });
  } else if (v.adjusterName) {
    const a = db.prepare('SELECT id FROM adjusters WHERE insurerId=? AND lower(name)=lower(?)').get(orgId, String(v.adjusterName).trim()) as any;
    if (a) adjusterId = a.id;
    else { adjusterId = 'a' + Date.now(); db.prepare('INSERT INTO adjusters(id,insurerId,name) VALUES(?,?,?)').run(adjusterId, orgId, String(v.adjusterName).trim()); }
  }

  const row = db.prepare('SELECT v FROM counters WHERE k=?').get('pt') as any;
  const num = (row?.v ?? 10000) + 1;
  db.prepare('INSERT INTO counters(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=?').run('pt', num, num);
  const id = 'PT-' + num;
  const claimInfo = [
    v.limits ? `PIP/coverage limits: ${v.limits}` : '',
    v.liability ? `Liability: ${v.liability}` : '',
  ].filter(Boolean).join(' · ');
  db.prepare(`INSERT INTO patients(id,name,caseType,phone,dob,doi,state,insurerId,claimNumber,policyNumber,adjusterId,coordinator,accident,uwLimit)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, v.name.trim(), v.caseType === 'trilogy' ? 'trilogy' : 'trilopay', v.phone || null, v.dob || null,
      v.doi || null, v.state || null, orgId, v.claimNumber || null, v.policyNumber || null, adjusterId, 'u1',
      [v.description || '', claimInfo].filter(Boolean).join('\n'), parseFloat(String(v.limits || '').replace(/[^0-9.]/g, '')) || 0);
  db.prepare('INSERT INTO stage_times(patientId,stage,at) VALUES(?,0,?)').run(id, new Date().toISOString());

  // Claim documents (traffic report, dec page, etc.) file straight to the new case.
  for (const f of (req.files as Express.Multer.File[] | undefined) || []) {
    db.prepare('INSERT INTO files(id,name,mime,size,uploadedBy,time) VALUES(?,?,?,?,?,?)')
      .run(f.filename, f.originalname, f.mimetype, f.size, req.user!.name, nowMST());
    db.prepare('INSERT INTO documents(patientId,name,cat,meta,fileId) VALUES(?,?,?,?,?)')
      .run(id, f.originalname, 'Insurance', nowMST() + ' · carrier referral upload', f.filename);
  }
  const carrierName = (db.prepare('SELECT name FROM insurers WHERE id=?').get(orgId) as any)?.name;
  addNote(id, `💬 Referral submitted via carrier portal by ${req.user!.name} (${carrierName})${claimInfo ? ' — ' + claimInfo : ''}${(req.files as any[])?.length ? ` · ${(req.files as any[]).length} claim document(s) attached` : ''}`, req.user!.name, true, 'portal');
  // Lands in the New Patient Requests inbox for intake review.
  db.prepare(`INSERT INTO intake_items(channel,kind,status,patientId,fromInfo,note,receivedAt)
    VALUES('portal','referral','triage',?,?,?,?)`)
    .run(id, `${req.user!.name} @ ${carrierName}`, `New referral: ${v.name} · claim ${v.claimNumber || '—'}`, nowMST());
  audit(req.user!, 'portal.carrier.refer', 'patient', id, v.name);
  res.json({ ok: true, id, message: `Referral received — Trilogy case ${id} opened for intake.` });
});

portal.post('/carrier/report-payment', (req, res) => {
  if (req.user!.role !== 'carrier') return res.status(403).json({ error: 'Carriers only' });
  const { patientId, amount, ref, date } = req.body || {};
  if (!accessiblePatient(req.user, patientId)) return res.status(403).json({ error: 'Not your case' });
  if (!(Number(amount) > 0)) return res.status(400).json({ error: 'Amount must be positive' });
  db.prepare('INSERT INTO receipts(patientId,date,ref,amount,status) VALUES(?,?,?,?,?)')
    .run(patientId, date || new Date().toISOString().slice(0, 10), (ref || '') + ' (carrier-reported)', Number(amount), 'Pending');
  addNote(patientId, `Payment reported via carrier portal by ${req.user!.name}: ${fmt$(Number(amount))} (${ref || 'no ref'}) — pending bank confirmation`, req.user!.name);
  audit(req.user!, 'portal.carrier.reportPayment', 'patient', patientId, String(amount));
  res.json({ ok: true, message: 'Recorded — pending confirmation against the bank account.' });
});
