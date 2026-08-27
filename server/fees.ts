/** Benchmark fee engine — Texas Medicare PFS auto-updater.
 *
 *  Computes the Medicare-allowed amount per CPT/HCPCS code per Texas ZIP using
 *  the CMS formula:  payment = CF × (workRVU·workGPCI + peRVU·peGPCI + mpRVU·mpGPCI)
 *
 *  Data sources (verified live 08/2026):
 *   · RVUs  — pfs.data.cms.gov DKAN API, "Indicators for {year}" dataset
 *   · GPCIs — same API, "Localities for {year}" dataset (TX = 8 localities, MAC 04412)
 *   · ZIP→locality crosswalk — no API; scraped from cms.gov Fee Schedules page
 *     (dated filename = change detection), with a manual-upload fallback.
 *
 *  The benchmark SOURCE is deliberately swappable (fee_meta.benchmark) — whether
 *  Medicare or a non-federal schedule (TX workers' comp) is the right reference is
 *  open anti-kickback legal research. This engine answers "what would Medicare pay,"
 *  not "what Trilogy pays." Rate history is retained: every refresh keeps its rows
 *  (current=0) so any past number can be traced to the CMS release that produced it.
 */
import { Router } from 'express';
import AdmZip from 'adm-zip';
import { db, audit, nowMST } from './db.js';
import { requireAdmin, requireFees } from './auth.js';

const PFS_API = 'https://pfs.data.cms.gov/api/1';
const CMS_FEE_PAGE = 'https://www.cms.gov/medicare/payment/fee-schedules';
const UA = { 'User-Agent': 'TrilogyPlatform/1.0 (fee schedule sync; trilogyconnections.com)' };

