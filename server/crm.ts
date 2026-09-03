/** CRM — the network-build workspace (absorbs the old Growth screen).
 *
 *  Rebuilt from the Marrick "Network Build" tool's notion, on Arc's stack and
 *  Trilogy-branded: one pipeline for recruiting providers and carriers, from
 *  identify → outreach → conversation → meeting → proposal → signed → live,
 *  with follow-ups, contacts, an activity log, a call-blitz queue, and
 *  reporting. Enrichment (Apollo/Seamless-style) and real email sending are
 *  deliberately NOT wired — outreach is draft-and-log, same as Arc's outbound,
 *  until the phase-7 integrations land.
 *
 *  Access: admins and the Sales role automatically; per-user 'crm' grant for
 *  others. Sales users still never touch case/patient data — this router reads
 *  only CRM tables plus aggregate network signals (organization names, never PHI).
 */
import { Router } from 'express';
import { q, audit, nowMST, nextId } from './db.js';
import { requireAdmin, requireCrm } from './auth.js';
import { placesReady, searchPlaces } from './integrations.js';

export const CRM_STAGES = ['identify', 'outreach', 'conversation', 'meeting', 'proposal', 'signed', 'live'] as const;

const target = async (id: number | string) => await q.get<any>('SELECT * FROM crm_targets WHERE id=?', id);
const logAct = async (targetId: number, kind: string, text: string, by: string, outcome?: string) =>
  await q.run('INSERT INTO crm_activities(targetId,at,kind,text,outcome,by) VALUES(?,?,?,?,?,?)',
    targetId, new Date().toISOString(), kind, text, outcome ?? null, by);

async function fullTarget(id: number | string) {
  const t = await target(id);
  if (!t) return null;
  t.contacts = await q.all('SELECT * FROM crm_contacts WHERE targetId=? ORDER BY isPrimary DESC, id', t.id);
  t.activities = await q.all('SELECT * FROM crm_activities WHERE targetId=? ORDER BY id DESC LIMIT 100', t.id);
  return t;
}

/* Network signals the old Growth queue surfaced — names and counts only. */
async function networkSignals() {
  const d30 = new Date(Date.now() - 30 * 86400000).toISOString();
  const d30d = d30.slice(0, 10);
  const allCarriers = await q.all<any>('SELECT id,name FROM insurers');
  const coldCarriers = [];
  for (const c of allCarriers) {
    if (!(await q.get<any>('SELECT 1 FROM patients WHERE insurerId=? AND createdAt>=?', c.id, d30)))
      coldCarriers.push({ kind: 'carrier', refId: c.id, name: c.name, why: 'Contracted carrier — no new referrals in 30 days' });
  }
  const allProviders = await q.all<any>('SELECT id,name,type FROM providers');
  const coldProviders = [];
  for (const p of allProviders) {
    if (!(await q.get<any>('SELECT 1 FROM bills WHERE providerId=? AND dos>=? AND voided=0', p.id, d30d)))
      coldProviders.push({ kind: 'provider', refId: p.id, name: p.name, why: 'Network provider — no bills in 30 days, relationship cooling' });
  }
  const gaps = (await q.all<any>('SELECT providerName, COUNT(*) c, SUM(amount) amt FROM agreements GROUP BY providerName HAVING c>=2'))
    .map(g => ({ kind: 'gap', refId: null, name: g.providerName, why: `${g.c} one-time agreements ($${Math.round(g.amt || 0).toLocaleString()}) — contract candidate` }));
  return { coldCarriers, coldProviders, gaps };
}

export const crm = Router();
crm.use(requireCrm);

