import express from 'express';
import cookieSession from 'cookie-session';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { db, DATA_DIR } from './db.js';
import { seedIfEmpty, ensureCoreUsers, flagSeedPasswords } from './seed.js';
import { login, mfa, logout, requireAuth, currentUser, changePassword, registerPortal, forgotPassword, resetPassword } from './auth.js';
import { scheduleCheckins, scheduleFaxPolling } from './integrations.js';
import { api } from './routes.js';
import { portal } from './portal.js';
import { fees, seedFeeCodes, scheduleFeeRefresh } from './fees.js';
import { crm } from './crm.js';
import { nowMST, audit } from './db.js';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4000;

// Persist a session-signing secret so logins survive restarts.
const secretFile = path.join(DATA_DIR, '.session-secret');
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'));
const SESSION_SECRET = process.env.SESSION_SECRET || fs.readFileSync(secretFile, 'utf8');

seedIfEmpty(process.env.TRILOGY_SEED !== 'empty');
ensureCoreUsers();
if (process.env.NODE_ENV === 'production') flagSeedPasswords();  // gate retired → no default passwords in production
seedFeeCodes();

// Deploy verification stamp: the current git commit, readable pre-gate at /api/health.
let BUILD = 'unknown';
try { BUILD = execSync('git rev-parse --short HEAD', { cwd: path.join(__dirname, '..') }).toString().trim(); } catch { /* not a git checkout */ }

const app = express();
// Behind a TLS-terminating reverse proxy (Caddy/ALB): trust X-Forwarded-* so that
// (a) secure cookies are actually issued and (b) req.ip is the real client for rate limiting.
if (process.env.TRUST_PROXY === '1' || process.env.SECURE_COOKIES === '1') app.set('trust proxy', 1);
// Baseline security headers (a full CSP is future work — inline styles preclude a strict one today).
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
app.use(express.json({ limit: '2mb' }));
app.use(cookieSession({
  name: 'trilogy',
  secret: SESSION_SECRET,
  httpOnly: true,
  sameSite: 'lax',
  // Secure cookies require HTTPS. Local use is plain http://localhost, so this stays off
  // until deployment behind TLS — set SECURE_COOKIES=1 on the hosted server.
  secure: process.env.SECURE_COOKIES === '1',
  maxAge: 12 * 60 * 60 * 1000, // 12h
}));

/* ── Site gate — retired 08/27/2026 by request ────────────────────────
   The shared gate password is gone: each person's own login is the door
   (plus login rate limiting; MFA when re-enabled). TRILOGY_GATE_PW in the
   service file is deliberately ignored; seed accounts still on default
   passwords are forced to set a real one at next login (flagSeedPasswords).
   The old gate code lives in git history if it's ever wanted again. */
/* Pre-gate health check: no data, just liveness + which commit is running.
   Lets deploys be verified from outside without a gate session. The fee block
   is pipeline metadata only (status/date/counts of public Medicare data). */
app.get('/api/health', (_req, res) => {
  let fees: any = null;
  try {
    const r = db.prepare('SELECT at, status, year, zips, codes, localities, detail FROM fee_refreshes ORDER BY id DESC LIMIT 1').get() as any;
    if (r) fees = { status: r.status, at: r.at, year: r.year, codes: r.codes, localities: r.localities, zips: r.zips, detail: r.detail };
  } catch { /* table absent on first boot */ }
  res.json({ ok: true, build: BUILD, fees });
});


app.post('/api/auth/login', login);
app.post('/api/auth/mfa', mfa);
app.post('/api/auth/logout', requireAuth, logout);
app.post('/api/auth/change-password', requireAuth, changePassword);
app.post('/api/auth/forgot-password', forgotPassword);   // pre-auth by design: emails a 30-min reset link, never reveals whether the address exists
app.post('/api/auth/reset-password', resetPassword);
app.get('/api/auth/me', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Not signed in' });
  const row = db.prepare('SELECT mustChangePw FROM users WHERE id=?').get(u.id) as any;
  res.json({ user: { ...u, mustChangePw: !!row?.mustChangePw } });
});

// Portal self-signup: org names only (no PHI) for the signup dropdown.
app.get('/api/public/orgs', (_req, res) => res.json({
  providers: db.prepare('SELECT id,name,type FROM providers ORDER BY name').all(),
  carriers: db.prepare('SELECT id,name FROM insurers ORDER BY name').all(),
}));
app.post('/api/auth/register-portal', registerPortal);

/* Inbound webhooks — SES (email) and Faxage (fax) POST here at deployment.
   Secured by a shared secret; both create triage intake items exactly like the in-app simulator. */
app.post('/api/hooks/:channel(email|fax)', express.json({ limit: '45mb' }), (req, res) => {
  if (!process.env.INBOUND_WEBHOOK_SECRET || req.headers['x-trilogy-secret'] !== process.env.INBOUND_WEBHOOK_SECRET)
    return res.status(401).json({ error: 'Bad webhook secret' });
  const { fileName, fileB64, mime, fromInfo, note } = req.body || {};
  if (!fileB64 || !fileName) return res.status(400).json({ error: 'fileB64 and fileName required' });
  const fid = crypto.randomUUID();
  fs.writeFileSync(path.join(DATA_DIR, 'uploads', fid), Buffer.from(fileB64, 'base64'));
  db.prepare('INSERT INTO files(id,name,mime,size,uploadedBy,time) VALUES(?,?,?,?,?,?)')
    .run(fid, fileName, mime || 'application/pdf', Buffer.byteLength(fileB64, 'base64'), 'inbound-' + req.params.channel, nowMST());
  db.prepare(`INSERT INTO intake_items(channel,kind,status,fileId,fileName,fromInfo,note,receivedAt)
    VALUES(?,?,'triage',?,?,?,?,?)`)
    .run(req.params.channel, 'bill', fid, fileName, fromInfo || 'unknown sender', note || null, nowMST());
  audit(null, 'inbound.' + req.params.channel, undefined, undefined, fileName);
  res.json({ ok: true });
});

app.use('/api/portal', portal);
app.use('/api/fees', requireAuth, fees);   // fee tool: admins + Sales + per-user grants (guard inside)
app.use('/api/crm', requireAuth, crm);     // CRM: same access model (guard inside)
app.use('/api', api);

// Serve built client in production
const dist = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(dist)) {
  // index.html must never be cached (it points at the current hashed asset files);
  // the hashed assets themselves are immutable and can cache forever.
  app.use(express.static(dist, {
    setHeaders: (res, p) => {
      if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      else res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    },
  }));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(dist, 'index.html'));
  });
}

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

scheduleFeeRefresh();
scheduleCheckins();   // post-appointment SMS check-ins (queues to outbox until Twilio creds are on file)
scheduleFaxPolling(); // inbound faxes → Requests queue (idle until Faxage creds are on file)

app.listen(PORT, () => {
  console.log(`Trilogy Platform API on http://localhost:${PORT} (build ${BUILD})`);
  if (!fs.existsSync(dist)) console.log('Dev mode: run the client with `npm run dev` (vite on :5173)');
});
