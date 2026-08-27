import React, { createContext, useContext, useEffect, useState } from 'react';
import { api } from './api';
import type { WidgetPref } from './types';

/* ================= brand ================= */
export function TrilogyLogo({ size = 22, light = false }: { size?: number; light?: boolean }) {
  const ink = light ? '#FFFFFF' : 'var(--slate)';
  const tri = size * 0.62;
  return (
    <span className="tlogo" style={{ fontSize: size, color: ink }}>
      tril
      <svg className="tri" width={tri} height={tri} viewBox="0 0 100 100" style={{ margin: `0 ${size * 0.06}px` }}>
        <path d="M14 18 L86 18 L50 84 Z" fill="none" stroke="#45A8EB" strokeWidth="17" strokeLinejoin="round" />
      </svg>
      gy
    </span>
  );
}

/* ================= form modal ================= */
export interface FieldSpec {
  key: string; label: string;
  type?: 'text' | 'number' | 'date' | 'email' | 'select' | 'search' | 'textarea';
  value?: string; ph?: string; full?: boolean; free?: boolean;
  options?: { v: string; l: string }[];
}
export function FormModal({ title, fields, onSave, onClose, saveLabel }: {
  title: string; fields: FieldSpec[];
  onSave: (vals: Record<string, string>) => void | Promise<void>;
  onClose: () => void; saveLabel?: string;
}) {
  const init: Record<string, string> = {};
  for (const f of fields) {
    if (f.type === 'search') {
      const sel = f.options?.find(o => o.v === f.value);
      init[f.key] = sel ? sel.l : '';
    } else init[f.key] = f.value ?? '';
  }
  const [vals, setVals] = useState(init);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setVals(s => ({ ...s, [k]: v }));

  const save = async () => {
    const out: Record<string, string> = {};
    for (const f of fields) {
      let v = vals[f.key] ?? '';
      if (f.type === 'search') {
        const q = v.trim().toLowerCase();
        const opt = f.options?.find(o => o.l.toLowerCase() === q) || (q ? f.options?.find(o => o.l.toLowerCase().includes(q)) : undefined);
        v = opt ? opt.v : (f.free ? v.trim() : '');
      }
      out[f.key] = v;
    }
    setBusy(true);
    try { await onSave(out); } catch (e: any) { alert(e.message || 'Error'); } finally { setBusy(false); }
  };

  return (
    <div className="overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <h2>{title}</h2>
        <div className="mgrid">
          {fields.map(f => (
            <div key={f.key} className={'mfield' + (f.full ? ' full' : '')}>
              <label>{f.label}</label>
              {f.type === 'select' ? (
                <select value={vals[f.key]} onChange={e => set(f.key, e.target.value)}>
                  {f.options?.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
                </select>
              ) : f.type === 'search' ? (
                <>
                  <input list={'dl_' + f.key} placeholder="🔍 Type to search…" value={vals[f.key]}
                    onChange={e => set(f.key, e.target.value)} autoComplete="off" />
                  <datalist id={'dl_' + f.key}>
                    {f.options?.map(o => <option key={o.v} value={o.l} />)}
                  </datalist>
                </>
              ) : f.type === 'textarea' ? (
                <textarea value={vals[f.key]} onChange={e => set(f.key, e.target.value)} placeholder={f.ph} />
              ) : (
                <input type={f.type || 'text'} value={vals[f.key]} placeholder={f.ph}
                  onChange={e => set(f.key, e.target.value)} />
              )}
            </div>
          ))}
        </div>
        <div className="mactions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={save}>{saveLabel || 'Save'}</button>
        </div>
      </div>
    </div>
  );
}

/* ================= widget prefs + gear ================= */
export const PrefsCtx = createContext<{ prefs: WidgetPref[]; setPrefs: (p: WidgetPref[]) => void }>({ prefs: [], setPrefs: () => {} });

const COLORS: [string, string][] = [['', '#fff'], ['blue', '#eaf1fe'], ['green', '#e8f7ee'], ['yellow', '#faf3dc'], ['purple', '#f1eafe'], ['red', '#fdecec']];

export function Widget({ wkey, title, defSize = 'm', headExtra, children }: {
  wkey: string; title: React.ReactNode; defSize?: 's' | 'm' | 'f';
  headExtra?: React.ReactNode; children: React.ReactNode;
}) {
  const { prefs, setPrefs } = useContext(PrefsCtx);
  const p = prefs.find(x => x.key === wkey);
  const [pop, setPop] = useState<{ x: number; y: number } | null>(null);
  const size = p?.size || defSize;
  const color = p?.color ? ' wc-' + p.color : '';

  const setPref = async (patch: { color?: string; size?: string }) => {
    setPop(null);
    setPrefs(await api('PUT', '/prefs/' + wkey, patch));
  };

  return (
    <div className={`card w-${size}${color}`}>
      <div className="chead">
        <h3>{title}</h3>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {headExtra}
          <span className="gear" title="Widget color & size"
            onClick={e => setPop(pop ? null : { x: Math.min(e.clientX, window.innerWidth - 210), y: e.clientY + 10 })}>⚙</span>
        </div>
      </div>
      <div className="cbody">{children}</div>
      {pop && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 79 }} onClick={() => setPop(null)} />
          <div className="gpop" style={{ left: pop.x, top: pop.y }}>
            <div className="glabel">Widget color</div>
            <div className="swatches">
              {COLORS.map(([c, bg]) => <div key={c} className="sw" style={{ background: bg }} onClick={() => setPref({ color: c })} />)}
            </div>
            <div className="glabel" style={{ marginTop: 10 }}>Widget size</div>
            <div className="sizebtns">
              <button className="btn sm" onClick={() => setPref({ size: 's' })}>S</button>
              <button className="btn sm" onClick={() => setPref({ size: 'm' })}>M</button>
              <button className="btn sm" onClick={() => setPref({ size: 'f' })}>Full</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* Contracted rates per CPT — admin-only card used on carrier & provider pages. */
export function RatesCard({ kind, id, label }: { kind: 'carrier' | 'provider'; id: string; label: string }) {
  const [rows, setRows] = useState<any[]>([]);
  const [paste, setPaste] = useState('');
  useEffect(() => { api('GET', `/rates/${kind}/${id}`).then(setRows).catch(() => {}); }, [kind, id]);
  const save = async () => {
    if (!paste.trim()) return;
    try { setRows(await api('POST', `/rates/${kind}/${id}`, { paste })); setPaste(''); }
    catch (e: any) { alert(e.message); }
  };
  return (
    <div className="card">
      <div className="chead"><h3>Contracted rates per CPT — {label} 🔒 admin</h3></div>
      <div className="cbody">
        <table><tbody>
          <tr><th>CPT</th><th>{kind === 'carrier' ? 'Carrier pays us' : 'We pay provider'}</th></tr>
          {rows.map(r => <tr key={r.id}><td>{r.cpt}</td><td>${(r.price ?? r.payout).toFixed(2)}</td></tr>)}
          {!rows.length && <tr><td colSpan={2} style={{ color: 'var(--muted)' }}>None yet — paste below. Margin locks in per procedure once both sides are on file.</td></tr>}
        </tbody></table>
        <textarea value={paste} onChange={e => setPaste(e.target.value)}
          placeholder={'Paste one per line:\n98940 120\n97110 85.50\n72148 600'}
          style={{ width: '100%', height: 90, border: '1px solid var(--line)', borderRadius: 8, padding: 8, fontSize: 12.5, fontFamily: 'ui-monospace,monospace', marginTop: 8 }} />
        <button className="btn sm primary" style={{ marginTop: 8 }} onClick={save}>Save rates</button>
      </div>
    </div>
  );
}

export const statusBadge = (s: string) =>
  ({ pending: 'b-gray', authorized: 'b-green', canceled: 'b-red', finalized: 'b-blue' } as Record<string, string>)[s] || 'b-gray';
export const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : '');
