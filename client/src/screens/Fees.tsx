import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { fmt$ } from '../types';
import type { User } from '../types';
import { TrilogyLogo, FormModal } from '../ui';

/* ═══════════ Medicare fee benchmark tool ═══════════
   Texas Medicare-allowed amounts per CPT per ZIP, auto-refreshed from CMS.
   Reference benchmark only — it answers "what would Medicare pay," never
   "what Trilogy pays." Access: admins, Sales role, and per-user grants. */

interface FeeRate {
  cpt: string; modifier: string; locality: string; localityName: string;
  nonfacAmount: number; facAmount: number; convFact: number;
  category: string | null; description: string | null; notes: string | null; review: number | null;
}

export function FeesPage({ user }: { user: User }) {
  const [zip, setZip] = useState('');
  const [q, setQ] = useState('');
  const [data, setData] = useState<any>(null);
  const [status, setStatus] = useState<any>(null);
  const [showSplits, setShowSplits] = useState(false);
  const [facility, setFacility] = useState(false);
  const [err, setErr] = useState('');
  const isAdmin = user.role === 'admin';

  const load = (z: string) => {
    setErr('');
    api('GET', `/fees/lookup${z ? '?zip=' + encodeURIComponent(z) : ''}`).then(setData).catch(e => setErr(e.message));
  };
  const loadStatus = () => { if (isAdmin) api('GET', '/fees/status').then(setStatus).catch(() => {}); };
  useEffect(() => { load(''); loadStatus(); }, []);

  const onZip = (v: string) => {
    const z = v.replace(/\D/g, '').slice(0, 5);
    setZip(z);
    if (z.length === 5 || z.length === 0) load(z);
  };

  const rates: FeeRate[] = data?.rates || [];
  const shown = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return rates.filter(r =>
      (showSplits || !r.modifier) &&
      (!ql || r.cpt.toLowerCase().includes(ql) || (r.description || '').toLowerCase().includes(ql) || (r.category || '').toLowerCase().includes(ql)));
  }, [rates, q, showSplits]);

  // No ZIP → matrix view (rows = codes, columns = localities). ZIP → single-locality list.
  const zipMode = !!data?.locality;
  const localities = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of shown) m.set(r.locality, r.localityName || r.locality);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [shown]);
  const codes = useMemo(() => {
    const m = new Map<string, FeeRate[]>();
    for (const r of shown) (m.get(r.cpt + '|' + r.modifier) || m.set(r.cpt + '|' + r.modifier, []).get(r.cpt + '|' + r.modifier)!).push(r);
    return [...m.values()].sort((a, b) =>
      (a[0].category || 'zz').localeCompare(b[0].category || 'zz') || a[0].cpt.localeCompare(b[0].cpt) || a[0].modifier.localeCompare(b[0].modifier));
  }, [shown]);
  const amt = (r?: FeeRate) => r == null ? '—' : fmt$(facility ? r.facAmount : r.nonfacAmount);

  return (
    <div>
      <div className="pagehead">
        <h1 className="serif">Medicare fee benchmark — Texas</h1>
        <div className="sub">What Medicare would allow, per code per ZIP — auto-refreshed from CMS. A reference number, not a payment decision.</div>
      </div>

      {err && <div className="card" style={{ borderColor: 'var(--red)', marginBottom: 14 }}><div className="cbody">{err}</div></div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="cbody" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <div>
            <label style={{ fontSize: 11.5, color: 'var(--ink-mute)', display: 'block', marginBottom: 3 }}>Texas ZIP code</label>
            <input className="mono" style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px', width: 110, fontSize: 15 }}
              placeholder="e.g. 75201" value={zip} onChange={e => onZip(e.target.value)} />
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <label style={{ fontSize: 11.5, color: 'var(--ink-mute)', display: 'block', marginBottom: 3 }}>Filter codes</label>
            <input style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px', width: '100%', fontSize: 13.5 }}
              placeholder="⌕ CPT, description, or category…" value={q} onChange={e => setQ(e.target.value)} />
          </div>
          <label style={{ fontSize: 12.5, display: 'flex', gap: 6, alignItems: 'center', marginTop: 14 }}>
            <input type="checkbox" checked={facility} onChange={e => setFacility(e.target.checked)} /> Facility rates
          </label>
          <label style={{ fontSize: 12.5, display: 'flex', gap: 6, alignItems: 'center', marginTop: 14 }}>
            <input type="checkbox" checked={showSplits} onChange={e => setShowSplits(e.target.checked)} /> Prof/tech splits
          </label>
        </div>
        {zip.length === 5 && data && (
          <div className="cbody" style={{ borderTop: '1px solid var(--line-soft)', paddingTop: 10, fontSize: 12.5 }}>
            {data.zipKnown === false
              ? <span className="badge b-amber">ZIP {zip} not in the current Texas crosswalk — check the ZIP or refresh the data</span>
              : data.locality && (<>
                  <span className="badge b-blue">ZIP {zip} → {shown[0]?.localityName || 'locality ' + data.locality.code}</span>
                  {data.locality.plus4 && <span className="badge b-amber" style={{ marginLeft: 6 }}>This ZIP splits localities by +4 extension — verify the full ZIP+4 for borderline addresses</span>}
                </>)}
          </div>)}
      </div>

      <div className="card">
        <div className="chead">
          <h3>{zipMode ? 'Medicare-allowed amounts' : 'Medicare-allowed by locality'} · {facility ? 'facility' : 'non-facility'}</h3>
          <span style={{ fontSize: 11.5, color: 'var(--ink-mute)' }}>
            {data?.source ? `CMS ${data.source.year} data · refreshed ${data.source.at}` : 'No data loaded yet'}
          </span>
        </div>
        <div className="cbody" style={{ overflowX: 'auto' }}>
          <table><tbody>
            <tr>
              <th>Code</th><th>Description</th>
              {zipMode ? <th style={{ textAlign: 'right' }}>Allowed</th>
                : localities.map(([code, name]) => <th key={code} style={{ textAlign: 'right' }}>{name}</th>)}
            </tr>
            {codes.map(group => {
              const r0 = group[0];
              return (
                <tr key={r0.cpt + r0.modifier}>
                  <td className="mono" style={{ whiteSpace: 'nowrap' }}>
                    {r0.cpt}{r0.modifier && <span className="badge b-gray" style={{ marginLeft: 5 }}>{r0.modifier}</span>}
                  </td>
                  <td>
                    <span style={{ fontSize: 11, color: 'var(--ink-mute)' }}>{r0.category || ''}</span>{' '}
                    {r0.description || ''}
                    {!!r0.review && <span className="badge b-amber" style={{ marginLeft: 6 }} title={r0.notes || ''}>REVIEW — scope unconfirmed</span>}
                  </td>
                  {zipMode
                    ? <td className="mono" style={{ textAlign: 'right' }}>{amt(group[0])}</td>
                    : localities.map(([code]) => <td key={code} className="mono" style={{ textAlign: 'right' }}>{amt(group.find(r => r.locality === code))}</td>)}
                </tr>);
            })}
            {!codes.length && <tr><td colSpan={zipMode ? 3 : 2 + localities.length} style={{ color: 'var(--muted)' }}>
              {rates.length ? 'Nothing matches the filter.' : 'No rate data yet — an admin needs to run the first CMS refresh from the panel below.'}</td></tr>}
          </tbody></table>
          <div style={{ fontSize: 11.5, color: 'var(--ink-mute)', marginTop: 10 }}>
            Benchmark: <b>Medicare Physician Fee Schedule</b> (source is configurable — the Medicare-vs-state-schedule question is open legal research).
            Amounts are the federal Medicare-allowed reference, non-facility unless toggled. Codes marked REVIEW are pending clinical-scope confirmation.
          </div>
        </div>
      </div>

      {isAdmin && status && <FeeAdminPanel status={status} reload={() => { loadStatus(); load(zip.length === 5 ? zip : ''); }} />}
    </div>
  );
}

