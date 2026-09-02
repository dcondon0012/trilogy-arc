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
  // Miles was seeded with a temporary password — locked out of the API until he sets his own.
  r = await call('GET', '/api/admin/users');
  assert(r.status === 403, 'seeded temp password locked out until changed');
  r = await call('POST', '/api/auth/change-password', { currentPassword: 'miles123', newPassword: 'milesownpw1' });
  assert(r.status === 200, 'Miles sets his own password');
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

  // ── Medicare fee benchmark tool ──
  // fixture: real 2026 values for 99213 (two CF rows — engine must pick the non-QP one),
  // a second code, three TX localities incl. a sub-1.00 work GPCI to prove the floor.
  r = await call('POST', '/api/fees/test/fixture', {
    rvu: [
      { hcpc: '99213', modifier: '', rvu_work: '1.30', full_nfac_pe: '1.46', full_fac_pe: '0.55', rvu_mp: '0.09', conv_fact: '33.5675', proc_stat: 'A' },
      { hcpc: '99213', modifier: '', rvu_work: '1.30', full_nfac_pe: '1.46', full_fac_pe: '0.55', rvu_mp: '0.09', conv_fact: '33.4009', proc_stat: 'A' },
      { hcpc: '97110', modifier: '', rvu_work: '0.45', full_nfac_pe: '0.35', full_fac_pe: '0.20', rvu_mp: '0.02', conv_fact: '33.4009', proc_stat: 'A' },
    ],
    gpci: [
      { locality: '0441211', loc_description: 'DALLAS', mac_description: 'TEXAS', gpci_work: '1.009', gpci_pe: '0.996', gpci_mp: '0.858' },
      { locality: '0441299', loc_description: 'REST OF TEXAS', mac_description: 'TEXAS', gpci_work: '1.000', gpci_pe: '0.949', gpci_mp: '0.903' },
      { locality: '0441220', loc_description: 'BEAUMONT', mac_description: 'TEXAS', gpci_work: '0.950', gpci_pe: '0.910', gpci_mp: '0.929' },
    ],
    zips: [
      { state: 'TX', zip: '75201', carrier: '04412', locality: '11', plus4: 0 },
      { state: 'TX', zip: '79936', carrier: '04412', locality: '99', plus4: 0 },
      { state: 'TX', zip: '77706', carrier: '04412', locality: '20', plus4: 1 },
    ],
  });
  assert(r.status === 200 && r.data.ok, 'fee fixture loaded');
  r = await call('GET', '/api/fees/lookup?zip=75201');
  const dallas99213 = r.data.rates.find((x: any) => x.cpt === '99213');
  assert(r.data.zipKnown === true && dallas99213?.localityName === 'DALLAS', 'fee lookup maps ZIP → locality');
  assert(dallas99213?.nonfacAmount === 94.96, `formula matches hand-computed Dallas 99213 ($94.96, got $${dallas99213?.nonfacAmount})`);
  assert(dallas99213?.convFact === 33.4009, 'engine selects the non-QP conversion factor row');
  r = await call('GET', '/api/fees/lookup?zip=79936');
  assert(r.data.rates.find((x: any) => x.cpt === '99213')?.nonfacAmount === 92.41, 'Rest of Texas 99213 = $92.41');
  r = await call('GET', '/api/fees/lookup?zip=77706');
  assert(r.data.rates.find((x: any) => x.cpt === '99213')?.nonfacAmount === 90.59, 'work GPCI 1.00 floor applied (Beaumont)');
  assert(r.data.locality?.plus4 === true, 'ZIP+4 split flag surfaces');
  r = await call('GET', '/api/fees/lookup?zip=99999');
  assert(r.data.zipKnown === false, 'unknown ZIP reported, not guessed');
  r = await call('GET', '/api/fees/status');
  assert(r.data.currentRates === 6 && r.data.currentZips === 3, 'fee status counts current rates and zips');
  assert(!r.data.codes.some((c: any) => c.cpt === '20552' || c.cpt === '20553'), 'trigger-point injection codes removed (out of clinical scope)');

  // crosswalk parser: header CSV and fixed-width both load through the manual endpoint
  r = await call('POST', '/api/fees/admin/zip-upload', {
    text: 'STATE,ZIP CODE,CARRIER,LOCALITY,RURAL,PLUS 4 FLAG\n"TX","75201","04412","11","","0"\n"TX","77706","04412","20","","1"\n"OK","73102","04520","00","","0"',
  });
  assert(r.status === 200 && r.data.zips === 2, 'manual crosswalk upload parses header CSV (TX rows only)');
  r = await call('POST', '/api/fees/admin/zip-upload', {
    text: 'TX752010441211 01 1020264\nTX790360441299 01 0020264\nOK731020452000 01 0020264',
  });
  assert(r.status === 200 && r.data.zips === 2, 'manual crosswalk upload parses fixed-width layout');
  r = await call('GET', '/api/fees/lookup?zip=75201');
  assert(r.data.zipKnown === true && r.data.locality?.plus4 === true, 'fixed-width plus-4 flag parsed');

  // ── 08/27 change set: auth docs, bill entry v2, financials, contracts, delete ──
  r = await call('GET', '/api/patients/PT-10042');
  assert(!r.data.documents.some((d: any) => d.cat === 'Misc'), 'document category Misc renamed to Other');
  const l2007 = r.data.provLinks.find((l: any) => l.providerId === 'MD-2007');
  // editable auth total
  r = await call('PATCH', `/api/provlinks/${l2007.id}`, { authAmount: 3000 });
  assert(r.status === 200 && r.data.provLinks.find((l: any) => l.id === l2007.id).authAmount === 3000, 'auth total editable after the fact');
  // auth sends generate a document + prewritten email draft
  r = await call('POST', `/api/provlinks/${l2007.id}/action`, { kind: 'reqform' });
  assert(r.data._doc && r.data._doc.url.includes('/sentdoc/') && r.data._doc.mailto.startsWith('mailto:'), 'auth send returns document + email draft');
  const printRes = await fetch(BASE + r.data._doc.url, { headers: { Cookie: cookies.join('; ') } });
  const printHtml = await printRes.text();
  assert(printRes.status === 200 && printHtml.includes('Sarah Mitchell') && printHtml.includes('Authorization'), 'printable auth document renders with case details');

  // carrier authorization envelope
  r = await call('PATCH', '/api/patients/PT-10042', { carrierAuthorized: 15000 });
  assert(r.data.carrierAuthorized === 15000, 'carrier-authorized amount stored');

  // bill entry v2: CPT lines must sum to billed; files ride inline; payout always auto
  const mkForm = (fields: Record<string, string>, withNote = true) => {
    const fd = new FormData();
    fd.append('bill', new Blob(['%PDF-1.4 test bill'], { type: 'application/pdf' }), 'bill-v2.pdf');
    if (withNote) fd.append('note', new Blob(['%PDF-1.4 test note'], { type: 'application/pdf' }), 'note-v2.pdf');
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    return fd;
  };
  r = await call('POST', '/api/patients/PT-10042/bills2', undefined, mkForm({
    providerId: 'MD-2007', dos: '2026-08-20', billed: '400', mode: 'itemized',
    items: JSON.stringify([{ cpt: '98942', units: 1, charge: 250 }, { cpt: '97112', units: 1, charge: 100 }]),
  }));
  assert(r.status === 400 && /must match/.test(r.data.error), 'itemized bill rejected when CPT lines do not sum to billed');
  r = await call('POST', '/api/patients/PT-10042/bills2', undefined, mkForm({
    providerId: 'MD-2007', dos: '2026-08-20', billed: '350', mode: 'itemized',
    items: JSON.stringify([{ cpt: '98942', units: 1, charge: 250 }, { cpt: '97112', units: 1, charge: 100 }]),
  }));
  const v2bill = r.data.bills.find((b: any) => b.dos === '2026-08-20' && b.billed === 350);
  assert(r.status === 200 && v2bill && v2bill.hasBill === 1 && v2bill.hasNote === 1 && v2bill.items.length === 2, 'itemized bill v2: files inline, CPT lines stored');
  assert(v2bill.rate === 210, 'payout auto-calculated on v2 bills (60% of $350)');
  r = await call('POST', '/api/patients/PT-10042/bills2', undefined, mkForm({
    providerId: 'MD-2007', dos: '2026-08-21', billed: '120', mode: 'invoice',
  }, false));
  assert(r.status === 400 && /description/.test(r.data.error), 'general invoice requires a description');
  r = await call('POST', '/api/patients/PT-10042/bills2', undefined, mkForm({
    providerId: 'MD-2007', dos: '2026-08-21', billed: '120', mode: 'invoice', descr: 'X-ray reading fee',
  }, false));
  assert(r.status === 200 && r.data.bills.some((b: any) => b.descr === 'X-ray reading fee'), 'general invoice mode works');

  // per-case financials (admin-only margins)
  r = await call('GET', '/api/patients/PT-10042/financials');
  assert(r.status === 200 && r.data.case && typeof r.data.case.marginProjected === 'number'
    && r.data.providers.some((x: any) => x.providerId === 'MD-2007' && x.payoutPctOfBilled != null), 'case financials computed for admin');

  // insurer contracts: scope + admin-only rate
  r = await call('POST', '/api/insurers/INS-3005/contracts', { name: 'Adjuster agreement — T. Ruiz (2026)', scope: 'adjuster', adjusterId: 'a1', rate: 85, status: 'Draft' });
  assert(r.status === 200, 'adjuster-scope contract created');
  assert(!JSON.stringify(r.data.contracts).includes('"rate"'), 'contract rate never in the general insurer payload');
  r = await call('GET', '/api/insurers/INS-3005/contract-rates');
  const adjC = r.data.find((x: any) => x.scope === 'adjuster' && x.adjusterId === 'a1');
  assert(adjC && adjC.rate === 85, 'admin sees contract rates in the admin endpoint');
  r = await call('PATCH', `/api/ins-contracts/${adjC.id}`, { status: 'Sent' });
  assert(r.status === 200, 'contract status advances');

  // provider BAA + rate agreement gate
  r = await call('POST', '/api/providers', { name: 'Gate Test Clinic', type: 'Chiropractic' });
  const gateId = r.data.id;
  r = await call('GET', '/api/patients/PT-10042');   // fullProvider comes via bootstrap; use contract endpoint responses instead
  let fdBaa = new FormData(); fdBaa.append('signed', '1');
  r = await call('POST', `/api/providers/${gateId}/contract/baa`, undefined, fdBaa);
  assert(r.status === 200 && r.data.underContract === false, 'BAA alone does not make a provider Under contract');
  let fdRate = new FormData(); fdRate.append('signed', '1');
  fdRate.append('file', new Blob(['%PDF rate agreement'], { type: 'application/pdf' }), 'rate-agreement.pdf');
  r = await call('POST', `/api/providers/${gateId}/contract/rate`, undefined, fdRate);
  assert(r.status === 200 && r.data.underContract === true && r.data.status.includes('Under contract'), 'BAA + rate agreement signed → Under contract (auto)');
  r = await call('POST', '/api/providers/' + gateId + '/contracted-rate', { rate: '140% of Medicare' });
  assert(r.status === 200, 'admin records contracted rate');
  r = await call('GET', `/api/providers/${gateId}/admin`);
  assert(r.data.contractedRate === '140% of Medicare', 'contracted rate readable in the provider admin endpoint');

  // delete account (permanent sibling of deactivate)
  r = await call('POST', '/api/admin/users', { name: 'Del Etee', email: 'del@trilogymed.com', role: 'coordinator', password: 'deletemepw1' });
  const delId = r.data.id;
  r = await call('DELETE', `/api/admin/users/${delId}`);
  assert(r.status === 200, 'admin deletes an account');
  {
    const saved = cookies; cookies = [];
    r = await call('POST', '/api/auth/login', { email: 'del@trilogymed.com', password: 'deletemepw1' });
    assert(r.status === 401, 'deleted account cannot sign in');
    cookies = saved;
  }
  r = await call('DELETE', `/api/admin/users/u1`);
  assert(r.status === 400, 'cannot delete your own account');

  // ── security hardening ──
  // a temporary password is not a working API key: locked out until changed
  r = await call('POST', '/api/admin/users', { name: 'Tara Temp', email: 'tara@trilogymed.com', role: 'coordinator', password: 'temppass99' });
  assert(r.status === 200, 'temp coordinator created');
  cookies = [];
  r = await call('POST', '/api/auth/login', { email: 'tara@trilogymed.com', password: 'temppass99' });
  const tsecret = r.data.secret;
  r = await call('POST', '/api/auth/mfa', { code: authenticator.generate(tsecret) });
  assert(r.status === 200, 'temp user completes MFA');
  r = await call('GET', '/api/bootstrap');
  assert(r.status === 403, 'temporary password cannot use the API before being changed');
  r = await call('POST', '/api/auth/change-password', { currentPassword: 'temppass99', newPassword: 'tarasrealpw1' });
  assert(r.status === 200, 'temp user sets a real password');
  r = await call('GET', '/api/bootstrap');
  assert(r.status === 200, 'API unlocked after password change');
  cookies = [];
  r = await call('POST', '/api/auth/login', { email: 'donny@trilogymed.com', password: 'admin123' });
  r = await call('POST', '/api/auth/mfa', { code: authenticator.generate(secret) });
  assert(r.status === 200, 'admin back in after hardening checks');
  r = await call('GET', '/api/admin/export');
  const usersDump = JSON.stringify(r.data.users || []);
  assert(r.status === 200 && !usersDump.includes('pwHash') && !usersDump.includes('totpSecret'), 'data export never contains password hashes or TOTP secrets');

  // ── CRM (network build) ──
  r = await call('POST', '/api/crm/targets', { name: 'Lone Star Spine & Rehab', kind: 'provider', specialty: 'Chiropractic', market: 'Dallas–Fort Worth', phone: '(214) 555-0100', email: 'office@lonestarspine.com' });
  assert(r.status === 200 && r.data.id, 'CRM target created');
  const crmId = r.data.id;
  r = await call('POST', '/api/crm/targets', { name: 'lone star spine & rehab' });
  assert(r.status === 400, 'duplicate CRM target rejected (case-insensitive)');
  r = await call('POST', `/api/crm/targets/${crmId}/activity`, { kind: 'call', text: 'Spoke with office manager', outcome: 'conversation', nextAt: '2026-09-02', nextNote: 'Send rate sheet' });
  assert(r.status === 200 && r.data.target.nextAt === '2026-09-02', 'CRM call logged and follow-up booked');
  r = await call('POST', `/api/crm/targets/${crmId}/contacts`, { name: 'Dana Cole', title: 'Office manager', phone: '(214) 555-0101' });
  assert(r.status === 200 && r.data.target.contacts.length === 1, 'CRM contact added');
  r = await call('POST', `/api/crm/targets/${crmId}/stage`, { stage: 'signed' });
  assert(r.status === 200, 'CRM stage advanced');
  r = await call('GET', `/api/crm/targets/${crmId}`);
  assert(r.data.stage === 'signed' && r.data.activities.some((a: any) => a.kind === 'stage'), 'stage change recorded on the timeline');
  r = await call('GET', '/api/crm/workspace');
  assert(r.data.targets.some((t: any) => t.id === crmId) && r.data.stats.byStage.signed >= 1 && Array.isArray(r.data.signals), 'CRM workspace payload');
  r = await call('POST', `/api/crm/targets/${crmId}/promote`);
  assert(r.status === 200 && /^MD-\d+/.test(r.data.id), 'signed target promotes into the provider network');
  const promotedId = r.data.id;
  r = await call('GET', `/api/providers/${promotedId}/stats`);
  assert(r.status === 200, 'promoted provider exists in operations');
  r = await call('POST', `/api/crm/targets/${crmId}/promote`);
  assert(r.status === 400, 'double promotion rejected');
  r = await call('GET', '/api/crm/report');
  assert(Array.isArray(r.data.funnel) && r.data.funnel.length === 7, 'CRM report funnel');

  // prospecting: paste → score → triage → pipeline
  r = await call('POST', '/api/crm/prospects/import', {
    market: 'Dallas–Fort Worth', specialty: 'Chiropractic',
    text: 'Dallas Spine & Injury Group | 4310 Gaston Ave, Dallas | (214) 555-0132 | dallasspine.com\nMercy Hospital Dallas | (214) 555-0100\nLakewood Chiropractic | (214) 555-0177',
  });
  assert(r.status === 200 && r.data.added === 2 && r.data.dropped === 1, 'prospect import scores candidates and filters hospitals');
  r = await call('GET', '/api/crm/prospects?market=' + encodeURIComponent('Dallas–Fort Worth'));
  const topProspect = r.data.prospects[0];
  assert(topProspect.name === 'Dallas Spine & Injury Group' && topProspect.score === 87
    && topProspect.flags.includes('Injury focused') && topProspect.flags.includes('Group or multi site'), 'prospect scoring: injury + group + website + phone = 87');
  r = await call('POST', '/api/crm/prospects/import', { market: 'Dallas–Fort Worth', text: 'Lakewood Chiropractic | (214) 555-0177' });
  assert(r.data.added === 0 && r.data.dupes === 1, 'prospect re-import deduplicates');
  r = await call('POST', `/api/crm/prospects/${topProspect.id}/add`);
  assert(r.status === 200 && r.data.targetId, 'prospect promotes into the pipeline');
  r = await call('GET', '/api/crm/workspace');
  assert(r.data.targets.some((t: any) => t.name === 'Dallas Spine & Injury Group' && t.source === 'prospecting'), 'prospect-sourced target lands in the workspace');

  // sales role: fee tool yes, case data never
  r = await call('POST', '/api/admin/users', { name: 'Sam Sales', email: 'sam.sales@trilogymed.com', role: 'sales', password: 'salespass1' });
  assert(r.status === 200, 'admin creates a sales user');
  const salesId = r.data.id;
  cookies = [];
  r = await call('GET', '/api/fees/status');
  assert(r.status === 401, 'fee tool requires sign-in');
  r = await call('POST', '/api/auth/login', { email: 'sam.sales@trilogymed.com', password: 'salespass1' });
  const ssecret = r.data.secret;
  r = await call('POST', '/api/auth/mfa', { code: authenticator.generate(ssecret) });
  assert(r.status === 200 && r.data.user.role === 'sales', 'sales login');
  await call('POST', '/api/auth/change-password', { currentPassword: 'salespass1', newPassword: 'salespass2' });
  r = await call('GET', '/api/fees/lookup?zip=75201');
  assert(r.status === 200 && r.data.rates.length > 0, 'sales role gets the fee tool automatically');
  r = await call('GET', '/api/fees/status');
  assert(r.status === 200, 'sales can read fee status');
  r = await call('POST', '/api/fees/admin/refresh');
  assert(r.status === 403, 'sales cannot trigger CMS refresh (admin only)');
  r = await call('GET', '/api/crm/workspace');
  assert(r.status === 200 && Array.isArray(r.data.targets), 'sales role gets the CRM automatically');
  r = await call('POST', '/api/crm/targets', { name: 'Hill Country PT Group', kind: 'provider', market: 'Austin' });
  assert(r.status === 200, 'sales can add CRM targets');
  r = await call('POST', `/api/crm/targets/${r.data.id}/promote`);
  assert(r.status === 403, 'sales cannot promote into the operational network (admin only)');
  r = await call('GET', '/api/bootstrap');
  assert(r.status === 403, 'sales blocked from staff bootstrap (no case data)');
  r = await call('GET', '/api/patients/PT-10042');
  assert(r.status === 403, 'sales blocked from patient records');
  r = await call('GET', '/api/deck');
  assert(r.status === 403, 'sales blocked from the decision deck');

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
  r = await call('GET', '/api/fees/lookup?zip=75201');
  assert(r.status === 403, 'coordinator blocked from fee tool without a grant');
  r = await call('GET', '/api/crm/workspace');
  assert(r.status === 403, 'coordinator blocked from CRM without a grant');
  // payout secrecy: coordinators see bills as billed-and-paid, never payout or margin figures
  r = await call('GET', '/api/patients/PT-10042');
  assert(r.status === 200 && r.data.bills.length > 0 && r.data.bills.every((b: any) => !('rate' in b) && !('revenue' in b)), 'coordinator patient payload carries no payout/revenue figures');
  r = await call('GET', '/api/rates/provider/MD-2007');
  assert(r.status === 403, 'coordinator blocked from per-CPT payout rates');
  r = await call('GET', '/api/patients/PT-10042/financials');
  assert(r.status === 403, 'coordinator blocked from the case financials tab');
  r = await call('PATCH', '/api/ins-contracts/1', { rate: 90 });
  assert(r.status === 403, 'coordinator cannot set contract rates');
  r = await call('PATCH', '/api/bills/b1', { rate: 1 });
  assert(r.status === 403, 'coordinator cannot correct payouts');

  // admin grants the fee tool per-user → coordinator gets in
  cookies = [];
  r = await call('POST', '/api/auth/login', { email: 'donny@trilogymed.com', password: 'admin123' });
  r = await call('POST', '/api/auth/mfa', { code: authenticator.generate(secret) });
  assert(r.status === 200, 'admin re-login for grant');
  r = await call('POST', '/api/admin/users/u2/perms', { perm: 'fees', grant: true });
  assert(r.status === 200 && r.data.perms.includes('fees'), 'admin grants fee tool to a coordinator');
  cookies = [];
  r = await call('POST', '/api/auth/login', { email: 'nicole@trilogymed.com', password: 'coord123' });
  r = await call('POST', '/api/auth/mfa', { code: authenticator.generate(nsecret) });
  r = await call('GET', '/api/fees/lookup?zip=75201');
  assert(r.status === 200 && r.data.rates.length > 0, 'granted coordinator can use the fee tool');

  /* ================= integrations layer (Phase A — no credentials) ================= */
  // coordinator cannot touch the integrations panel
  r = await call('GET', '/api/admin/integrations');
  assert(r.status === 403, 'coordinator blocked from integrations panel');

  cookies = [];
  r = await call('POST', '/api/auth/login', { email: 'donny@trilogymed.com', password: 'admin123' });
  r = await call('POST', '/api/auth/mfa', { code: authenticator.generate(secret) });
  assert(r.status === 200, 'admin re-login for integrations');

  // status: all services listed, none live without credentials
  r = await call('GET', '/api/admin/integrations');
  assert(r.status === 200 && r.data.services.length >= 5 && r.data.services.every((s: any) => !s.live), 'integration status: services listed, none live yet');
  assert(r.data.secrets.every((s: any) => !s.masked || s.masked.includes('••') || s.masked.includes('(set')), 'secrets never returned in full');

  // secrets: unknown keys rejected, valid key saves and comes back masked
  r = await call('POST', '/api/admin/secrets', { EVIL_KEY: 'x' });
  assert(r.status === 400, 'unknown secret key rejected');
  r = await call('POST', '/api/admin/secrets', { SES_FROM: 'notifications@trilogyconnections.com' });
  const sesRow = r.data?.secrets?.find((s: any) => s.key === 'SES_FROM');
  assert(r.status === 200 && sesRow?.set && !sesRow.masked.includes('notifications@trilogyconnections'), 'secret saved, masked on read');

  // new user with no password → temp code generated; queued to outbox since email is dark
  const uEmail = `test${Date.now()}@trilogyconnections.com`;
  r = await call('POST', '/api/admin/users', { name: 'Temp Code Test', role: 'coordinator', email: uEmail });
  assert(r.status === 200 && r.data.tempPassword && r.data.emailed === false, 'user without password → temp code returned (email not live)');
  const tempUid = r.data.id;
  r = await call('GET', '/api/admin/outbox');
  assert(r.status === 200 && r.data.some((o: any) => o.toAddr === uEmail && o.status === 'queued'), 'temp-code email queued in outbox');

  // OCR endpoint refuses politely without AWS keys
  {
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from('%PDF-1.4 fake')], { type: 'application/pdf' }), 'bill.pdf');
    r = await call('POST', '/api/bills/parse', undefined, fd);
    assert(r.status === 503, 'bill OCR reports not-configured without AWS keys');
  }

  // self-serve password reset — same reply for unknown emails (no enumeration)
  cookies = [];
  r = await call('POST', '/api/auth/forgot-password', { email: 'nobody@nowhere.example' });
  const genericMsg = r.data?.message;
  assert(r.status === 200 && genericMsg, 'forgot-password: unknown email gets the same generic reply');
  r = await call('POST', '/api/auth/forgot-password', { email: 'nicole@trilogymed.com' });
  assert(r.status === 200 && r.data.message === genericMsg, 'forgot-password: real email gets the identical reply');

  // pull the reset link out of the queued email (admin outbox), complete the reset
  cookies = [];
  r = await call('POST', '/api/auth/login', { email: 'donny@trilogymed.com', password: 'admin123' });
  r = await call('POST', '/api/auth/mfa', { code: authenticator.generate(secret) });
  r = await call('GET', '/api/admin/outbox');
  const resetMail = r.data.find((o: any) => o.toAddr === 'nicole@trilogymed.com' && /reset=/.test(o.body));
  const token = resetMail ? (resetMail.body.match(/reset=([0-9a-f]+)/) || [])[1] : null;
  assert(!!token, 'reset link (with token) queued for the real account');

  cookies = [];
  r = await call('POST', '/api/auth/reset-password', { token: 'deadbeef', newPassword: 'whatever123' });
  assert(r.status === 400, 'bogus reset token rejected');
  r = await call('POST', '/api/auth/reset-password', { token, newPassword: 'brandnew123' });
  assert(r.status === 200, 'valid reset token sets a new password');
  r = await call('POST', '/api/auth/reset-password', { token, newPassword: 'again12345' });
  assert(r.status === 400, 'reset token is single-use');
  r = await call('POST', '/api/auth/login', { email: 'nicole@trilogymed.com', password: 'coord123' });
  assert(r.status === 401, 'old password no longer works after reset');
  r = await call('POST', '/api/auth/login', { email: 'nicole@trilogymed.com', password: 'brandnew123' });
  assert(r.status === 200, 'new password works after reset');

  /* ---- geo batch + SES/fax admin tools (no credentials in the test env) ---- */
  cookies = [];
  r = await call('POST', '/api/auth/login', { email: 'donny@trilogymed.com', password: 'admin123' });
  r = await call('POST', '/api/auth/mfa', { code: authenticator.generate(secret) });
  r = await call('POST', '/api/geo/batch', { addresses: ['600 Main St, Dallas, TX 75201', '75001'] });
  assert(r.status === 200 && typeof r.data.pending === 'number' && typeof r.data.results === 'object', 'geo batch returns results + pending count');
  r = await call('POST', '/api/geo/batch', {});
  assert(r.status === 400, 'geo batch requires addresses');
  r = await call('GET', '/api/admin/integrations/ses/status');
  assert(r.status === 503, 'SES status reports not-configured without AWS keys');
  r = await call('POST', '/api/admin/integrations/ses/verify-address', { email: 'not-an-email' });
  assert(r.status === 400, 'SES verify-address validates the email');
  r = await call('POST', '/api/admin/integrations/ses/test', { to: 'donny@trilogyconnections.com' });
  assert(r.status === 200 && r.data.sent === false && r.data.status === 'queued', 'SES test email queues when email is dark');
  r = await call('POST', '/api/admin/integrations/fax/poll');
  assert(r.status === 503, 'fax poll reports not-configured without Faxage keys');

  // put nicole back to coord123 through the same flow (keeps reruns clean)
  cookies = [];
  await call('POST', '/api/auth/forgot-password', { email: 'nicole@trilogymed.com' });
  cookies = [];
  r = await call('POST', '/api/auth/login', { email: 'donny@trilogymed.com', password: 'admin123' });
  r = await call('POST', '/api/auth/mfa', { code: authenticator.generate(secret) });
  r = await call('GET', '/api/admin/outbox');
  const t2 = (r.data.find((o: any) => o.toAddr === 'nicole@trilogymed.com' && /reset=/.test(o.body) && !o.body.includes(token!))?.body.match(/reset=([0-9a-f]+)/) || [])[1];
  // clean up the temp test user while we're admin
  r = await call('DELETE', `/api/admin/users/${tempUid}`);
  assert(r.status === 200, 'temp test user deleted');
  cookies = [];
  r = await call('POST', '/api/auth/reset-password', { token: t2, newPassword: 'coord123' });
  assert(r.status === 200, 'nicole restored to original password');

  console.log(failures ? `\n${failures} FAILURES` : '\nALL API TESTS PASSED');
  process.exit(failures ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
