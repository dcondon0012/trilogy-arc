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
import { db, audit, nowMST, nextId } from './db.js';
import { requireAdmin, requireCrm } from './auth.js';

export const CRM_STAGES = ['identify', 'outreach', 'conversation', 'meeting', 'proposal', 'signed', 'live'] as const;

const target = (id: number | string) => db.prepare('SELECT * FROM crm_targets WHERE id=?').get(id) as any;
const logAct = (targetId: number, kind: string, text: string, by: string, outcome?: string) =>
  db.prepare('INSERT INTO crm_activities(targetId,at,kind,text,outcome,by) VALUES(?,?,?,?,?,?)')
    .run(targetId, new Date().toISOString(), kind, text, outcome ?? null, by);

function fullTarget(id: number | string) {
  const t = target(id);
  if (!t) return null;
  t.contacts = db.prepare('SELECT * FROM crm_contacts WHERE targetId=? ORDER BY isPrimary DESC, id').all(t.id);
  t.activities = db.prepare('SELECT * FROM crm_activities WHERE targetId=? ORDER BY id DESC LIMIT 100').all(t.id);
  return t;
}

/* Network signals the old Growth queue surfaced — names and counts only. */
function networkSignals() {
  const d30 = new Date(Date.now() - 30 * 86400000).toISOString();
  const d30d = d30.slice(0, 10);
  const coldCarriers = (db.prepare('SELECT id,name FROM insurers').all() as any[])
    .filter(c => !(db.prepare('SELECT 1 FROM patients WHERE insurerId=? AND createdAt>=?').get(c.id, d30)))
    .map(c => ({ kind: 'carrier', refId: c.id, name: c.name, why: 'Contracted carrier — no new referrals in 30 days' }));
  const coldProviders = (db.prepare('SELECT id,name,type FROM providers').all() as any[])
    .filter(p => !(db.prepare('SELECT 1 FROM bills WHERE providerId=? AND dos>=? AND voided=0').get(p.id, d30d)))
    .map(p => ({ kind: 'provider', refId: p.id, name: p.name, why: 'Network provider — no bills in 30 days, relationship cooling' }));
  const gaps = (db.prepare('SELECT providerName, COUNT(*) c, SUM(amount) amt FROM agreements GROUP BY providerName HAVING c>=2').all() as any[])
    .map(g => ({ kind: 'gap', refId: null, name: g.providerName, why: `${g.c} one-time agreements ($${Math.round(g.amt || 0).toLocaleString()}) — contract candidate` }));
  return { coldCarriers, coldProviders, gaps };
}

export const crm = Router();
crm.use(requireCrm);

/* One payload the whole workspace renders from. */
crm.get('/workspace', (_req, res) => {
  const targets = db.prepare('SELECT * FROM crm_targets ORDER BY (nextAt IS NULL), nextAt, id DESC').all() as any[];
  const today = new Date().toISOString().slice(0, 10);
  const d7 = new Date(Date.now() - 7 * 86400000).toISOString();
  const sig = networkSignals();
  const inPipeline = new Set(targets.map(t => t.name.toLowerCase()));
  const stats = {
    byStage: Object.fromEntries(CRM_STAGES.map(s => [s, targets.filter(t => t.stage === s).length])),
    dead: targets.filter(t => t.stage === 'dead').length,
    dueToday: targets.filter(t => t.nextAt && t.nextAt <= today && t.stage !== 'dead' && t.stage !== 'live').length,
    activity7d: (db.prepare('SELECT COUNT(*) c FROM crm_activities WHERE at>=?').get(d7) as any).c,
  };
  res.json({
    targets,
    stages: CRM_STAGES,
    stats,
    // network signals not already being worked
    signals: [...sig.gaps, ...sig.coldCarriers, ...sig.coldProviders].filter(s => !inPipeline.has(s.name.toLowerCase())),
    recent: db.prepare(`SELECT a.*, t.name AS targetName FROM crm_activities a JOIN crm_targets t ON t.id=a.targetId
      ORDER BY a.id DESC LIMIT 25`).all(),
  });
});

