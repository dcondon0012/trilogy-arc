import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.TRILOGY_DATA_DIR || path.join(__dirname, '..', 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, 'trilogy.db'));
try { db.pragma('journal_mode = WAL'); } catch { /* some filesystems (network mounts) don't support WAL */ }
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
  pwHash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','coordinator')),
  totpSecret TEXT
);
CREATE TABLE IF NOT EXISTS counters(k TEXT PRIMARY KEY, v INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS insurers(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, hq TEXT, phone TEXT, email TEXT,
  relationship TEXT, payRate TEXT, states TEXT DEFAULT '[]', rules TEXT DEFAULT '[]',
  avgDays REAL DEFAULT 0, disputes INTEGER DEFAULT 0, denialRate REAL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS adjusters(
  id TEXT PRIMARY KEY, insurerId TEXT NOT NULL REFERENCES insurers(id) ON DELETE CASCADE,
  name TEXT NOT NULL, phone TEXT, email TEXT, contract TEXT, notes TEXT
);
CREATE TABLE IF NOT EXISTS ins_contracts(
  id INTEGER PRIMARY KEY AUTOINCREMENT, insurerId TEXT NOT NULL REFERENCES insurers(id) ON DELETE CASCADE,
  name TEXT NOT NULL, meta TEXT, status TEXT DEFAULT 'Active'
);
CREATE TABLE IF NOT EXISTS providers(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT,
  status TEXT DEFAULT '[]', corpAddress TEXT, corpPhone TEXT, corpEmail TEXT,
  taxId TEXT, rules TEXT DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS branches(
  id INTEGER PRIMARY KEY AUTOINCREMENT, providerId TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  name TEXT NOT NULL, address TEXT, phone TEXT, email TEXT, contacts TEXT,
  rate TEXT, status TEXT, contract TEXT, disputes INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS patients(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, caseType TEXT NOT NULL DEFAULT 'trilopay',
  phone TEXT, email TEXT, address TEXT, dob TEXT, doi TEXT, state TEXT,
  insurerId TEXT REFERENCES insurers(id), claimNumber TEXT, policyNumber TEXT,
  adjusterId TEXT, coordinator TEXT REFERENCES users(id), companionId TEXT,
  stage INTEGER DEFAULT 0, accident TEXT,
  uwStatus TEXT DEFAULT 'Not started', uwCoverage TEXT, uwLimit REAL DEFAULT 0,
  uwRiskFlags TEXT, uwApprovedBy TEXT,
  createdAt TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS outside_bills(
  id INTEGER PRIMARY KEY AUTOINCREMENT, patientId TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  descr TEXT NOT NULL, amt REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS notes(
  id INTEGER PRIMARY KEY AUTOINCREMENT, patientId TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  text TEXT NOT NULL, by TEXT NOT NULL, time TEXT NOT NULL, sys INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tasks(
  id TEXT PRIMARY KEY, patientId TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  title TEXT NOT NULL, due TEXT, created TEXT NOT NULL, by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_comments(
  id INTEGER PRIMARY KEY AUTOINCREMENT, taskId TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  text TEXT NOT NULL, by TEXT NOT NULL, time TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS prov_links(
  id INTEGER PRIMARY KEY AUTOINCREMENT, patientId TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  providerId TEXT NOT NULL REFERENCES providers(id), branch TEXT,
  authAmount REAL DEFAULT 0, authCount INTEGER DEFAULT 0, billed REAL DEFAULT 0,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','authorized','canceled','finalized')),
  UNIQUE(patientId, providerId)
);
CREATE TABLE IF NOT EXISTS bills(
  id TEXT PRIMARY KEY, patientId TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  providerId TEXT NOT NULL REFERENCES providers(id), dos TEXT NOT NULL,
  billed REAL NOT NULL, rate REAL DEFAULT 0,
  hasBill INTEGER DEFAULT 0, hasNote INTEGER DEFAULT 0,
  billFileId TEXT, billFileName TEXT, noteFileId TEXT, noteFileName TEXT,
  status TEXT DEFAULT 'unpaid' CHECK(status IN ('unpaid','paid')), paidDate TEXT
);
CREATE TABLE IF NOT EXISTS receipts(
  id INTEGER PRIMARY KEY AUTOINCREMENT, patientId TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  date TEXT, ref TEXT, amount REAL NOT NULL, status TEXT DEFAULT 'Pending'
);
CREATE TABLE IF NOT EXISTS sent_docs(
  id INTEGER PRIMARY KEY AUTOINCREMENT, patientId TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  name TEXT NOT NULL, toStr TEXT, time TEXT NOT NULL, status TEXT DEFAULT 'Sent', method TEXT DEFAULT 'Email'
);
CREATE TABLE IF NOT EXISTS documents(
  id INTEGER PRIMARY KEY AUTOINCREMENT, patientId TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  name TEXT NOT NULL, cat TEXT DEFAULT 'Misc', meta TEXT, fileId TEXT
);
CREATE TABLE IF NOT EXISTS files(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT, size INTEGER,
  uploadedBy TEXT, time TEXT
);
CREATE TABLE IF NOT EXISTS ai_requests(
  id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, time TEXT NOT NULL,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','denied')), by TEXT
);
CREATE TABLE IF NOT EXISTS widget_prefs(
  userId TEXT NOT NULL, key TEXT NOT NULL, color TEXT, size TEXT,
  PRIMARY KEY(userId, key)
);
CREATE TABLE IF NOT EXISTS audit_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT, time TEXT NOT NULL,
  userId TEXT, userName TEXT, action TEXT NOT NULL,
  entity TEXT, entityId TEXT, detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_notes_pt ON notes(patientId);
CREATE INDEX IF NOT EXISTS idx_bills_pt2 ON bills(patientId);
CREATE INDEX IF NOT EXISTS idx_bills_pt ON bills(patientId);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(time);
`);

/* ---------- migrations (safe to re-run) ---------- */
const migrate = (sql: string) => { try { db.exec(sql); } catch { /* already applied */ } };
migrate('ALTER TABLE users ADD COLUMN active INTEGER DEFAULT 1');
migrate('ALTER TABLE users ADD COLUMN mustChangePw INTEGER DEFAULT 0');
migrate('ALTER TABLE bills ADD COLUMN voided INTEGER DEFAULT 0');
migrate('ALTER TABLE bills ADD COLUMN voidReason TEXT');
migrate('ALTER TABLE receipts ADD COLUMN voided INTEGER DEFAULT 0');
migrate('ALTER TABLE receipts ADD COLUMN voidReason TEXT');
migrate('ALTER TABLE branches ADD COLUMN ratePct REAL');
migrate('ALTER TABLE branches ADD COLUMN rateCap REAL');
db.exec(`CREATE TABLE IF NOT EXISTS receipt_bills(
  receiptId INTEGER NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  billId TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  PRIMARY KEY(receiptId, billId)
)`);
// Rebuild users table to support portal roles (provider/carrier) + org scoping + signup approval.
const usersSql = (db.prepare("SELECT sql FROM sqlite_master WHERE name='users'").get() as any)?.sql || '';
if (!usersSql.includes("'provider'")) {
  db.pragma('foreign_keys = OFF');
  const rebuild = db.transaction(() => {
    db.exec(`CREATE TABLE users_new(
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
      pwHash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','coordinator','provider','carrier')),
      totpSecret TEXT, active INTEGER DEFAULT 1, mustChangePw INTEGER DEFAULT 0,
      orgId TEXT, approved INTEGER DEFAULT 1
    )`);
    db.exec(`INSERT INTO users_new(id,name,email,pwHash,role,totpSecret,active,mustChangePw)
      SELECT id,name,email,pwHash,role,totpSecret,active,mustChangePw FROM users`);
    db.exec('DROP TABLE users');
    db.exec('ALTER TABLE users_new RENAME TO users');
  });
  rebuild();
  db.pragma('foreign_keys = ON');
}

migrate('ALTER TABLE bills ADD COLUMN denied INTEGER DEFAULT 0');
migrate('ALTER TABLE bills ADD COLUMN denialReason TEXT');
migrate("ALTER TABLE bills ADD COLUMN appealStatus TEXT DEFAULT 'none'");
migrate('ALTER TABLE patients ADD COLUMN attorneyRetained INTEGER DEFAULT 0');
migrate('ALTER TABLE patients ADD COLUMN attorneyDate TEXT');
migrate('ALTER TABLE patients ADD COLUMN attorneyFirm TEXT');
migrate('ALTER TABLE patients ADD COLUMN escalated INTEGER DEFAULT 0');
migrate('ALTER TABLE providers ADD COLUMN npi TEXT');
migrate('ALTER TABLE providers ADD COLUMN licenseNo TEXT');
migrate('ALTER TABLE providers ADD COLUMN licenseExp TEXT');
migrate('ALTER TABLE providers ADD COLUMN malpracticeCarrier TEXT');
migrate('ALTER TABLE providers ADD COLUMN malpracticeExp TEXT');
migrate('ALTER TABLE providers ADD COLUMN w9OnFile INTEGER DEFAULT 0');
migrate('ALTER TABLE providers ADD COLUMN baaSigned TEXT');
migrate("ALTER TABLE users ADD COLUMN orgRole TEXT DEFAULT 'worker'");
migrate('ALTER TABLE bills ADD COLUMN source TEXT');
migrate('ALTER TABLE notes ADD COLUMN kind TEXT');
migrate('ALTER TABLE patients ADD COLUMN agentName TEXT');
migrate('ALTER TABLE patients ADD COLUMN agentContact TEXT');
migrate('ALTER TABLE patients ADD COLUMN agentAuth INTEGER DEFAULT 0');
migrate('ALTER TABLE patients ADD COLUMN referralSource TEXT');
migrate('ALTER TABLE patients ADD COLUMN carrierConfirmed INTEGER DEFAULT 0');
migrate('ALTER TABLE patients ADD COLUMN consentSharing INTEGER DEFAULT 0');
migrate('ALTER TABLE branches ADD COLUMN latePct REAL');
migrate('ALTER TABLE insurers ADD COLUMN onboarding TEXT');
migrate('ALTER TABLE bills ADD COLUMN revenue REAL DEFAULT 0');
db.exec(`CREATE TABLE IF NOT EXISTS carrier_rates(
  id INTEGER PRIMARY KEY AUTOINCREMENT, insurerId TEXT NOT NULL REFERENCES insurers(id) ON DELETE CASCADE,
  cpt TEXT NOT NULL, price REAL NOT NULL, UNIQUE(insurerId, cpt)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS provider_rates(
  id INTEGER PRIMARY KEY AUTOINCREMENT, providerId TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  cpt TEXT NOT NULL, payout REAL NOT NULL, UNIQUE(providerId, cpt)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS state_minimums(
  id INTEGER PRIMARY KEY AUTOINCREMENT, state TEXT NOT NULL, coverageType TEXT NOT NULL,
  amount REAL NOT NULL, note TEXT, UNIQUE(state, coverageType)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS appointments(
  id INTEGER PRIMARY KEY AUTOINCREMENT, patientId TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  providerId TEXT, whenAt TEXT NOT NULL, note TEXT, createdBy TEXT, createdAt TEXT
)`);
if (!db.prepare("SELECT 1 FROM counters WHERE k='mig_statemin'").get()) {
  db.prepare("INSERT OR IGNORE INTO state_minimums(state,coverageType,amount,note) VALUES('Oregon','PIP',15000,'Statutory PIP minimum')").run();
  db.prepare("INSERT OR IGNORE INTO state_minimums(state,coverageType,amount,note) VALUES('Texas','PIP',2500,'TX PIP minimum when carried — verify per policy')").run();
  db.prepare("INSERT INTO counters(k,v) VALUES('mig_statemin',1)").run();
}
db.exec(`CREATE TABLE IF NOT EXISTS bill_items(
  id INTEGER PRIMARY KEY AUTOINCREMENT, billId TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  cpt TEXT, icd TEXT, units REAL DEFAULT 1, charge REAL DEFAULT 0, modifier TEXT
)`);
db.exec(`CREATE TABLE IF NOT EXISTS fee_schedules(
  id INTEGER PRIMARY KEY AUTOINCREMENT, state TEXT NOT NULL, cpt TEXT NOT NULL, allowed REAL NOT NULL,
  UNIQUE(state, cpt)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS stage_times(
  id INTEGER PRIMARY KEY AUTOINCREMENT, patientId TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  stage INTEGER NOT NULL, at TEXT NOT NULL
)`);
db.exec(`CREATE TABLE IF NOT EXISTS intake_items(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL CHECK(channel IN ('portal','email','fax')),
  kind TEXT DEFAULT 'bill', status TEXT DEFAULT 'triage' CHECK(status IN ('triage','queued','processed','rejected')),
  patientId TEXT, providerId TEXT, fileId TEXT, fileName TEXT,
  fromInfo TEXT, note TEXT, receivedAt TEXT NOT NULL, parsed TEXT, processedBy TEXT
)`);
/* Phase 4-6 */
migrate('ALTER TABLE bills ADD COLUMN eobAllowed REAL');
migrate('ALTER TABLE bills ADD COLUMN eobPaid REAL');
migrate('ALTER TABLE bills ADD COLUMN eobNote TEXT');
migrate('ALTER TABLE bills ADD COLUMN eobAt TEXT');
migrate('ALTER TABLE providers ADD COLUMN conservative INTEGER DEFAULT 0');
db.exec(`CREATE TABLE IF NOT EXISTS agreements(
  id INTEGER PRIMARY KEY AUTOINCREMENT, patientId TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  providerId TEXT, providerName TEXT NOT NULL, service TEXT, amount REAL DEFAULT 0, terms TEXT,
  status TEXT DEFAULT 'draft' CHECK(status IN ('draft','sent','signed','declined')),
  createdAt TEXT, createdBy TEXT, signedAt TEXT
)`);
db.exec(`CREATE TABLE IF NOT EXISTS campaigns(
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, kind TEXT DEFAULT 'carrier',
  region TEXT, stage TEXT DEFAULT 'identify' CHECK(stage IN ('identify','outreach','negotiating','contracted','soft-launch')),
  contact TEXT, notes TEXT, updatedAt TEXT, by TEXT
)`);
if (!db.prepare("SELECT 1 FROM counters WHERE k='mig_conserv'").get()) {
  db.prepare("UPDATE providers SET conservative=1 WHERE id IN ('MD-2007','MD-2021')").run();
  db.prepare("INSERT INTO counters(k,v) VALUES('mig_conserv',1)").run();
}
db.exec(`CREATE TABLE IF NOT EXISTS case_messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT, patientId TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  authorName TEXT NOT NULL, authorType TEXT NOT NULL CHECK(authorType IN ('staff','provider','carrier')),
  text TEXT NOT NULL, time TEXT NOT NULL
)`);

/* ---------- benchmark fee tool (Medicare PFS, source-swappable) ---------- */
// Per-user tool grants live in users.perms (JSON array, e.g. ["fees"]).
migrate("ALTER TABLE users ADD COLUMN perms TEXT DEFAULT '[]'");
// Add the 'sales' staff role (fee-tool access, no case data). SQLite CHECK constraints
// can't be altered, so rebuild the table once — same pattern as the portal-roles rebuild.
const usersSql2 = (db.prepare("SELECT sql FROM sqlite_master WHERE name='users'").get() as any)?.sql || '';
if (!usersSql2.includes("'sales'")) {
  db.pragma('foreign_keys = OFF');
  const rebuild2 = db.transaction(() => {
    db.exec(`CREATE TABLE users_new(
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
      pwHash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','coordinator','sales','provider','carrier')),
      totpSecret TEXT, active INTEGER DEFAULT 1, mustChangePw INTEGER DEFAULT 0,
      orgId TEXT, approved INTEGER DEFAULT 1, orgRole TEXT DEFAULT 'worker', perms TEXT DEFAULT '[]'
    )`);
    db.exec(`INSERT INTO users_new(id,name,email,pwHash,role,totpSecret,active,mustChangePw,orgId,approved,orgRole,perms)
      SELECT id,name,email,pwHash,role,totpSecret,active,mustChangePw,orgId,approved,orgRole,COALESCE(perms,'[]') FROM users`);
    db.exec('DROP TABLE users');
    db.exec('ALTER TABLE users_new RENAME TO users');
  });
  rebuild2();
  db.pragma('foreign_keys = ON');
}
/* ---------- CRM (network build) — absorbs the old Growth workspace ---------- */
db.exec(`CREATE TABLE IF NOT EXISTS crm_targets(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'provider' CHECK(kind IN ('provider','carrier')),
  name TEXT NOT NULL, specialty TEXT, market TEXT, state TEXT,
  address TEXT, phone TEXT, email TEXT, website TEXT,
  owner TEXT, source TEXT,
  stage TEXT NOT NULL DEFAULT 'identify' CHECK(stage IN ('identify','outreach','conversation','meeting','proposal','signed','live','dead')),
  proposedRate TEXT, acceptedRate TEXT, notes TEXT,
  nextAt TEXT, nextNote TEXT, promotedId TEXT,
  createdAt TEXT, updatedAt TEXT, by TEXT
)`);
db.exec(`CREATE TABLE IF NOT EXISTS crm_contacts(
  id INTEGER PRIMARY KEY AUTOINCREMENT, targetId INTEGER NOT NULL REFERENCES crm_targets(id) ON DELETE CASCADE,
  name TEXT NOT NULL, title TEXT, phone TEXT, email TEXT, notes TEXT, isPrimary INTEGER DEFAULT 0
)`);
db.exec(`CREATE TABLE IF NOT EXISTS crm_activities(
  id INTEGER PRIMARY KEY AUTOINCREMENT, targetId INTEGER NOT NULL REFERENCES crm_targets(id) ON DELETE CASCADE,
  at TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('call','email','meeting','note','stage')),
  text TEXT, outcome TEXT, by TEXT
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_crm_act_target ON crm_activities(targetId)`);
db.exec(`CREATE TABLE IF NOT EXISTS crm_prospects(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market TEXT NOT NULL, specialty TEXT,
  name TEXT NOT NULL, address TEXT, phone TEXT, website TEXT,
  score INTEGER DEFAULT 0, flags TEXT DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','added','rejected')),
  targetId INTEGER, createdAt TEXT, by TEXT
)`);
// One-time: fold the old Growth campaigns into the CRM pipeline.
if (!db.prepare("SELECT 1 FROM counters WHERE k='mig_crm_campaigns'").get()) {
  const stageMap: Record<string, string> = { identify: 'identify', outreach: 'outreach', negotiating: 'proposal', contracted: 'signed', 'soft-launch': 'live' };
  try {
    for (const c of db.prepare('SELECT * FROM campaigns').all() as any[]) {
      db.prepare(`INSERT INTO crm_targets(kind,name,market,source,stage,notes,owner,createdAt,updatedAt,by)
        VALUES(?,?,?,?,?,?,?,?,?,?)`)
        .run(c.kind === 'carrier' ? 'carrier' : 'provider', c.name, c.region || null, 'growth-workspace',
          stageMap[c.stage] || 'identify', [c.contact, c.notes].filter(Boolean).join(' · ') || null,
          c.by || null, c.updatedAt || null, c.updatedAt || null, c.by || null);
    }
  } catch { /* campaigns table empty or absent */ }
  db.prepare("INSERT INTO counters(k,v) VALUES('mig_crm_campaigns',1)").run();
}

db.exec(`CREATE TABLE IF NOT EXISTS fee_meta(k TEXT PRIMARY KEY, v TEXT)`);
db.exec(`CREATE TABLE IF NOT EXISTS fee_codes(
  cpt TEXT PRIMARY KEY, category TEXT, description TEXT, notes TEXT,
  review INTEGER DEFAULT 0, active INTEGER DEFAULT 1
)`);
db.exec(`CREATE TABLE IF NOT EXISTS fee_refreshes(
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, by TEXT,
  source TEXT NOT NULL, year INTEGER, status TEXT NOT NULL CHECK(status IN ('running','ok','failed')),
  detail TEXT, rvuDataset TEXT, gpciDataset TEXT, zipFile TEXT,
  codes INTEGER DEFAULT 0, localities INTEGER DEFAULT 0, zips INTEGER DEFAULT 0
)`);
db.exec(`CREATE TABLE IF NOT EXISTS fee_rates(
  id INTEGER PRIMARY KEY AUTOINCREMENT, refreshId INTEGER NOT NULL REFERENCES fee_refreshes(id) ON DELETE CASCADE,
  cpt TEXT NOT NULL, modifier TEXT NOT NULL DEFAULT '', locality TEXT NOT NULL, localityName TEXT,
  nonfacAmount REAL, facAmount REAL, convFact REAL,
  workRvu REAL, nonfacPeRvu REAL, facPeRvu REAL, mpRvu REAL,
  workGpci REAL, peGpci REAL, mpGpci REAL,
  current INTEGER DEFAULT 1
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_fee_rates_cur ON fee_rates(current, cpt, locality)`);
db.exec(`CREATE TABLE IF NOT EXISTS fee_zips(
  id INTEGER PRIMARY KEY AUTOINCREMENT, refreshId INTEGER,
  zip TEXT NOT NULL, state TEXT NOT NULL, carrier TEXT, locality TEXT NOT NULL,
  plus4 INTEGER DEFAULT 0, current INTEGER DEFAULT 1
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_fee_zips_cur ON fee_zips(current, zip)`);

// One-time backfill of numeric rates for pre-existing demo branches.
if (!db.prepare("SELECT 1 FROM counters WHERE k='mig_rates'").get()) {
  const backfill: Array<[string, number, number | null]> = [
    ['SE Portland — 4th & Division', 60, 280], ['Beaverton', 60, 280], ['Gresham', 55, null],
    ['Lloyd District', 65, null], ['NE Sandy', 58, null], ['Happy Valley', 62, null],
  ];
  for (const [name, pct, cap] of backfill)
    db.prepare('UPDATE branches SET ratePct=?, rateCap=? WHERE name=? AND ratePct IS NULL').run(pct, cap, name);
  db.prepare("INSERT INTO counters(k,v) VALUES('mig_rates',1)").run();
}

/* ---------- helpers ---------- */
export const nowMST = () =>
  new Date().toLocaleString('en-US', {
    month: '2-digit', day: '2-digit', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZone: 'America/Denver',
  }) + ' MST';

export function nextId(kind: 'pt' | 'md' | 'ins'): string {
  const prefix = { pt: 'PT-', md: 'MD-', ins: 'INS-' }[kind];
  const row = db.prepare('SELECT v FROM counters WHERE k=?').get(kind) as { v: number } | undefined;
  const v = (row?.v ?? { pt: 10000, md: 2000, ins: 3000 }[kind]) + 1;
  db.prepare('INSERT INTO counters(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=?').run(kind, v, v);
  return prefix + v;
}

export function addNote(patientId: string, text: string, by: string, sys = true, kind?: string) {
  db.prepare('INSERT INTO notes(patientId,text,by,time,sys,kind) VALUES(?,?,?,?,?,?)')
    .run(patientId, text, by, nowMST(), sys ? 1 : 0, kind || (sys ? 'sys' : 'user'));
}

export function audit(user: { id: string; name: string } | null, action: string, entity?: string, entityId?: string, detail?: string) {
  db.prepare('INSERT INTO audit_log(time,userId,userName,action,entity,entityId,detail) VALUES(?,?,?,?,?,?,?)')
    .run(new Date().toISOString(), user?.id ?? null, user?.name ?? 'system', action, entity ?? null, entityId ?? null, detail ?? null);
}

const J = (s: any) => { try { return JSON.parse(s || '[]'); } catch { return []; } };

/* ---------- assemblers (shape matches the validated v1 UI) ---------- */
export function fullInsurer(id: string) {
  const c = db.prepare('SELECT * FROM insurers WHERE id=?').get(id) as any;
  if (!c) return null;
  c.states = J(c.states); c.rules = J(c.rules);
  c.adjusters = db.prepare('SELECT * FROM adjusters WHERE insurerId=?').all(id);
  c.contracts = db.prepare('SELECT * FROM ins_contracts WHERE insurerId=?').all(id);
  return c;
}

export function fullProvider(id: string) {
  const p = db.prepare('SELECT * FROM providers WHERE id=?').get(id) as any;
  if (!p) return null;
  p.status = J(p.status); p.rules = J(p.rules);
  p.branches = db.prepare('SELECT * FROM branches WHERE providerId=?').all(id);
  return p;
}

export function fullPatient(id: string) {
  const p = db.prepare('SELECT * FROM patients WHERE id=?').get(id) as any;
  if (!p) return null;
  p.uw = {
    status: p.uwStatus, coverage: p.uwCoverage, limit: p.uwLimit,
    riskFlags: p.uwRiskFlags, approvedBy: p.uwApprovedBy,
    outsideBills: db.prepare('SELECT id, descr as "desc", amt FROM outside_bills WHERE patientId=?').all(id),
  };
  p.notes = db.prepare('SELECT * FROM notes WHERE patientId=? ORDER BY id DESC').all(id);
  p.tasks = (db.prepare('SELECT * FROM tasks WHERE patientId=? ORDER BY due IS NULL, due').all(id) as any[])
    .map(t => ({ ...t, comments: db.prepare('SELECT * FROM task_comments WHERE taskId=? ORDER BY id').all(t.id) }));
  p.provLinks = db.prepare('SELECT * FROM prov_links WHERE patientId=?').all(id);
  p.bills = (db.prepare('SELECT * FROM bills WHERE patientId=? ORDER BY dos').all(id) as any[])
    .map(b => ({
      ...b,
      coveredBy: (db.prepare('SELECT receiptId FROM receipt_bills WHERE billId=?').all(b.id) as any[]).map(x => x.receiptId),
      items: db.prepare('SELECT * FROM bill_items WHERE billId=?').all(b.id),
    }));
  p.receipts = (db.prepare('SELECT * FROM receipts WHERE patientId=? ORDER BY date').all(id) as any[])
    .map(r => ({ ...r, billIds: (db.prepare('SELECT billId FROM receipt_bills WHERE receiptId=?').all(r.id) as any[]).map(x => x.billId) }));
  p.sentDocs = db.prepare('SELECT id, name, toStr as "to", time, status, method FROM sent_docs WHERE patientId=? ORDER BY id').all(id);
  p.documents = db.prepare('SELECT * FROM documents WHERE patientId=? ORDER BY id DESC').all(id);
  p.messages = db.prepare('SELECT * FROM case_messages WHERE patientId=? ORDER BY id DESC').all(id);
  p.appointments = db.prepare('SELECT * FROM appointments WHERE patientId=? ORDER BY whenAt DESC').all(id);
  return p;
}

/** Contracted-rate computation for one bill's CPT lines.
 *  revenue = carrier price per CPT (what they pay us) · payout = provider per-CPT rate,
 *  else branch % (timely-filing tier applies) · margin locked regardless of billed. */
export function computeBillEconomics(insurerId: string | null, providerId: string, branchName: string | null,
  items: Array<{ cpt?: string; units?: number; charge?: number }>, billed: number, dos: string | null) {
  let revenue = 0, payout = 0, revenueMissing: string[] = [], payoutFromPct = false;
  for (const x of items) {
    const u = Number(x.units) || 1;
    if (insurerId && x.cpt) {
      const cr = db.prepare('SELECT price FROM carrier_rates WHERE insurerId=? AND cpt=?').get(insurerId, x.cpt) as any;
      if (cr) revenue += cr.price * u; else revenueMissing.push(x.cpt);
    }
    if (x.cpt) {
      const pr = db.prepare('SELECT payout FROM provider_rates WHERE providerId=? AND cpt=?').get(providerId, x.cpt) as any;
      if (pr) payout += pr.payout * u;
    }
  }
  if (!payout) {
    const branch = db.prepare('SELECT * FROM branches WHERE providerId=? AND (name=? OR (SELECT COUNT(*) FROM branches WHERE providerId=?)=1)')
      .get(providerId, branchName || '', providerId) as any;
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

export function recordStage(patientId: string, stage: number) {
  db.prepare('INSERT INTO stage_times(patientId,stage,at) VALUES(?,?,?)').run(patientId, stage, new Date().toISOString());
}

export function patientSummaries() {
  return (db.prepare('SELECT id,name,caseType,stage,insurerId,adjusterId,coordinator,phone,email FROM patients').all() as any[]);
}

/* ---------- computed stats ---------- */
export function insAutoStats(insurerId: string) {
  const pts = db.prepare('SELECT id, stage FROM patients WHERE insurerId=?').all(insurerId) as any[];
  let received = 0, paidOut = 0;
  for (const p of pts) {
    received += (db.prepare("SELECT COALESCE(SUM(amount),0) s FROM receipts WHERE patientId=? AND status='Cleared' AND voided=0").get(p.id) as any).s;
    paidOut += (db.prepare("SELECT COALESCE(SUM(rate),0) s FROM bills WHERE patientId=? AND status='paid' AND voided=0").get(p.id) as any).s;
  }
  const profit = received - paidOut;
  return {
    all: pts.length, act: pts.filter(p => p.stage < 4).length,
    received, paidOut, profit,
    margin: received ? Math.round((profit / received) * 100) : 0,
  };
}

export function branchStats(providerId: string, branchName: string, branchCount: number) {
  let pts = 0, billed = 0, paid = 0, authSent = 0, billCount = 0, missing = 0;
  const links = db.prepare('SELECT * FROM prov_links WHERE providerId=?').all(providerId) as any[];
  for (const l of links) {
    if (branchCount > 1 && l.branch !== branchName) continue;
    pts++; authSent += l.authAmount || 0;
    const bs = db.prepare('SELECT * FROM bills WHERE patientId=? AND providerId=? AND voided=0').all(l.patientId, providerId) as any[];
    for (const b of bs) {
      billCount++; billed += b.billed || 0;
      if (b.status === 'paid') paid += b.rate || 0;
      if (!b.hasNote) missing++;
    }
  }
  return { pts, billed, paid, authSent, missNotes: billCount ? Math.round((missing / billCount) * 100) + '%' : '0%' };
}
