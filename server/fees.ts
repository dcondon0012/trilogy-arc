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
import { q, tx, audit, nowMST } from './db.js';
import { withAdvisoryLock } from './pgdb.js';
import { requireAdmin, requireFees } from './auth.js';

const PFS_API = 'https://pfs.data.cms.gov/api/1';
const CMS_FEE_PAGE = 'https://www.cms.gov/medicare/payment/fee-schedules';
const UA = { 'User-Agent': 'TrilogyPlatform/1.0 (fee schedule sync; trilogyconnections.com)' };

/* ---------- config / meta ---------- */
const getMeta = async (k: string) => (await q.get('SELECT v FROM fee_meta WHERE k=?', k) as any)?.v ?? null;
const setMeta = async (k: string, v: string) => await q.run('INSERT INTO fee_meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, v);

export const feeConfig = async () => ({
  benchmark: await getMeta('benchmark') || 'medicare_pfs',      // swappable by design — see header
  state: await getMeta('state') || 'TX',
  qualifyingApm: await getMeta('qualifyingApm') === '1',        // network providers are not APM participants
  workGpciFloor: await getMeta('workGpciFloor') !== '0',        // statutory 1.00 floor — extended repeatedly, verify yearly
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
  // 20552/20553 (trigger point injections) removed 08/27/2026 — Donny ruled them
  // outside the soft-tissue-only clinical scope. Re-add via the admin panel if that changes.
];
export async function seedFeeCodes() {
  if ((await q.get('SELECT COUNT(*) c FROM fee_codes') as any).c === 0) {
    for (const [cpt, cat, desc, notes, review] of DEFAULT_CODES) {
      await q.run('INSERT INTO fee_codes(cpt,category,description,notes,review,active) VALUES(?,?,?,?,?,1)', cpt, cat, desc, notes, review);
    }
  }
  // One-time cleanup on databases seeded before the scope decision.
  if (!await q.get("SELECT 1 FROM counters WHERE k='mig_tpi_removed'")) {
    await q.run("DELETE FROM fee_codes WHERE cpt IN ('20552','20553')");
    await q.run("UPDATE fee_rates SET current=0 WHERE cpt IN ('20552','20553')");
    await q.run("INSERT INTO counters(k,v) VALUES('mig_tpi_removed',1)");
    await audit(null, 'fees.code.removed', 'fees', '20552,20553', 'Out of clinical scope — decision 08/27/2026');
  }
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
  // The zip carries both ZIP5 (zip→locality — what we want) and ZIP9 (+4 splits).
  const candidates = zip.getEntries()
    .filter(e => /\.(csv|txt)$/i.test(e.entryName) && !/readme|layout|record/i.test(e.entryName))
    .sort((a, b) =>
      (/zip9/i.test(a.entryName) ? 1 : 0) - (/zip9/i.test(b.entryName) ? 1 : 0)
      || (/zip5/i.test(b.entryName) ? 1 : 0) - (/zip5/i.test(a.entryName) ? 1 : 0)
      || b.header.size - a.header.size);
  const entry = candidates[0];
  if (!entry) throw new Error(`Crosswalk zip "${fileName}" has no CSV/TXT inside (entries: ${zip.getEntries().map(e => e.entryName).join(', ')}) — may be Excel-only now; use manual upload`);
  const text = entry.getData().toString('utf8');
  const rows = parseCrosswalk(text);
  if (!rows.length) {
    const sample = text.split(/\r?\n/).filter(l => l.trim()).slice(0, 2).map(l => JSON.stringify(l.slice(0, 90))).join(' · ');
    throw new Error(`Parsed 0 Texas rows from ${entry.entryName} (entries: ${candidates.map(e => e.entryName).join(', ')}; sample: ${sample}) — layout changed; use manual upload`);
  }
  return { fileName: `${fileName} → ${entry.entryName}`, rows };
}

/** Tolerant parser for the ZIP5 file: delimited (header or positional) or fixed-width.
 *  Fixed-width layout per the CMS record layout: STATE(2) ZIP(5) CARRIER(5) LOCALITY(2)
 *  RURAL(1) LAB CB LOCALITY(2) RURAL2(1) PLUS4 FLAG(1) PART B IND(1) YEAR/QTR. */
export function parseCrosswalk(text: string): Array<{ state: string; zip: string; carrier: string; locality: string; plus4: number }> {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  // Fixed-width shape: no commas on the sample data line.
  if (!lines[Math.min(1, lines.length - 1)].includes(',')) {
    const out: Array<{ state: string; zip: string; carrier: string; locality: string; plus4: number }> = [];
    for (const l of lines) {
      const m = l.match(/^([A-Za-z]{2})(\d{5})(\d{5})(\d{2})(.*)$/);
      if (!m || m[1].toUpperCase() !== 'TX') continue;
      const rest = m[5];
      // plus-4 flag: the single 0/1 sitting right before the trailing year/quarter digits
      const p4 = rest.match(/([01])\d?\s*\d{5}\s*$/);
      out.push({ state: 'TX', zip: m[2], carrier: m[3], locality: m[4], plus4: p4 && p4[1] === '1' ? 1 : 0 });
    }
    if (out.length) return out;
    // fall through to delimited parsing if fixed-width found nothing
  }
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
export async function computeAndStore(refreshId: number, rvuRows: any[], gpciRows: any[]): Promise<{ rates: number; localities: number }> {
  const cfg = await feeConfig();
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
  let count = 0;
  await tx(async c => {
    for (const [key, rows] of byKey) {
      const [cpt, modifier] = key.split('|');
      const pick = rows.slice().sort((a, b) => num(a.conv_fact) - num(b.conv_fact));
      const row = cfg.qualifyingApm ? pick[pick.length - 1] : pick[0];
      const cf = num(row.conv_fact);
      const work = num(row.rvu_work), mp = num(row.rvu_mp);
      const peN = num(row.full_nfac_pe ?? row.nfac_pe), peF = num(row.full_fac_pe ?? row.fac_pe);
      for (const L of localities) {
        await c.run(`INSERT INTO fee_rates(refreshId,cpt,modifier,locality,localityName,nonfacAmount,facAmount,convFact,
          workRvu,nonfacPeRvu,facPeRvu,mpRvu,workGpci,peGpci,mpGpci,current)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
          refreshId, cpt, modifier, L.code, L.name,
          computeAmount(cf, { work, pe: peN, mp }, L),
          computeAmount(cf, { work, pe: peF, mp }, L),
          cf, work, peN, peF, mp, L.work, L.pe, L.mp);
        count++;
      }
    }
  });
  return { rates: count, localities: localities.length };
}

export async function storeZips(refreshId: number, rows: Array<{ state: string; zip: string; carrier: string; locality: string; plus4: number }>) {
  await tx(async c => {
    await c.run('UPDATE fee_zips SET current=0 WHERE current=1');
    for (const r of rows) {
      await c.run('INSERT INTO fee_zips(refreshId,zip,state,carrier,locality,plus4,current) VALUES(?,?,?,?,?,?,1)',
        refreshId, r.zip, r.state, r.carrier, r.locality, r.plus4);
    }
  });
}

/* ---------- the refresh pipeline ---------- */
let refreshRunning = false;
export async function refreshFees(by: string): Promise<{ ok: boolean; detail: string }> {
  if (refreshRunning) return { ok: false, detail: 'A refresh is already running' };
  refreshRunning = true;
  const year = new Date().getFullYear();
  const cfg = await feeConfig();
  const info = await q.run(`INSERT INTO fee_refreshes(at,by,source,year,status,detail) VALUES(?,?,?,?,'running','')`,
    nowMST(), by, cfg.benchmark, year);
  const refreshId = Number(info.lastInsertRowid);
  try {
    const codes = (await q.all('SELECT cpt FROM fee_codes WHERE active=1')).map(r => r.cpt);
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

    await q.run('UPDATE fee_rates SET current=0 WHERE current=1');
    const { rates, localities } = await computeAndStore(refreshId, rvuRows, gpciRows);
    await storeZips(refreshId, cw.rows);
    const detail = `Indicators ${usedYear} · Localities ${usedYear} · ${cw.fileName}` + (missing.length ? ` · MISSING codes: ${missing.join(', ')}` : '');
    await q.run(`UPDATE fee_refreshes SET status='ok', detail=?, rvuDataset=?, gpciDataset=?, zipFile=?, year=?, codes=?, localities=?, zips=? WHERE id=?`,
      detail, rvuDs, gpciDs, cw.fileName, usedYear, found.size, localities, cw.rows.length, refreshId);
    await setMeta('lastOkAt', new Date().toISOString());
    await audit(null, 'fees.refresh.ok', 'fees', String(refreshId), detail);
    return { ok: true, detail };
  } catch (err: any) {
    const detail = String(err?.message || err);
    await q.run(`UPDATE fee_refreshes SET status='failed', detail=? WHERE id=?`, detail, refreshId);
    await audit(null, 'fees.refresh.failed', 'fees', String(refreshId), detail);
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
  const check = async () => {
    // Stage 4: advisory lock ensures only one node runs this scheduler, even when multiple
    // ECS tasks are running. Lock key 1001 = fee refresh.
    const result = await withAdvisoryLock(1001, async () => {
      const last = await getMeta('lastOkAt');
      if (last && Date.now() - new Date(last).getTime() < staleDays * 86400000) return;
      return refreshFees('scheduler').then(r => console.log('[fees] scheduled refresh:', r.ok ? 'ok' : 'FAILED', '—', r.detail))
        .catch(e => console.log('[fees] scheduled refresh crashed:', e));
    });
    if (result === null) return; // another node has the lock
  };
  setTimeout(check, 60 * 1000);               // shortly after boot if stale
  setInterval(check, 6 * 60 * 60 * 1000);     // then every 6h (only acts when >7d old)
}

/* ---------- queries ---------- */
export async function feeStatus() {
  const cfg = await feeConfig();
  const last = await q.all(`SELECT * FROM fee_refreshes ORDER BY id DESC LIMIT 8`);
  const lastOk = await q.get(`SELECT * FROM fee_refreshes WHERE status='ok' ORDER BY id DESC LIMIT 1`);
  return {
    benchmark: cfg.benchmark, state: cfg.state,
    qualifyingApm: cfg.qualifyingApm, workGpciFloor: cfg.workGpciFloor,
    currentRates: (await q.get('SELECT COUNT(*) c FROM fee_rates WHERE current=1') as any).c,
    currentZips: (await q.get('SELECT COUNT(*) c FROM fee_zips WHERE current=1') as any).c,
    lastOk: lastOk || null, history: last,
    codes: await q.all('SELECT * FROM fee_codes ORDER BY category, cpt'),
  };
}

export async function feeLookup(zip?: string, cpt?: string) {
  const z = String(zip || '').replace(/\D/g, '').slice(0, 5);
  let loc: any = null;
  if (z) loc = await q.get('SELECT * FROM fee_zips WHERE zip=? AND current=1 LIMIT 1', z);
  const where: string[] = ['r.current=1'];
  const args: any[] = [];
  if (loc) { where.push('r.locality=?'); args.push(loc.locality); }
  if (cpt) { where.push('r.cpt=?'); args.push(String(cpt).trim()); }
  const rates = await q.all(`SELECT r.*, c.category, c.description, c.notes, c.review
    FROM fee_rates r LEFT JOIN fee_codes c ON c.cpt=r.cpt
    WHERE ${where.join(' AND ')} ORDER BY c.category, r.cpt, r.modifier, r.localityName`, ...args);
  const lastOk = await q.get(`SELECT at, year, detail, zipFile FROM fee_refreshes WHERE status='ok' ORDER BY id DESC LIMIT 1`);
  const cfg = await feeConfig();
  return {
    zip: z || null,
    locality: loc ? { code: loc.locality, plus4: !!loc.plus4 } : null,
    zipKnown: z ? !!loc : null,
    rates, source: lastOk || null, benchmark: cfg.benchmark,
  };
}

/** Current Medicare non-facility amount for one CPT at one ZIP (global modifier row).
 *  Used by the per-case margins engine. Null when the ZIP or code isn't loaded. */
export async function medicareFor(zip: string, cpt: string): Promise<number | null> {
  const z = String(zip || '').replace(/\D/g, '').slice(0, 5);
  if (!z) return null;
  const loc = await q.get('SELECT locality FROM fee_zips WHERE zip=? AND current=1 LIMIT 1', z);
  if (!loc) return null;
  const r = await q.get("SELECT nonfacAmount FROM fee_rates WHERE current=1 AND cpt=? AND modifier='' AND locality=? LIMIT 1",
    String(cpt).trim(), loc.locality);
  return r?.nonfacAmount ?? null;
}

/* ---------- router ---------- */
export const fees = Router();
// requireAuth is applied at mount; this router adds the fee-tool gate.
fees.use(requireFees);

fees.get('/status', async (_req, res) => res.json(await feeStatus()));
fees.get('/lookup', async (req, res) => res.json(await feeLookup(String(req.query.zip || ''), String(req.query.cpt || ''))));

fees.post('/admin/refresh', requireAdmin, async (req, res) => {
  await audit(req.user!, 'fees.refresh.start', 'fees', undefined, 'manual');
  // Fire async — the pipeline can take a minute; the UI polls /status.
  refreshFees(req.user!.name).catch(() => { /* recorded in fee_refreshes */ });
  res.json({ ok: true, started: true });
});

fees.post('/admin/codes', requireAdmin, async (req, res) => {
  const { cpt, category, description, notes, review, active } = req.body || {};
  const code = String(cpt || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4,5}$/.test(code)) return res.status(400).json({ error: 'CPT/HCPCS code required (4–5 characters)' });
  await q.run(`INSERT INTO fee_codes(cpt,category,description,notes,review,active) VALUES(?,?,?,?,?,?)
    ON CONFLICT(cpt) DO UPDATE SET category=excluded.category, description=excluded.description,
    notes=excluded.notes, review=excluded.review, active=excluded.active`,
    code, String(category || '').trim() || 'Other', String(description || '').trim(),
    String(notes || '').trim(), review ? 1 : 0, active === 0 || active === false ? 0 : 1);
  await audit(req.user!, 'fees.code.set', 'fees', code, description);
  res.json({ ok: true, codes: await q.all('SELECT * FROM fee_codes ORDER BY category, cpt') });
});

fees.post('/admin/codes/:cpt/review', requireAdmin, async (req, res) => {
  const code = String(req.params.cpt).trim().toUpperCase();
  const row = await q.get('SELECT * FROM fee_codes WHERE cpt=?', code);
  if (!row) return res.status(404).json({ error: 'Unknown code' });
  const cleared = req.body?.cleared !== false;
  await q.run('UPDATE fee_codes SET review=?, notes=? WHERE cpt=?',
    cleared ? 0 : 1, cleared ? `Scope confirmed by ${req.user!.name} ${nowMST()}` : row.notes, code);
  await audit(req.user!, cleared ? 'fees.code.reviewCleared' : 'fees.code.reviewFlagged', 'fees', code);
  res.json({ ok: true });
});

/** Manual crosswalk upload — the escape hatch if CMS changes their page/file format. */
fees.post('/admin/zip-upload', requireAdmin, async (req, res) => {
  const text = String(req.body?.text || '');
  if (!text.trim()) return res.status(400).json({ error: 'Paste the crosswalk CSV content' });
  const rows = parseCrosswalk(text);
  if (!rows.length) return res.status(400).json({ error: 'No Texas rows recognized — expected columns STATE, ZIP CODE, CARRIER, LOCALITY' });
  const cfg = await feeConfig();
  const info = await q.run(`INSERT INTO fee_refreshes(at,by,source,year,status,detail,zips) VALUES(?,?,?,?,'ok',?,?)`,
    nowMST(), req.user!.name, cfg.benchmark, new Date().getFullYear(), 'Manual ZIP crosswalk upload', rows.length);
  await storeZips(Number(info.lastInsertRowid), rows);
  await audit(req.user!, 'fees.zipUpload', 'fees', String(info.lastInsertRowid), `${rows.length} TX zips`);
  res.json({ ok: true, zips: rows.length });
});

/* Test-only fixture loader — compiled out of reach in production. */
if (process.env.NODE_ENV !== 'production') {
  fees.post('/test/fixture', requireAdmin, async (req, res) => {
    const { rvu, gpci, zips } = req.body || {};
    if (!Array.isArray(rvu) || !Array.isArray(gpci)) return res.status(400).json({ error: 'rvu and gpci arrays required' });
    const info = await q.run(`INSERT INTO fee_refreshes(at,by,source,year,status,detail) VALUES(?,?,?,?,'ok','test fixture')`,
      nowMST(), 'test', 'medicare_pfs', 2026);
    const refreshId = Number(info.lastInsertRowid);
    await q.run('UPDATE fee_rates SET current=0 WHERE current=1');
    const r = await computeAndStore(refreshId, rvu, gpci);
    if (Array.isArray(zips) && zips.length) await storeZips(refreshId, zips);
    await q.run('UPDATE fee_refreshes SET codes=?, localities=?, zips=? WHERE id=?',
      new Set(rvu.map((x: any) => x.hcpc)).size, r.localities, (zips || []).length, refreshId);
    await setMeta('lastOkAt', new Date().toISOString());
    res.json({ ok: true, ...r });
  });
}
