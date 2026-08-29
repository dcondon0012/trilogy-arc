import React, { useEffect, useRef, useState } from 'react';
import { api, apiUpload } from '../api';
import { useApp } from '../App';
import type { IntakeItem } from '../types';
import { fmt$, todayISO } from '../types';

const chBadge = (c: string) => c === 'email' ? 'b-blue' : c === 'fax' ? 'b-purple' : 'b-green';

export function InboxScreen() {
  const { boot, go } = useApp();
  const [items, setItems] = useState<IntakeItem[]>([]);
  const [tab, setTab] = useState<'triage' | 'queued' | 'done'>('triage');
  const [open, setOpen] = useState<IntakeItem | null>(null);
  const simRef = useRef<HTMLInputElement>(null);

  const load = () => api('GET', '/intake').then(r => setItems(r.items));
  useEffect(() => { load(); }, []);

  const shown = items.filter(i =>
    tab === 'triage' ? (i.kind === 'referral' && i.status === 'triage')
      : tab === 'queued' ? (i.kind !== 'referral' && (i.status === 'triage' || i.status === 'queued'))
      : (i.status === 'processed' || i.status === 'rejected'));
  const review = async (i: IntakeItem) => { await api('POST', `/intake/${i.id}/process`, {}); load(); };

  const simulate = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return;
    await apiUpload('/intake/simulate-inbound', f, { channel: Math.random() > 0.5 ? 'email' : 'fax', fromInfo: 'billing@summitspine.com' });
    if (simRef.current) simRef.current.value = '';
    load();
  };

  return (
    <div>
      <span className="backlink" onClick={() => go({ screen: 'home' })}>← Back</span>
      <div className="pt-head">
        <div className="pt-id" style={{ background: 'var(--amber)' }}>⇩</div>
        <div className="pt-title" style={{ flex: 1 }}>
          <h2>Requests</h2>
          <div className="pt-meta"><span className="badge b-blue">Only two things live here: new-patient referrals awaiting intake review, and inbound email/fax that couldn't auto-match a patient. Everything else files straight to patient accounts.</span></div>
        </div>
        {boot.user.role === 'admin' && (<>
          <button className="btn sm" onClick={() => simRef.current?.click()} title="Test the email/fax pipeline before the real webhooks are connected">Simulate inbound email/fax</button>
          <input ref={simRef} type="file" style={{ display: 'none' }} onChange={simulate} />
        </>)}
      </div>

      <div className="tabs">
        <div className={'tab' + (tab === 'triage' ? ' active' : '')} onClick={() => setTab('triage')}>
          New patient requests ({items.filter(i => i.kind === 'referral' && i.status === 'triage').length})</div>
        <div className={'tab' + (tab === 'queued' ? ' active' : '')} onClick={() => setTab('queued')}>
          ✉ Unmatched email/fax ({items.filter(i => i.kind !== 'referral' && (i.status === 'triage' || i.status === 'queued')).length})</div>
        <div className={'tab' + (tab === 'done' ? ' active' : '')} onClick={() => setTab('done')}>Done</div>
      </div>

      <div className="card"><div className="cbody">
        <table><tbody>
          <tr><th>Received</th><th>Channel</th><th>Document</th><th>From</th><th>Patient</th><th>Provider</th><th></th></tr>
          {shown.map(i => (
            <tr key={i.id} style={i.status === 'rejected' ? { opacity: 0.5 } : undefined}>
              <td style={{ whiteSpace: 'nowrap' }}>{i.receivedAt}</td>
              <td><span className={'badge ' + chBadge(i.channel)}>{i.channel}</span></td>
              <td>{i.fileId
                ? <span className="pdf" onClick={() => window.open('/api/files/' + i.fileId)}>{i.fileName}</span>
                : i.fileName}<div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{i.note}</div></td>
              <td style={{ fontSize: 12.5 }}>{i.fromInfo}</td>
              <td>{i.patientId ? <span className="link" onClick={() => go({ screen: 'patient', id: i.patientId! })}>{i.patientName}</span> : <span className="badge b-amber">unmatched</span>}</td>
              <td>{i.providerName || '—'}</td>
              <td>
                {(i.status === 'triage' || i.status === 'queued') && (i.kind === 'referral'
                  ? <button className="btn sm primary" onClick={() => review(i)}>✓ Mark intake reviewed</button>
                  : <button className="btn sm primary" onClick={() => setOpen(i)}>Assign & process</button>)}
                {i.status === 'processed' && <span className="badge b-green">✓ {i.processedBy}</span>}
                {i.status === 'rejected' && <span className="badge b-red">Rejected</span>}
              </td>
            </tr>))}
          {!shown.length && <tr><td colSpan={7} style={{ color: 'var(--muted)' }}>Nothing here. {tab === 'triage' ? 'All inbound documents are matched.' : ''}</td></tr>}
        </tbody></table>
      </div></div>

      {open && <ProcessModal item={open} onClose={() => { setOpen(null); load(); }} />}
    </div>
  );
}

