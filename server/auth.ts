import type { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { authenticator } from 'otplib';
import { q, audit } from './db.js';
import { sendMail } from './integrations.js';

export interface SessionUser {
  id: string; name: string; email: string;
  role: 'admin' | 'coordinator' | 'sales' | 'provider' | 'carrier';
  orgId?: string | null; orgRole?: 'admin' | 'worker';
  perms: string[]; mustChangePw?: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express { interface Request { user?: SessionUser } }
}

authenticator.options = { window: 1 };

export async function currentUser(req: Request): Promise<SessionUser | null> {
  const s: any = (req as any).session;
  if (!s?.userId) return null;
  const u = await q.get<any>('SELECT id,name,email,role,orgId,orgRole,perms,mustChangePw FROM users WHERE id=? AND active=1 AND approved=1', s.userId);
  if (!u) return null;
  try { u.perms = JSON.parse(u.perms || '[]'); } catch { u.perms = []; }
  return u as SessionUser;
}

/** Fee-tool access: admins always, Sales role automatically, anyone else per-user grant. */
export function canUseFees(u: SessionUser | undefined | null): boolean {
  return !!u && (u.role === 'admin' || u.role === 'sales' || (u.perms || []).includes('fees'));
}
export function requireFees(req: Request, res: Response, next: NextFunction) {
  if (!canUseFees(req.user)) return res.status(403).json({ error: 'No fee tool access — ask an admin to grant it' });
  next();
}

/** CRM access: same model — admins and Sales automatically, per-user grant for others. */
export function canUseCrm(u: SessionUser | undefined | null): boolean {
  return !!u && (u.role === 'admin' || u.role === 'sales' || (u.perms || []).includes('crm'));
}
export function requireCrm(req: Request, res: Response, next: NextFunction) {
  if (!canUseCrm(req.user)) return res.status(403).json({ error: 'No CRM access — ask an admin to grant it' });
  next();
}

export function requireStaff(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== 'admin' && req.user?.role !== 'coordinator')
    return res.status(403).json({ error: 'Staff only' });
  next();
}

