import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../App';
import { FormModal, RatesCard } from '../ui';
import type { Insurer, Adjuster } from '../types';
import { fmtK, initials } from '../types';

export function InsurerScreen({ id }: { id: string }) {
  const { boot, go, refresh } = useApp();
  const [tab, setTab] = useState<'main' | 'adj' | 'contracts' | 'stats' | 'report'>('main');
  const [scope, setScope] = useState<'carrier' | 'adjuster'>('carrier');
  const [rates, setRates] = useState<any[] | null>(null);
  const [stats, setStats] = useState<any>(null);
  const [report, setReport] = useState<any>(null);
  const [modal, setModal] = useState<React.ReactNode>(null);
  const c = boot.insurers.find(x => x.id === id) as Insurer | undefined;
  const isAdmin = boot.user.role === 'admin';

  useEffect(() => { setTab('main'); }, [id]);
  useEffect(() => { if (tab === 'stats' && isAdmin) api('GET', `/insurers/${id}/stats`).then(setStats); }, [tab, id, boot, isAdmin]);
  useEffect(() => { if ((tab === 'stats' || tab === 'contracts') && isAdmin) api('GET', `/insurers/${id}/contract-rates`).then(setRates).catch(() => {}); }, [tab, id, boot, isAdmin]);
  useEffect(() => { if (tab === 'report') api('GET', `/insurers/${id}/report`).then(setReport).catch(() => {}); }, [tab, id]);
  if (!c) return null;

  const myPatients = boot.patients.filter(p => p.insurerId === c.id);
  const activePts = myPatients.filter(p => p.stage < 4);

  const editInsurer = () => setModal(
    <FormModal title="Edit insurance company" onClose={() => setModal(null)}
      fields={[
        { key: 'name', label: 'Name', value: c.name },
        { key: 'hq', label: 'HQ address', value: c.hq, full: true },
        { key: 'phone', label: 'Phone', value: c.phone }, { key: 'email', label: 'Email', value: c.email },
        { key: 'relationship', label: 'Relationship contact', value: c.relationship, full: true },
        { key: 'payRate', label: 'Payment rate', value: c.payRate, full: true },
        { key: 'states', label: 'States (comma separated)', value: c.states.join(', '), full: true },
        { key: 'rules', label: 'Business rules (one per line)', type: 'textarea', value: c.rules.join('\n'), full: true },
      ]}
      onSave={async v => {
        await api('PATCH', '/insurers/' + c.id, {
          ...v, states: v.states.split(',').map(s => s.trim()).filter(Boolean),
          rules: v.rules.split('\n').filter(x => x.trim()),
        });
        await refresh(); setModal(null);
      }} />);
  const addAdjuster = () => setModal(
    <FormModal title={'Add adjuster — ' + c.name} onClose={() => setModal(null)} saveLabel="Add adjuster"
      fields={[
        { key: 'name', label: 'Name*' }, { key: 'phone', label: 'Phone' },
        { key: 'email', label: 'Email', full: true }, { key: 'notes', label: 'Notes', full: true },
      ]}
      onSave={async v => {
        if (!v.name.trim()) { alert('Name required'); return; }
        await api('POST', `/insurers/${c.id}/adjusters`, v); await refresh(); setModal(null);
      }} />);
  const addAdjContract = (a: Adjuster) => setModal(
    <FormModal title={'Add contract — ' + a.name} onClose={() => setModal(null)} saveLabel="Attach"
      fields={[{ key: 'contract', label: 'Contract file name', value: `Adjuster agreement — ${a.name}.pdf`, full: true }]}
      onSave={async v => { await api('PATCH', `/adjusters/${a.id}`, { contract: v.contract }); await refresh(); setModal(null); }} />);
  const addContract = (forScope: 'carrier' | 'adjuster') => setModal(
    <FormModal title={forScope === 'adjuster' ? 'Add adjuster contract' : 'Add carrier master contract — ' + c.name} onClose={() => setModal(null)} saveLabel="Add"
      fields={[
        { key: 'name', label: 'Contract name', ph: forScope === 'adjuster' ? 'e.g. Adjuster agreement — T. Ruiz.pdf' : 'e.g. Master services agreement.pdf', full: true },
        ...(forScope === 'adjuster' ? [{ key: 'adjusterId', label: 'Adjuster (search)', type: 'search' as const, options: c.adjusters.map(a => ({ v: a.id, l: a.name })), full: true }] : []),
        { key: 'meta', label: 'Description', ph: 'e.g. Signed 07/2026 · renews annually', full: true },
        { key: 'status', label: 'Status', type: 'select', options: [{ v: 'Draft', l: 'Draft' }, { v: 'Sent', l: 'Sent' }, { v: 'Active', l: 'Active (signed)' }, { v: 'Expired', l: 'Expired' }] },
        ...(isAdmin ? [{ key: 'rate', label: '% of billed they pay us (admin-only — hidden from staff)', type: 'number' as const }] : []),
      ]}
      onSave={async v => {
        if (!v.name.trim()) { alert('Name required'); return; }
        if (forScope === 'adjuster' && !v.adjusterId) { alert('Pick the adjuster'); return; }
        await api('POST', `/insurers/${c.id}/contracts`, { ...v, scope: forScope }); await refresh(); setModal(null);
      }} />);
  const sendContract = async (x: any) => {
    if (!confirm(`Send "${x.name}" to ${c.name}? Opens a prewritten email; the status moves to Sent.`)) return;
    await api('PATCH', `/ins-contracts/${x.id}`, { status: 'Sent' });
    window.location.href = `mailto:${encodeURIComponent(c.email || '')}?subject=${encodeURIComponent(`${x.name} — Trilogy Medical Networks`)}&body=${encodeURIComponent(`Hi,\n\nPlease find attached the ${x.name} for review and signature.\n\nThank you,\nTrilogy Medical Networks\ntrilogyconnections.com`)}`;
    await refresh();
  };
  const advanceContract = async (x: any) => {
    const next = x.status === 'Draft' ? 'Sent' : 'Active';
    await api('PATCH', `/ins-contracts/${x.id}`, { status: next }); await refresh();
  };
  const setContractRate = async (x: any) => {
    const cur = rates?.find(r => r.id === x.id)?.rate;
    const v = prompt(`% of billed ${c.name} pays us under "${x.name}" (admin-only):`, cur != null ? String(cur) : '');
    if (v === null) return;
    await api('PATCH', `/ins-contracts/${x.id}`, { rate: v });
    setRates(await api('GET', `/insurers/${c.id}/contract-rates`));
  };
  const editManualStats = () => setModal(
    <FormModal title="Edit manual stats (dollars & counts auto-compute)" onClose={() => setModal(null)}
      fields={[
        { key: 'avgDays', label: 'Avg days to pay', type: 'number', value: String(c.avgDays || 0) },
        { key: 'disputes', label: 'Disputed bills', type: 'number', value: String(c.disputes || 0) },
        { key: 'denialRate', label: 'Denial rate (%)', type: 'number', value: String(c.denialRate || 0) },
      ]}
      onSave={async v => {
        await api('PATCH', `/insurers/${c.id}/manual-stats`, v);
        await refresh(); setStats(await api('GET', `/insurers/${c.id}/stats`)); setModal(null);
      }} />);

  return (
    <div>
      <span className="backlink" onClick={() => go({ screen: 'home' })}>← Back</span>
      <div className="pt-head">
        <div className="pt-id" style={{ background: 'var(--purple)' }}>{initials(c.name)}</div>
        <div className="pt-title" style={{ flex: 1 }}>
          <h2>{c.name} <span className="idchip">{c.id}</span></h2>
          <div className="pt-meta">
            <span className="badge b-green">{c.contracts.some(x => x.status === 'Active') ? 'Contract active' : 'No active contract'}</span>
            <span className="badge b-blue">{activePts.length} active patient{activePts.length === 1 ? '' : 's'}</span>
          </div>
        </div>
        <button className="btn sm" onClick={editInsurer}>✎ Edit</button>
      </div>

      <div className="tabs">
        <div className={'tab' + (tab === 'main' ? ' active' : '')} onClick={() => setTab('main')}>Overview</div>
        <div className={'tab' + (tab === 'adj' ? ' active' : '')} onClick={() => setTab('adj')}>Adjusters</div>
        <div className={'tab' + (tab === 'contracts' ? ' active' : '')} onClick={() => setTab('contracts')}>Contracts</div>
        {isAdmin && <div className={'tab' + (tab === 'stats' ? ' active' : '')} onClick={() => setTab('stats')}>Business Stats</div>}
        <div className={'tab' + (tab === 'report' ? ' active' : '')} onClick={() => setTab('report')}>Enterprise Report</div>
      </div>

      {tab === 'report' && report && (
        <div>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="chead"><h3>What Trilogy has done for {report.carrier}</h3>
              <button className="btn sm" onClick={() => window.print()}>Print / PDF</button></div>
            <div className="cbody">
              {report.goals?.primary && <div style={{ fontSize: 13, marginBottom: 12, padding: 10, background: 'var(--blue-pale)', borderRadius: 8 }}>
                <b>Your stated goal:</b> {report.goals.primary}{report.goals.kpi ? ` · judged by: ${report.goals.kpi}` : ''}</div>}
              <div className="statrow">
                <div className="stat"><div className="sv serif money-in">{fmtK(report.savings)}</div><div className="sl">Saved vs face-value billing ({report.savingsPct}%)</div></div>
                <div className="stat"><div className="sv serif">{report.avgDaysToTreatment ?? '—'}{report.avgDaysToTreatment ? 'd' : ''}</div><div className="sl">Referral → treating</div></div>
                <div className="stat"><div className="sv serif">{100 - report.attorneyRate}%</div><div className="sl">Cases attorney-free</div></div>
                <div className="stat"><div className="sv serif">{report.cases}</div><div className="sl">Cases handled ({report.active} active)</div></div>
              </div>
              <table style={{ marginTop: 14 }}><tbody>
                <tr><th>Measure</th><th>Value</th><th>What it means for you</th></tr>
                <tr><td>Provider face-value charges</td><td className="mono">{fmtK(report.billedFace)}</td><td style={{ fontSize: 12.5 }}>What this care would have billed at street rates</td></tr>
                <tr><td>Contracted through Trilogy</td><td className="mono">{fmtK(report.contracted)}</td><td style={{ fontSize: 12.5 }}>What it actually cost at our locked rates</td></tr>
                <tr><td><b>Savings</b></td><td className="mono money-in"><b>{fmtK(report.savings)}</b></td><td style={{ fontSize: 12.5 }}>Every case inside coverage, no surprises</td></tr>
                <tr><td>Attorney involvement</td><td className="mono">{report.attorneyCount} of {report.cases}</td><td style={{ fontSize: 12.5 }}>Claimants in fast care don't hire attorneys</td></tr>
              </tbody></table>
            </div>
          </div>
          {isAdmin && report.tier && (
            <div className="card">
              <div className="chead"><h3>Internal — partnership tier: {report.tier.tier} ({report.tier.score}/100)</h3></div>
              <div className="cbody"><table><tbody>
                <tr><th>Factor</th><th>Reading</th><th>Points</th></tr>
                {report.tier.parts.map((x: any) => (
                  <tr key={x.k}><td>{x.k}</td><td className="mono" style={{ fontSize: 12 }}>{String(x.v)}</td><td className="mono">{x.pts}</td></tr>))}
              </tbody></table>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>Transparent weights — the tier is earned, not assigned. Not shown to the carrier.</div></div>
            </div>)}
        </div>)}

      {tab === 'main' && (
        <>
          <div className="grid2" style={{ marginBottom: 16 }}>
            <div className="card">
              <div className="chead"><h3>Main contact</h3></div>
              <div className="cbody"><dl className="kv">
                <dt>HQ</dt><dd>{c.hq || '—'}</dd>
                <dt>Phone</dt><dd>{c.phone || '—'}</dd>
                <dt>Email</dt><dd>{c.email || '—'}</dd>
                <dt>Relationship</dt><dd>{c.relationship || '—'}</dd>
                <dt>Payment rate</dt><dd>{c.payRate || '—'}</dd>
                <dt>States active</dt><dd>{c.states.map(s => <span key={s} className="badge b-gray" style={{ marginRight: 4 }}>{s}</span>)}{!c.states.length && '—'}</dd>
                <dt>Patients</dt><dd>{activePts.length} active · {myPatients.length} total in system</dd>
              </dl></div>
            </div>
            <div className="card">
              <div className="chead"><h3>Business rules</h3></div>
              <div className="cbody" style={{ fontSize: 13, lineHeight: 1.8 }}>
                {c.rules.map((r, i) => <div key={i}>• {r}</div>)}
                {!c.rules.length && '—'}</div>
            </div>
          </div>
          {isAdmin && <div style={{ marginBottom: 16 }}><RatesCard kind="carrier" id={c.id} label={c.name} /></div>}
        </>
      )}

      {tab === 'contracts' && (
        <div className="card">
          <div className="chead">
            <div className="subtabs" style={{ marginBottom: 0 }}>
              <span className={'subtab' + (scope === 'carrier' ? ' active' : '')} onClick={() => setScope('carrier')}>Insurance carrier (master)</span>
              <span className={'subtab' + (scope === 'adjuster' ? ' active' : '')} onClick={() => setScope('adjuster')}>Adjusters</span>
            </div>
            <button className="btn sm primary" onClick={() => addContract(scope)}>＋ Add {scope === 'adjuster' ? 'adjuster contract' : 'master contract'}</button>
          </div>
          <div className="cbody">
            <div style={{ fontSize: 12, color: 'var(--ink-mute)', marginBottom: 10 }}>
              {scope === 'carrier'
                ? 'One master contract with the carrier as a whole. What they pay us lives in Business Stats — never visible to non-admin staff.'
                : 'Individual adjuster contracts, one per adjuster on the roster.'}</div>
            <table><tbody>
              <tr><th>Contract</th>{scope === 'adjuster' && <th>Adjuster</th>}<th>Description</th><th>Status</th>{isAdmin && <th>Rate</th>}<th></th></tr>
              {c.contracts.filter(x => (x as any).scope === scope || (scope === 'carrier' && !(x as any).scope)).map(x => {
                const adjName = c.adjusters.find(a => a.id === (x as any).adjusterId)?.name || '—';
                const rate = rates?.find(r => r.id === x.id)?.rate;
                return (
                  <tr key={x.id}>
                    <td><b>{x.name}</b></td>
                    {scope === 'adjuster' && <td>{adjName}</td>}
                    <td style={{ fontSize: 12.5 }}>{x.meta || '—'}</td>
                    <td><span className={'badge ' + (x.status === 'Active' ? 'b-green' : x.status === 'Sent' ? 'b-blue' : 'b-amber')}>{x.status === 'Active' ? '✓ Active' : x.status}</span></td>
                    {isAdmin && <td className="mono">{rate != null ? rate + '%' : '—'}{' '}
                      <span className="addpdf" onClick={() => setContractRate(x)}>set</span></td>}
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {x.status !== 'Active' && <button className="btn sm" onClick={() => sendContract(x)}>Send</button>}{' '}
                      {x.status !== 'Active' && <button className="btn sm" onClick={() => advanceContract(x)}>→ {x.status === 'Draft' ? 'Sent' : 'Active'}</button>}
                    </td>
                  </tr>);
              })}
              {!c.contracts.filter(x => (x as any).scope === scope || (scope === 'carrier' && !(x as any).scope)).length &&
                <tr><td colSpan={6} style={{ color: 'var(--muted)' }}>None yet.</td></tr>}
            </tbody></table>
          </div>
        </div>
      )}

      {tab === 'adj' && (
        <div className="card"><div className="cbody">
          <table><tbody>
            <tr><th>Adjuster</th><th>Phone</th><th>Email</th><th>Active patients</th><th>Contract</th><th>Notes</th></tr>
            {c.adjusters.map(a => <AdjRow key={a.id} a={a} insurerId={c.id} onAddContract={() => addAdjContract(a)} />)}
            {!c.adjusters.length && <tr><td colSpan={6} style={{ color: 'var(--muted)' }}>No adjusters yet.</td></tr>}
          </tbody></table>
          <button className="btn sm" style={{ marginTop: 10 }} onClick={addAdjuster}>＋ Add adjuster</button>
        </div></div>
      )}

      {tab === 'stats' && isAdmin && stats && (
        <div className="card">
          <div className="chead"><h3>Business with {c.name} — all time admin only</h3></div>
          <div className="cbody">
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
              Auto-updated live from every patient linked to this carrier — recalculates on each receipt, payment, and status change.</div>
            <div className="statrow">
              <div className="stat"><div className="sv">{stats.all}</div><div className="sl">Patients (all-time)</div></div>
              <div className="stat"><div className="sv">{stats.act}</div><div className="sl">Active now</div></div>
              <div className="stat"><div className="sv money-in">{fmtK(stats.received)}</div><div className="sl">Total received</div></div>
              <div className="stat"><div className="sv money-out">{fmtK(stats.paidOut)}</div><div className="sl">Total paid out</div></div>
              <div className="stat"><div className="sv">{fmtK(stats.profit)}</div><div className="sl">Profit</div></div>
              <div className="stat"><div className="sv">{stats.margin}%</div><div className="sl">Avg margin</div></div>
              <div className="stat"><div className="sv">{stats.avgDays} d</div><div className="sl">Avg days to pay</div></div>
              <div className="stat"><div className="sv">{stats.disputes}</div><div className="sl">Disputed bills</div></div>
              <div className="stat"><div className="sv">{stats.denialRate}%</div><div className="sl">Denial rate</div></div>
            </div>
            <button className="btn sm" style={{ marginTop: 12 }} onClick={editManualStats}>Edit manual fields (days to pay, disputes, denials)</button>
            <div style={{ marginTop: 18 }}>
              <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--muted)', fontWeight: 700, marginBottom: 8 }}>
                Contract rates — % of billed {c.name} pays us (admin-only, never in staff payloads)</div>
              <table><tbody>
                <tr><th>Contract</th><th>Scope</th><th>Rate</th></tr>
                {(rates || []).map(r => (
                  <tr key={r.id}><td><b>{r.name}</b></td>
                    <td>{r.scope === 'adjuster' ? (c.adjusters.find(a => a.id === r.adjusterId)?.name || 'adjuster') : 'carrier master'}</td>
                    <td className="mono">{r.rate != null ? r.rate + '%' : '—'}</td></tr>))}
                {!(rates || []).length && <tr><td colSpan={3} style={{ color: 'var(--muted)' }}>No contracts yet — add them on the Contracts tab.</td></tr>}
              </tbody></table>
            </div>
          </div>
        </div>
      )}
      {modal}
    </div>
  );
}

