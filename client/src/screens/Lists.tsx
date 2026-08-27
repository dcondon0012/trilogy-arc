import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useApp } from '../App';
import { FormModal, FieldSpec } from '../ui';
import { CarrierWizard, ProviderWizard } from './Wizards';
import type { RosterPatient } from '../types';
import { STAGES, fmtDate, fmt$ } from '../types';

const caseAge = (doi: string | null) => {
  if (!doi) return null;
  const d = Math.floor((Date.now() - new Date(doi + 'T00:00:00').getTime()) / 86400000);
  return isNaN(d) ? null : d;
};
const sel = { border: '1px solid var(--line)', borderRadius: 9, padding: '7px 10px', fontSize: 12.5, background: 'var(--card)', fontFamily: 'var(--sans)' } as const;

/* ═══════════ CASES ═══════════ */
export function CasesPage() {
  const { boot, go, refresh } = useApp();
  const [rows, setRows] = useState<RosterPatient[]>([]);
  const [q, setQ] = useState('');
  const [stage, setStage] = useState('all');
  const [caseType, setCaseType] = useState('all');
  const [coord, setCoord] = useState('all');
  const [modal, setModal] = useState<React.ReactNode>(null);
  const [health, setHealth] = useState<Record<string, any>>({});
  useEffect(() => { api('GET', '/roster/patients').then(setRows); api('GET', '/health-summaries').then(setHealth).catch(() => {}); }, []);

  const pts = useMemo(() => rows
    .filter(p => (p.name + p.id).toLowerCase().includes(q.toLowerCase()))
    .filter(p => stage === 'all' || String(p.stage) === stage)
    .filter(p => caseType === 'all' || p.caseType === caseType)
    .filter(p => coord === 'all' || p.coordinator === coord)
    .sort((a, b) => (caseAge(b.doi) ?? -1) - (caseAge(a.doi) ?? -1)),
    [rows, q, stage, caseType, coord]);

  const newPatient = () => setModal(
    <FormModal title="New patient" onClose={() => setModal(null)} saveLabel="Create case"
      fields={([
        { key: 'name', label: 'Full name*' },
        { key: 'caseType', label: 'Case type*', type: 'select', options: [{ v: 'trilopay', l: 'Trilopay — PIP (1st party)' }, { v: 'trilogy', l: 'Trilogy — BI (3rd party)' }] },
        { key: 'phone', label: 'Phone' }, { key: 'email', label: 'Email', type: 'email' },
        { key: 'address', label: 'Address', full: true },
        { key: 'dob', label: 'Date of birth', type: 'date' }, { key: 'doi', label: 'Date of injury', type: 'date' },
        { key: 'state', label: 'State of accident (auto-populates minimum coverage)', ph: 'Oregon' },
        { key: 'insurerId', label: 'Carrier (search)', type: 'search', options: boot.insurers.map(i => ({ v: i.id, l: `${i.name} (${i.id})` })) },
        { key: 'claimNumber', label: 'Claim #' }, { key: 'policyNumber', label: 'Policy #' },
        { key: 'adjusterName', label: 'Adjuster (name)' },
        { key: 'agentName', label: 'Insurance agent (name)' },
        { key: 'agentContact', label: 'Agent phone/email' },
        { key: 'referralSource', label: 'Referral source', type: 'select', options: [{ v: '', l: '—' }, { v: 'carrier', l: 'Carrier / adjuster' }, { v: 'agent', l: 'Insurance agent' }, { v: 'provider', l: 'Provider' }, { v: 'other', l: 'Other' }] },
        { key: 'coordinator', label: 'Coordinator (search)', type: 'search', value: boot.user.id, options: boot.users.filter(u => u.role === 'admin' || u.role === 'coordinator').map(u => ({ v: u.id, l: u.name })) },
        { key: 'accident', label: 'Accident description', type: 'textarea', full: true },
      ] as FieldSpec[])}
      onSave={async v => {
        if (!v.name.trim()) { alert('Name required'); return; }
        let p;
        try { p = await api('POST', '/patients', v); }
        catch (e: any) {
          if (e.status === 409 && e.data?.duplicates) {
            const list = e.data.duplicates.map((d: any) => `• ${d.name} (${d.id})`).join('\n');
            if (!confirm(`⚠ Possible duplicate:\n\n${list}\n\nCreate anyway?`)) return;
            p = await api('POST', '/patients', { ...v, force: true });
          } else throw e;
        }
        await refresh(); setModal(null); go({ screen: 'patient', id: p.id });
      }} />);

  return (
    <div>
      <div className="pagehead" style={{ display: 'flex', alignItems: 'flex-end', gap: 14 }}>
        <div><h1 className="serif">Cases</h1><div className="sub">Every case, oldest first — nothing ages silently</div></div>
        <span className="spacer" />
        <button className="btn primary" onClick={newPatient}>＋ New patient</button>
      </div>
      <div className="card">
        <div className="chead" style={{ gap: 8 }}>
          <input placeholder="🔍 Name or ID…" value={q} onChange={e => setQ(e.target.value)} style={{ ...sel, width: 200 }} />
          <select value={stage} onChange={e => setStage(e.target.value)} style={sel}>
            <option value="all">All stages</option>
            {STAGES.map((s, i) => <option key={s} value={String(i)}>{s}</option>)}
          </select>
          <select value={caseType} onChange={e => setCaseType(e.target.value)} style={sel}>
            <option value="all">Both lines</option><option value="trilopay">Trilopay (PIP)</option><option value="trilogy">Trilogy (BI)</option>
          </select>
          <select value={coord} onChange={e => setCoord(e.target.value)} style={sel}>
            <option value="all">All coordinators</option>
            {boot.users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <span style={{ fontSize: 12, color: 'var(--ink-mute)' }}>{pts.length} shown</span>
        </div>
        <div className="cbody">
          <table><tbody>
            <tr><th>Patient</th><th>Line</th><th>Health</th><th>Stage</th><th>Coordinator</th><th>DOI</th><th>Age</th><th>Open tasks</th><th>Unpaid</th><th>Carrier</th></tr>
            {pts.map(p => {
              const age = caseAge(p.doi);
              return (
                <tr key={p.id}>
                  <td><span className="link" onClick={() => go({ screen: 'patient', id: p.id })}>{p.name}</span><br /><span className="idchip">{p.id}</span></td>
                  <td><span className={'badge ' + (p.caseType === 'trilogy' ? 'b-yellow' : 'b-blue')}>{p.caseType === 'trilogy' ? 'BI' : 'PIP'}</span></td>
                  <td>{health[p.id]
                    ? <span className={'badge ' + (health[p.id].band === 'green' ? 'b-green' : health[p.id].band === 'amber' ? 'b-amber' : 'b-red')}
                        title={health[p.id].status}>{health[p.id].score}</span>
                    : '—'}</td>
                  <td><span className={'badge ' + (p.stage >= 4 ? 'b-green' : p.stage === 0 ? 'b-gray' : 'b-blue')}>{STAGES[p.stage]}</span></td>
                  <td>{boot.users.find(u => u.id === p.coordinator)?.name || '—'}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{fmtDate(p.doi)}</td>
                  <td>{age === null ? '—' : <b className="mono" style={age > 90 && p.stage < 4 ? { color: 'var(--red)' } : undefined}>{age}d</b>}</td>
                  <td>{p.openTasks || '—'}</td>
                  <td>{p.unpaidBills ? <b style={{ color: 'var(--amber)' }}>{p.unpaidBills}</b> : '—'}</td>
                  <td>{p.insurerId ? <span className="link" onClick={() => go({ screen: 'insurance', id: p.insurerId! })}>{boot.insurers.find(i => i.id === p.insurerId)?.name}</span> : '—'}</td>
                </tr>);
            })}
            {!pts.length && <tr><td colSpan={10} style={{ color: 'var(--ink-mute)' }}>No cases match.</td></tr>}
          </tbody></table>
        </div>
      </div>
      {modal}
    </div>
  );
}

/* ═══════════ CARRIERS ═══════════ */
export function CarriersPage() {
  const { boot, go, refresh } = useApp();
  const [rows, setRows] = useState<RosterPatient[]>([]);
  const [wizard, setWizard] = useState<{ id: string; name: string } | null>(null);
  const [modal, setModal] = useState<React.ReactNode>(null);
  useEffect(() => { api('GET', '/roster/patients').then(setRows); }, []);

  const newCarrier = () => setModal(
    <FormModal title="New carrier" onClose={() => setModal(null)} saveLabel="Create — then configure the partnership"
      fields={[
        { key: 'name', label: 'Company name*', full: true },
        { key: 'hq', label: 'HQ address', full: true },
        { key: 'phone', label: 'Phone' }, { key: 'email', label: 'Email', type: 'email' },
        { key: 'relationship', label: 'Relationship contact', full: true },
        { key: 'states', label: 'States (comma separated)', full: true },
      ]}
      onSave={async v => {
        if (!v.name.trim()) { alert('Name required'); return; }
        const c = await api('POST', '/insurers', { ...v, states: v.states.split(',').map((s: string) => s.trim()).filter(Boolean), rules: [] });
        await refresh(); setModal(null); setWizard({ id: c.id, name: c.name });
      }} />);

  return (
    <div>
      <div className="pagehead" style={{ display: 'flex', alignItems: 'flex-end', gap: 14 }}>
        <div><h1 className="serif">Carriers</h1><div className="sub">Partners whose preferences configure the machine</div></div>
        <span className="spacer" />
        <button className="btn primary" onClick={newCarrier}>＋ New carrier</button>
      </div>
      <div className="card"><div className="cbody">
        <table><tbody>
          <tr><th>Carrier</th><th>States</th><th>Adjusters</th><th>Patients</th><th>Partnership config</th><th></th></tr>
          {boot.insurers.map(c => {
            const mine = rows.filter(p => p.insurerId === c.id);
            const cfg = (c as any).onboarding;
            return (
              <tr key={c.id}>
                <td><span className="link" onClick={() => go({ screen: 'insurance', id: c.id })}>{c.name}</span><br /><span className="idchip">{c.id}</span></td>
                <td>{c.states.join(', ') || '—'}</td>
                <td>{c.adjusters.length}</td>
                <td><span className="mono">{mine.filter(p => p.stage < 4).length}</span> active · {mine.length} total</td>
                <td>{cfg ? <span className="badge b-green">Configured — live</span> : <span className="badge b-amber">Not configured</span>}</td>
                <td><button className="btn sm" onClick={() => setWizard({ id: c.id, name: c.name })}>⚙ {cfg ? 'Edit' : 'Configure'} partnership</button></td>
              </tr>);
          })}
        </tbody></table>
      </div></div>
      {wizard && <CarrierWizard insurerId={wizard.id} insurerName={wizard.name} mode="staff"
        onClose={() => { setWizard(null); refresh(); }} />}
      {modal}
    </div>
  );
}

/* ═══════════ PROVIDERS ═══════════ */
export function ProvidersPage() {
  const { boot, go, refresh } = useApp();
  const [wizard, setWizard] = useState(false);
  const [q, setQ] = useState('');
  const provs = boot.providers.filter(p => (p.name + p.id + p.type).toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      <div className="pagehead" style={{ display: 'flex', alignItems: 'flex-end', gap: 14 }}>
        <div><h1 className="serif">Providers</h1><div className="sub">The network — contracted rates locked, credentialing tracked</div></div>
        <span className="spacer" />
        <button className="btn primary" onClick={() => setWizard(true)}>＋ Onboard provider · 10 min</button>
      </div>
      <div className="card">
        <div className="chead">
          <input placeholder="🔍 Name, ID, or type…" value={q} onChange={e => setQ(e.target.value)} style={{ ...sel, width: 240 }} />
          <span style={{ fontSize: 12, color: 'var(--ink-mute)' }}>{provs.length} in network</span>
        </div>
        <div className="cbody">
          <table><tbody>
            <tr><th>Provider</th><th>Type</th><th>Status</th><th>Branches</th><th>Credentialing</th><th>Auto-payout</th></tr>
            {provs.map(pr => {
              const cred = (pr as any).npi && (pr as any).licenseNo;
              const hasRate = pr.branches.some(b => b.ratePct != null);
              return (
                <tr key={pr.id}>
                  <td><span className="link" onClick={() => go({ screen: 'provider', id: pr.id })}>{pr.name}</span><br /><span className="idchip">{pr.id}</span></td>
                  <td>{pr.type}</td>
                  <td>{pr.status.map(s => <span key={s} className={'badge ' + (s === 'Preferred' ? 'b-green' : s === 'Under contract' ? 'b-blue' : 'b-amber')} style={{ marginRight: 4 }}>{s === 'Preferred' ? '★ ' : ''}{s}</span>)}</td>
                  <td>{pr.branches.map(b => b.name).join(' · ') || '—'}</td>
                  <td>{cred ? <span className="badge b-green">On file</span> : <span className="badge b-amber">Incomplete</span>}</td>
                  <td>{hasRate ? <span className="badge b-green">Armed</span> : <span className="badge b-gray">Manual</span>}</td>
                </tr>);
            })}
          </tbody></table>
        </div>
      </div>
      {wizard && <ProviderWizard onClose={() => setWizard(false)}
        onDone={async id => { setWizard(false); await refresh(); go({ screen: 'provider', id }); }} />}
    </div>
  );
}
