/**
 * Postgres schema — the END STATE of server/db.ts, not its migration history.
 *
 * server/db.ts builds the SQLite schema incrementally (CREATE TABLE, then ~50
 * ALTER TABLE migrations, then two full users-table rebuilds). Replaying that
 * history on Postgres would be pointless: this file declares the shape those
 * steps arrive at. When you add a column in db.ts, add it here too.
 *
 * Translation rules applied (AWS migration stage 2):
 *  - INTEGER PRIMARY KEY AUTOINCREMENT -> INTEGER GENERATED ALWAYS AS IDENTITY.
 *    Explicit ids (the data migration) need OVERRIDING SYSTEM VALUE; see
 *    scripts/migrate-to-pg.ts.
 *  - SQLite REAL -> DOUBLE PRECISION, *not* Postgres REAL. SQLite REAL is an
 *    8-byte IEEE double; Postgres REAL is float4 (~6 significant digits), which
 *    would silently round money. DOUBLE PRECISION is byte-for-byte equivalent
 *    to what SQLite stores and keeps the JS `number` semantics the app relies
 *    on everywhere. (NUMERIC would be more correct for money but node-postgres
 *    returns it as a string, which would break arithmetic across routes.ts —
 *    revisit post-cutover, not during.)
 *  - Dates/times stay TEXT (the app stores ISO strings and formatted MST
 *    strings; no behaviour change).
 *  - Booleans stay INTEGER 0/1 — same reason, zero churn.
 *  - Identifiers are left UNQUOTED, so Postgres folds them to lowercase.
 *    Existing SQL keeps working unchanged (`WHERE patientId=?` folds too), but
 *    result rows come back lowercased — see COLUMN_CASE in server/pgdb.ts,
 *    which maps them back to the camelCase the API payloads and client expect.
 *  - `datetime('now')` default -> to_char(now() AT TIME ZONE 'UTC', ...), which
 *    produces the identical 'YYYY-MM-DD HH:MM:SS' string.
 *
 * Verified against PostgreSQL 16: every column name here is legal unquoted,
 * including `by`, `time`, `text`, `key`, `current`, `year`, `date` and `size`.
 */