/* One payload the whole workspace renders from. */
crm.get('/workspace', async (_req, res) => {
  const targets = await q.all<any>('SELECT * FROM crm_targets ORDER BY (nextAt IS NULL), nextAt, id DESC');
  const today = new Date().toISOString().slice(0, 10);
  const d7 = new Date(Date.now() - 7 * 86400000).toISOString();
  const sig = await networkSignals();
  const inPipeline = new Set(targets.map(t => t.name.toLowerCase()));
  const actCount = await q.get<any>('SELECT COUNT(*) c FROM crm_activities WHERE at>=?', d7);
  const stats = {
    byStage: Object.fromEntries(CRM_STAGES.map(s => [s, targets.filter(t => t.stage === s).length])),
    dead: targets.filter(t => t.stage === 'dead').length,
    dueToday: targets.filter(t => t.nextAt && t.nextAt <= today && t.stage !== 'dead' && t.stage !== 'live').length,
    activity7d: actCount?.c || 0,
  };
  res.json({
    targets,
    stages: CRM_STAGES,
    stats,
    // network signals not already being worked
    signals: [...sig.gaps, ...sig.coldCarriers, ...sig.coldProviders].filter(s => !inPipeline.has(s.name.toLowerCase())),
    recent: await q.all(`SELECT a.*, t.name AS targetName FROM crm_activities a JOIN crm_targets t ON t.id=a.targetId
      ORDER BY a.id DESC LIMIT 25`),
  });
});

