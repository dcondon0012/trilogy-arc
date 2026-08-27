import type { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import { db, audit } from './db.js';

export interface SessionUser {
  id: string; name: string; email: string;
  role: 'admin' | 'coordinator' | 'sales' | 'provider' | 'carrier';
  orgId?: string | null; orgRole?: 'admin' | 'worker';
  perms: string[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express { interface Request { user?: SessionUser } }
}

authenticator.options = { window: 1 };

export function currentUser(req: Request): SessionUser | null {
  const s: any = (req as any).session;
  if (!s?.userId) return null;
  const u = db.prepare('SELECT id,name,email,role,orgId,orgRole,perms FROM users WHERE id=? AND active=1 AND approved=1').get(s.userId) as any;
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
export function registerPortal(req: Request, res: Response) {
  const { name, email, password, orgType, orgId } = req.body || {};
  if (!String(name || '').trim() || !String(email || '').trim()) return res.status(400).json({ error: 'Name and email required' });
  if (String(password || '').length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (orgType !== 'provider' && orgType !== 'carrier') return res.status(400).json({ error: 'Choose provider or insurance carrier' });
  const org = orgType === 'provider'
    ? db.prepare('SELECT id,name FROM providers WHERE id=?').get(orgId)
    : db.prepare('SELECT id,name FROM insurers WHERE id=?').get(orgId);
  if (!org) return res.status(400).json({ error: 'Select your organization from the list' });
  if (db.prepare('SELECT 1 FROM users WHERE lower(email)=lower(?)').get(email)) return res.status(400).json({ error: 'That email already has an account' });
  const id = 'u' + Date.now();
  db.prepare('INSERT INTO users(id,name,email,pwHash,role,active,approved,orgId,mustChangePw) VALUES(?,?,?,?,?,1,0,?,0)')
    .run(id, name.trim(), email.trim(), bcrypt.hashSync(password, 10), orgType, orgId);
  audit(null, 'portal.signup', 'user', id, `${name} (${orgType} @ ${(org as any).name})`);
  res.json({ ok: true, message: 'Request received — a Trilogy admin will approve your access. You will be able to sign in once approved.' });
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Not signed in' });
  req.user = u;
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

/* Login rate limiting: 5 failures per email per 15 minutes. */
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;
const loginFails = new Map<string, number[]>();
function tooManyFails(key: string): boolean {
  const now = Date.now();
  const fails = (loginFails.get(key) || []).filter(t => now - t < FAIL_WINDOW_MS);
  loginFails.set(key, fails);
  return fails.length >= MAX_FAILS;
}
function recordFail(key: string) {
  loginFails.set(key, [...(loginFails.get(key) || []), Date.now()]);
}

/* Step 1: email + password. Returns MFA requirement + enrollment info. */
export function login(req: Request, res: Response) {
  const { email, password } = req.body || {};
  const key = String(email || '').toLowerCase();
  if (tooManyFails(key)) {
    audit(null, 'login.rateLimited', 'user', key);
    return res.status(429).json({ error: 'Too many failed attempts — wait 15 minutes and try again.' });
  }
  const u = db.prepare('SELECT * FROM users WHERE lower(email)=lower(?)').get(String(email || '')) as any;
  if (!u || !bcrypt.compareSync(String(password || ''), u.pwHash)) {
    recordFail(key);
    audit(null, 'login.failed', 'user', email);
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  loginFails.delete(key);
  if (u.active === 0) {
    audit({ id: u.id, name: u.name }, 'login.deactivated');
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
    audit({ id: u.id, name: u.name }, 'login.success.noMfa');
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
export function mfa(req: Request, res: Response) {
  const s: any = (req as any).session;
  const { code } = req.body || {};
  if (!s?.pendingUserId) return res.status(400).json({ error: 'Sign in first' });
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(s.pendingUserId) as any;
  if (!u) return res.status(400).json({ error: 'Sign in first' });

  const secret = u.totpSecret || s.pendingTotpSecret;
  if (!secret) return res.status(400).json({ error: 'Sign in first' });

  const ok = authenticator.check(String(code || ''), secret);
  if (!ok) {
    audit({ id: u.id, name: u.name }, 'mfa.failed');
    return res.status(401).json({ error: 'Invalid code — check your authenticator app' });
  }
  if (!u.totpSecret) {
    db.prepare('UPDATE users SET totpSecret=? WHERE id=?').run(secret, u.id);
    audit({ id: u.id, name: u.name }, 'mfa.enrolled');
  }
  s.userId = u.id;
  s.pendingUserId = null;
  s.pendingTotpSecret = null;
  audit({ id: u.id, name: u.name }, 'login.success');
  return res.json({ user: { id: u.id, name: u.name, email: u.email, role: u.role, orgId: u.orgId, mustChangePw: !!u.mustChangePw } });
}

/* Set a new password for the signed-in user (also clears the must-change flag). */
export function changePassword(req: Request, res: Response) {
  const pw = String(req.body?.newPassword || '');
  if (pw.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const current = String(req.body?.currentPassword || '');
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user!.id) as any;
  if (!bcrypt.compareSync(current, u.pwHash)) return res.status(401).json({ error: 'Current password is incorrect' });
  if (current === pw) return res.status(400).json({ error: 'New password must be different' });
  db.prepare('UPDATE users SET pwHash=?, mustChangePw=0 WHERE id=?').run(bcrypt.hashSync(pw, 10), u.id);
  audit(req.user!, 'password.change');
  res.json({ ok: true });
}

export function logout(req: Request, res: Response) {
  if (req.user) audit(req.user, 'logout');
  (req as any).session = null;
  res.json({ ok: true });
}
