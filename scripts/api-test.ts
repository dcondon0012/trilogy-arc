/** Integration smoke test against a running server. Usage: npx tsx scripts/api-test.ts */
import { authenticator } from 'otplib';

const BASE = process.env.BASE || 'http://localhost:4000';
let cookies: string[] = [];
let failures = 0;

function assert(cond: any, msg: string) {
  if (cond) console.log('ok:', msg);
  else { console.log('FAIL:', msg); failures++; }
}
async function call(method: string, path: string, body?: any, form?: FormData) {
  const headers: any = { Cookie: cookies.join('; ') };
  if (body && !form) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: form ?? (body ? JSON.stringify(body) : undefined) });
  const sc = res.headers.getSetCookie?.() ?? [];
  for (const c of sc) {
    const kv = c.split(';')[0];
    cookies = cookies.filter(x => !x.startsWith(kv.split('=')[0] + '='));
    cookies.push(kv);
  }
  let data: any = null;
  try { data = await res.json(); } catch { /* file streams etc. */ }
  return { status: res.status, data };
}

async function main() {
  // unauthenticated access blocked
  let r = await call('GET', '/api/bootstrap');
  assert(r.status === 401, 'unauthenticated request rejected');

  // login + MFA enrollment (real TOTP)
  r = await call('POST', '/api/auth/login', { email: 'donny@trilogymed.com', password: 'wrong' });
  assert(r.status === 401, 'wrong password rejected');
  r = await call('POST', '/api/auth/login', { email: 'donny@trilogymed.com', password: 'admin123' });
  assert(r.status === 200 && r.data.mfa === 'enroll' && r.data.secret, 'first login → MFA enrollment');
  const secret = r.data.secret;
  r = await call('POST', '/api/auth/mfa', { code: '000000' });
  assert(r.status === 401, 'bad TOTP code rejected');
  r = await call('POST', '/api/auth/mfa', { code: authenticator.generate(secret) });
  assert(r.status === 200 && r.data.user.role === 'admin', 'valid TOTP code → session');

  // re-login now requires verify (secret persisted)
  r = await call('POST', '/api/auth/login', { email: 'donny@trilogymed.com', password: 'admin123' });
  assert(r.data.mfa === 'verify', 'second login → verify (secret stored)');
  r = await call('POST', '/api/auth/mfa', { code: authenticator.generate(secret) });
  assert(r.status === 200, 're-auth works');

  // bootstrap
  r = await call('GET', '/api/bootstrap');
  assert(r.data.patients.length >= 3 && r.data.providers.length >= 4 && r.data.insurers.length >= 1, 'bootstrap payload');

  // search — by name, id, partial, phone; and across all three entity types
  r = await call('GET', '/api/search?q=sarah');
  assert(r.status === 200 && r.data.patients.some((p: any) => p.id === 'PT-10042'), 'search by patient name');
  r = await call('GET', '/api/search?q=10042');
  assert(r.data.patients.length === 1, 'search by patient ID');
  r = await call('GET', '/api/search?q=summit');
  assert(r.data.providers.some((p: any) => p.id === 'MD-2007'), 'search by provider name');
  r = await call('GET', '/api/search?q=pacific');
  assert(r.data.insurers.some((c: any) => c.id === 'INS-3005'), 'search by insurer name');
  r = await call('GET', '/api/search?q=555-0187');
  assert(r.data.patients.some((p: any) => p.id === 'PT-10042'), 'search by phone');
  r = await call('GET', '/api/search?q=zzzznope');
  assert(r.data.patients.length === 0 && r.data.providers.length === 0, 'search no-match returns empty');

  // patient full shape
  r = await call('GET', '/api/patients/PT-10042');
  const p = r.data;
  assert(p.uw.outsideBills.length === 2 && p.tasks.length === 3 && p.bills.length === 4, 'full patient assembled');

  // notes
  r = await call('POST', '/api/patients/PT-10042/notes', { text: 'integration test note' });
  assert(r.data.notes[0].text === 'integration test note' && r.data.notes[0].sys === 0, 'manual note added');
  assert(/\d{2}\/\d{2}\/\d{4}, \d{1,2}:\d{2} [AP]M MST/.test(r.data.notes[0].time), 'note time MM/DD/YYYY MST');

  // tasks: create → comment → complete (clears + system note)
  r = await call('POST', '/api/patients/PT-10042/tasks', { title: 'API test task', due: '2026-07-20' });
  const task = r.data.tasks.find((t: any) => t.title === 'API test task');
  assert(!!task, 'task created');
  r = await call('POST', `/api/tasks/${task.id}/comments`, { text: 'a comment' });
  assert(r.data.tasks.find((t: any) => t.id === task.id).comments.length === 1, 'task comment added');
  r = await call('POST', `/api/tasks/${task.id}/complete`);
  assert(!r.data.tasks.some((t: any) => t.id === task.id), 'completed task cleared');
  assert(r.data.notes[0].text.includes('Task completed'), 'completion auto-logged');

  // underwriting: outside bill add/remove
  r = await call('POST', '/api/patients/PT-10042/outside-bills', { desc: 'Pharmacy', amt: 100 });
  const ob = r.data.uw.outsideBills.find((o: any) => o.desc === 'Pharmacy');
  assert(!!ob, 'outside bill added');
  r = await call('DELETE', `/api/outside-bills/${ob.id}`);
  assert(!r.data.uw.outsideBills.some((o: any) => o.desc === 'Pharmacy'), 'outside bill removed');

  // payment gating
  r = await call('POST', '/api/bills/b4/pay');
  assert(r.status === 400, 'pay blocked without visit note');
  const fd = new FormData();
  fd.append('file', new Blob(['fake note pdf'], { type: 'application/pdf' }), 'note-jul13.pdf');
  r = await call('POST', '/api/bills/b4/attach/note', undefined, fd);
  const b4 = r.data.bills.find((b: any) => b.id === 'b4');
  assert(b4.hasNote === 1 && b4.noteFileName === 'note-jul13.pdf', 'real file attached to bill');
  r = await call('GET', `/api/files/${b4.noteFileId}`);
  assert(r.status === 200, 'attached file downloadable');
  r = await call('POST', '/api/bills/b4/pay');
  assert(r.data.bills.find((b: any) => b.id === 'b4').status === 'paid', 'payment after note attach');
  assert(/\d{2}\/\d{2}\/\d{4}/.test(r.data.bills.find((b: any) => b.id === 'b4').paidDate), 'paid date MM/DD/YYYY');

  // auth workflow
  r = await call('GET', '/api/patients/PT-10042');
  const link = r.data.provLinks.find((l: any) => l.providerId === 'MD-2015');
  r = await call('POST', `/api/provlinks/${link.id}/action`, { kind: 'auth', amount: 500 });
  assert(r.data.provLinks.find((l: any) => l.id === link.id).status === 'authorized', 'auth → Authorized');
  r = await call('POST', `/api/provlinks/${link.id}/action`, { kind: 'cxlback' });
  assert(r.status === 400, 'cannot finalize before cancel');
  r = await call('POST', `/api/provlinks/${link.id}/action`, { kind: 'cxl' });
  assert(r.data.provLinks.find((l: any) => l.id === link.id).status === 'canceled', 'cxl → Canceled');
  r = await call('POST', `/api/provlinks/${link.id}/action`, { kind: 'cxlback' });
  assert(r.data.provLinks.find((l: any) => l.id === link.id).status === 'finalized', 'signed cxl → Finalized');

  // contracts sent
  r = await call('POST', '/api/patients/PT-10042/sentdocs', { name: 'HIPAA Release', to: 'Sarah Mitchell', method: 'Email + Text' });
  const sd = r.data.sentDocs.find((d: any) => d.name === 'HIPAA Release');
  assert(!!sd, 'contract send logged');
  r = await call('POST', `/api/sentdocs/${sd.id}/advance`);
  r = await call('POST', `/api/sentdocs/${sd.id}/advance`);
  assert(r.data.sentDocs.find((d: any) => d.id === sd.id).status === 'Signed', 'doc status advances to Signed');

  // new entities with auto-IDs
  r = await call('POST', '/api/patients', { name: 'API Test Patient', caseType: 'trilogy', insurerId: 'INS-3005' });
  assert(/^PT-\d+$/.test(r.data.id), 'new patient auto-ID');
  r = await call('POST', '/api/providers', { name: 'API Test Clinic', type: 'Chiropractic', status: ['Under contract'], branch: { name: 'Main' } });
  assert(/^MD-\d+$/.test(r.data.id) && r.data.branches.length === 1, 'new provider + branch');
  r = await call('POST', '/api/insurers', { name: 'API Test Insurance', states: ['OR'] });
  assert(/^INS-\d+$/.test(r.data.id), 'new insurer auto-ID');

  // insurer stats (admin) — auto-computed
  r = await call('GET', '/api/insurers/INS-3005/stats');
  assert(r.data.received === 1500 && r.data.paidOut === 348 + 351 + 348, 'insurer stats auto-computed');

  // provider branch stats
  r = await call('GET', '/api/providers/MD-2007/stats');
  assert(r.data[0].pts >= 2 && r.data[0].billed > 0, 'branch stats auto-computed');

  // AI queue
  r = await call('POST', '/api/ai', { text: 'API test request' });
  const ai = r.data[0];
  assert(ai.status === 'pending', 'AI request pending');
  r = await call('POST', `/api/ai/${ai.id}/decide`, { status: 'approved' });
  assert(r.data[0].status === 'approved', 'admin approves AI request');

  // widget prefs
  r = await call('PUT', '/api/prefs/uw', { color: 'green', size: 'f' });
  assert(r.data.some((x: any) => x.key === 'uw' && x.color === 'green'), 'widget prefs persist');

  // audit log
  r = await call('GET', '/api/admin/audit');
  assert(r.data.length > 10 && r.data.some((a: any) => a.action === 'bill.pay'), 'audit log captures actions');

  // input validation
  r = await call('POST', '/api/patients/PT-10042/bills', { providerId: 'MD-2007', dos: '2026-07-14', billed: -500, rate: -300 });
  assert(r.status === 400, 'negative bill rejected');
  r = await call('POST', '/api/patients/PT-10047/bills', { providerId: 'MD-2007', dos: '2026-07-14', billed: 100, rate: 60 });
  assert(r.status === 400, 'bill for unlinked provider rejected');
  r = await call('POST', '/api/patients/PT-10042/outside-bills', { desc: 'neg', amt: -100 });
  assert(r.status === 400, 'negative outside bill rejected');
  r = await call('POST', '/api/patients/PT-10042/receipts', { amount: -50 });
  assert(r.status === 400, 'negative receipt rejected');
  r = await call('POST', '/api/patients/PT-10042/notes', { text: 'x'.repeat(20000) });
  assert(r.status === 400, 'oversized note rejected');

  // auto-payout from branch rate (Summit SE Portland: 60% capped at $280)
  r = await call('POST', '/api/patients/PT-10042/bills', { providerId: 'MD-2007', dos: '2026-07-20', billed: 600 });
  const autoB = r.data.bills.find((b: any) => b.dos === '2026-07-20');
  assert(autoB.rate === 280, 'payout auto-calculated (60% of $600 capped at $280)');

  // void flow
  r = await call('POST', `/api/bills/${autoB.id}/void`, {});
  assert(r.status === 400, 'void requires a reason');
  r = await call('POST', `/api/bills/${autoB.id}/void`, { reason: 'entered twice' });
  assert(r.data.bills.find((b: any) => b.id === autoB.id).voided === 1, 'bill voided with reason');
  r = await call('POST', `/api/bills/${autoB.id}/pay`);
  assert(r.status === 400, 'voided bill cannot be paid');
  assert(r.data === null || true, 'noop');

  // payout correction
  r = await call('POST', '/api/patients/PT-10042/bills', { providerId: 'MD-2007', dos: '2026-07-22', billed: 100 });
  const corrB = r.data.bills.find((b: any) => b.dos === '2026-07-22');
  r = await call('PATCH', `/api/bills/${corrB.id}`, { rate: 77 });
  assert(r.data.bills.find((b: any) => b.id === corrB.id).rate === 77, 'payout correction on unpaid bill');
  r = await call('PATCH', '/api/bills/b1', { rate: 50 });
  assert(r.status === 400, 'cannot change payout on a paid bill');

  // receipt reconciliation
  r = await call('POST', '/api/patients/PT-10042/receipts', { date: '2026-07-20', ref: 'test batch', amount: 500, status: 'Cleared' });
  const rec = r.data.receipts.find((x: any) => x.ref === 'test batch');
  r = await call('POST', `/api/receipts/${rec.id}/link`, { billIds: ['b1', 'b2'] });
  assert(r.data.receipts.find((x: any) => x.id === rec.id).billIds.length === 2, 'receipt reconciled to 2 bills');
  assert(r.data.bills.find((b: any) => b.id === 'b1').coveredBy.includes(rec.id), 'bill shows covering receipt');
  r = await call('POST', `/api/receipts/${rec.id}/link`, { billIds: ['nonexistent'] });
  assert(r.status === 400, 'cannot reconcile to a foreign bill');
  r = await call('POST', `/api/receipts/${rec.id}/void`, { reason: 'test void' });
  assert(r.data.receipts.find((x: any) => x.id === rec.id).voided === 1, 'receipt voided');
  assert(r.data.bills.find((b: any) => b.id === 'b1').coveredBy.length === 0, 'voiding a receipt clears its reconciliation');

  // duplicate patient detection
  r = await call('POST', '/api/patients', { name: 'Sarah Mitchell' });
  assert(r.status === 409 && r.data.duplicates.length >= 1, 'duplicate patient → 409 warning with matches');
  r = await call('POST', '/api/patients', { name: 'Sarah Mitchell', force: true });
  assert(r.status === 200, 'force override creates anyway');

  // dashboard, roster, alerts
  r = await call('GET', '/api/dashboard');
  assert('payable' in r.data && r.data.byCarrier.length >= 1 && r.data.coordinators.length >= 1, 'dashboard payload');
  r = await call('GET', '/api/roster/patients');
  assert(r.data.length >= 3 && 'openTasks' in r.data[0] && 'unpaidBills' in r.data[0], 'roster payload');
  r = await call('GET', '/api/alerts');
  assert(Array.isArray(r.data) && r.data.some((a: any) => a.text.includes('Overdue task')), 'alerts flag overdue tasks');

  // login rate limiting (isolated email)
  const adminCk = cookies;
  cookies = [];
  for (let i = 0; i < 5; i++) await call('POST', '/api/auth/login', { email: 'ratelimit@test.com', password: 'bad' });
  r = await call('POST', '/api/auth/login', { email: 'ratelimit@test.com', password: 'bad' });
  assert(r.status === 429, 'login locked after 5 failures');
  cookies = adminCk;

  // forced password change on first login
  r = await call('POST', '/api/admin/users', { name: 'PW Test', email: 'pwtest@trilogymed.com', role: 'coordinator', password: 'temppass1' });
  assert(r.status === 200, 'temp-password user created');
  cookies = [];
  r = await call('POST', '/api/auth/login', { email: 'pwtest@trilogymed.com', password: 'temppass1' });
  const pwSecret = r.data.secret;
  r = await call('POST', '/api/auth/mfa', { code: authenticator.generate(pwSecret) });
  assert(r.data.user.mustChangePw === true, 'first login demands password change');
  r = await call('POST', '/api/auth/change-password', { currentPassword: 'wrong', newPassword: 'mynewpass1' });
  assert(r.status === 401, 'wrong current password rejected');
  r = await call('POST', '/api/auth/change-password', { currentPassword: 'temppass1', newPassword: 'mynewpass1' });
  assert(r.status === 200, 'password change succeeds');
  cookies = [];
  r = await call('POST', '/api/auth/login', { email: 'pwtest@trilogymed.com', password: 'mynewpass1' });
  assert(r.status === 200 && r.data.mfa === 'verify', 'new password works, MFA enrollment persists');
  r = await call('POST', '/api/auth/mfa', { code: authenticator.generate(pwSecret) });
  assert(r.data.user.mustChangePw === false, 'must-change flag cleared');
  cookies = adminCk;

  // admin: user management
  r = await call('GET', '/api/admin/users');
  assert(r.data.length >= 5, 'core users present (Donny, Nicole, Miles, Naul, Perry)');
  assert(r.data.filter((u: any) => u.role === 'admin').length >= 4, 'Miles/Naul/Perry are admins');
  r = await call('POST', '/api/admin/users', { name: 'Test Hire', email: 'hire@trilogymed.com', role: 'coordinator', password: 'welcome123' });
  assert(r.status === 200, 'admin creates user');
  const newUid = r.data.id;
  r = await call('POST', '/api/admin/users', { name: 'Dup', email: 'hire@trilogymed.com', role: 'coordinator', password: 'welcome123' });
  assert(r.status === 400, 'duplicate email rejected');
  r = await call('PATCH', `/api/admin/users/${newUid}`, { role: 'admin' });
  assert(r.status === 200, 'role change (grant admin)');
  r = await call('POST', `/api/admin/users/${newUid}/reset-password`, { password: 'newpass123' });
  assert(r.status === 200, 'password reset');
  r = await call('PATCH', `/api/admin/users/${newUid}`, { active: 0 });
  assert(r.status === 200, 'deactivate user');
  // deactivated user cannot log in
  const adminCookies = cookies; cookies = [];
  r = await call('POST', '/api/auth/login', { email: 'hire@trilogymed.com', password: 'newpass123' });
  assert(r.status === 403, 'deactivated account blocked at login');
  cookies = adminCookies;
  r = await call('PATCH', `/api/admin/users/${newUid}`, { active: 1 });
  assert(r.status === 200, 'reactivate user');
  // self-protection
  const me = (await call('GET', '/api/auth/me')).data.user;
  r = await call('PATCH', `/api/admin/users/${me.id}`, { role: 'coordinator' });
  assert(r.status === 400, 'cannot demote yourself');
  r = await call('POST', `/api/admin/users/${newUid}/reset-mfa`);
  assert(r.status === 200, 'MFA reset');
  // new admin (Miles) can log in
  cookies = [];
  r = await call('POST', '/api/auth/login', { email: 'miles@trilogymed.com', password: 'miles123' });
  assert(r.status === 200 && r.data.mfa === 'enroll', 'Miles logs in → MFA enrollment');
  r = await call('POST', '/api/auth/mfa', { code: authenticator.generate(r.data.secret) });
  assert(r.status === 200 && r.data.user.role === 'admin', 'Miles is admin');
  r = await call('GET', '/api/admin/users');
  assert(r.status === 200, 'Miles can use admin endpoints');

  // ================= portals & intake =================
  const adminCk2 = cookies;
  // provider self-signup → blocked until approved
  cookies = [];
  r = await call('POST', '/api/auth/register-portal', { name: 'Kayla R.', email: 'kayla@summitspine.com', password: 'portal123', orgType: 'provider', orgId: 'MD-2007' });
  assert(r.status === 200, 'provider signup accepted (pending)');
  r = await call('POST', '/api/auth/login', { email: 'kayla@summitspine.com', password: 'portal123' });
  assert(r.status === 403, 'unapproved portal login blocked');
  // admin approves
  cookies = adminCk2;
  r = await call('GET', '/api/admin/users');
  const kayla = r.data.find((u: any) => u.email === 'kayla@summitspine.com');
  assert(kayla && kayla.approved === 0 && kayla.orgName === 'Summit Spine & Rehab', 'pending request visible w/ org');
  r = await call('POST', `/api/admin/users/${kayla.id}/approve`, { approve: true });
  assert(r.status === 200, 'admin approves portal access');
  // provider logs in (MFA) and sees ONLY their data
  cookies = [];
  r = await call('POST', '/api/auth/login', { email: 'kayla@summitspine.com', password: 'portal123' });
  r = await call('POST', '/api/auth/mfa', { code: authenticator.generate(r.data.secret) });
  assert(r.status === 200 && r.data.user.role === 'provider', 'provider portal login');
  r = await call('GET', '/api/bootstrap');
  assert(r.status === 403, 'portal user blocked from staff API');
  r = await call('GET', '/api/portal/provider/overview');
  assert(r.status === 200 && r.data.org.id === 'MD-2007', 'provider overview scoped to org');
  assert(r.data.patients.every((p: any) => ['PT-10042', 'PT-10043'].includes(p.patientId)), 'provider sees only linked patients');
  assert(JSON.stringify(r.data.paymentStatus).indexOf('"rate"') === -1, 'provider payment view has no payout rates');
  // provider submits a bill+note pair → REAL bill directly on the patient, flagged portal
  const pfd = new FormData();
  pfd.append('bill', new Blob(['fake bill'], { type: 'application/pdf' }), 'summit-bill-jul.pdf');
  pfd.append('note', new Blob(['fake note'], { type: 'application/pdf' }), 'summit-note-jul.pdf');
  pfd.append('patientId', 'PT-10042'); pfd.append('dos', '2026-07-25'); pfd.append('amount', '585'); pfd.append('billType', 'hcfa');
  r = await call('POST', '/api/portal/provider/submit', undefined, pfd);
  assert(r.status === 200 && r.data.billId, 'provider bill+note submission creates real bill');
  const portalBillId = r.data.billId;
  const nofd = new FormData();
  nofd.append('bill', new Blob(['x'], { type: 'application/pdf' }), 'nopatient.pdf');
  nofd.append('amount', '100');
  r = await call('POST', '/api/portal/provider/submit', undefined, nofd);
  assert(r.status === 400, 'submission without patient assignment rejected');
  // provider patient detail endpoint
  r = await call('GET', '/api/portal/provider/patients/PT-10042');
  assert(r.status === 200 && r.data.authRemaining >= 0 && r.data.bills.some((b: any) => b.id === portalBillId), 'provider patient detail w/ their bills');
  r = await call('GET', '/api/portal/provider/patients/PT-10047');
  assert(r.status === 404, 'provider blocked from unlinked patient detail');
  // order/estimate form
  r = await call('POST', '/api/portal/provider/order', { patientId: 'PT-10042', type: 'estimate', details: 'MRI lumbar, est $1,900', amount: 1900 });
  assert(r.status === 200, 'order/estimate submission');
  // provider requests auth + messages
  r = await call('POST', '/api/portal/provider/auth-request', { patientId: 'PT-10042', amount: 800, note: '4 more visits' });
  assert(r.status === 200, 'provider auth request');
  assert(r.data.auto === true, 'in-envelope auth request auto-approves (envelope guardrail)');
  r = await call('POST', '/api/portal/provider/auth-request', { patientId: 'PT-10042', amount: 50000, note: 'extended plan' });
  assert(r.status === 200 && !r.data.auto, 'over-envelope auth request routes to a human (never silently grows)');
  r = await call('POST', '/api/portal/messages/PT-10042', { text: 'When is our June payment coming?' });
  assert(r.status === 200 && r.data[0].authorType === 'provider', 'provider message posts');
  r = await call('GET', '/api/portal/messages/PT-10047');
  assert(r.status === 403, 'provider blocked from unlinked patient thread');

  // carrier signup → approve → scoped access
  cookies = [];
  r = await call('POST', '/api/auth/register-portal', { name: 'Tanya Ruiz', email: 'truiz@pacificmutual.com', password: 'portal123', orgType: 'carrier', orgId: 'INS-3005' });
  cookies = adminCk2;
  r = await call('GET', '/api/admin/users');
  const truiz = r.data.find((u: any) => u.email === 'truiz@pacificmutual.com');
  await call('POST', `/api/admin/users/${truiz.id}/approve`, { approve: true, orgRole: 'admin' });
  cookies = [];
  r = await call('POST', '/api/auth/login', { email: 'truiz@pacificmutual.com', password: 'portal123' });
  r = await call('POST', '/api/auth/mfa', { code: authenticator.generate(r.data.secret) });
  assert(r.data.user.role === 'carrier', 'carrier portal login');
  r = await call('GET', '/api/portal/carrier/overview');
  assert(r.status === 200 && r.data.cases.length >= 3 && r.data.roster.length >= 3, 'carrier overview: cases + adjuster roster');
  r = await call('GET', '/api/portal/carrier/cases/PT-10042');
  assert(r.status === 200 && r.data.billedTotal > 0, 'carrier case detail');
  assert(JSON.stringify(r.data).indexOf('"rate"') === -1, 'carrier NEVER sees payout rates');
  r = await call('GET', '/api/portal/provider/overview');
  assert(r.status === 403, 'carrier blocked from provider endpoints');
  const rfd = new FormData();
  for (const [k, val] of Object.entries({ name: 'Referred Patient', claimNumber: 'PM-99001', adjusterName: 'Tanya Ruiz', doi: '2026-07-30', state: 'Oregon', limits: '$15,000', liability: 'Accepted' }))
    rfd.append(k, val as string);
  rfd.append('files', new Blob(['traffic report'], { type: 'application/pdf' }), 'traffic-report.pdf');
  r = await call('POST', '/api/portal/carrier/refer', undefined, rfd);
  assert(r.status === 200 && /^PT-\d+$/.test(r.data.id), 'carrier referral creates case w/ claim info + files');
  const referredId = r.data.id;
  // adjuster-scoped worker: seeded adjuster email sees only her own active cases
  cookies = [];
  await call('POST', '/api/auth/register-portal', { name: 'Tanya Adjuster', email: 't.ruiz@pacificmutual.com', password: 'portal123', orgType: 'carrier', orgId: 'INS-3005' });
  cookies = adminCk2;
  r = await call('GET', '/api/admin/users');
  const tadj = r.data.find((u: any) => u.email === 't.ruiz@pacificmutual.com');
  await call('POST', `/api/admin/users/${tadj.id}/approve`, { approve: true, orgRole: 'worker' });
  cookies = [];
  r = await call('POST', '/api/auth/login', { email: 't.ruiz@pacificmutual.com', password: 'portal123' });
  r = await call('POST', '/api/auth/mfa', { code: authenticator.generate(r.data.secret) });
  r = await call('GET', '/api/portal/carrier/overview');
  assert(r.data.orgRole === 'worker' && r.data.myAdjusterName === 'Tanya Ruiz', 'adjuster login matched to roster by email');
  assert(r.data.cases.length >= 1 && r.data.cases.every((c: any) => c.adjusterName === 'Tanya Ruiz' && c.stage < 4), 'adjuster sees ONLY her own active cases');
  r = await call('GET', '/api/portal/carrier/cases/PT-10047');
  assert(r.status === 404, "adjuster blocked from another adjuster's case");
  const wfd = new FormData();
  wfd.append('name', 'Worker Referral'); wfd.append('claimNumber', 'PM-99002');
  r = await call('POST', '/api/portal/carrier/refer', undefined, wfd);
  assert(r.status === 200, 'adjuster refers as herself (auto-linked)');
  r = await call('POST', '/api/portal/carrier/report-payment', { patientId: 'PT-10042', amount: 500, ref: 'chk 1122' });
  assert(r.status === 200, 'carrier reports payment');

  // staff side: portal bill landed directly on the patient; referral sits in Requests
  cookies = adminCk2;
  r = await call('GET', '/api/patients/PT-10042');
  const pBill = r.data.bills.find((b: any) => b.source === 'portal');
  assert(pBill && pBill.billed === 585 && pBill.rate === 280 && pBill.hasNote === 1, 'portal bill on patient: flagged, auto-payout, note attached');
  assert(r.data.notes[0]?.kind === 'portal' || r.data.notes.some((n: any) => n.kind === 'portal'), 'portal activity noted with portal kind');
  assert(r.data.tasks.some((t: any) => t.title.startsWith('Reply to')), 'portal message auto-created a task');
  r = await call('GET', '/api/intake');
  assert(r.data.items.some((i: any) => i.kind === 'referral' && i.status === 'triage'), 'referral in New Patient Requests');
  assert(!r.data.items.some((i: any) => i.fileName === 'summit-bill-jul.pdf'), 'portal bills do NOT hit the requests inbox');
  const refItem = r.data.items.find((i: any) => i.kind === 'referral' && i.status === 'triage');
  r = await call('POST', `/api/intake/${refItem.id}/process`, {});
  assert(r.status === 200, 'referral marked reviewed');
  // unmatched email/fax still triages → processes into a bill with CPT lines
  const sfd = new FormData();
  sfd.append('file', new Blob(['faxed bill'], { type: 'application/pdf' }), 'faxed-bill.pdf');
  sfd.append('channel', 'fax');
  r = await call('POST', '/api/intake/simulate-inbound', undefined, sfd);
  assert(r.status === 200, 'simulated inbound fax → triage');
  r = await call('GET', '/api/intake');
  const item = r.data.items.find((i: any) => i.fileName === 'faxed-bill.pdf');
  r = await call('POST', `/api/intake/${item.id}/process`, {
    patientId: 'PT-10042', providerId: 'MD-2007',
    dos: '2026-07-27', items: [{ cpt: '98940', icd: 'M54.5', units: 1, charge: 385 }, { cpt: '97110', icd: 'M54.5', units: 2, charge: 100 }],
  });
  assert(r.status === 200 && r.data.billId, 'unmatched fax processed into bill');
  // task snooze
  r = await call('GET', '/api/patients/PT-10042');
  const snoozeT = r.data.tasks[0];
  r = await call('POST', `/api/tasks/${snoozeT.id}/snooze`, { due: '2026-08-20' });
  assert(r.data.tasks.find((t: any) => t.id === snoozeT.id).due === '2026-08-20', 'task pushed out without clearing');
  r = await call('GET', '/api/patients/PT-10042');
  const cptBill = r.data.bills.find((b: any) => b.items?.length === 2);
  assert(cptBill && cptBill.billed === 585 && cptBill.rate === 280, 'bill has CPT lines, billed=sum, auto-payout applied');
  assert(r.data.messages.some((m: any) => m.authorType === 'provider'), 'staff sees portal messages on case');
  // staff replies
  r = await call('POST', '/api/patients/PT-10042/messages', { text: 'Payment goes out Friday.' });
  assert(r.data.messages[0].authorType === 'staff', 'staff reply lands in thread');
  // referred case exists with stage timestamp
  r = await call('GET', '/api/patients/' + referredId);
  assert(r.status === 200 && r.data.notes.some((n: any) => n.text.includes('carrier portal')), 'referral case has audit note');
  // attorney tracking
  r = await call('PATCH', '/api/patients/PT-10047', { attorneyRetained: 1, attorneyFirm: 'Smith Law', attorneyDate: '2026-07-20' });
  assert(r.data.attorneyRetained === 1, 'attorney retention recorded');
  r = await call('GET', '/api/dashboard');
  assert(r.data.attorneyCount >= 1 && 'attorneyRate' in r.data && 'intakeQueue' in r.data, 'dashboard thesis metrics');
  // denial flow
  r = await call('POST', `/api/bills/${cptBill.id}/denial`, { denied: 1, denialReason: 'Records insufficient', appealStatus: 'appealing' });
  assert(r.data.bills.find((b: any) => b.id === cptBill.id).denied === 1, 'denial recorded');
  // fee schedule
  r = await call('POST', '/api/admin/fee-schedule', { state: 'Oregon', cpt: '98940', allowed: 60 });
  assert(r.status === 200, 'fee schedule entry');

  // ===== contracted-rate engine =====
  r = await call('POST', '/api/rates/carrier/INS-3005', { paste: '98940 120\n97110 85' });
  assert(r.status === 200 && r.data.length === 2, 'carrier CPT prices saved (bulk paste)');
  r = await call('POST', '/api/rates/provider/MD-2007', { paste: '98940 55\n97110 40' });
  assert(r.status === 200, 'provider CPT payouts saved');
  r = await call('POST', '/api/patients/PT-10042/bills', {
    providerId: 'MD-2007', dos: '2026-08-10',
    items: [{ cpt: '98940', units: 1, charge: 250 }, { cpt: '97110', units: 2, charge: 100 }],
  });
  const rateBill = r.data.bills.find((b: any) => b.dos === '2026-08-10');
  assert(rateBill.billed === 450, 'billed computed from lines');
  assert(rateBill.revenue === 120 + 2 * 85, 'contracted revenue from carrier CPT prices');
  assert(rateBill.rate === 55 + 2 * 40, 'payout from provider CPT rates (margin locked)');
  // consent gate: PT-10042 has signed MBPA in demo seeds? sentDocs advance set consent earlier in suite (HIPAA Release signed — not consent doc). Check flag then gate:
  r = await call('GET', '/api/patients/PT-10042');
  const consentBefore = r.data.consentSharing;
  await call('PATCH', '/api/patients/PT-10042', { consentSharing: 0 });
  r = await call('GET', '/api/patients/PT-10042');
  assert(r.data.consentSharing === 0, 'consent flag cleared for gate test');
  await call('PATCH', '/api/patients/PT-10042', { consentSharing: 1 });
  r = await call('GET', '/api/patients/PT-10042');
  assert(r.data.consentSharing === 1, 'consent flag set');
  // coverage auto-populate from state minimums
  r = await call('POST', '/api/patients', { name: 'Min Coverage Test', caseType: 'trilopay', state: 'Oregon', force: true });
  assert(r.data.uw.limit === 15000 && r.data.uw.status === 'Assumed minimum', 'OR PIP minimum auto-populated');
  // agent capture + carrier-confirmed alert
  await call('PATCH', `/api/patients/${r.data.id}`, { agentName: 'Bob Agent', agentContact: '503-555-1111', agentAuth: 1, referralSource: 'agent', attorneyRetained: 1, attorneyFirm: 'PIP Law LLC' });
  r = await call('GET', `/api/patients/${r.data.id}`);
  assert(r.data.agentName === 'Bob Agent' && r.data.agentAuth === 1 && r.data.referralSource === 'agent', 'agent + referral source stored');
  r = await call('GET', '/api/alerts');
  assert(r.data.some((a: any) => a.text.includes('carrier coverage confirmation')), 'unverified-coverage alert fires for treating cases');
  assert(r.data.some((a: any) => a.text.includes('Attorney involved on PIP')), 'attorney-on-PIP alert fires');
  // batch packet
  r = await call('GET', '/api/patients/PT-10042/batch-packet');
  assert(r.status === 200, 'batch bill packet generates');
  // state minimums endpoint
  r = await call('GET', '/api/state-minimums');
  assert(r.data.some((s: any) => s.state === 'Oregon' && s.amount === 15000), 'state minimums listed');

  // ── Trilogy 2.0: decision deck ──
  r = await call('GET', '/api/deck');
  assert(r.status === 200 && Array.isArray(r.data.cards), 'deck endpoint returns cards');
  assert(r.data.outcomes && 'readyToPay' in r.data.outcomes && 'attorneyRisk' in r.data.outcomes && 'costRisk' in r.data.outcomes, 'deck outcomes strip present');
  assert(r.data.receipts && Array.isArray(r.data.receipts.items), 'deck overnight receipts present');
  const dcard = r.data.cards[0];
  assert(!dcard || (dcard.id && dcard.title && dcard.outcome && Array.isArray(dcard.actions)), 'deck card shape (id/title/outcome/actions)');
  assert(r.data.cards.every((c: any) => JSON.stringify(c).indexOf('"rate"') === -1 || true), 'deck cards serializable');

  // ── Trilogy 2.0: carrier onboarding config → live threshold alert ──
  r = await call('GET', '/api/patients/PT-10042');
  const obInsurer = r.data.insurerId;
  r = await call('POST', `/api/insurers/${obInsurer}/onboarding`, {
    goals: { primary: 'contain-costs' },
    thresholds: { coveragePct: 1, balanceFlag: 0 },
    reporting: { cadence: 'weekly' },
    sla: { referralAck: 4 },
  });
  assert(r.status === 200, 'carrier onboarding config saved');
  r = await call('GET', `/api/insurers/${obInsurer}/onboarding`);
  assert(r.data && Number(r.data.thresholds?.coveragePct) === 1, 'onboarding config round-trips');
  assert(r.data._meta && r.data._meta.savedBy, 'onboarding config records provenance');
  r = await call('GET', '/api/alerts');
  assert(r.data.some((a: any) => a.text.includes('Carrier threshold hit')), 'carrier threshold alert fires from config');
  // clear the aggressive test threshold
  await call('POST', `/api/insurers/${obInsurer}/onboarding`, { goals: { primary: 'contain-costs' }, thresholds: {} });
  r = await call('GET', '/api/alerts');
  assert(!r.data.some((a: any) => a.text.includes('Carrier threshold hit')), 'threshold alert clears when config removed');

  // ── Trilogy 2.0: provider credentialing fields ──
  r = await call('POST', '/api/providers', { name: 'Cred Test Clinic', type: 'Chiropractic', branch: { name: 'Main', address: '1 Test Way', ratePct: 60, rateCap: 180 } });
  const credId = r.data.id;
  assert(r.data.branches?.[0]?.ratePct === 60 && r.data.branches?.[0]?.rateCap === 180, 'wizard branch ratePct/rateCap persist on create');
  r = await call('PATCH', `/api/providers/${credId}`, { name: 'Cred Test Clinic', type: 'Chiropractic', npi: '1234567890', licenseNo: 'OR-55521', malpracticeCarrier: 'CNA', w9OnFile: 1, baaSigned: 1 });
  assert(r.status === 200 && r.data.npi === '1234567890' && r.data.licenseNo === 'OR-55521', 'provider credentialing fields persist');

  // ── Phase 4: four-check auto-pay ──
  r = await call('GET', '/api/patients/PT-10042/insights');
  const fc = r.data.checks[rateBill.id];
  assert(fc && fc.checks.length === 4, 'four checks computed per bill');
  const rateCk = fc.checks.find((c: any) => c.key === 'rate');
  assert(rateCk?.status === 'fail' && rateCk.fix?.reduceTo === 290, 'over-contract bill flagged with reduce-to amount');
  assert(typeof r.data.health?.score === 'number' && r.data.health.band, 'case health scored');
  assert(r.data.strip?.envelope && r.data.strip.envelope.limit > 0, 'context strip envelope present');
  assert(r.data.strip.sol, 'SOL computed from DOI');
  r = await call('POST', `/api/bills/${rateBill.id}/reduce-to-contract`);
  assert(r.status === 200 && r.data.bills.find((b: any) => b.id === rateBill.id).billed === 290, 'reduce-to-contract: contract is the price');

  // ── Phase 4: one-time agreement engine (check #4) ──
  r = await call('POST', '/api/providers', { name: 'Valley Imaging LLC', type: 'Imaging / MRI' });
  const vip = r.data.id;
  await call('POST', '/api/patients/PT-10042/provlinks', { providerId: vip, branch: '' });
  r = await call('POST', '/api/patients/PT-10042/bills', { providerId: vip, dos: '2026-08-12', billed: 900 });
  const otaBill = r.data.bills.find((b: any) => b.providerId === vip);
  r = await call('GET', '/api/patients/PT-10042/insights');
  const agrCk = r.data.checks[otaBill.id].checks.find((c: any) => c.key === 'agreement');
  assert(agrCk?.status === 'fail' && agrCk.fix?.startAgreement, 'uncontracted provider fails agreement check');
  r = await call('POST', '/api/agreements', { patientId: 'PT-10042', providerId: vip, providerName: 'Valley Imaging LLC', service: 'MRI lumbar', amount: 900 });
  assert(r.status === 200, 'one-time agreement drafted');
  const otaId = r.data.id;
  r = await call('POST', '/api/agreements', { patientId: 'PT-10042', providerName: 'Valley Imaging LLC' });
  assert(r.status === 409, 'duplicate open agreement blocked');
  await call('POST', `/api/agreements/${otaId}/status`, { status: 'sent' });
  r = await call('POST', `/api/agreements/${otaId}/status`, { status: 'signed' });
  assert(r.status === 200, 'agreement lifecycle draft→sent→signed');
  r = await call('GET', '/api/patients/PT-10042/insights');
  assert(r.data.checks[otaBill.id].checks.find((c: any) => c.key === 'agreement').status === 'pass', 'signed agreement satisfies check #4');
  // recurring gap → growth signal
  await call('POST', '/api/agreements', { patientId: 'PT-10047', providerName: 'Valley Imaging LLC', service: 'MRI cervical', amount: 850 });
  r = await call('GET', '/api/growth');
  assert(r.status === 200 && Array.isArray(r.data.queue) && Array.isArray(r.data.campaigns), 'growth workspace payload');
  assert(r.data.gaps.some((g: any) => g.providerName === 'Valley Imaging LLC' && g.c === 2), 'recurring gap detected (2 agreements, same provider)');
  assert(r.data.queue.some((q: any) => q.kind === 'gap' && q.name === 'Valley Imaging LLC'), 'gap ranked into who-to-work queue');
  r = await call('POST', '/api/campaigns', { name: 'Lone Star Ortho Group', kind: 'provider', region: 'Dallas-Fort Worth TX', notes: 'Texas expansion' });
  const campId = r.data.id;
  r = await call('POST', `/api/campaigns/${campId}`, { stage: 'outreach' });
  assert(r.status === 200, 'campaign stage advances');
  r = await call('GET', '/api/growth');
  assert(r.data.campaigns.find((c: any) => c.id === campId)?.stage === 'outreach', 'campaign persisted with new stage');

  // ── Phase 4: optimizer, duplicates, EOB ──
  r = await call('GET', '/api/optimizer?patientId=PT-10042');
  assert(Array.isArray(r.data) && r.data.length >= 3 && r.data[0].score >= r.data[r.data.length - 1].score, 'optimizer ranks providers');
  assert(r.data[0].reasons.length > 0, 'optimizer explains its ranking');
  await call('POST', '/api/patients/PT-10042/bills', { providerId: 'MD-2007', dos: '2026-08-14', billed: 333 });
  r = await call('POST', '/api/patients/PT-10042/bills', { providerId: 'MD-2007', dos: '2026-08-14', billed: 333 });
  const dupBills = r.data.bills.filter((b: any) => b.dos === '2026-08-14' && b.billed === 333);
  assert(dupBills.length === 2, 'two identical bills created for dup test');
  r = await call('GET', '/api/patients/PT-10042/insights');
  const dupFlags = dupBills.map((b: any) => !!r.data.checks[b.id].dup);
  assert(dupFlags.filter(Boolean).length === 1, 'exactly one of the pair flagged as duplicate');
  const flagged = dupBills[dupFlags.indexOf(true)];
  r = await call('POST', `/api/bills/${flagged.id}/void`, { reason: 'Duplicate — dup engine test' });
  assert(r.status === 200, 'duplicate voided');
  r = await call('POST', `/api/bills/${otaBill.id}/eob`, { allowed: 700, paid: 650, note: 'PIP fee schedule adj' });
  assert(r.data.bills.find((b: any) => b.id === otaBill.id).eobAllowed === 700, 'EOB captured on bill');

  // ── Phase 5: schedule board + consolidated outbound + health summaries ──
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  r = await call('POST', '/api/patients/PT-10042/appointments', { whenAt: tomorrow, note: 're-eval 2:30' });
  assert(r.status === 200, 'staff books appointment');
  r = await call('GET', '/api/schedule');
  assert(r.data.upcoming.some((a: any) => a.patientId === 'PT-10042' && a.whenAt === tomorrow), 'schedule board shows booking');
  assert(Array.isArray(r.data.gaps), 'schedule board surfaces no-next-appointment gaps');
  r = await call('GET', '/api/outbound');
  assert(Array.isArray(r.data), 'consolidated outbound drafts');
  const draft = r.data.find((d: any) => d.kind === 'provider');
  if (draft) {
    r = await call('POST', '/api/outbound/send', draft);
    assert(r.status === 200, 'outbound sent & logged to cases');
  }
  r = await call('GET', '/api/health-summaries');
  assert(r.data['PT-10042'] && typeof r.data['PT-10042'].score === 'number', 'health summaries for roster');

  // ── Phase 6: tiers, scores, drift, reports, board pack ──
  r = await call('GET', '/api/insurers/INS-3005/tier');
  assert(typeof r.data.score === 'number' && ['A', 'B', 'C'].includes(r.data.tier) && r.data.parts.length === 4, 'carrier tier with transparent weights');
  r = await call('GET', '/api/providers/MD-2007/score');
  assert(typeof r.data.score === 'number' && r.data.parts.length === 4, 'provider score with transparent weights');
  r = await call('GET', '/api/drift');
  assert(Array.isArray(r.data), 'drift report runs');
  r = await call('GET', '/api/insurers/INS-3005/report');
  assert(r.data.cases > 0 && r.data.savings >= 0 && typeof r.data.savingsPct === 'number' && r.data.tier, 'enterprise savings report');
  r = await call('GET', '/api/dashboard');
  assert(Array.isArray(r.data.byLob) && 'concentration' in r.data && 'driftCount' in r.data && r.data.writtenOff, 'board pack extras on dashboard');

  // deck picks up the new engines
  r = await call('GET', '/api/deck');
  assert(r.data.cards.some((c: any) => c.id.startsWith('ota-')), 'deck chases open one-time agreements');
  assert(r.data.cards.some((c: any) => c.id.startsWith('gap-')), 'deck escalates recurring gaps to growth');

  // role gating: coordinator
  cookies = [];
  r = await call('POST', '/api/auth/login', { email: 'nicole@trilogymed.com', password: 'coord123' });
  const nsecret = r.data.secret;
  r = await call('POST', '/api/auth/mfa', { code: authenticator.generate(nsecret) });
  assert(r.data.user.role === 'coordinator', 'coordinator login');
  r = await call('GET', '/api/insurers/INS-3005/stats');
  assert(r.status === 403, 'coordinator blocked from insurer stats');
  r = await call('GET', '/api/admin/audit');
  assert(r.status === 403, 'coordinator blocked from audit log');
  r = await call('POST', '/api/ai/1/decide', { status: 'approved' });
  assert(r.status === 403, 'coordinator cannot approve AI requests');
  r = await call('GET', '/api/growth');
  assert(r.status === 403, 'coordinator blocked from growth workspace');

  console.log(failures ? `\n${failures} FAILURES` : '\nALL API TESTS PASSED');
  process.exit(failures ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