function AdjRow({ a, insurerId, onAddContract }: { a: Adjuster; insurerId: string; onAddContract: () => void }) {
  const { boot, go } = useApp();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const pts = boot.patients.filter(p => p.insurerId === insurerId && p.adjusterId === a.id && p.stage < 4);
  const shown = pts.filter(p => (p.name + p.id).toLowerCase().includes(q.toLowerCase()));
  return (
    <tr>
      <td><b>{a.name}</b></td><td>{a.phone || '—'}</td><td>{a.email || '—'}</td>
      <td>
        <span style={{ cursor: 'pointer', fontWeight: 600, color: 'var(--accent)' }} onClick={() => setOpen(o => !o)}>{pts.length} active ▾</span>
        {open && (
          <div style={{ marginTop: 6 }}>
            <input placeholder="Search patients…" value={q} onChange={e => setQ(e.target.value)}
              style={{ width: '100%', border: '1px solid var(--line)', borderRadius: 6, padding: '5px 8px', fontSize: 12, marginBottom: 6 }} />
            <div style={{ fontSize: 12.5, lineHeight: 1.9 }}>
              {shown.map(p => <div key={p.id}><span className="link" onClick={() => go({ screen: 'patient', id: p.id })}>{p.name} · {p.id}</span></div>)}
              {!shown.length && <span style={{ color: 'var(--muted)' }}>None</span>}
            </div>
          </div>)}
      </td>
      <td>{a.contract
        ? <span className="pdf" onClick={() => alert('Opens the stored adjuster agreement PDF.')}>{a.contract}</span>
        : <span className="addpdf" onClick={onAddContract}>＋ add contract</span>}</td>
      <td>{a.notes || '—'}</td>
    </tr>
  );
}