function ProcessModal({ item, onClose }: { item: IntakeItem; onClose: () => void }) {
  const { boot } = useApp();
  const [patientQ, setPatientQ] = useState('');
  const [patientId, setPatientId] = useState(item.patientId || '');
  const [providerId, setProviderId] = useState(item.providerId || '');
  const [kind, setKind] = useState(item.kind === 'record' ? 'record' : 'bill');
  const [dos, setDos] = useState(todayISO());
  const [rate, setRate] = useState('');
  const [lines, setLines] = useState<any[]>([{ cpt: '', icd: '', units: 1, charge: '' }]);
  const [busy, setBusy] = useState(false);

  const patients = boot.patients.filter(p => (p.name + p.id).toLowerCase().includes(patientQ.toLowerCase())).slice(0, 6);
  const billed = lines.reduce((s, l) => s + (parseFloat(l.charge) || 0) * (parseFloat(l.units) || 1), 0);
  const setLine = (i: number, k: string, v: any) => setLines(ls => ls.map((l, j) => j === i ? { ...l, [k]: v } : l));

  const parse = async () => {
    const p = await api('POST', `/intake/${item.id}/parse`);
    if (p?.lines?.length) setLines(p.lines.map((l: any) => ({ cpt: l.cpt || '', icd: l.icd || '', units: l.units || 1, charge: l.charge || '' })));
    alert('Parser stub ran — at deployment, Textract + Bedrock pre-fill the CPT lines from the PDF. Enter them manually for now with the PDF open beside you.');
  };
  const process = async () => {
    setBusy(true);
    try {
      if (patientId && (patientId !== item.patientId || providerId !== item.providerId))
        await api('POST', `/intake/${item.id}/assign`, { patientId, providerId });
      const r = await api('POST', `/intake/${item.id}/process`, {
        patientId, providerId, dos, rate: parseFloat(rate) || 0,
        items: kind === 'bill' ? lines.filter(l => l.cpt || l.charge) : [],
        billed: kind === 'bill' ? billed : undefined,
      });
      if (r.feeFlags?.length) alert('Fee schedule flags:\n' + r.feeFlags.join('\n'));
      onClose();
    } catch (e: any) { alert(e.message); } finally { setBusy(false); }
  };
  const reject = async () => {
    const reason = prompt('Reject this item — reason:');
    if (reason?.trim()) { await api('POST', `/intake/${item.id}/reject`, { reason }); onClose(); }
  };

  return (
    <div className="overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ width: 760 }}>
        <h2>Process: {item.fileName} <span className={'badge ' + chBadge(item.channel)}>{item.channel}</span></h2>
        {item.fileId && <div style={{ marginBottom: 10 }}><span className="pdf" onClick={() => window.open('/api/files/' + item.fileId)}>Open document</span>
          <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 8 }}>from {item.fromInfo}</span></div>}
        <div className="mgrid">
          <div className="mfield"><label>Patient (search)</label>
            <input placeholder="⌕ name or ID" value={patientQ || (boot.patients.find(p => p.id === patientId)?.name ?? '')}
              onChange={e => { setPatientQ(e.target.value); setPatientId(''); }} />
            {patientQ && !patientId && (
              <div style={{ border: '1px solid var(--line)', borderRadius: 8, marginTop: 4 }}>
                {patients.map(p => <div key={p.id} className="um" onClick={() => { setPatientId(p.id); setPatientQ(''); }}>{p.name} · {p.id}</div>)}
              </div>)}
          </div>
          <div className="mfield"><label>Provider</label>
            <select value={providerId} onChange={e => setProviderId(e.target.value)}>
              <option value="">— choose —</option>
              {boot.providers.map(pr => <option key={pr.id} value={pr.id}>{pr.name}</option>)}
            </select></div>
          <div className="mfield"><label>Type</label>
            <select value={kind} onChange={e => setKind(e.target.value)}>
              <option value="bill">Bill (creates a payable bill)</option>
              <option value="record">Record (files as a document)</option>
            </select></div>
          {kind === 'bill' && <div className="mfield"><label>Date of service</label>
            <input type="date" value={dos} onChange={e => setDos(e.target.value)} /></div>}
        </div>

        {kind === 'bill' && (<>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '14px 0 6px' }}>
            <b style={{ fontSize: 13 }}>CPT line items <span style={{ fontWeight: 400, color: 'var(--muted)' }}>(optional — total-only is OK)</span></b>
            <button className="btn sm" onClick={parse}>Parse PDF (stub)</button>
          </div>
          <table><tbody>
            <tr><th>CPT</th><th>ICD-10</th><th>Units</th><th>Charge $</th><th></th></tr>
            {lines.map((l, i) => (
              <tr key={i}>
                <td><input value={l.cpt} onChange={e => setLine(i, 'cpt', e.target.value)} placeholder="98940" style={{ width: 90, border: '1px solid var(--line)', borderRadius: 6, padding: 5 }} /></td>
                <td><input value={l.icd} onChange={e => setLine(i, 'icd', e.target.value)} placeholder="M54.5" style={{ width: 90, border: '1px solid var(--line)', borderRadius: 6, padding: 5 }} /></td>
                <td><input type="number" value={l.units} onChange={e => setLine(i, 'units', e.target.value)} style={{ width: 60, border: '1px solid var(--line)', borderRadius: 6, padding: 5 }} /></td>
                <td><input type="number" value={l.charge} onChange={e => setLine(i, 'charge', e.target.value)} style={{ width: 90, border: '1px solid var(--line)', borderRadius: 6, padding: 5 }} /></td>
                <td><span style={{ color: 'var(--red)', cursor: 'pointer' }} onClick={() => setLines(ls => ls.filter((_, j) => j !== i))}>✕</span></td>
              </tr>))}
          </tbody></table>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8 }}>
            <button className="btn sm" onClick={() => setLines(ls => [...ls, { cpt: '', icd: '', units: 1, charge: '' }])}>＋ Line</button>
            <span style={{ fontSize: 13 }}>Billed total: <b>{fmt$(billed)}</b></span>
            <input placeholder="Payout $ (blank = auto from branch rate)" value={rate} onChange={e => setRate(e.target.value)}
              style={{ flex: 1, border: '1px solid var(--line)', borderRadius: 8, padding: 8, fontSize: 12.5 }} />
          </div>
        </>)}

        <div className="mactions">
          <button className="btn" style={{ color: 'var(--red)' }} onClick={reject}>Reject</button>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !patientId || (kind === 'bill' && !providerId)} onClick={process}>
            {kind === 'bill' ? 'Create bill' : 'File document'}</button>
        </div>
      </div>
    </div>
  );
}
