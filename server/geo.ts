/** Geocoding that doesn't fall over.
 *
 *  Nominatim (OpenStreetMap) allows ONE request per second, total — the old code
 *  fired one per provider branch in a burst, so on a fresh cache most lookups got
 *  rate-limited and silently dropped. This module fixes that with:
 *    · a global throttle (1.1s spacing shared by every caller)
 *    · a fallback cascade: full address → city/state/ZIP → ZIP only, so a suite
 *      number or a typo degrades to an approximate pin instead of no pin
 *    · a persistent cache (geo_cache) including not-founds, so each address is
 *      resolved once ever, and the map is instant after first load
 *    · background batch resolution: /geo/batch returns what's cached now and a
 *      pending count; the client polls while the queue drains.
 */
import { db, nowMST } from './db.js';

const GEO_UA = { 'User-Agent': 'TrilogyPlatform/1.0 (internal provider map; trilogyconnections.com)' };
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/* ---------- global 1-per-1.1s throttle across all callers ---------- */
let chain: Promise<unknown> = Promise.resolve();
let lastAt = 0;
function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = async () => {
    const wait = Math.max(0, lastAt + 1100 - Date.now());
    if (wait) await new Promise(r => setTimeout(r, wait));
    lastAt = Date.now();
    return fn();
  };
  const p = chain.then(run, run);
  chain = p.catch(() => { /* keep the chain alive */ });
  return p;
}

async function nominatim(q: string): Promise<{ lat: number; lon: number } | null> {
  const r = await throttled(() =>
    fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(q)}`, { headers: GEO_UA }));
  if (!r.ok) throw new Error(`Nominatim ${r.status}`);
  const d: any = await r.json();
  if (!Array.isArray(d) || !d[0]) return null;
  return { lat: parseFloat(d[0].lat), lon: parseFloat(d[0].lon) };
}

export interface GeoResult { lat: number; lon: number; approx: 'street' | 'city' | 'zip'; }

/* Fallback variants for one address, most → least precise. */
function variants(addr: string): Array<{ q: string; approx: GeoResult['approx'] }> {
  const out: Array<{ q: string; approx: GeoResult['approx'] }> = [{ q: addr, approx: 'street' }];
  // strip suite/unit/floor — Nominatim chokes on them constantly
  const noUnit = addr.replace(/[,\s]+(suite|ste\.?|unit|apt\.?|bldg\.?|building|floor|fl\.?|#)\s*[\w-]+/gi, '');
  if (norm(noUnit) !== norm(addr)) out.push({ q: noUnit, approx: 'street' });
  // drop the street: everything after the first comma ("Dallas, TX 75201")
  const parts = addr.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length >= 2) out.push({ q: parts.slice(1).join(', '), approx: 'city' });
  // ZIP alone, last resort
  const zip = (addr.match(/\b(\d{5})(?:-\d{4})?\b/) || [])[1];
  if (zip) out.push({ q: zip, approx: 'zip' });
  return out;
}

const STALE_NOTFOUND_DAYS = 7;
function cached(key: string): { hit: boolean; res: GeoResult | null } {
  const row = db.prepare('SELECT lat, lon, approx, at FROM geo_cache WHERE k=?').get(key) as any;
  if (!row) return { hit: false, res: null };
  if (row.lat == null) {
    // known not-found — honor it for a week, then let it retry (addresses get fixed)
    const age = (Date.now() - new Date(row.at).getTime()) / 86400000;
    return age > STALE_NOTFOUND_DAYS ? { hit: false, res: null } : { hit: true, res: null };
  }
  return { hit: true, res: { lat: row.lat, lon: row.lon, approx: row.approx || 'street' } };
}

/** Resolve one address (throttled, cascading, cached). Never throws. */
export async function geocode(addr: string): Promise<GeoResult | null> {
  const key = norm(addr);
  if (!key) return null;
  const c = cached(key);
  if (c.hit) return c.res;
  for (const v of variants(addr)) {
    try {
      const hit = await nominatim(v.q);
      if (hit) {
        db.prepare('INSERT OR REPLACE INTO geo_cache(k,lat,lon,approx,at) VALUES(?,?,?,?,?)')
          .run(key, hit.lat, hit.lon, v.approx, nowMST());
        return { ...hit, approx: v.approx };
      }
    } catch { /* rate limit / outage — try the next variant; do NOT cache a failure */ return null; }
  }
  db.prepare('INSERT OR REPLACE INTO geo_cache(k,lat,lon,approx,at) VALUES(?,NULL,NULL,?,?)')
    .run(key, 'notfound', nowMST());
  return null;
}

/* ---------- background batch: answer from cache, queue the rest ---------- */
const inflight = new Set<string>();
export function geoBatch(addresses: string[]): { results: Record<string, GeoResult | null>; pending: number } {
  const results: Record<string, GeoResult | null> = {};
  let pending = 0;
  for (const a of [...new Set(addresses.map(x => String(x || '')).filter(Boolean))].slice(0, 200)) {
    const key = norm(a);
    const c = cached(key);
    if (c.hit) { results[a] = c.res; continue; }
    pending++;
    if (!inflight.has(key)) {
      inflight.add(key);
      geocode(a).finally(() => inflight.delete(key));
    }
  }
  return { results, pending };
}

/* ---------- driving route (OSRM), cached; straight-line marker on failure ---------- */
export async function route(flat: number, flon: number, tlat: number, tlon: number):
  Promise<{ seconds: number; meters: number } | null> {
  const key = [flat, flon, tlat, tlon].map(x => Number(x).toFixed(4)).join(',');
  const hit = db.prepare('SELECT seconds, meters FROM route_cache WHERE k=?').get(key) as any;
  if (hit) return { seconds: hit.seconds, meters: hit.meters };
  try {
    const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${flon},${flat};${tlon},${tlat}?overview=false`, { headers: GEO_UA });
    const d: any = await r.json();
    const rt = d?.routes?.[0];
    if (!rt) return null;
    db.prepare('INSERT OR REPLACE INTO route_cache(k,seconds,meters,at) VALUES(?,?,?,?)').run(key, rt.duration, rt.distance, nowMST());
    return { seconds: rt.duration, meters: rt.distance };
  } catch { return null; }
}