crm.get('/targets/:id', async (req, res) => {
  const t = await fullTarget(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  res.json(t);
});

crm.post('/targets', async (req, res) => {
  const v = req.body || {};
  if (!String(v.name || '').trim()) return res.status(400).json({ error: 'Name required' });
  if (await q.get<any>('SELECT 1 FROM crm_targets WHERE lower(name)=lower(?)', v.name.trim()))
    return res.status(400).json({ error: 'Already in the pipeline' });
  const row = await q.get<any>(`INSERT INTO crm_targets(kind,name,specialty,market,state,address,phone,email,website,owner,source,stage,notes,nextAt,nextNote,createdAt,updatedAt,by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    v.kind === 'carrier' ? 'carrier' : 'provider', v.name.trim(), v.specialty || null, v.market || null,
    v.state || 'TX', v.address || null, v.phone || null, v.email || null, v.website || null,
    v.owner || req.user!.name, v.source || 'manual', CRM_STAGES.includes(v.stage) ? v.stage : 'identify',
    v.notes || null, v.nextAt || null, v.nextNote || null, nowMST(), nowMST(), req.user!.name);
  const id = row.id;
  await logAct(id, 'note', 'Added to pipeline' + (v.source && v.source !== 'manual' ? ` (source: ${v.source})` : ''), req.user!.name);
  await audit(req.user!, 'crm.target.create', 'crm', String(id), v.name);
  res.json({ ok: true, id });
});

crm.patch('/targets/:id', async (req, res) => {
  const t = await target(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const v = req.body || {};
  const fields = ['name', 'kind', 'specialty', 'market', 'state', 'address', 'phone', 'email', 'website', 'owner', 'proposedRate', 'acceptedRate', 'notes', 'nextAt', 'nextNote'];
  const sets: string[] = []; const args: any[] = [];
  for (const f of fields) if (f in v) { sets.push(`${f}=?`); args.push(v[f] === '' ? null : v[f]); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  await q.run(`UPDATE crm_targets SET ${sets.join(',')}, updatedAt=? WHERE id=?`, ...args, nowMST(), t.id);
  await audit(req.user!, 'crm.target.update', 'crm', String(t.id), Object.keys(v).join(','));
  res.json({ ok: true });
});

crm.post('/targets/:id/stage', async (req, res) => {
  const t = await target(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const stage = String(req.body?.stage || '');
  if (!(CRM_STAGES as readonly string[]).includes(stage) && stage !== 'dead') return res.status(400).json({ error: 'Bad stage' });
  await q.run('UPDATE crm_targets SET stage=?, updatedAt=? WHERE id=?', stage, nowMST(), t.id);
  await logAct(t.id, 'stage', `${t.stage} → ${stage}${req.body?.note ? ` — ${req.body.note}` : ''}`, req.user!.name, stage);
  await audit(req.user!, 'crm.target.stage', 'crm', String(t.id), `${t.name}: ${t.stage} → ${stage}`);
  res.json({ ok: true });
});

/* Log a touch (call/email/meeting/note); optionally set the next follow-up in the same motion. */
crm.post('/targets/:id/activity', async (req, res) => {
  const t = await target(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const kind = ['call', 'email', 'meeting', 'note'].includes(req.body?.kind) ? req.body.kind : 'note';
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Say what happened' });
  await logAct(t.id, kind, text, req.user!.name, req.body?.outcome || null);
  const sets: string[] = ['updatedAt=?']; const args: any[] = [nowMST()];
  if ('nextAt' in (req.body || {})) { sets.push('nextAt=?', 'nextNote=?'); args.push(req.body.nextAt || null, req.body.nextNote || null); }
  await q.run(`UPDATE crm_targets SET ${sets.join(',')} WHERE id=?`, ...args, t.id);
  await audit(req.user!, 'crm.activity', 'crm', String(t.id), `${kind}: ${text.slice(0, 80)}`);
  res.json({ ok: true, target: await fullTarget(t.id) });
});

crm.post('/targets/:id/contacts', async (req, res) => {
  const t = await target(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const v = req.body || {};
  if (!String(v.name || '').trim()) return res.status(400).json({ error: 'Contact name required' });
  await q.run('INSERT INTO crm_contacts(targetId,name,title,phone,email,notes,isPrimary) VALUES(?,?,?,?,?,?,?)',
    t.id, v.name.trim(), v.title || null, v.phone || null, v.email || null, v.notes || null, v.isPrimary ? 1 : 0);
  await audit(req.user!, 'crm.contact.add', 'crm', String(t.id), v.name);
  res.json({ ok: true, target: await fullTarget(t.id) });
});

/* Signed target → real network record (creates the providers/insurers row). Admin only —
   this is the one CRM action that writes into operational tables. */
crm.post('/targets/:id/promote', requireAdmin, async (req, res) => {
  const t = await target(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (t.promotedId) return res.status(400).json({ error: `Already promoted as ${t.promotedId}` });
  let newId: string;
  if (t.kind === 'carrier') {
    newId = await nextId('ins');
    await q.run('INSERT INTO insurers(id,name,hq,phone,email,states) VALUES(?,?,?,?,?,?)',
      newId, t.name, t.address || null, t.phone || null, t.email || null, JSON.stringify(t.state ? [t.state] : []));
  } else {
    newId = await nextId('md');
    await q.run('INSERT INTO providers(id,name,type,corpAddress,corpPhone,corpEmail) VALUES(?,?,?,?,?,?)',
      newId, t.name, t.specialty || null, t.address || null, t.phone || null, t.email || null);
  }
  await q.run("UPDATE crm_targets SET stage='live', promotedId=?, updatedAt=? WHERE id=?", newId, nowMST(), t.id);
  await logAct(t.id, 'stage', `Promoted to the network as ${newId}`, req.user!.name, 'live');
  await audit(req.user!, 'crm.target.promote', 'crm', String(t.id), `${t.name} → ${newId}`);
  res.json({ ok: true, id: newId });
});

/* ── Prospecting: paste-in candidates, scored and triaged before the pipeline ──
   The Marrick tool searched Google Places and enriched via Apollo/Seamless; those
   integrations are parked (no API connections yet). The scored triage flow works
   today on pasted lists — the search/enrichment buttons light up when wired. */

const PHONE_RE = /(\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/;
const URL_RE = /((?:https?:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?)/i;
const DROP_RE = /hospital|urgent care|dental|veterinar|emergency room/i;

export function scoreProspect(p: { name: string; phone?: string | null; website?: string | null; rating?: number | null; reviews?: number | null }) {
  let score = 35; const flags: string[] = [];
  if (p.website) { score += 15; } else flags.push('No website');
  if (p.phone) score += 10; else { score -= 10; flags.push('No phone'); }
  if (/injur|accident|auto|whiplash/i.test(p.name)) { score += 15; flags.push('Injury focused'); }
  if (/group|associates|institute|partners|clinics|centers/i.test(p.name)) { score += 12; flags.push('Group or multi site'); }
  // From auto-search only: an established, well-reviewed practice is a better first call.
  if (p.rating != null && p.reviews != null && p.reviews >= 20) {
    if (p.rating >= 4.5) { score += 8; flags.push('Highly rated'); }
    else if (p.rating < 3.5) { score -= 8; flags.push('Weak reviews'); }
  }
  return { score: Math.max(0, Math.min(100, score)), flags };
}

/** One candidate per line: "Name | address | phone | website" (pipes, tabs, or free-form). */
export function parseProspects(text: string): Array<{ name: string; address: string | null; phone: string | null; website: string | null; dropped?: string }> {
  const out: any[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let rest = line;
    const phone = (rest.match(PHONE_RE) || [])[1] || null;
    if (phone) rest = rest.replace(phone, ' ');
    let website: string | null = null;
    for (const m of rest.match(new RegExp(URL_RE.source, 'gi')) || []) {
      if (/\.(com|org|net|health|care|clinic|us)\b/i.test(m)) { website = m; rest = rest.replace(m, ' '); break; }
    }
    const parts = rest.split(/\||\t/).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const name = parts[0] || '';
    if (!name) continue;
    const address = parts.slice(1).join(', ') || null;
    if (DROP_RE.test(name)) { out.push({ name, address, phone, website, dropped: 'out of scope (hospital/urgent care/dental)' }); continue; }
    out.push({ name, address, phone, website });
  }
  return out;
}

crm.get('/prospects', async (req, res) => {
  const market = String(req.query.market || '').trim();
  const rows = await q.all<any>(`SELECT * FROM crm_prospects ${market ? 'WHERE market=?' : ''}
    ORDER BY CASE status WHEN 'new' THEN 0 WHEN 'added' THEN 1 ELSE 2 END, score DESC`, ...(market ? [market] : []));
  const markets = (await q.all<any>('SELECT DISTINCT market FROM crm_prospects ORDER BY market')).map(r => r.market);
  res.json({ prospects: rows.map(r => ({ ...r, flags: JSON.parse(r.flags || '[]') })), markets });
});

crm.post('/prospects/import', async (req, res) => {
  const market = String(req.body?.market || '').trim();
  const specialty = String(req.body?.specialty || '').trim() || null;
  const text = String(req.body?.text || '');
  if (!market) return res.status(400).json({ error: 'Name the market (e.g. Dallas–Fort Worth)' });
  if (!text.trim()) return res.status(400).json({ error: 'Paste at least one candidate line' });
  const parsed = parseProspects(text);
  let added = 0, dropped = 0, dupes = 0;
  for (const p of parsed) {
    if (p.dropped) { dropped++; continue; }
    const dup = await q.get<any>('SELECT 1 FROM crm_prospects WHERE lower(name)=lower(?) AND market=?', p.name, market)
      || await q.get<any>('SELECT 1 FROM crm_targets WHERE lower(name)=lower(?)', p.name)
      || await q.get<any>('SELECT 1 FROM providers WHERE lower(name)=lower(?)', p.name);
    if (dup) { dupes++; continue; }
    const { score, flags } = scoreProspect(p);
    await q.run(`INSERT INTO crm_prospects(market,specialty,name,address,phone,website,score,flags,status,createdAt,by)
      VALUES(?,?,?,?,?,?,?,?,'new',?,?)`, market, specialty, p.name, p.address, p.phone, p.website, score, JSON.stringify(flags), nowMST(), req.user!.name);
    added++;
  }
  await audit(req.user!, 'crm.prospects.import', 'crm', market, `${added} added, ${dupes} duplicates, ${dropped} out-of-scope`);
  res.json({ ok: true, added, dupes, dropped });
});

/* Auto-search: Google Places finds the market's practices; the same scoring,
   scope filter, and dedupe as paste-in imports apply before anything lands. */
crm.post('/prospects/search', async (req, res) => {
  const market = String(req.body?.market || '').trim();
  const specialty = String(req.body?.specialty || '').trim();
  if (!market || !specialty) return res.status(400).json({ error: 'Market and specialty are both required — e.g. "Springfield, MO" + "Chiropractic"' });
  if (!placesReady()) return res.status(503).json({ error: 'Auto-search needs the Google Places key — an admin can add it under Admin → Integrations' });
  let hits;
  try { hits = await searchPlaces(`${specialty} in ${market}`); }
  catch (err: any) { return res.status(502).json({ error: 'Google Places said: ' + String(err?.message || err).slice(0, 160) }); }
  let added = 0, dropped = 0, dupes = 0;
  for (const h of hits) {
    if (DROP_RE.test(h.name)) { dropped++; continue; }
    const dup = await q.get<any>('SELECT 1 FROM crm_prospects WHERE lower(name)=lower(?) AND market=?', h.name, market)
      || await q.get<any>('SELECT 1 FROM crm_targets WHERE lower(name)=lower(?)', h.name)
      || await q.get<any>('SELECT 1 FROM providers WHERE lower(name)=lower(?)', h.name);
    if (dup) { dupes++; continue; }
    const { score, flags } = scoreProspect(h);
    await q.run(`INSERT INTO crm_prospects(market,specialty,name,address,phone,website,score,flags,status,createdAt,by)
      VALUES(?,?,?,?,?,?,?,?,'new',?,?)`, market, specialty, h.name, h.address, h.phone, h.website, score, JSON.stringify(flags), nowMST(), req.user!.name);
    added++;
  }
  await audit(req.user!, 'crm.prospects.search', 'crm', market, `"${specialty}" · ${hits.length} found · ${added} added, ${dupes} known, ${dropped} out-of-scope`);
  res.json({ ok: true, found: hits.length, added, dupes, dropped });
});

crm.post('/prospects/:id/add', async (req, res) => {
  const p = await q.get<any>('SELECT * FROM crm_prospects WHERE id=?', req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  if (p.status === 'added') return res.status(400).json({ error: 'Already in the pipeline' });
  const row = await q.get<any>(`INSERT INTO crm_targets(kind,name,specialty,market,state,address,phone,website,owner,source,stage,createdAt,updatedAt,by)
    VALUES('provider',?,?,?,?,?,?,?,?,'prospecting','identify',?,?,?) RETURNING id`,
    p.name, p.specialty, p.market, 'TX', p.address, p.phone, p.website, req.user!.name, nowMST(), nowMST(), req.user!.name);
  const targetId = row.id;
  await logAct(targetId, 'note', `Added from prospecting (${p.market}, score ${p.score})`, req.user!.name);
  await q.run("UPDATE crm_prospects SET status='added', targetId=? WHERE id=?", targetId, p.id);
  await audit(req.user!, 'crm.prospect.add', 'crm', String(targetId), p.name);
  res.json({ ok: true, targetId });
});

crm.post('/prospects/:id/reject', async (req, res) => {
  const p = await q.get<any>('SELECT * FROM crm_prospects WHERE id=?', req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  if (p.status === 'added') return res.status(400).json({ error: 'Already in the pipeline — mark it dead there instead' });
  const restore = p.status === 'rejected';
  await q.run('UPDATE crm_prospects SET status=? WHERE id=?', restore ? 'new' : 'rejected', p.id);
  res.json({ ok: true });
});

crm.post('/prospects/clear', async (req, res) => {
  const market = String(req.body?.market || '').trim();
  if (!market) return res.status(400).json({ error: 'Market required' });
  await q.run("DELETE FROM crm_prospects WHERE market=? AND status!='added'", market);
  await audit(req.user!, 'crm.prospects.clear', 'crm', market);
  res.json({ ok: true });
});

/* Reporting: funnel, velocity, touch volume, per-owner. */
crm.get('/report', async (_req, res) => {
  const targets = await q.all<any>('SELECT * FROM crm_targets');
  const funnel = CRM_STAGES.map(s => ({ stage: s, count: targets.filter(t => t.stage === s).length }));
  const d30 = new Date(Date.now() - 30 * 86400000).toISOString();
  const touches = await q.all(`SELECT kind, COUNT(*) c FROM crm_activities WHERE at>=? AND kind!='stage' GROUP BY kind`, d30);
  // velocity: avg days from creation to reaching 'signed' (from stage activities)
  const signedAts = await q.all<any>(`SELECT a.targetId, MIN(a.at) at FROM crm_activities a WHERE a.kind='stage' AND a.outcome IN ('signed','live') GROUP BY a.targetId`);
  let velDays: number | null = null;
  if (signedAts.length) {
    const created = await q.all<any>(`SELECT targetId, MIN(at) at FROM crm_activities GROUP BY targetId`);
    const cMap = new Map(created.map((c: any) => [c.targetId, c.at]));
    const spans = signedAts
      .map(s => (new Date(s.at).getTime() - new Date(cMap.get(s.targetId) || s.at).getTime()) / 86400000)
      .filter(d => d >= 0);
    if (spans.length) velDays = Math.round(spans.reduce((a, b) => a + b, 0) / spans.length * 10) / 10;
  }
  const owners = await q.all(`SELECT owner, COUNT(*) targets,
      SUM(CASE WHEN stage IN ('signed','live') THEN 1 ELSE 0 END) signed
    FROM crm_targets WHERE owner IS NOT NULL GROUP BY owner ORDER BY targets DESC`);
  res.json({ funnel, dead: targets.filter(t => t.stage === 'dead').length, touches30d: touches, avgDaysToSigned: velDays, owners });
});
