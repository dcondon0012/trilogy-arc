/** Phase 4-6 computation engines — pure reads, no state mutations.
 *  Containment lens throughout: cheap, fast, cared-for; flag when they conflict. */
import { q, tx } from './db.js';

const J = (s: any) => { try { return JSON.parse(s || '[]'); } catch { return []; } };
export const fmt$ = (n: number) => '$' + (Math.round(n * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });

/* Visits-per-case norm by provider type (conservative course of care). */
export const VISIT_NORMS: Record<string, number> = {
  Chiropractic: 24, 'PT / Rehab': 18, 'Imaging / MRI': 2, Orthopedic: 4, default: 12,
};
export const normFor = (type?: string | null) => VISIT_NORMS[type || ''] ?? VISIT_NORMS.default;

/* ── envelope ─────────────────────────────────────────────────
   Two numbers, different jobs (Donny, 09/02): the POLICY LIMIT is the whole case's
   ceiling (context), but the case WORKS OFF the carrier's AUTHORIZATION to Trilogy.
   When an authorization is on file it is the operative cap and Trilogy's own billed
   usage draws it down (outside bills draw the policy, not our authorization).
   With no authorization yet, we fall back to the old policy-limit arithmetic. */
export async function envelope(patientId: string) {
  const p = await q.get('SELECT uwLimit, carrierAuthorized FROM patients WHERE id=?', patientId);
  const outside = (await q.get('SELECT COALESCE(SUM(amt),0) s FROM outside_bills WHERE patientId=?', patientId) as any).s;
  const usage = (await q.get('SELECT COALESCE(SUM(billed),0) s FROM bills WHERE patientId=? AND voided=0', patientId) as any).s;
  const limit = p?.uwLimit || 0;
  const auth = p?.carrierAuthorized || 0;
  const basis: 'auth' | 'limit' = auth > 0 ? 'auth' : 'limit';
  const cap = basis === 'auth' ? auth : limit;
  const remaining = basis === 'auth' ? auth - usage : limit - outside - usage;
  return { limit, auth, basis, cap, outside, usage, remaining };
}

/* ── the four-check auto-pay verdict ──────────────────────── */
export type Check = { key: string; label: string; status: 'pass' | 'fail' | 'warn'; detail: string; fix?: any };
export async function billChecks(bill: any): Promise<{ checks: Check[]; verdict: 'green' | 'exception' | 'incomplete'; exception?: string }> {
  const checks: Check[] = [];
  // ① authorization exists for this provider on this case
  const link = await q.get('SELECT * FROM prov_links WHERE patientId=? AND providerId=?', bill.patientId, bill.providerId);
  const authed = link && link.status === 'authorized' && link.authAmount > 0;
  checks.push({
    key: 'auth', label: 'Authorization', status: authed ? 'pass' : 'fail',
    detail: authed ? `${fmt$(link.authAmount)} authorized (${link.authCount}×)` : 'No authorization on file for this provider',
  });
  // ② envelope covers (BI cases without a PIP limit pass with a note)
  const env = await envelope(bill.patientId);
  const caseType = (await q.get('SELECT caseType FROM patients WHERE id=?', bill.patientId) as any)?.caseType;
  const envOk = env.cap === 0 ? caseType === 'trilogy' : env.remaining >= 0;
  checks.push({
    key: 'envelope', label: env.basis === 'auth' ? 'Carrier authorization' : 'Coverage envelope', status: envOk ? 'pass' : 'fail',
    detail: env.cap === 0
      ? (caseType === 'trilogy' ? 'BI case — no carrier authorization or PIP envelope on file yet' : 'No coverage limit on file — underwrite first')
      : envOk
        ? `${fmt$(env.remaining)} of the ${env.basis === 'auth' ? 'carrier authorization' : 'coverage limit'} remaining`
        : `${fmt$(-env.remaining)} OVER the ${env.basis === 'auth' ? 'carrier authorization' : 'coverage limit'}`,
  });
  // ③ billed ≤ contracted (carrier CPT prices)
  const rev = bill.revenue || 0;
  if (rev > 0) {
    const over = bill.billed - rev;
    checks.push({
      key: 'rate', label: 'Rate vs contract', status: over > 0.01 ? 'fail' : 'pass',
      detail: over > 0.01
        ? `Billed ${fmt$(bill.billed)} is ${Math.round(over / rev * 100)}% over contracted ${fmt$(rev)}`
        : `Billed at/under contracted ${fmt$(rev)}`,
      fix: over > 0.01 ? { reduceTo: rev } : undefined,
    });
  } else {
    checks.push({ key: 'rate', label: 'Rate vs contract', status: 'warn', detail: 'No contracted price on file for these codes — human eyes' });
  }
  // ④ agreement on file — a provider is contracted only when BOTH the BAA and the
  //    contracted-rate agreement are signed (pre-gate providers were grandfathered),
  //    otherwise a signed one-time agreement covers this case.
  const pr = await q.get('SELECT * FROM providers WHERE id=?', bill.providerId);
  const contracted = !!(pr?.baaSignedAt && pr?.rateAgreementSignedAt);
  const ota = await q.get("SELECT 1 FROM agreements WHERE patientId=? AND (providerId=? OR providerName=?) AND status='signed'",
    bill.patientId, bill.providerId, pr?.name || '');
  checks.push({
    key: 'agreement', label: 'Agreement on file', status: contracted || ota ? 'pass' : 'fail',
    detail: contracted ? 'Network contract (BAA + rate agreement signed)' : ota ? 'Signed one-time agreement' : 'No BAA + rate agreement, and no one-time agreement',
    fix: contracted || ota ? undefined : { startAgreement: true },
  });

  const docsReady = bill.hasBill && bill.hasNote && bill.rate > 0;
  const fails = checks.filter(c => c.status === 'fail');
  const verdict = fails.length ? 'exception' : docsReady ? 'green' : 'incomplete';
  return { checks, verdict, exception: fails[0]?.key };
}