export const PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
  pwHash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','coordinator','sales','provider','carrier')),
  totpSecret TEXT, active INTEGER DEFAULT 1, mustChangePw INTEGER DEFAULT 0,
  orgId TEXT, approved INTEGER DEFAULT 1, orgRole TEXT DEFAULT 'worker',
  perms TEXT DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS counters(k TEXT PRIMARY KEY, v INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS insurers(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, hq TEXT, phone TEXT, email TEXT,
  relationship TEXT, payRate TEXT, states TEXT DEFAULT '[]', rules TEXT DEFAULT '[]',
  avgDays DOUBLE PRECISION DEFAULT 0, disputes INTEGER DEFAULT 0,
  denialRate DOUBLE PRECISION DEFAULT 0, onboarding TEXT
);
CREATE TABLE IF NOT EXISTS adjusters(
  id TEXT PRIMARY KEY,
  insurerId TEXT NOT NULL REFERENCES insurers(id) ON DELETE CASCADE,
  name TEXT NOT NULL, phone TEXT, email TEXT, contract TEXT, notes TEXT
);
CREATE TABLE IF NOT EXISTS ins_contracts(
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  insurerId TEXT NOT NULL REFERENCES insurers(id) ON DELETE CASCADE,
  name TEXT NOT NULL, meta TEXT, status TEXT DEFAULT 'Active',
  scope TEXT DEFAULT 'carrier', adjusterId TEXT, rate DOUBLE PRECISION
);
CREATE TABLE IF NOT EXISTS providers(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT,
  status TEXT DEFAULT '[]', corpAddress TEXT, corpPhone TEXT, corpEmail TEXT,
  taxId TEXT, rules TEXT DEFAULT '[]',
  npi TEXT, licenseNo TEXT, licenseExp TEXT,
  malpracticeCarrier TEXT, malpracticeExp TEXT,
  w9OnFile INTEGER DEFAULT 0, baaSigned TEXT, conservative INTEGER DEFAULT 0,
  baaFileId TEXT, baaSignedAt TEXT,
  rateAgreementFileId TEXT, rateAgreementSignedAt TEXT,
  contractedRate TEXT, orgType TEXT DEFAULT 'corporate'
);
CREATE TABLE IF NOT EXISTS branches(
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  providerId TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  name TEXT NOT NULL, address TEXT, phone TEXT, email TEXT, contacts TEXT,
  rate TEXT, status TEXT, contract TEXT, disputes INTEGER DEFAULT 0,
  ratePct DOUBLE PRECISION, rateCap DOUBLE PRECISION, latePct DOUBLE PRECISION
);
CREATE TABLE IF NOT EXISTS patients(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, caseType TEXT NOT NULL DEFAULT 'trilopay',
  phone TEXT, email TEXT, address TEXT, dob TEXT, doi TEXT, state TEXT,
  insurerId TEXT REFERENCES insurers(id), claimNumber TEXT, policyNumber TEXT,
  adjusterId TEXT, coordinator TEXT REFERENCES users(id), companionId TEXT,
  stage INTEGER DEFAULT 0, accident TEXT,
  uwStatus TEXT DEFAULT 'Not started', uwCoverage TEXT,
  uwLimit DOUBLE PRECISION DEFAULT 0, uwRiskFlags TEXT, uwApprovedBy TEXT,
  createdAt TEXT DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  attorneyRetained INTEGER DEFAULT 0, attorneyDate TEXT, attorneyFirm TEXT,
  escalated INTEGER DEFAULT 0,
  agentName TEXT, agentContact TEXT, agentAuth INTEGER DEFAULT 0,
  referralSource TEXT, carrierConfirmed INTEGER DEFAULT 0,
  consentSharing INTEGER DEFAULT 0, carrierAuthorized DOUBLE PRECISION DEFAULT 0
);
CREATE TABLE IF NOT EXISTS outside_bills(
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  patientId TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  descr TEXT NOT NULL, amt DOUBLE PRECISION NOT NULL
);
CREATE TABLE IF NOT EXISTS notes(
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  patientId TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  text TEXT NOT NULL, by TEXT NOT NULL, time TEXT NOT NULL,
  sys INTEGER DEFAULT 0, kind TEXT
);
CREATE TABLE IF NOT EXISTS tasks(
  id TEXT PRIMARY KEY,
  patientId TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  title TEXT NOT NULL, due TEXT, created TEXT NOT NULL, by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_comments(
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  taskId TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  text TEXT NOT NULL, by TEXT NOT NULL, time TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS prov_links(
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  patientId TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  providerId TEXT NOT NULL REFERENCES providers(id), branch TEXT,
  authAmount DOUBLE PRECISION DEFAULT 0, authCount INTEGER DEFAULT 0,
  billed DOUBLE PRECISION DEFAULT 0,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','authorized','canceled','finalized')),
  UNIQUE(patientId, providerId)
);
CREATE TABLE IF NOT EXISTS bills(
  id TEXT PRIMARY KEY,
  patientId TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  providerId TEXT NOT NULL REFERENCES providers(id), dos TEXT NOT NULL,
  billed DOUBLE PRECISION NOT NULL, rate DOUBLE PRECISION DEFAULT 0,
  hasBill INTEGER DEFAULT 0, hasNote INTEGER DEFAULT 0,
  billFileId TEXT, billFileName TEXT, noteFileId TEXT, noteFileName TEXT,
  status TEXT DEFAULT 'unpaid' CHECK(status IN ('unpaid','paid')), paidDate TEXT,
  voided INTEGER DEFAULT 0, voidReason TEXT,
  denied INTEGER DEFAULT 0, denialReason TEXT, appealStatus TEXT DEFAULT 'none',
  source TEXT, revenue DOUBLE PRECISION DEFAULT 0,
  eobAllowed DOUBLE PRECISION, eobPaid DOUBLE PRECISION, eobNote TEXT, eobAt TEXT,
  descr TEXT
);
CREATE TABLE IF NOT EXISTS receipts(
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  patientId TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  date TEXT, ref TEXT, amount DOUBLE PRECISION NOT NULL, status TEXT DEFAULT 'Pending',
  voided INTEGER DEFAULT 0, voidReason TEXT
);
CREATE TABLE IF NOT EXISTS receipt_bills(
  receiptId INTEGER NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  billId TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  PRIMARY KEY(receiptId, billId)
);
CREATE TABLE IF NOT EXISTS sent_docs(
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  patientId TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  name TEXT NOT NULL, toStr TEXT, time TEXT NOT NULL,
  status TEXT DEFAULT 'Sent', method TEXT DEFAULT 'Email', meta TEXT
);
CREATE TABLE IF NOT EXISTS documents(
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  patientId TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  name TEXT NOT NULL, cat TEXT DEFAULT 'Misc', meta TEXT, fileId TEXT
);
CREATE TABLE IF NOT EXISTS files(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT, size INTEGER,
  uploadedBy TEXT, time TEXT
);
CREATE TABLE IF NOT EXISTS ai_requests(
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  text TEXT NOT NULL, time TEXT NOT NULL,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','denied')), by TEXT
);
CREATE TABLE IF NOT EXISTS widget_prefs(
  userId TEXT NOT NULL, key TEXT NOT NULL, color TEXT, size TEXT,
  PRIMARY KEY(userId, key)
);
CREATE TABLE IF NOT EXISTS audit_log(
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, time TEXT NOT NULL,
  userId TEXT, userName TEXT, action TEXT NOT NULL,
  entity TEXT, entityId TEXT, detail TEXT
);
CREATE TABLE IF NOT EXISTS carrier_rates(
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  insurerId TEXT NOT NULL REFERENCES insurers(id) ON DELETE CASCADE,
  cpt TEXT NOT NULL, price DOUBLE PRECISION NOT NULL, UNIQUE(insurerId, cpt)
);
CREATE TABLE IF NOT EXISTS provider_rates(
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  providerId TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  cpt TEXT NOT NULL, payout DOUBLE PRECISION NOT NULL, UNIQUE(providerId, cpt)
);
CREATE TABLE IF NOT EXISTS state_minimums(
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  state TEXT NOT NULL, coverageType TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL, note TEXT, UNIQUE(state, coverageType)
);
CREATE TABLE IF NOT EXISTS appointments(
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  patientId TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  providerId TEXT, whenAt TEXT NOT NULL, note TEXT, createdBy TEXT, createdAt TEXT
);
CREATE TABLE IF NOT EXISTS bill_items(
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  billId TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  cpt TEXT, icd TEXT, units DOUBLE PRECISION DEFAULT 1,
  charge DOUBLE PRECISION DEFAULT 0, modifier TEXT
);
CREATE TABLE IF NOT EXISTS fee_schedules(
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  state TEXT NOT NULL, cpt TEXT NOT NULL, allowed DOUBLE PRECISION NOT NULL,
  UNIQUE(state, cpt)
);
CREATE TABLE IF NOT EXISTS stage_times(
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  patientId TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  stage INTEGER NOT NULL, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS intake_items(
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel TEXT NOT NULL CHECK(channel IN ('portal','email','fax')),
  kind TEXT DEFAULT 'bill',
  status TEXT DEFAULT 'triage' CHECK(status IN ('triage','queued','processed','rejected')),
  patientId TEXT, providerId TEXT, fileId TEXT, fileName TEXT,
  fromInfo TEXT, note TEXT, receivedAt TEXT NOT NULL, parsed TEXT, processedBy TEXT
);
CREATE TABLE IF NOT EXISTS agreements(
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  patientId TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  providerId TEXT, providerName TEXT NOT NULL, service TEXT,
  amount DOUBLE PRECISION DEFAULT 0, terms TEXT,
  status TEXT DEFAULT 'draft' CHECK(status IN ('draft','sent','signed','declined')),
  createdAt TEXT, createdBy TEXT, signedAt TEXT
);
CREATE TABLE IF NOT EXISTS campaigns(
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL, kind TEXT DEFAULT 'carrier', region TEXT,
  stage TEXT DEFAULT 'identify' CHECK(stage IN ('identify','outreach','negotiating','contracted','soft-launch')),
  contact TEXT, notes TEXT, updatedAt TEXT, by TEXT
);
CREATE TABLE IF NOT EXISTS case_messages(
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  patientId TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  authorName TEXT NOT NULL,
  authorType TEXT NOT NULL CHECK(authorType IN ('staff','provider','carrier')),
  text TEXT NOT NULL, time TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS crm_targets(
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'provider' CHECK(kind IN ('provider','carrier')),
  name TEXT NOT NULL, specialty TEXT, market TEXT, state TEXT,
  address TEXT, phone TEXT, email TEXT, website TEXT,
  owner TEXT, source TEXT,
  stage TEXT NOT NULL DEFAULT 'identify' CHECK(stage IN ('identify','outreach','conversation','meeting','proposal','signed','live','dead')),
  proposedRate TEXT, acceptedRate TEXT, notes TEXT,
  nextAt TEXT, nextNote TEXT, promotedId TEXT,
  createdAt TEXT, updatedAt TEXT, by TEXT
);
CREATE TABLE IF NOT EXISTS crm_contacts(
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  targetId INTEGER NOT NULL REFERENCES crm_targets(id) ON DELETE CASCADE,
  name TEXT NOT NULL, title TEXT, phone TEXT, email TEXT, notes TEXT,
  isPrimary INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS crm_activities(
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  targetId INTEGER NOT NULL REFERENCES crm_targets(id) ON DELETE CASCADE,
  at TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('call','email','meeting','note','stage')),
  text TEXT, outcome TEXT, by TEXT
);
CREATE TABLE IF NOT EXISTS crm_prospects(
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  market TEXT NOT NULL, specialty TEXT,
  name TEXT NOT NULL, address TEXT, phone TEXT, website TEXT,
  score INTEGER DEFAULT 0, flags TEXT DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','added','rejected')),
  targetId INTEGER, createdAt TEXT, by TEXT
);
CREATE TABLE IF NOT EXISTS secrets(k TEXT PRIMARY KEY, v TEXT, updatedAt TEXT, updatedBy TEXT);
CREATE TABLE IF NOT EXISTS outbox(
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'email' CHECK(kind IN ('email','sms','fax')),
  toAddr TEXT NOT NULL, subject TEXT, body TEXT, patientId TEXT, meta TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sent','failed')),
  detail TEXT, createdAt TEXT NOT NULL, sentAt TEXT
);
CREATE TABLE IF NOT EXISTS pw_resets(
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tokenHash TEXT NOT NULL, expiresAt TEXT NOT NULL, usedAt TEXT
);
CREATE TABLE IF NOT EXISTS geo_cache(
  k TEXT PRIMARY KEY, lat DOUBLE PRECISION, lon DOUBLE PRECISION, at TEXT, approx TEXT
);
CREATE TABLE IF NOT EXISTS route_cache(
  k TEXT PRIMARY KEY, seconds DOUBLE PRECISION, meters DOUBLE PRECISION, at TEXT
);
CREATE TABLE IF NOT EXISTS fax_seen(recvid TEXT PRIMARY KEY, at TEXT);
CREATE TABLE IF NOT EXISTS fee_meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS fee_codes(
  cpt TEXT PRIMARY KEY, category TEXT, description TEXT, notes TEXT,
  review INTEGER DEFAULT 0, active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS fee_refreshes(
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at TEXT NOT NULL, by TEXT, source TEXT NOT NULL, year INTEGER,
  status TEXT NOT NULL CHECK(status IN ('running','ok','failed')),
  detail TEXT, rvuDataset TEXT, gpciDataset TEXT, zipFile TEXT,
  codes INTEGER DEFAULT 0, localities INTEGER DEFAULT 0, zips INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS fee_rates(
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  refreshId INTEGER NOT NULL REFERENCES fee_refreshes(id) ON DELETE CASCADE,
  cpt TEXT NOT NULL, modifier TEXT NOT NULL DEFAULT '',
  locality TEXT NOT NULL, localityName TEXT,
  nonfacAmount DOUBLE PRECISION, facAmount DOUBLE PRECISION, convFact DOUBLE PRECISION,
  workRvu DOUBLE PRECISION, nonfacPeRvu DOUBLE PRECISION,
  facPeRvu DOUBLE PRECISION, mpRvu DOUBLE PRECISION,
  workGpci DOUBLE PRECISION, peGpci DOUBLE PRECISION, mpGpci DOUBLE PRECISION,
  current INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS fee_zips(
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  refreshId INTEGER, zip TEXT NOT NULL, state TEXT NOT NULL, carrier TEXT,
  locality TEXT NOT NULL, plus4 INTEGER DEFAULT 0, current INTEGER DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_notes_pt ON notes(patientId);
CREATE INDEX IF NOT EXISTS idx_bills_pt2 ON bills(patientId);
CREATE INDEX IF NOT EXISTS idx_bills_pt ON bills(patientId);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(time);
CREATE INDEX IF NOT EXISTS idx_crm_act_target ON crm_activities(targetId);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status, kind);
CREATE INDEX IF NOT EXISTS idx_fee_rates_cur ON fee_rates(current, cpt, locality);
CREATE INDEX IF NOT EXISTS idx_fee_zips_cur ON fee_zips(current, zip);
`;

/**
 * Every table, in an order that satisfies the foreign keys — insert front to
 * back, delete back to front. scripts/migrate-to-pg.ts walks this list.
 */
export const TABLES: readonly string[] = [
  'users', 'counters', 'insurers', 'adjusters', 'ins_contracts',
  'providers', 'branches', 'patients',
  'outside_bills', 'notes', 'tasks', 'task_comments', 'prov_links',
  'bills', 'receipts', 'receipt_bills',
  'sent_docs', 'documents', 'files', 'ai_requests', 'widget_prefs', 'audit_log',
  'carrier_rates', 'provider_rates', 'state_minimums', 'appointments',
  'bill_items', 'fee_schedules', 'stage_times', 'intake_items',
  'agreements', 'campaigns', 'case_messages',
  'crm_targets', 'crm_contacts', 'crm_activities', 'crm_prospects',
  'secrets', 'outbox', 'pw_resets',
  'geo_cache', 'route_cache', 'fax_seen',
  'fee_meta', 'fee_codes', 'fee_refreshes', 'fee_rates', 'fee_zips',
];

/** Tables whose `id` is GENERATED ALWAYS AS IDENTITY. */
export const IDENTITY_TABLES: ReadonlySet<string> = new Set(
  [...PG_SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)\(([\s\S]*?)\);/g)]
    .filter(m => /GENERATED ALWAYS AS IDENTITY/.test(m[2]))
    .map(m => m[1]),
);

/**
 * lowercase -> camelCase, so result rows keep the key spelling the API and the
 * client expect. Postgres folds unquoted identifiers to lowercase, so
 * `SELECT patientId FROM notes` comes back as `patientid`.
 *
 * Derived from the DDL: in this schema every camelCase token IS a column name.
 * SQL keywords are upper-case and string literals contain no camelCase, so the
 * scan can't pick up anything spurious.
 */
function buildColumnCase(): Map<string, string> {
  const map = new Map<string, string>();
  const add = (ident: string) => {
    const lower = ident.toLowerCase();
    const prev = map.get(lower);
    if (prev && prev !== ident) {
      throw new Error(
        `pgschema: two spellings fold to the same lowercase column '${lower}': ` +
        `'${prev}' and '${ident}'. Rename one, or quote it in the query.`,
      );
    }
    map.set(lower, ident);
  };
  for (const m of PG_SCHEMA.matchAll(/\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b/g)) add(m[0]);
  // Aliases that exist only in query text, never as a column. Postgres lowercases
  // these too. Stage 3 alternative: write them quoted — `AS "patientName"`.
  for (const alias of ['patientName', 'providerName', 'prName', 'targetName', 'openTasks', 'unpaidBills']) add(alias);
  return map;
}

export const COLUMN_CASE: ReadonlyMap<string, string> = buildColumnCase();