/* ── admin panel: refresh, history, code list, manual crosswalk ── */
function FeeAdminPanel({ status, reload }: { status: any; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [paste, setPaste] = useState('');
  const [modal, setModal] = useState<React.ReactNode>(null);

  const refresh = async () => {
    setBusy(true);
    try {
      await api('POST', '/fees/admin/refresh');
      // the pipeline runs async — poll status a few times
      for (let i = 0; i < 24; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const s = await api('GET', '/fees/status');
        if (s.history?.[0]?.status !== 'running') break;
      }
    } catch (e: any) { alert(e.message); }
    setBusy(false); reload();
  };

  const addCode = () => setModal(
    <FormModal title="Add / edit a code" onClose={() => setModal(null)} saveLabel="Save code"
      fields={[
        { key: 'cpt', label: 'CPT / HCPCS code*', ph: 'e.g. 97110' },
        { key: 'category', label: 'Category', ph: 'PT / Imaging / E-M…' },
        { key: 'description', label: 'Description', full: true },
        { key: 'notes', label: 'Notes', full: true },
      ]}
      onSave={async v => { await api('POST', '/fees/admin/codes', v); setModal(null); reload(); }} />);

  const uploadZips = async () => {
    if (!paste.trim()) return;
    try { const r = await api('POST', '/fees/admin/zip-upload', { text: paste }); alert(`Loaded ${r.zips} Texas ZIPs.`); setPaste(''); reload(); }
    catch (e: any) { alert(e.message); }
  };

  return (
    <div className="grid2" style={{ marginTop: 16 }}>
      <div className="card">
        <div className="chead"><h3>Data pipeline admin</h3>
          <button className="btn sm primary" disabled={busy} onClick={refresh}>{busy ? 'Refreshing from CMS…' : '↻ Refresh from CMS now'}</button>
        </div>
        <div className="cbody">
          <div style={{ fontSize: 12.5, marginBottom: 8 }}>
            <b>{status.currentRates}</b> current rates · <b>{status.currentZips}</b> Texas ZIPs mapped ·
            auto-refresh weekly{status.lastOk ? <> · last good refresh <b>{status.lastOk.at}</b> (CMS {status.lastOk.year})</> : <> · <span className="badge b-amber">never refreshed</span></>}
          </div>
          <table><tbody>
            <tr><th>When</th><th>By</th><th>Status</th><th>Detail</th></tr>
            {status.history.map((h: any) => (
              <tr key={h.id}>
                <td style={{ whiteSpace: 'nowrap' }}>{h.at}</td><td>{h.by}</td>
                <td><span className={'badge ' + (h.status === 'ok' ? 'b-green' : h.status === 'running' ? 'b-amber' : 'b-red')}>{h.status}</span></td>
                <td style={{ fontSize: 11.5, maxWidth: 320 }}>{h.detail}</td>
              </tr>))}
            {!status.history.length && <tr><td colSpan={4} style={{ color: 'var(--muted)' }}>No refreshes yet.</td></tr>}
          </tbody></table>
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 11.5, color: 'var(--ink-mute)', marginBottom: 4 }}>
              Manual ZIP-crosswalk fallback — paste the CMS "Zip Code to Carrier Locality" CSV here if the automatic fetch breaks:</div>
            <textarea value={paste} onChange={e => setPaste(e.target.value)} placeholder='"TX","75201","04412","11",…'
              style={{ width: '100%', height: 60, border: '1px solid var(--line)', borderRadius: 8, padding: 8, fontSize: 11.5, fontFamily: 'ui-monospace,monospace' }} />
            <button className="btn sm" style={{ marginTop: 6 }} onClick={uploadZips}>Load pasted crosswalk</button>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="chead"><h3>Codes of interest ({status.codes.filter((c: any) => c.active).length}) admin</h3>
          <button className="btn sm" onClick={addCode}>＋ Add code</button></div>
        <div className="cbody" style={{ maxHeight: 420, overflowY: 'auto' }}>
          <table><tbody>
            <tr><th>Code</th><th>Category</th><th>Description</th><th></th></tr>
            {status.codes.map((c: any) => (
              <tr key={c.cpt} style={c.active ? undefined : { opacity: 0.45 }}>
                <td className="mono" style={{ whiteSpace: 'nowrap' }}>{c.cpt}</td>
                <td style={{ fontSize: 12 }}>{c.category}</td>
                <td style={{ fontSize: 12 }}>{c.description}
                  {!!c.review && <span className="badge b-amber" style={{ marginLeft: 6 }} title={c.notes}>REVIEW</span>}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {!!c.review && <button className="btn sm" onClick={async () => {
                    if (!confirm(`Confirm ${c.cpt} is inside the soft-tissue clinical scope? This clears the REVIEW flag (audited).`)) return;
                    await api('POST', `/fees/admin/codes/${c.cpt}/review`, { cleared: true }); reload();
                  }}>✓ Confirm scope</button>}{' '}
                  <button className="btn sm" onClick={async () => {
                    await api('POST', '/fees/admin/codes', { ...c, active: c.active ? 0 : 1 }); reload();
                  }}>{c.active ? 'Retire' : 'Restore'}</button>
                </td>
              </tr>))}
          </tbody></table>
          <div style={{ fontSize: 11.5, color: 'var(--ink-mute)', marginTop: 8 }}>
            Newly added codes get rates on the next refresh. Sales-role accounts see this tool automatically; grant other users access from Admin → Users.
          </div>
        </div>
      </div>
      {modal}
    </div>
  );
}

