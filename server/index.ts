import express from 'express';
import cookieSession from 'cookie-session';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { db, DATA_DIR } from './db.js';
import { seedIfEmpty, ensureCoreUsers } from './seed.js';
import { login, mfa, logout, requireAuth, currentUser, changePassword, registerPortal } from './auth.js';
import { api } from './routes.js';
import { portal } from './portal.js';
import { fees, seedFeeCodes, scheduleFeeRefresh } from './fees.js';
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
seedFeeCodes();

// Deploy verification stamp: the current git commit, readable pre-gate at /api/health.
let BUILD = 'unknown';
try { BUILD = execSync('git rev-parse --short HEAD', { cwd: path.join(__dirname, '..') }).toString().trim(); } catch { /* not a git checkout */ }

const app = express();
// Behind a TLS-terminating reverse proxy (Caddy/ALB): trust X-Forwarded-* so that
// (a) secure cookies are actually issued and (b) req.ip is the real client for rate limiting.
if (process.env.TRUST_PROXY === '1' || process.env.SECURE_COOKIES === '1') app.set('trust proxy', 1);
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

/* ── Site gate ─────────────────────────────────────────────────────────
   One password in front of the entire site (Donny hands it to invited people).
   Off unless TRILOGY_GATE_PW is set — local use is unchanged. Inbound webhooks
   bypass it (they carry their own shared secret). Enable at deployment. */
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

const GATE_PW = process.env.TRILOGY_GATE_PW;
if (GATE_PW) {
  const gateFails = new Map<string, { n: number; until: number }>();
  const gatePage = (msg = '') => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>trilogy</title>
<meta name="robots" content="noindex,nofollow">
<link href="https://fonts.googleapis.com/css2?family=Quicksand:wght@600&family=Inter+Tight:wght@400;600&display=swap" rel="stylesheet">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#2C3646;font-family:'Inter Tight',sans-serif}
.box{background:#F7F6F1;border-radius:16px;padding:40px 44px;width:300px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.35)}
.logo{font-family:Quicksand,sans-serif;font-weight:600;font-size:30px;color:#3D4A5F;letter-spacing:.5px}
.logo svg{vertical-align:-2px}
p{font-size:13px;color:#6B7688;margin:10px 0 22px}
input{width:100%;box-sizing:border-box;padding:11px 13px;border:1px solid #D9D5C7;border-radius:9px;font-size:15px;text-align:center;letter-spacing:2px}
button{width:100%;margin-top:12px;padding:11px;border:0;border-radius:9px;background:#3D4A5F;color:#fff;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit}
.err{color:#B4453A;font-size:12.5px;margin-top:10px;min-height:16px}</style></head>
<body><form class="box" method="POST" action="/gate">
<div class="logo">tril<svg width="19" height="17" viewBox="0 0 200 180"><path d="M100 168 L14 20 L186 20 Z" fill="none" stroke="#45A8E8" stroke-width="30" stroke-linejoin="round"/></svg>gy</div>
<p>This is a private workspace.<br>Enter the access password you were given.</p>
<input type="password" name="pw" autofocus autocomplete="off">
<button>Enter</button><div class="err">${msg}</div></form></body></html>`;
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    if ((req.session as any)?.gateOk) return next();
    if (req.path.startsWith('/api/hooks/')) return next();
    if (req.path === '/gate' && req.method === 'POST') {
      const ip = req.ip || '?';
      const f = gateFails.get(ip);
      if (f && f.n >= 8 && Date.now() < f.until)
        return res.status(429).send(gatePage('Too many tries — wait 15 minutes.'));
      const pw = String((req.body as any)?.pw || '');
      if (pw.length === GATE_PW.length && crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(GATE_PW))) {
        gateFails.delete(ip);
        (req.session as any).gateOk = true;
        return res.redirect('/');
      }
      gateFails.set(ip, { n: (f?.n || 0) + 1, until: Date.now() + 15 * 60 * 1000 });
      return res.status(401).send(gatePage('That’s not it — check the password you were sent.'));
    }
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Gate locked' });
    return res.status(401).send(gatePage());
  });
}

app.post('/api/auth/login', login);
app.post('/api/auth/mfa', mfa);
app.post('/api/auth/logout', requireAuth, logout);
app.post('/api/auth/change-password', requireAuth, changePassword);
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

app.listen(PORT, () => {
  console.log(`Trilogy Platform API on http://localhost:${PORT} (build ${BUILD})`);
  if (!fs.existsSync(dist)) console.log('Dev mode: run the client with `npm run dev` (vite on :5173)');
});