/* ── duplicate detection ──────────────────────────────────── */
export async function duplicateBillIds(patientId?: string): Promise<Set<string>> {
  const rows = await q.all(`SELECT id, patientId, providerId, dos, billed FROM bills WHERE voided=0${patientId ? ' AND patientId=?' : ''} ORDER BY id`,
    ...(patientId ? [patientId] : []));
  const seen = new Map<string, string>(); const dups = new Set<string>();
  for (const b of rows) {
    const k = `${b.patientId}|${b.providerId}|${b.dos}|${b.billed}`;
    if (seen.has(k)) dups.add(b.id); else seen.set(k, b.id);
  }
  return dups;
}

/* ── provider optimizer v1 ────────────────────────────────── */
export async function costProxy(providerId: string): Promise<number | null> {
  const r = await q.get('SELECT AVG(payout) a FROM provider_rates WHERE providerId=?', providerId);
  if (r?.a) return Math.round(r.a * 100) / 100;
  const b = await q.get('SELECT AVG(ratePct) a FROM branches WHERE providerId=? AND ratePct IS NOT NULL', providerId);
  return b?.a ? Math.round(b.a * 100) / 100 : null; // % proxy when no per-CPT rates
}
export async function rankProviders(type?: string | null, patientAddress?: string | null) {
  const provs = await q.all('SELECT * FROM providers' + (type ? ' WHERE type=?' : ''), ...(type ? [type] : []));
  const proxies = (await Promise.all(provs.map(p => costProxy(p.id)))).filter((x): x is number => x != null);
  const minC = Math.min(...proxies), maxC = Math.max(...proxies);
  const city = (patientAddress || '').split(',')[1]?.trim().split(' ')[0] || '';
  const results = [];
  for (const p of provs) {
    const status = J(p.status);
    const branches = await q.all('SELECT * FROM branches WHERE providerId=?', p.id);
    const cost = await costProxy(p.id);
    const reasons: string[] = []; let score = 0;
    if (status.includes('Preferred')) { score += 30; reasons.push('Preferred network'); }
    if (p.conservative) { score += 20; reasons.push('Conservative-care philosophy'); }
    if (cost != null && maxC > minC) {
      const cs = Math.round(30 * (1 - (cost - minC) / (maxC - minC)));
      score += cs; if (cs >= 20) reasons.push('Lowest contracted cost tier');
    } else if (cost != null) score += 15;
    if (city && branches.some(b => (b.address || '').includes(city))) { score += 10; reasons.push(`Near patient (${city})`); }
    if (p.npi && p.licenseNo) { score += 10; reasons.push('Credentialing complete'); }
    results.push({
      id: p.id, name: p.name, type: p.type, score, reasons, costProxy: cost,
      preferred: status.includes('Preferred'), conservative: !!p.conservative,
      branches: branches.map(b => ({ name: b.name, address: b.address })),
    });
  }
  return results.sort((a, b) => b.score - a.score);
}