/* ---------- config / meta ---------- */
const getMeta = (k: string) => (db.prepare('SELECT v FROM fee_meta WHERE k=?').get(k) as any)?.v ?? null;
const setMeta = (k: string, v: string) => db.prepare('INSERT INTO fee_meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, v);

export const feeConfig = () => ({
  benchmark: getMeta('benchmark') || 'medicare_pfs',      // swappable by design — see header
  state: getMeta('state') || 'TX',
  qualifyingApm: getMeta('qualifyingApm') === '1',        // network providers are not APM participants
  workGpciFloor: getMeta('workGpciFloor') !== '0',        // statutory 1.00 floor — extended repeatedly, verify yearly
});

/* ---------- codes of interest (soft-tissue clinical scope) ---------- */
const DEFAULT_CODES: Array<[string, string, string, string, number]> = [
  ['99202', 'E/M', 'New patient office visit - straightforward', '', 0],
  ['99203', 'E/M', 'New patient office visit - low complexity', '', 0],
  ['99204', 'E/M', 'New patient office visit - moderate complexity', '', 0],
  ['99205', 'E/M', 'New patient office visit - high complexity', '', 0],
  ['99211', 'E/M', 'Established patient office visit - minimal', '', 0],
  ['99212', 'E/M', 'Established patient office visit - straightforward', '', 0],
  ['99213', 'E/M', 'Established patient office visit - low complexity', '', 0],
  ['99214', 'E/M', 'Established patient office visit - moderate complexity', '', 0],
  ['99215', 'E/M', 'Established patient office visit - high complexity', '', 0],
  ['97161', 'PT', 'PT evaluation - low complexity', '', 0],
  ['97162', 'PT', 'PT evaluation - moderate complexity', '', 0],
  ['97163', 'PT', 'PT evaluation - high complexity', '', 0],
  ['97164', 'PT', 'PT re-evaluation', '', 0],
  ['97110', 'PT', 'Therapeutic exercise', '', 0],
  ['97112', 'PT', 'Neuromuscular re-education', '', 0],
  ['97140', 'PT', 'Manual therapy', '', 0],
  ['97530', 'PT', 'Therapeutic activities', '', 0],
  ['97010', 'PT', 'Hot/cold pack application', '', 0],
  ['97012', 'PT', 'Mechanical traction', '', 0],
  ['97014', 'PT', 'Electrical stimulation (unattended)', '', 0],
  ['97032', 'PT', 'Electrical stimulation (attended)', '', 0],
  ['97035', 'PT', 'Ultrasound therapy', '', 0],
  ['97124', 'PT', 'Massage therapy', '', 0],
  ['98940', 'Chiropractic', 'Chiropractic manipulation - 1-2 regions', '', 0],
  ['98941', 'Chiropractic', 'Chiropractic manipulation - 3-4 regions', '', 0],
  ['98942', 'Chiropractic', 'Chiropractic manipulation - 5 regions', '', 0],
  ['98943', 'Chiropractic', 'Chiropractic manipulation - extraspinal', '', 0],
  ['72040', 'Imaging', 'X-ray cervical spine', '', 0],
  ['72070', 'Imaging', 'X-ray thoracic spine', '', 0],
  ['72100', 'Imaging', 'X-ray lumbosacral spine (1-2 views)', '', 0],
  ['72110', 'Imaging', 'X-ray lumbosacral spine (min. 4 views)', '', 0],
  ['73030', 'Imaging', 'X-ray shoulder', '', 0],
  ['73600', 'Imaging', 'X-ray ankle (1-2 views)', '', 0],
  ['73610', 'Imaging', 'X-ray ankle (3+ views)', '', 0],
  ['72141', 'Imaging', 'MRI cervical spine w/o contrast', '', 0],
  ['72148', 'Imaging', 'MRI lumbar spine w/o contrast', '', 0],
  ['73221', 'Imaging', 'MRI upper extremity joint w/o contrast', '', 0],
  ['73721', 'Imaging', 'MRI lower extremity joint w/o contrast', '', 0],
  ['20552', 'Injection', 'Trigger point injection - 1-2 muscles', 'REVIEW: confirm in-scope under soft-tissue-only clinical policy', 1],
  ['20553', 'Injection', 'Trigger point injection - 3+ muscles', 'REVIEW: confirm in-scope under soft-tissue-only clinical policy', 1],
];
export function seedFeeCodes() {
  if ((db.prepare('SELECT COUNT(*) c FROM fee_codes').get() as any).c > 0) return;
  const ins = db.prepare('INSERT INTO fee_codes(cpt,category,description,notes,review,active) VALUES(?,?,?,?,?,1)');
  for (const [cpt, cat, desc, notes, review] of DEFAULT_CODES) ins.run(cpt, cat, desc, notes, review);
}

/* ---------- DKAN API client ---------- */
async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { ...UA, accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url.split('?')[0]} returned ${res.status}`);
  return res.json();
}

/** Resolve the dataset UUID for e.g. "Indicators for 2026" — never hardcode year IDs. */
export async function resolveDataset(title: string): Promise<string> {
  const d = await getJson(`${PFS_API}/search?fulltext=${encodeURIComponent(title)}`);
  const results = d.results || {};
  for (const key of Object.keys(results)) {
    const item = results[key];
    if (String(item.title || '').trim().toLowerCase() === title.toLowerCase()) return item.identifier;
  }
  // fall back to a contains-match (CMS occasionally tweaks titles)
  for (const key of Object.keys(results)) {
    const item = results[key];
    if (String(item.title || '').toLowerCase().includes(title.toLowerCase())) return item.identifier;
  }
  throw new Error(`CMS dataset not found: "${title}"`);
}

async function queryDatastore(datasetId: string, conditions: Array<{ property: string; value: any; operator?: string }>, limit = 500): Promise<any[]> {
  const rows: any[] = [];
  for (let offset = 0; ; offset += limit) {
    let qs = `limit=${limit}&offset=${offset}`;
    conditions.forEach((c, i) => {
      if (Array.isArray(c.value)) c.value.forEach(v => { qs += `&conditions[${i}][value][]=${encodeURIComponent(v)}`; });
      else qs += `&conditions[${i}][value]=${encodeURIComponent(c.value)}`;
      qs += `&conditions[${i}][property]=${encodeURIComponent(c.property)}&conditions[${i}][operator]=${encodeURIComponent(c.operator || '=')}`;
    });
    const d = await getJson(`${PFS_API}/datastore/query/${datasetId}/0?${qs}`);
    const batch = d.results || [];
    rows.push(...batch);
    if (batch.length < limit) break;
    if (offset > 20000) throw new Error('Datastore pagination ran away — aborting');
  }
  return rows;
}

/** RVU rows for our codes. Tries the 'in' operator; falls back to per-code queries. */
async function fetchRvuRows(datasetId: string, codes: string[]): Promise<any[]> {
  try {
    const rows = await queryDatastore(datasetId, [{ property: 'hcpc', value: codes, operator: 'in' }]);
    if (rows.length) return rows;
  } catch { /* fall through to per-code */ }
  const rows: any[] = [];
  for (const c of codes) rows.push(...await queryDatastore(datasetId, [{ property: 'hcpc', value: c }]));
  return rows;
}

async function fetchTxGpci(datasetId: string): Promise<any[]> {
  const all = await queryDatastore(datasetId, []);
  const tx = all.filter(r => String(r.mac_description || '').trim().toUpperCase() === 'TEXAS');
  if (!tx.length) throw new Error('No Texas rows in the GPCI (Localities) dataset — layout may have changed');
  return tx;
}

/* ---------- ZIP→locality crosswalk (no API — scheduled fetch of the published file) ---------- */
async function fetchZipCrosswalk(): Promise<{ fileName: string; rows: Array<{ state: string; zip: string; carrier: string; locality: string; plus4: number }> }> {
  const pageRes = await fetch(CMS_FEE_PAGE, { headers: UA });
  if (!pageRes.ok) throw new Error(`CMS fee schedules page returned ${pageRes.status}`);
  const html = await pageRes.text();
  const m = html.match(/href="([^"]*zip[^"]*(?:carrier[^"]*locality|locality[^"]*carrier)[^"]*\.zip)"/i)
    || html.match(/href="(\/files\/zip\/zip-code[^"]*\.zip)"/i);
  if (!m) throw new Error('Could not find the Zip Code to Carrier Locality file link on the CMS page — page structure changed, needs a human look');
  const fileUrl = m[1].startsWith('http') ? m[1] : 'https://www.cms.gov' + m[1];
  const fileName = fileUrl.split('/').pop() || 'crosswalk.zip';
  const zipRes = await fetch(fileUrl, { headers: UA });
  if (!zipRes.ok) throw new Error(`Crosswalk download returned ${zipRes.status}`);
  const buf = Buffer.from(await zipRes.arrayBuffer());
  const zip = new AdmZip(buf);
  const entry = zip.getEntries()
    .filter(e => /\.(csv|txt)$/i.test(e.entryName) && !/readme|layout|record/i.test(e.entryName))
    .sort((a, b) => b.header.size - a.header.size)[0];
  if (!entry) throw new Error(`Crosswalk zip "${fileName}" has no CSV/TXT inside (entries: ${zip.getEntries().map(e => e.entryName).join(', ')}) — may be Excel-only now; use manual upload`);
  const rows = parseCrosswalk(entry.getData().toString('utf8'));
  if (!rows.length) throw new Error(`Parsed 0 Texas rows from ${entry.entryName} — column layout may have changed; use manual upload`);
  return { fileName, rows };
}

/** Tolerant parser for the ZIP5 file: header-based if headers exist, positional otherwise. */
export function parseCrosswalk(text: string): Array<{ state: string; zip: string; carrier: string; locality: string; plus4: number }> {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const split = (l: string) => l.split(',').map(c => c.replace(/^"|"$/g, '').trim());
  const first = split(lines[0]);
  const findCol = (want: RegExp) => first.findIndex(h => want.test(h.toUpperCase()));
  let iState = findCol(/^STATE/), iZip = findCol(/ZIP ?CODE|^ZIP$/), iCar = findCol(/CARRIER/), iLoc = findCol(/LOCALITY/), iP4 = findCol(/PLUS ?4|\+4/);
  let start = 1;
  if (iState < 0 || iZip < 0 || iLoc < 0) {
    // No header row — the published ZIP5 layout: STATE, ZIP, CARRIER, LOCALITY, ..., PLUS4 flag
    iState = 0; iZip = 1; iCar = 2; iLoc = 3; iP4 = -1; start = 0;
    // find a 0/1 flag column beyond locality on a sample TX row (the +4 indicator)
    const sample = lines.map(split).find(c => c[0] === 'TX' && /^\d{5}$/.test(c[1] || ''));
    if (sample) for (let i = 4; i < sample.length; i++) if (sample[i] === '0' || sample[i] === '1') { iP4 = i; break; }
  }
  const out: Array<{ state: string; zip: string; carrier: string; locality: string; plus4: number }> = [];
  for (let n = start; n < lines.length; n++) {
    const c = split(lines[n]);
    const state = (c[iState] || '').toUpperCase();
    if (state !== 'TX') continue;   // Texas-only build, per the brief — don't store 40k national rows
    const zip = (c[iZip] || '').replace(/\D/g, '').slice(0, 5);
    if (!/^\d{5}$/.test(zip)) continue;
    out.push({
      state, zip,
      carrier: c[iCar] || '',
      locality: String(c[iLoc] || '').padStart(2, '0').slice(-2),
      plus4: iP4 >= 0 && c[iP4] === '1' ? 1 : 0,
    });
  }
  return out;
}

/* ---------- the formula ---------- */
export function computeAmount(cf: number, rvu: { work: number; pe: number; mp: number }, gpci: { work: number; pe: number; mp: number }): number {
  return Math.round(cf * (rvu.work * gpci.work + rvu.pe * gpci.pe + rvu.mp * gpci.mp) * 100) / 100;
}

const num = (v: any) => { const n = parseFloat(String(v ?? '').replace(/[^0-9.eE+-]/g, '')); return Number.isFinite(n) ? n : 0; };

/** Turn raw RVU + GPCI rows into stored fee_rates for one refresh. Pure of network. */
export function computeAndStore(refreshId: number, rvuRows: any[], gpciRows: any[]): { rates: number; localities: number } {
  const cfg = feeConfig();
  // Group RVU rows by code+modifier; the dataset carries one row per conversion factor
  // (QP vs non-QP). Non-QP is always the lower CF — select by min/max, never hardcode.
  const byKey = new Map<string, any[]>();
  for (const r of rvuRows) {
    const key = `${String(r.hcpc).trim()}|${String(r.modifier ?? '').trim()}`;
    (byKey.get(key) || byKey.set(key, []).get(key)!).push(r);
  }
  const localities = gpciRows.map(g => ({
    code: String(g.locality).trim().slice(-2),
    name: String(g.loc_description || '').trim(),
    work: cfg.workGpciFloor ? Math.max(1, num(g.gpci_work)) : num(g.gpci_work),
    pe: num(g.gpci_pe),
    mp: num(g.gpci_mp),
  }));
  const ins = db.prepare(`INSERT INTO fee_rates(refreshId,cpt,modifier,locality,localityName,nonfacAmount,facAmount,convFact,
    workRvu,nonfacPeRvu,facPeRvu,mpRvu,workGpci,peGpci,mpGpci,current)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`);
  let count = 0;
  const write = db.transaction(() => {
    for (const [key, rows] of byKey) {
      const [cpt, modifier] = key.split('|');
      const pick = rows.slice().sort((a, b) => num(a.conv_fact) - num(b.conv_fact));
      const row = cfg.qualifyingApm ? pick[pick.length - 1] : pick[0];
      const cf = num(row.conv_fact);
      const work = num(row.rvu_work), mp = num(row.rvu_mp);
      const peN = num(row.full_nfac_pe ?? row.nfac_pe), peF = num(row.full_fac_pe ?? row.fac_pe);
      for (const L of localities) {
        ins.run(refreshId, cpt, modifier, L.code, L.name,
          computeAmount(cf, { work, pe: peN, mp }, L),
          computeAmount(cf, { work, pe: peF, mp }, L),
          cf, work, peN, peF, mp, L.work, L.pe, L.mp);
        count++;
      }
    }
  });
  write();
  return { rates: count, localities: localities.length };
}

export function storeZips(refreshId: number, rows: Array<{ state: string; zip: string; carrier: string; locality: string; plus4: number }>) {
  const ins = db.prepare('INSERT INTO fee_zips(refreshId,zip,state,carrier,locality,plus4,current) VALUES(?,?,?,?,?,?,1)');
  const write = db.transaction(() => {
    db.prepare('UPDATE fee_zips SET current=0 WHERE current=1').run();
    for (const r of rows) ins.run(refreshId, r.zip, r.state, r.carrier, r.locality, r.plus4);
  });
  write();
}

/* ---------- the refresh pipeline ---------- */
let refreshRunning = false;
export async function refreshFees(by: string): Promise<{ ok: boolean; detail: string }> {
  if (refreshRunning) return { ok: false, detail: 'A refresh is already running' };
  refreshRunning = true;
  const year = new Date().getFullYear();
  const info = db.prepare(`INSERT INTO fee_refreshes(at,by,source,year,status,detail) VALUES(?,?,?,?,'running','')`)
    .run(nowMST(), by, feeConfig().benchmark, year);
  const refreshId = Number(info.lastInsertRowid);
  try {
    const codes = (db.prepare('SELECT cpt FROM fee_codes WHERE active=1').all() as any[]).map(r => r.cpt);
    if (!codes.length) throw new Error('No active codes configured');
    // Resolve this year's datasets live; fall back to last year's early in a new year
    // (CMS typically publishes the new year in Nov–Dec).
    let rvuDs: string, gpciDs: string, usedYear = year;
    try {
      [rvuDs, gpciDs] = await Promise.all([resolveDataset(`Indicators for ${year}`), resolveDataset(`Localities for ${year}`)]);
    } catch {
      usedYear = year - 1;
      [rvuDs, gpciDs] = await Promise.all([resolveDataset(`Indicators for ${usedYear}`), resolveDataset(`Localities for ${usedYear}`)]);
    }
    const [rvuRows, gpciRows] = await Promise.all([fetchRvuRows(rvuDs, codes), fetchTxGpci(gpciDs)]);
    const found = new Set(rvuRows.map(r => String(r.hcpc).trim()));
    const missing = codes.filter(c => !found.has(c));
    const cw = await fetchZipCrosswalk();

    db.prepare('UPDATE fee_rates SET current=0 WHERE current=1').run();
    const { rates, localities } = computeAndStore(refreshId, rvuRows, gpciRows);
    storeZips(refreshId, cw.rows);
    const detail = `Indicators ${usedYear} · Localities ${usedYear} · ${cw.fileName}` + (missing.length ? ` · MISSING codes: ${missing.join(', ')}` : '');
    db.prepare(`UPDATE fee_refreshes SET status='ok', detail=?, rvuDataset=?, gpciDataset=?, zipFile=?, year=?, codes=?, localities=?, zips=? WHERE id=?`)
      .run(detail, rvuDs, gpciDs, cw.fileName, usedYear, found.size, localities, cw.rows.length, refreshId);
    setMeta('lastOkAt', new Date().toISOString());
    audit(null, 'fees.refresh.ok', 'fees', String(refreshId), detail);
    return { ok: true, detail };
  } catch (err: any) {
    const detail = String(err?.message || err);
    db.prepare(`UPDATE fee_refreshes SET status='failed', detail=? WHERE id=?`).run(detail, refreshId);
    audit(null, 'fees.refresh.failed', 'fees', String(refreshId), detail);
    return { ok: false, detail };
  } finally {
    refreshRunning = false;
  }
}

/** Weekly self-refresh: RVU/GPCI update annually (plus corrections), the crosswalk quarterly.
 *  Never silently stale: a failure lands in fee_refreshes and the admin alert bell. */
export function scheduleFeeRefresh() {
  if (process.env.NODE_ENV !== 'production' || process.env.TRILOGY_FEES_NO_AUTO === '1') return;
  const staleDays = 7;
  const check = () => {
    const last = getMeta('lastOkAt');
    if (last && Date.now() - new Date(last).getTime() < staleDays * 86400000) return;
    refreshFees('scheduler').catch(() => { /* failure already recorded */ });
  };
  setTimeout(check, 60 * 1000);               // shortly after boot if stale
  setInterval(check, 6 * 60 * 60 * 1000);     // then every 6h (only acts when >7d old)
}

/* ---------- queries ---------- */
export function feeStatus() {
  const cfg = feeConfig();
  const last = db.prepare(`SELECT * FROM fee_refreshes ORDER BY id DESC LIMIT 8`).all() as any[];
  const lastOk = db.prepare(`SELECT * FROM fee_refreshes WHERE status='ok' ORDER BY id DESC LIMIT 1`).get() as any;
  return {
    benchmark: cfg.benchmark, state: cfg.state,
    qualifyingApm: cfg.qualifyingApm, workGpciFloor: cfg.workGpciFloor,
    currentRates: (db.prepare('SELECT COUNT(*) c FROM fee_rates WHERE current=1').get() as any).c,
    currentZips: (db.prepare('SELECT COUNT(*) c FROM fee_zips WHERE current=1').get() as any).c,
    lastOk: lastOk || null, history: last,
    codes: db.prepare('SELECT * FROM fee_codes ORDER BY category, cpt').all(),
  };
}

export function feeLookup(zip?: string, cpt?: string) {
  const z = String(zip || '').replace(/\D/g, '').slice(0, 5);
  let loc: any = null;
  if (z) loc = db.prepare('SELECT * FROM fee_zips WHERE zip=? AND current=1 LIMIT 1').get(z);
  const where: string[] = ['r.current=1'];
  const args: any[] = [];
  if (loc) { where.push('r.locality=?'); args.push(loc.locality); }
  if (cpt) { where.push('r.cpt=?'); args.push(String(cpt).trim()); }
  const rates = db.prepare(`SELECT r.*, c.category, c.description, c.notes, c.review
    FROM fee_rates r LEFT JOIN fee_codes c ON c.cpt=r.cpt
    WHERE ${where.join(' AND ')} ORDER BY c.category, r.cpt, r.modifier, r.localityName`).all(...args) as any[];
  const lastOk = db.prepare(`SELECT at, year, detail, zipFile FROM fee_refreshes WHERE status='ok' ORDER BY id DESC LIMIT 1`).get() as any;
  return {
    zip: z || null,
    locality: loc ? { code: loc.locality, plus4: !!loc.plus4 } : null,
    zipKnown: z ? !!loc : null,
    rates, source: lastOk || null, benchmark: feeConfig().benchmark,
  };
}

/* ---------- router ---------- */
export const fees = Router();
// requireAuth is applied at mount; this router adds the fee-tool gate.
fees.use(requireFees);

fees.get('/status', (_req, res) => res.json(feeStatus()));
fees.get('/lookup', (req, res) => res.json(feeLookup(String(req.query.zip || ''), String(req.query.cpt || ''))));

fees.post('/admin/refresh', requireAdmin, (req, res) => {
  audit(req.user!, 'fees.refresh.start', 'fees', undefined, 'manual');
  // Fire async — the pipeline can take a minute; the UI polls /status.
  refreshFees(req.user!.name).catch(() => { /* recorded in fee_refreshes */ });
  res.json({ ok: true, started: true });
});

fees.post('/admin/codes', requireAdmin, (req, res) => {
  const { cpt, category, description, notes, review, active } = req.body || {};
  const code = String(cpt || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4,5}$/.test(code)) return res.status(400).json({ error: 'CPT/HCPCS code required (4–5 characters)' });
  db.prepare(`INSERT INTO fee_codes(cpt,category,description,notes,review,active) VALUES(?,?,?,?,?,?)
    ON CONFLICT(cpt) DO UPDATE SET category=excluded.category, description=excluded.description,
    notes=excluded.notes, review=excluded.review, active=excluded.active`)
    .run(code, String(category || '').trim() || 'Other', String(description || '').trim(),
      String(notes || '').trim(), review ? 1 : 0, active === 0 || active === false ? 0 : 1);
  audit(req.user!, 'fees.code.set', 'fees', code, description);
  res.json({ ok: true, codes: db.prepare('SELECT * FROM fee_codes ORDER BY category, cpt').all() });
});

fees.post('/admin/codes/:cpt/review', requireAdmin, (req, res) => {
  const code = String(req.params.cpt).trim().toUpperCase();
  const row = db.prepare('SELECT * FROM fee_codes WHERE cpt=?').get(code) as any;
  if (!row) return res.status(404).json({ error: 'Unknown code' });
  const cleared = req.body?.cleared !== false;
  db.prepare('UPDATE fee_codes SET review=?, notes=? WHERE cpt=?')
    .run(cleared ? 0 : 1, cleared ? `Scope confirmed by ${req.user!.name} ${nowMST()}` : row.notes, code);
  audit(req.user!, cleared ? 'fees.code.reviewCleared' : 'fees.code.reviewFlagged', 'fees', code);
  res.json({ ok: true });
});

/** Manual crosswalk upload — the escape hatch if CMS changes their page/file format. */
fees.post('/admin/zip-upload', requireAdmin, (req, res) => {
  const text = String(req.body?.text || '');
  if (!text.trim()) return res.status(400).json({ error: 'Paste the crosswalk CSV content' });
  const rows = parseCrosswalk(text);
  if (!rows.length) return res.status(400).json({ error: 'No Texas rows recognized — expected columns STATE, ZIP CODE, CARRIER, LOCALITY' });
  const info = db.prepare(`INSERT INTO fee_refreshes(at,by,source,year,status,detail,zips) VALUES(?,?,?,?,'ok',?,?)`)
    .run(nowMST(), req.user!.name, feeConfig().benchmark, new Date().getFullYear(), 'Manual ZIP crosswalk upload', rows.length);
  storeZips(Number(info.lastInsertRowid), rows);
  audit(req.user!, 'fees.zipUpload', 'fees', String(info.lastInsertRowid), `${rows.length} TX zips`);
  res.json({ ok: true, zips: rows.length });
});

/* Test-only fixture loader — compiled out of reach in production. */
if (process.env.NODE_ENV !== 'production') {
  fees.post('/test/fixture', requireAdmin, (req, res) => {
    const { rvu, gpci, zips } = req.body || {};
    if (!Array.isArray(rvu) || !Array.isArray(gpci)) return res.status(400).json({ error: 'rvu and gpci arrays required' });
    const info = db.prepare(`INSERT INTO fee_refreshes(at,by,source,year,status,detail) VALUES(?,?,?,?,'ok','test fixture')`)
      .run(nowMST(), 'test', 'medicare_pfs', 2026);
    const refreshId = Number(info.lastInsertRowid);
    db.prepare('UPDATE fee_rates SET current=0 WHERE current=1').run();
    const r = computeAndStore(refreshId, rvu, gpci);
    if (Array.isArray(zips) && zips.length) storeZips(refreshId, zips);
    db.prepare('UPDATE fee_refreshes SET codes=?, localities=?, zips=? WHERE id=?')
      .run(new Set(rvu.map((x: any) => x.hcpc)).size, r.localities, (zips || []).length, refreshId);
    setMeta('lastOkAt', new Date().toISOString());
    res.json({ ok: true, ...r });
  });
}