/* ── standalone shell for Sales-role users (CRM + fee tool, no case data) ── */
export function SalesShell({ user, onLogout, crm }: { user: User; onLogout: () => void; crm: React.ReactNode }) {
  const [view, setView] = useState<'crm' | 'fees'>('crm');
  return (
    <div style={{ minHeight: '100vh', background: 'var(--paper, #F7F6F1)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 22px', background: 'var(--slate-deep, #2D3647)' }}>
        <TrilogyLogo size={20} light />
        {(['crm', 'fees'] as const).map(v => (
          <span key={v} onClick={() => setView(v)}
            style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600, padding: '4px 10px', borderRadius: 7,
              color: view === v ? '#fff' : 'rgba(255,255,255,.6)', background: view === v ? 'rgba(255,255,255,.12)' : 'transparent' }}>
            {v === 'crm' ? 'CRM' : 'Fee tool'}</span>))}
        <span style={{ flex: 1 }} />
        <span style={{ color: 'rgba(255,255,255,.75)', fontSize: 12.5 }}>{user.name} · sales</span>
        <button className="btn sm" onClick={onLogout}>Log out</button>
      </div>
      <div style={{ maxWidth: 1180, margin: '0 auto', padding: '22px 22px 60px' }}>
        {view === 'fees' ? <FeesPage user={user} /> : crm}
      </div>
    </div>
  );
}