/* ── case health + auto-status ────────────────────────────── */
export async function caseHealth(p: any) {
  const today = new Date().toISOString().slice(0, 10);
  const reds: Array<{ kind: 'cost' | 'care' | 'speed' | 'legal' | 'money'; text: string }> = [];
  let score = 100;
  const overdue = (await q.get('SELECT COUNT(*) c FROM tasks WHERE patientId=? AND due IS NOT NULL AND due<?', p.id, today) as any).c;
  if (overdue) { score -= Math.min(20, overdue * 5); reds.push({ kind: 'care', text: `${overdue} overdue task${overdue > 1 ? 's' : ''}` }); }
  const env = await envelope(p.id);
  if (env.cap > 0) {
    const basisWord = env.basis === 'auth' ? 'carrier authorization' : 'coverage';
    const usedPct = (env.basis === 'auth' ? env.usage : env.outside + env.usage) / env.cap * 100;
    if (usedPct >= 100) { score -= 30; reds.push({ kind: 'cost', text: `${Math.round(usedPct)}% of ${basisWord} used — OVER` }); }
    else if (usedPct >= 85) { score -= 20; reds.push({ kind: 'cost', text: `${Math.round(usedPct)}% of ${basisWord} used` }); }
  }
  if (p.attorneyRetained) { score -= 25; reds.push({ kind: 'legal', text: 'Attorney retained' }); }
  const upcoming = (await q.get("SELECT COUNT(*) c FROM appointments WHERE patientId=? AND whenAt>=?", p.id, today) as any).c;
  if (p.stage >= 2 && p.stage < 3 && !upcoming) { score -= 15; reds.push({ kind: 'care', text: 'No upcoming appointment — drop-out risk' }); }
  if (p.stage < 2) {
    const created = p.createdAt ? new Date(p.createdAt).getTime() : Date.now();
    const days = Math.floor((Date.now() - created) / 86400000);
    if (days > 7) { score -= 15; reds.push({ kind: 'speed', text: `${days} days and not yet treating — attorney risk grows daily` }); }
  }
  const cutoff30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const aging = (await q.get("SELECT COUNT(*) c FROM bills WHERE patientId=? AND status='unpaid' AND voided=0 AND dos<?", p.id, cutoff30) as any).c;
  if (aging) { score -= 10; reds.push({ kind: 'money', text: `${aging} bill${aging > 1 ? 's' : ''} unpaid 30+ days` }); }
  // utilization vs norm (primary provider)
  const link = await q.get(`SELECT l.*, pr.type FROM prov_links l JOIN providers pr ON pr.id=l.providerId
    WHERE l.patientId=? ORDER BY l.billed DESC LIMIT 1`, p.id);
  let visits = 0, norm = 0;
  if (link) {
    visits = (await q.get('SELECT COUNT(*) c FROM bills WHERE patientId=? AND providerId=? AND voided=0', p.id, link.providerId) as any).c;
    norm = normFor(link.type);
    if (visits > norm) { score -= 10; reds.push({ kind: 'cost', text: `${visits} visits vs ~${norm} norm — plateau review` }); }
  }
  score = Math.max(0, score);
  const stageName = ['Intake', 'Underwriting', 'Treating', 'Done Treating', 'Paid Out'][p.stage] || '?';
  const flavor = reds.find(r => r.kind === 'cost') ? 'trending over plan'
    : reds.find(r => r.kind === 'speed') ? 'aging' : reds.length ? 'needs attention' : 'on plan';
  return { score, band: score >= 80 ? 'green' : score >= 55 ? 'amber' : 'red', reds, status: `${stageName} · ${flavor}`, visits, norm };
}