/* Portal self-signup: creates a pending account an admin must approve. */
export async function registerPortal(req: Request, res: Response) {
  const { name, email, password, orgType, orgId } = req.body || {};
  if (!String(name || '').trim() || !String(email || '').trim()) return res.status(400).json({ error: 'Name and email required' });
  if (String(password || '').length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (orgType !== 'provider' && orgType !== 'carrier') return res.status(400).json({ error: 'Choose provider or insurance carrier' });
  const org = orgType === 'provider'
    ? await q.get<any>('SELECT id,name FROM providers WHERE id=?', orgId)
    : await q.get<any>('SELECT id,name FROM insurers WHERE id=?', orgId);
  if (!org) return res.status(400).json({ error: 'Select your organization from the list' });
  if (await q.get<any>('SELECT 1 FROM users WHERE lower(email)=lower(?)', email)) return res.status(400).json({ error: 'That email already has an account' });
  const id = 'u' + Date.now();
  await q.run('INSERT INTO users(id,name,email,pwHash,role,active,approved,orgId,mustChangePw) VALUES(?,?,?,?,?,1,0,?,0)',
    id, name.trim(), email.trim(), bcrypt.hashSync(password, 10), orgType, orgId);
  await audit(null, 'portal.signup', 'user', id, `${name} (${orgType} @ ${org.name})`);
  res.json({ ok: true, message: 'Request received — a Trilogy admin will approve your access. You will be able to sign in once approved.' });
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const u = await currentUser(req);
  if (!u) return res.status(401).json({ error: 'Not signed in' });
  // Temp-password lockout: a known temporary password must not be a working key
  // to the whole API. Until the user sets their own, only /api/auth/* works.
  if (u.mustChangePw && !req.originalUrl.startsWith('/api/auth/'))
    return res.status(403).json({ error: 'Set a new password first — your temporary one expired' });
  req.user = u;
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

/* Login rate limiting: 5 failures per email+IP per 15 minutes. Stage 4: moved to
   Postgres so it works across multiple nodes. Old entries are cleaned lazily. */
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;
async function tooManyFails(key: string): Promise<boolean> {
  const now = Date.now();
  const cutoff = now - FAIL_WINDOW_MS;
  const rows = await q.all<{ at: number }>('SELECT at FROM rate_limits WHERE k=? AND at>?', key, cutoff);
  return rows.length >= MAX_FAILS;
}
async function recordFail(key: string) {
  const now = Date.now();
  await q.run('INSERT INTO rate_limits(k, at) VALUES(?, ?)', key, now);
  // Lazy cleanup: delete expired entries table-wide, not just this key — otherwise
  // keys that never recur (one failed login per stray IP) accumulate forever.
  // Safe while every limiter here uses the same 15-minute window.
  await q.run('DELETE FROM rate_limits WHERE at<?', now - FAIL_WINDOW_MS);
}

/* Step 1: email + password. Returns MFA requirement + enrollment info. */
export async function login(req: Request, res: Response) {
  const { email, password } = req.body || {};
  // 'login|' prefix namespaces the key so a crafted email can't collide with the
  // 'forgot|' or 'mfa|' buckets in the shared rate_limits table.
  const key = 'login|' + String(email || '').toLowerCase() + '|' + (req.ip || '?');
  if (await tooManyFails(key)) {
    await audit(null, 'login.rateLimited', 'user', key);
    return res.status(429).json({ error: 'Too many failed attempts — wait 15 minutes and try again.' });
  }
  const u = await q.get<any>('SELECT * FROM users WHERE lower(email)=lower(?)', String(email || ''));
  if (!u || !bcrypt.compareSync(String(password || ''), u.pwHash)) {
    await recordFail(key);
    await audit(null, 'login.failed', 'user', email);
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  // On success, clear rate-limit entries for this key.
  await q.run('DELETE FROM rate_limits WHERE k=?', key);
  if (u.active === 0) {
    await audit({ id: u.id, name: u.name }, 'login.deactivated');
    return res.status(403).json({ error: 'This account has been deactivated — contact an admin.' });
  }
  if (u.approved === 0) {
    return res.status(403).json({ error: 'Your access request is awaiting approval by a Trilogy admin.' });
  }
  const s: any = (req as any).session;
  // Pre-launch convenience: TRILOGY_DISABLE_MFA=1 skips the authenticator step entirely.
  // MUST be removed from the launcher at deployment — logins then require TOTP again.
  if (process.env.TRILOGY_DISABLE_MFA === '1') {
    s.userId = u.id;
    s.pendingUserId = null;
    await audit({ id: u.id, name: u.name }, 'login.success.noMfa');
    return res.json({ mfa: 'none', user: { id: u.id, name: u.name, email: u.email, role: u.role, orgId: u.orgId, mustChangePw: !!u.mustChangePw } });
  }
  s.pendingUserId = u.id;
  s.userId = null;
  if (!u.totpSecret) {
    // First login: enroll MFA. Secret is confirmed (saved) only after a valid code.
    const secret = authenticator.generateSecret();
    s.pendingTotpSecret = secret;
    return res.json({
      mfa: 'enroll',
      otpauthUrl: authenticator.keyuri(u.email, 'Trilogy Platform', secret),
      secret,
    });
  }
  return res.json({ mfa: 'verify' });
}

/* Step 2: TOTP code. */
export async function mfa(req: Request, res: Response) {
  const s: any = (req as any).session;
  const { code } = req.body || {};
  if (!s?.pendingUserId) return res.status(400).json({ error: 'Sign in first' });
  const u = await q.get<any>('SELECT * FROM users WHERE id=?', s.pendingUserId);
  if (!u) return res.status(400).json({ error: 'Sign in first' });

  // TOTP brute-force limit: 5 wrong codes per user per 15 minutes. Without this a
  // 6-digit code is guessable online; the check sits before verification so even a
  // correct code is refused while the account is limited.
  const mfaKey = 'mfa|' + u.id;
  if (await tooManyFails(mfaKey)) {
    await audit({ id: u.id, name: u.name }, 'mfa.rateLimited');
    return res.status(429).json({ error: 'Too many failed codes — wait 15 minutes and try again.' });
  }

  const secret = u.totpSecret || s.pendingTotpSecret;
  if (!secret) return res.status(400).json({ error: 'Sign in first' });

  const ok = authenticator.check(String(code || ''), secret);
  if (!ok) {
    await recordFail(mfaKey);
    await audit({ id: u.id, name: u.name }, 'mfa.failed');
    return res.status(401).json({ error: 'Invalid code — check your authenticator app' });
  }
  await q.run('DELETE FROM rate_limits WHERE k=?', mfaKey);
  if (!u.totpSecret) {
    await q.run('UPDATE users SET totpSecret=? WHERE id=?', secret, u.id);
    await audit({ id: u.id, name: u.name }, 'mfa.enrolled');
  }
  s.userId = u.id;
  s.pendingUserId = null;
  s.pendingTotpSecret = null;
  await audit({ id: u.id, name: u.name }, 'login.success');
  return res.json({ user: { id: u.id, name: u.name, email: u.email, role: u.role, orgId: u.orgId, mustChangePw: !!u.mustChangePw } });
}

/* Set a new password for the signed-in user (also clears the must-change flag). */
export async function changePassword(req: Request, res: Response) {
  const pw = String(req.body?.newPassword || '');
  if (pw.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const current = String(req.body?.currentPassword || '');
  const u = await q.get<any>('SELECT * FROM users WHERE id=?', req.user!.id);
  if (!bcrypt.compareSync(current, u.pwHash)) return res.status(401).json({ error: 'Current password is incorrect' });
  if (current === pw) return res.status(400).json({ error: 'New password must be different' });
  await q.run('UPDATE users SET pwHash=?, mustChangePw=0 WHERE id=?', bcrypt.hashSync(pw, 10), u.id);
  await audit(req.user!, 'password.change');
  res.json({ ok: true });
}

/* ── self-serve password reset (email-backed; queued until SES is live) ── */
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export async function forgotPassword(req: Request, res: Response) {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const key = 'forgot|' + (req.ip || '?');
  const now = Date.now();
  const cutoff = now - 15 * 60 * 1000;
  const hits = await q.all<{ at: number }>('SELECT at FROM rate_limits WHERE k=? AND at>?', key, cutoff);
  await q.run('INSERT INTO rate_limits(k, at) VALUES(?, ?)', key, now);
  await q.run('DELETE FROM rate_limits WHERE k=? AND at<?', key, cutoff);
  // Same response whether or not the account exists — no user enumeration; rate-limited per IP.
  const done = () => res.json({ ok: true, message: 'If that email has an account, a reset link is on its way. It expires in 30 minutes.' });
  if (hits.length >= 5 || !email) return done();
  const u = await q.get<any>('SELECT * FROM users WHERE lower(email)=? AND active=1 AND approved=1', email);
  if (!u) return done();
  const token = crypto.randomBytes(32).toString('hex');
  await q.run('INSERT INTO pw_resets(userId,tokenHash,expiresAt) VALUES(?,?,?)',
    u.id, sha(token), new Date(now + 30 * 60 * 1000).toISOString());
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'trilogyconnections.com');
  const proto = String(req.headers['x-forwarded-proto'] || 'https');
  const link = `${proto}://${host}/?reset=${token}`;
  await audit({ id: u.id, name: u.name }, 'password.resetRequested');
  await sendMail({
    to: u.email, subject: 'Reset your Trilogy password',
    text: `Hi ${u.name},\n\nSomeone (hopefully you) asked to reset your Trilogy password. Use this link within 30 minutes:\n\n${link}\n\nIf you didn't ask for this, you can ignore it — your password is unchanged.\n\n— Trilogy Medical Networks`,
    meta: { kind: 'pw-reset', userId: u.id },
  });
  return done();
}

export async function resetPassword(req: Request, res: Response) {
  const token = String(req.body?.token || '');
  const pw = String(req.body?.newPassword || '');
  if (pw.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const row = await q.get<any>('SELECT * FROM pw_resets WHERE tokenHash=?', sha(token));
  if (!row || row.usedAt || new Date(row.expiresAt).getTime() < Date.now())
    return res.status(400).json({ error: 'That reset link is invalid or expired — request a new one' });
  const u = await q.get<any>('SELECT * FROM users WHERE id=? AND active=1', row.userId);
  if (!u) return res.status(400).json({ error: 'That reset link is invalid or expired — request a new one' });
  await q.run('UPDATE users SET pwHash=?, mustChangePw=0 WHERE id=?', bcrypt.hashSync(pw, 10), u.id);
  await q.run('UPDATE pw_resets SET usedAt=? WHERE id=?', new Date().toISOString(), row.id);
  await audit({ id: u.id, name: u.name }, 'password.resetCompleted');
  res.json({ ok: true, message: 'Password updated — sign in with it now.' });
}

export async function logout(req: Request, res: Response) {
  if (req.user) await audit(req.user, 'logout');
  (req as any).session = null;
  res.json({ ok: true });
}
