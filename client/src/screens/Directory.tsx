import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useApp } from '../App';
import type { RosterPatient } from '../types';
import { STAGES, fmtDate } from '../types';

const caseAge = (doi: string | null) => {
  if (!doi) return null;
  const d = Math.floor((Date.now() - new Date(doi + 'T00:00:00').getTime()) / 86400000);
  return isNaN(d) ? null : d;
};

export function DirectoryScreen() {
  const { boot, go } = useApp();
  const [tab, setTab] = useState<'pt' | 'md' | 'ins'>('pt');
  const [rows, setRows] = useState<RosterPatient[]>([]);
  const [q, setQ] = useState('');
  const [stage, setStage] = useState('all');
  const [caseType, setCaseType] = useState('all');
  const [coord, setCoord] = useState('all');

  useEffect(() => { api('GET', '/roster/patients').then(setRows); }, []);

  const pts = useMemo(() => rows
    .filter(p => (p.name + p.id).toLowerCase().includes(q.toLowerCase()))
    .filter(p => stage === 'all' || String(p.stage) === stage)
    .filter(p => caseType === 'all' || p.caseType === caseType)
    .filter(p => coord === 'all' || p.coordinator === coord)
    .sort((a, b) => (caseAge(b.doi) ?? -1) - (caseAge(a.doi) ?? -1)),
    [rows, q, stage, caseType, coord]);

  const sel = { border: '1px solid var(--line)', borderRadius: 8, padding: '7px 9px', fontSize: 12.5 } as const;

  return (
    <div>
      <span className="backlink" onClick={() => go({ screen: 'home' })}>← Back</span>
      <div className="pt-head">
        <div className="pt-id" style={{ background: 'var(--accent)' }}>📇</div>
        <div className="pt-title" style={{ flex: 1 }}><h2>Directory</h2>
          <div className="pt-meta"><span className="badge b-blue">Every patient, provider, and carrier — filter and click through</span></div></div>
      </div>

      <div className="tabs">
        {([['pt', `Patients (${rows.length})`], ['md', `Providers (${boot.providers.length})`], ['ins', `Insurance (${boot.insurers.length})`]] as const).map(([k, l]) => (
          <div key={k} className={'tab' + (tab === k ? ' active' : '')} onClick={() => setTab(k)}>{l}</div>))}
      </div>

      {tab === 'pt' && (
        <div className="card">
          <div className="chead" style={{ gap: 8 }}>
            <input placeholder="🔍 Name or ID…" value={q} onChange={e => setQ(e.target.value)} style={{ ...sel, width: 200 }} />
            <select value={stage} onChange={e => setStage(e.target.value)} style={sel}>
              <option value="all">All stages</option>
              {STAGES.map((s, i) => <option key={s} value={String(i)}>{s}</option>)}
            </select>
            <select value={caseType} onChange={e => setCaseType(e.target.value)} style={sel}>
              <option value="all">Trilopay + Trilogy</option>
              <option value="trilopay">Trilopay (PIP)</option>
              <option value="trilogy">Trilogy (BI)</option>
            </select>
            <select value={coord} onChange={e => setCoord(e.target.value)} style={sel}>
              <option value="all">All coordinators</option>
              {boot.users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{pts.length} shown · oldest cases first</span>
          </div>
          <div className="cbody">
            <table><tbody>
              <tr><th>Patient</th><th>Type</th><th>Stage</th><th>Coordinator</th><th>DOI</th><th>Case age</th><th>Open tasks</th><th>Unpaid bills</th><th>Carrier</th></tr>
              {pts.map(p => {
                const age = caseAge(p.doi);
                return (
                  <tr key={p.id}>
                    <td><span className="link" onClick={() => go({ screen: 'patient', id: p.id })}>{p.name}</span><br /><span className="idchip">{p.id}</span></td>
                    <td><span className={'badge ' + (p.caseType === 'trilogy' ? 'b-yellow' : 'b-blue')}>{p.caseType === 'trilogy' ? 'Trilogy' : 'Trilopay'}</span></td>
                    <td><span className={'badge ' + (p.stage >= 4 ? 'b-green' : p.stage === 0 ? 'b-gray' : 'b-blue')}>{STAGES[p.stage]}</span></td>
                    <td>{boot.users.find(u => u.id === p.coordinator)?.name || '—'}</td>
                    <td>{fmtDate(p.doi)}</td>
                    <td>{age === null ? '—' : <b style={age > 90 && p.stage < 4 ? { color: 'var(--red)' } : undefined}>{age}d</b>}</td>
                    <td>{p.openTasks || '—'}</td>
                    <td>{p.unpaidBills ? <b style={{ color: 'var(--amber)' }}>{p.unpaidBills}</b> : '—'}</td>
                    <td>{p.insurerId ? <span className="link" onClick={() => go({ screen: 'insurance', id: p.insurerId! })}>{boot.insurers.find(i => i.id === p.insurerId)?.name}</span> : '—'}</td>
                  </tr>);
              })}
              {!pts.length && <tr><td colSpan={9} style={{ color: 'var(--muted)' }}>No patients match.</td></tr>}
            </tbody></table>
          </div>
        </div>
      )}

      {tab === 'md' && (
        <div className="card"><div className="cbody">
          <table><tbody>
            <tr><th>Provider</th><th>Type</th><th>Status</th><th>Branches</th><th>Corporate</th></tr>
            {boot.providers.map(pr => (
              <tr key={pr.id}>
                <td><span className="link" onClick={() => go({ screen: 'provider', id: pr.id })}>{pr.name}</span><br /><span className="idchip">{pr.id}</span></td>
                <td>{pr.type}</td>
                <td>{pr.status.map(s => <span key={s} className={'badge ' + (s === 'Preferred' ? 'b-green' : s === 'Under contract' ? 'b-blue' : 'b-amber')} style={{ marginRight: 4 }}>{s === 'Preferred' ? '★ ' : ''}{s}</span>)}</td>
                <td>{pr.branches.map(b => b.name).join(' · ') || '—'}</td>
                <td>{pr.corpPhone || '—'}<br /><span style={{ color: 'var(--muted)', fontSize: 12 }}>{pr.corpEmail || ''}</span></td>
              </tr>))}
          </tbody></table>
        </div></div>
      )}

      {tab === 'ins' && (
        <div className="card"><div className="cbody">
          <table><tbody>
            <tr><th>Company</th><th>States</th><th>Adjusters</th><th>Patients</th><th>Contact</th></tr>
            {boot.insurers.map(c => (
              <tr key={c.id}>
                <td><span className="link" onClick={() => go({ screen: 'insurance', id: c.id })}>{c.name}</span><br /><span className="idchip">{c.id}</span></td>
                <td>{c.states.join(', ') || '—'}</td>
                <td>{c.adjusters.length}</td>
                <td>{rows.filter(p => p.insurerId === c.id).length} total · {rows.filter(p => p.insurerId === c.id && p.stage < 4).length} active</td>
                <td>{c.phone || '—'}<br /><span style={{ color: 'var(--muted)', fontSize: 12 }}>{c.email || ''}</span></td>
              </tr>))}
          </tbody></table>
        </div></div>
      )}
    </div>
  );
}