/* ── context strip extras: SOL, cost-vs-plan ──────────────── */
export async function stripExtras(p: any) {
  let sol: string | null = null, solDays: number | null = null;
  if (p.doi) {
    const d = new Date(p.doi + 'T00:00:00'); d.setFullYear(d.getFullYear() + 2); // OR & TX PI: 2yr
    sol = d.toISOString().slice(0, 10);
    solDays = Math.floor((d.getTime() - Date.now()) / 86400000);
  }
  const env = await envelope(p.id);
  let costVsPlan: string | null = null;
  if (env.cap > 0 && p.doi) {
    const daysIn = Math.max(1, Math.floor((Date.now() - new Date(p.doi + 'T00:00:00').getTime()) / 86400000));
    const expectedPct = Math.min(100, daysIn / 90 * 100); // 90-day conservative course
    const actualPct = (env.basis === 'auth' ? env.usage : env.outside + env.usage) / env.cap * 100;
    costVsPlan = `${Math.round(actualPct)}% used vs ~${Math.round(expectedPct)}% expected`;
  }
  return { sol, solDays, costVsPlan, envelope: env };
}

/* ── drift detection ──────────────────────────────────────── */
export async function driftReport() {
  const d60 = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
  const findings: any[] = [];
  for (const pr of await q.all('SELECT id,name FROM providers')) {
    const recent = await q.get('SELECT AVG(billed) a, COUNT(*) c FROM bills WHERE providerId=? AND voided=0 AND dos>=?', pr.id, d60);
    const prior = await q.get('SELECT AVG(billed) a, COUNT(*) c FROM bills WHERE providerId=? AND voided=0 AND dos<?', pr.id, d60);
    if (recent?.c >= 2 && prior?.c >= 2 && prior.a > 0) {
      const chg = (recent.a - prior.a) / prior.a * 100;
      if (chg > 15) findings.push({
        kind: 'charge', who: pr.name, whoId: pr.id,
        text: `Avg charge up ${Math.round(chg)}% (${fmt$(prior.a)} → ${fmt$(recent.a)}) over 60 days`,
        action: 'Pull recent bills; re-anchor to contracted rates',
      });
    }
    // utilization drift: avg visits per case, recent cases vs older
    const perCase = await q.all(`SELECT patientId, COUNT(*) c FROM bills WHERE providerId=? AND voided=0 GROUP BY patientId`, pr.id);
    if (perCase.length >= 2) {
      const avg = perCase.reduce((s, r) => s + r.c, 0) / perCase.length;
      const norm = normFor((await q.get('SELECT type FROM providers WHERE id=?', pr.id) as any)?.type);
      if (avg > norm * 0.8 && avg > 3) findings.push({
        kind: 'utilization', who: pr.name, whoId: pr.id,
        text: `Averaging ${Math.round(avg * 10) / 10} visits/case against a ~${norm} norm`,
        action: 'Utilization review; ask for treatment plans on active cases',
      });
    }
  }
  for (const ins of await q.all('SELECT id,name FROM insurers')) {
    const pend = await q.get(`SELECT COUNT(*) c, MIN(date) oldest FROM receipts r JOIN patients p ON p.id=r.patientId
      WHERE p.insurerId=? AND r.status='Pending' AND r.voided=0`, ins.id);
    if (pend?.c >= 2) findings.push({
      kind: 'pay-cycle', who: ins.name, whoId: ins.id,
      text: `${pend.c} receipts pending, oldest since ${pend.oldest}`,
      action: 'Escalate to the adjuster supervisor; document the pattern',
    });
  }
  return findings;
}