crm.get('/targets/:id', (req, res) => {
  const t = fullTarget(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  res.json(t);
});

crm.post('/targets', (req, res) => {
  const v = req.body || {};
  if (!String(v.name || '').trim()) return res.status(400).json({ error: 'Name required' });
  if (db.prepare('SELECT 1 FROM crm_targets WHERE lower(name)=lower(?)').get(v.name.trim()))
    return res.status(400).json({ error: 'Already in the pipeline' });
  const info = db.prepare(`INSERT INTO crm_targets(kind,name,specialty,market,state,address,phone,email,website,owner,source,stage,notes,nextAt,nextNote,createdAt,updatedAt,by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(v.kind === 'carrier' ? 'carrier' : 'provider', v.name.trim(), v.specialty || null, v.market || null,
      v.state || 'TX', v.address || null, v.phone || null, v.email || null, v.website || null,
      v.owner || req.user!.name, v.source || 'manual', CRM_STAGES.includes(v.stage) ? v.stage : 'identify',
      v.notes || null, v.nextAt || null, v.nextNote || null, nowMST(), nowMST(), req.user!.name);
  const id = Number(info.lastInsertRowid);
  logAct(id, 'note', 'Added to pipeline' + (v.source && v.source !== 'manual' ? ` (source: ${v.source})` : ''), req.user!.name);
  audit(req.user!, 'crm.target.create', 'crm', String(id), v.name);
  res.json({ ok: true, id });
});

crm.patch('/targets/:id', (req, res) => {
  const t = target(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const v = req.body || {};
  const fields = ['name', 'kind', 'specialty', 'market', 'state', 'address', 'phone', 'email', 'website', 'owner', 'proposedRate', 'acceptedRate', 'notes', 'nextAt', 'nextNote'];
  const sets: string[] = []; const args: any[] = [];
  for (const f of fields) if (f in v) { sets.push(`${f}=?`); args.push(v[f] === '' ? null : v[f]); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  db.prepare(`UPDATE crm_targets SET ${sets.join(',')}, updatedAt=? WHERE id=?`).run(...args, nowMST(), t.id);
  audit(req.user!, 'crm.target.update', 'crm', String(t.id), Object.keys(v).join(','));
  res.json({ ok: true });
});

crm.post('/targets/:id/stage', (req, res) => {
  const t = target(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const stage = String(req.body?.stage || '');
  if (!(CRM_STAGES as readonly string[]).includes(stage) && stage !== 'dead') return res.status(400).json({ error: 'Bad stage' });
  db.prepare('UPDATE crm_targets SET stage=?, updatedAt=? WHERE id=?').run(stage, nowMST(), t.id);
  logAct(t.id, 'stage', `${t.stage} → ${stage}${req.body?.note ? ` — ${req.body.note}` : ''}`, req.user!.name, stage);
  audit(req.user!, 'crm.target.stage', 'crm', String(t.id), `${t.name}: ${t.stage} → ${stage}`);
  res.json({ ok: true });
});

/* Log a touch (call/email/meeting/note); optionally set the next follow-up in the same motion. */
crm.post('/targets/:id/activity', (req, res) => {
  const t = target(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const kind = ['call', 'email', 'meeting', 'note'].includes(req.body?.kind) ? req.body.kind : 'note';
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Say what happened' });
  logAct(t.id, kind, text, req.user!.name, req.body?.outcome || null);
  const sets: string[] = ['updatedAt=?']; const args: any[] = [nowMST()];
  if ('nextAt' in (req.body || {})) { sets.push('nextAt=?', 'nextNote=?'); args.push(req.body.nextAt || null, req.body.nextNote || null); }
  db.prepare(`UPDATE crm_targets SET ${sets.join(',')} WHERE id=?`).run(...args, t.id);
  audit(req.user!, 'crm.activity', 'crm', String(t.id), `${kind}: ${text.slice(0, 80)}`);
  res.json({ ok: true, target: fullTarget(t.id) });
});

crm.post('/targets/:id/contacts', (req, res) => {
  const t = target(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const v = req.body || {};
  if (!String(v.name || '').trim()) return res.status(400).json({ error: 'Contact name required' });
  db.prepare('INSERT INTO crm_contacts(targetId,name,title,phone,email,notes,isPrimary) VALUES(?,?,?,?,?,?,?)')
    .run(t.id, v.name.trim(), v.title || null, v.phone || null, v.email || null, v.notes || null, v.isPrimary ? 1 : 0);
  audit(req.user!, 'crm.contact.add', 'crm', String(t.id), v.name);
  res.json({ ok: true, target: fullTarget(t.id) });
});

/* Signed target → real network record (creates the providers/insurers row). Admin only —
   this is the one CRM action that writes into operational tables. */
crm.post('/targets/:id/promote', requireAdmin, (req, res) => {
  const t = target(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (t.promotedId) return res.status(400).json({ error: `Already promoted as ${t.promotedId}` });
  let newId: string;
  if (t.kind === 'carrier') {
    newId = nextId('ins');
    db.prepare('INSERT INTO insurers(id,name,hq,phone,email,states) VALUES(?,?,?,?,?,?)')
      .run(newId, t.name, t.address || null, t.phone || null, t.email || null, JSON.stringify(t.state ? [t.state] : []));
  } else {
    newId = nextId('md');
    db.prepare('INSERT INTO providers(id,name,type,corpAddress,corpPhone,corpEmail) VALUES(?,?,?,?,?,?)')
      .run(newId, t.name, t.specialty || null, t.address || null, t.phone || null, t.email || null);
  }
  db.prepare("UPDATE crm_targets SET stage='live', promotedId=?, updatedAt=? WHERE id=?").run(newId, nowMST(), t.id);
  logAct(t.id, 'stage', `Promoted to the network as ${newId}`, req.user!.name, 'live');
  audit(req.user!, 'crm.target.promote', 'crm', String(t.id), `${t.name} → ${newId}`);
  res.json({ ok: true, id: newId });
});

/* Reporting: funnel, velocity, touch volume, per-owner. */
crm.get('/report', (_req, res) => {
  const targets = db.prepare('SELECT * FROM crm_targets').all() as any[];
  const funnel = CRM_STAGES.map(s => ({ stage: s, count: targets.filter(t => t.stage === s).length }));
  const d30 = new Date(Date.now() - 30 * 86400000).toISOString();
  const touches = db.prepare(`SELECT kind, COUNT(*) c FROM crm_activities WHERE at>=? AND kind!='stage' GROUP BY kind`).all(d30);
  // velocity: avg days from creation to reaching 'signed' (from stage activities)
  const signedAts = db.prepare(`SELECT a.targetId, MIN(a.at) at FROM crm_activities a WHERE a.kind='stage' AND a.outcome IN ('signed','live') GROUP BY a.targetId`).all() as any[];
  let velDays: number | null = null;
  if (signedAts.length) {
    const created = db.prepare(`SELECT targetId, MIN(at) at FROM crm_activities GROUP BY targetId`).all() as any[];
    const cMap = new Map(created.map((c: any) => [c.targetId, c.at]));
    const spans = signedAts
      .map(s => (new Date(s.at).getTime() - new Date(cMap.get(s.targetId) || s.at).getTime()) / 86400000)
      .filter(d => d >= 0);
    if (spans.length) velDays = Math.round(spans.reduce((a, b) => a + b, 0) / spans.length * 10) / 10;
  }
  const owners = db.prepare(`SELECT owner, COUNT(*) targets,
      SUM(CASE WHEN stage IN ('signed','live') THEN 1 ELSE 0 END) signed
    FROM crm_targets WHERE owner IS NOT NULL GROUP BY owner ORDER BY targets DESC`).all();
  res.json({ funnel, dead: targets.filter(t => t.stage === 'dead').length, touches30d: touches, avgDaysToSigned: velDays, owners });
});