/* ── carrier tier + provider score (transparent weights) ──── */
export async function carrierTier(insurerId: string) {
  const d90 = new Date(Date.now() - 90 * 86400000).toISOString();
  const vol = (await q.get('SELECT COUNT(*) c FROM patients WHERE insurerId=? AND createdAt>=?', insurerId, d90) as any).c;
  const pend = (await q.get(`SELECT COUNT(*) c FROM receipts r JOIN patients p ON p.id=r.patientId WHERE p.insurerId=? AND r.status='Pending' AND r.voided=0`, insurerId) as any).c;
  const cleared = (await q.get(`SELECT COUNT(*) c FROM receipts r JOIN patients p ON p.id=r.patientId WHERE p.insurerId=? AND r.status='Cleared' AND r.voided=0`, insurerId) as any).c;
  const denialRate = (await q.get('SELECT denialRate FROM insurers WHERE id=?', insurerId) as any)?.denialRate || 0;
  const pts = await q.get('SELECT COUNT(*) c, SUM(attorneyRetained) a FROM patients WHERE insurerId=?', insurerId);
  const attyRate = pts.c ? (pts.a || 0) / pts.c * 100 : 0;
  const parts = [
    { k: 'Referral volume (90d)', v: vol, pts: Math.min(30, vol * 6) },
    { k: 'Pay reliability', v: `${cleared} cleared / ${pend} pending`, pts: cleared + pend ? Math.round(25 * cleared / (cleared + pend)) : 12 },
    { k: 'Denial behavior', v: `${denialRate}%`, pts: Math.max(0, 25 - denialRate * 2) },
    { k: 'Referral quality (attorney-free)', v: `${Math.round(100 - attyRate)}%`, pts: Math.round(20 * (100 - attyRate) / 100) },
  ];
  const score = parts.reduce((s, p) => s + p.pts, 0);
  return { score, tier: score >= 75 ? 'A' : score >= 50 ? 'B' : 'C', parts };
}
export async function providerScore(providerId: string) {
  const bills = await q.all('SELECT * FROM bills WHERE providerId=? AND voided=0', providerId);
  const withNotes = bills.filter(b => b.hasNote).length;
  const clean = bills.length ? withNotes / bills.length : 1;
  const perCase = await q.all('SELECT patientId, COUNT(*) c FROM bills WHERE providerId=? AND voided=0 GROUP BY patientId', providerId);
  const avgVisits = perCase.length ? perCase.reduce((s, r) => s + r.c, 0) / perCase.length : 0;
  const norm = normFor((await q.get('SELECT type FROM providers WHERE id=?', providerId) as any)?.type);
  const cost = await costProxy(providerId);
  const netAvg = (await q.get(`SELECT AVG(payout) a FROM provider_rates`) as any)?.a || null;
  const parts = [
    { k: 'Bill cleanliness (notes attached)', v: `${Math.round(clean * 100)}%`, pts: Math.round(35 * clean) },
    { k: 'Utilization discipline', v: `${Math.round(avgVisits * 10) / 10} visits/case vs ~${norm}`, pts: avgVisits <= norm ? 30 : Math.max(0, 30 - Math.round((avgVisits - norm) * 3)) },
    { k: 'Cost vs network', v: cost != null ? fmt$(cost) : '—', pts: cost != null && netAvg ? (cost <= netAvg ? 25 : 12) : 15 },
    { k: 'Credentialing current', v: '', pts: 10 },
  ];
  const p = await q.get('SELECT npi, licenseNo FROM providers WHERE id=?', providerId);
  if (!p?.npi || !p?.licenseNo) { parts[3].pts = 0; parts[3].v = 'incomplete'; } else parts[3].v = 'complete';
  const score = parts.reduce((s, x) => s + x.pts, 0);
  return { score, band: score >= 80 ? 'A' : score >= 60 ? 'B' : 'C', parts };
}

/* ── per-carrier savings report (the renewal weapon) ──────── */
export async function carrierReport(insurerId: string) {
  const pts = await q.all('SELECT * FROM patients WHERE insurerId=?', insurerId);
  let billedFace = 0, contracted = 0, paidOut = 0;
  for (const p of pts) {
    for (const b of await q.all('SELECT * FROM bills WHERE patientId=? AND voided=0', p.id)) {
      billedFace += b.billed || 0;
      contracted += b.revenue || b.billed || 0; // no contracted price on file → no claimed savings
    }
    paidOut += (await q.get(`SELECT COALESCE(SUM(amount),0) s FROM receipts WHERE patientId=? AND voided=0`, p.id) as any).s;
  }
  const savings = Math.max(0, billedFace - contracted);
  const attyCount = pts.filter(p => p.attorneyRetained).length;
  // ::float — AVG over an integer (date diff) returns NUMERIC, which node-pg hands back
  // as a string; AVG over float8 columns elsewhere is unaffected.
  const vel = await q.get(`SELECT AVG(s2.at::date - s0.at::date)::float d FROM stage_times s0
    JOIN stage_times s2 ON s2.patientId=s0.patientId AND s2.stage=2
    JOIN patients p ON p.id=s0.patientId WHERE s0.stage=0 AND p.insurerId=?`, insurerId);
  const cfg = JSON.parse((await q.get('SELECT onboarding FROM insurers WHERE id=?', insurerId) as any)?.onboarding || '{}');
  return {
    cases: pts.length, active: pts.filter(p => p.stage < 4).length,
    billedFace, contracted, savings,
    savingsPct: billedFace ? Math.round(savings / billedFace * 100) : 0,
    paidByCarrier: paidOut,
    attorneyCount: attyCount,
    attorneyRate: pts.length ? Math.round(attyCount / pts.length * 1000) / 10 : 0,
    avgDaysToTreatment: vel?.d ? Math.round(vel.d * 10) / 10 : null,
    goals: cfg.goals || null, reporting: cfg.reporting || null,
  };
}

/* ── consolidated daily outbound ──────────────────────────── */
export async function outboundDrafts() {
  const drafts: any[] = [];
  // per provider: records chases + auth confirmations
  const byProv: Record<string, any[]> = {};
  for (const b of await q.all(`SELECT b.*, pr.name "prName", p.name "ptName" FROM bills b
    JOIN providers pr ON pr.id=b.providerId JOIN patients p ON p.id=b.patientId
    WHERE b.status='unpaid' AND b.voided=0 AND (b.hasBill=0 OR b.hasNote=0)`)) {
    (byProv[b.providerId] = byProv[b.providerId] || []).push(b);
  }
  for (const [pid, items] of Object.entries(byProv)) {
    const prName = items[0].prName;
    drafts.push({
      kind: 'provider', toId: pid, toName: prName,
      subject: `Records needed on ${items.length} claim${items.length > 1 ? 's' : ''} — payment waiting`,
      lines: items.map(b => `• ${b.ptName} — DOS ${b.dos}: missing ${b.hasBill ? 'visit note' : 'bill document'} (${fmt$(b.billed)} held)`),
      patientIds: [...new Set(items.map(b => b.patientId))],
    });
  }
  // per carrier: aging receipts
  const byIns: Record<string, any[]> = {};
  const cutoff14 = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  for (const r of await q.all(`SELECT r.*, p.name "ptName", p.insurerId, i.name "insName" FROM receipts r
    JOIN patients p ON p.id=r.patientId JOIN insurers i ON i.id=p.insurerId
    WHERE r.status='Pending' AND r.voided=0 AND r.date<?`, cutoff14)) {
    (byIns[r.insurerId] = byIns[r.insurerId] || []).push(r);
  }
  for (const [iid, items] of Object.entries(byIns)) {
    drafts.push({
      kind: 'carrier', toId: iid, toName: items[0].insName,
      subject: `Payment status on ${items.length} pending item${items.length > 1 ? 's' : ''}`,
      lines: items.map(r => `• ${r.ptName} — ${fmt$(r.amount)} pending since ${r.date} (${r.ref || 'no ref'})`),
      patientIds: [...new Set(items.map(r => r.patientId))],
    });
  }
  return drafts;
}
