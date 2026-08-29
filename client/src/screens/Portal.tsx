import React, { useEffect, useRef, useState } from 'react';
import { api, apiUpload } from '../api';
import { TrilogyLogo } from '../ui';
import { CarrierWizard } from './Wizards';
import type { User, CaseMessage } from '../types';
import { STAGES, fmt$, fmtDate, todayISO } from '../types';

/* Shared message thread */
function Thread({ pid }: { pid: string }) {
  const [msgs, setMsgs] = useState<CaseMessage[]>([]);
  const [text, setText] = useState('');
  const load = () => api('GET', '/portal/messages/' + pid).then(setMsgs).catch(() => {});
  useEffect(() => { load(); }, [pid]);
  const send = async () => {
    if (!text.trim()) return;
    setMsgs(await api('POST', '/portal/messages/' + pid, { text })); setText('');
  };
  return (
    <div>
      <div className="notesticky">
        <input placeholder="Message Trilogy about this case…" value={text} onChange={e => setText(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && send()} />
        <button className="btn sm primary" onClick={send}>Send</button>
      </div>
      {msgs.map(m => (
        <div key={m.id} className={'note' + (m.authorType === 'staff' ? ' sys' : '')}>
          <div className="nmeta">{m.time} · {m.authorName} ({m.authorType === 'staff' ? 'Trilogy' : m.authorType})</div>{m.text}
        </div>))}
      {!msgs.length && <div style={{ color: 'var(--muted)', fontSize: 13 }}>No messages yet.</div>}
    </div>
  );
}

const inp = { border: '1px solid var(--line)', borderRadius: 8, padding: '7px 9px', fontSize: 12.5 } as const;

/* ================= PROVIDER PORTAL ================= */
export function ProviderPortal({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [data, setData] = useState<any>(null);
  const [tab, setTab] = useState<'patients' | 'payments' | 'submit' | 'account'>('patients');
  const [q, setQ] = useState('');
  const [detail, setDetail] = useState<any>(null);
  const [modal, setModal] = useState<React.ReactNode>(null);
  const load = () => api('GET', '/portal/provider/overview').then(setData).catch((e: any) => alert(e.message));
  useEffect(() => { load(); }, []);
  if (!data) return null;

  const openPatient = async (pid: string) => setDetail(await api('GET', '/portal/provider/patients/' + pid));
  const patients = data.patients.filter((p: any) => (p.patientName + p.patientId).toLowerCase().includes(q.toLowerCase()));

  const authForm = (p: any) => setModal(
    <PortalForm title={`Request additional authorization — ${p.patientName}`} onClose={() => setModal(null)}
      fields={[
        { k: 'amount', label: 'Amount requested ($)*', type: 'number' },
        { k: 'visits', label: 'Visits / services requested*' },
        { k: 'reason', label: 'Clinical justification*', textarea: true },
        { k: 'plan', label: 'Treatment plan / expected duration', textarea: true },
      ]}
      onSubmit={async v => {
        if (!v.amount || !v.visits || !v.reason) throw new Error('Amount, visits, and justification are required');
        const r = await api('POST', '/portal/provider/auth-request', {
          patientId: p.patientId, amount: v.amount,
          note: `${v.visits} — ${v.reason}${v.plan ? ' · Plan: ' + v.plan : ''}`,
        });
        return r.message;
      }} />);

  const orderForm = (p: any) => setModal(
    <PortalForm title={`Submit order / estimate — ${p.patientName}`} onClose={() => setModal(null)}
      fields={[
        { k: 'type', label: 'Type*', select: [['order', 'Order (imaging, referral, DME…)'], ['estimate', 'Estimate (upcoming treatment cost)']] },
        { k: 'details', label: 'Details*', textarea: true },
        { k: 'amount', label: 'Estimated amount ($)', type: 'number' },
        { k: 'file', label: 'Attach document (optional)', file: true },
      ]}
      onSubmit={async v => {
        if (!v.details) throw new Error('Describe the order/estimate');
        const r = v.file
          ? await apiUpload('/portal/provider/order', v.file, { patientId: p.patientId, type: v.type || 'order', details: v.details, amount: v.amount || '' })
          : await api('POST', '/portal/provider/order', { patientId: p.patientId, type: v.type || 'order', details: v.details, amount: v.amount });
        return r.message;
      }} />);

  return (
    <>
      <div className="stopbar">
        <TrilogyLogo size={20} /> <span className="badge b-green">Provider Portal</span>
        <div className="spacer" />
        <span style={{ fontSize: 13, fontWeight: 600 }}>{data.org?.name}</span>
        {data.orgRole === 'admin' && <span className="rolechip">org admin</span>}
        <button className="btn sm" onClick={onLogout}>Log out</button>
      </div>
      <div className="page">
        <div className="tabs">
          {([['patients', 'My Patients'], ['payments', 'Bills & Payment Status'], ['submit', 'Submit Bills & Records'], ['account', 'My Account']] as const).map(([k, l]) => (
            <div key={k} className={'tab' + (tab === k ? ' active' : '')} onClick={() => { setTab(k); setDetail(null); }}>{l}</div>))}
        </div>

        {tab === 'patients' && detail && (
          <div>
            <span className="backlink" onClick={() => setDetail(null)}>← All patients</span>
            <div className="grid2">
              <div className="card"><div className="chead"><h3>{detail.name} <span className="idchip">{detail.id}</span></h3></div>
                <div className="cbody"><dl className="kv">
                  <dt>Stage</dt><dd><span className="badge b-blue">{STAGES[detail.stage]}</span></dd>
                  <dt>DOB / DOI</dt><dd>{fmtDate(detail.dob)} / {fmtDate(detail.doi)}</dd>
                  <dt>Your branch</dt><dd>{detail.branch || '—'}</dd>
                  <dt>Authorized</dt><dd>{fmt$(detail.authAmount)} ({detail.authCount} auth{detail.authCount === 1 ? '' : 's'})</dd>
                  <dt>Billed</dt><dd>{fmt$(detail.billed)}</dd>
                  <dt>Auth remaining</dt><dd><b style={{ color: detail.authRemaining > 0 ? 'var(--green)' : 'var(--red)' }}>{fmt$(detail.authRemaining)}</b></dd>
                  <dt>Auth status</dt><dd><span className="badge b-blue">{detail.authStatus}</span></dd>
                </dl>
                <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn sm primary" onClick={() => authForm({ patientId: detail.id, patientName: detail.name })}>Request more auth</button>
                  <button className="btn sm" onClick={() => orderForm({ patientId: detail.id, patientName: detail.name })}>Submit order / estimate</button>
                  <button className="btn sm" onClick={() => setModal(
                    <PortalForm title={`Report booked appointment — ${detail.name}`} onClose={() => setModal(null)}
                      fields={[
                        { k: 'whenAt', label: 'Appointment date & time*', type: 'datetime-local' },
                        { k: 'note', label: 'Location / notes (branch, doctor…)', textarea: true },
                      ]}
                      onSubmit={async v => {
                        if (!v.whenAt) throw new Error('Pick the date/time');
                        const r = await api('POST', '/portal/provider/appointment', { patientId: detail.id, whenAt: v.whenAt.replace('T', ' '), note: v.note });
                        return r.message;
                      }} />)}>Report booked appointment</button>
                </div></div></div>
              <div className="card"><div className="chead"><h3>Messages</h3></div><div className="cbody"><Thread pid={detail.id} /></div></div>
            </div>
            <div className="card" style={{ marginTop: 16 }}><div className="chead"><h3>Your bills on this patient</h3></div>
              <div className="cbody"><table><tbody>
                <tr><th>DOS</th><th>Billed</th><th>Bill</th><th>Note</th><th>Status</th></tr>
                {detail.bills.filter((b: any) => !b.voided).map((b: any) => (
                  <tr key={b.id}>
                    <td>{fmtDate(b.dos)}</td><td>{fmt$(b.billed)}</td>
                    <td>{b.billFileId ? <span className="pdf" onClick={() => window.open('/api/portal/files/' + b.billFileId)}></span> : '—'}</td>
                    <td>{b.noteFileId ? <span className="pdf" onClick={() => window.open('/api/portal/files/' + b.noteFileId)}></span> : <span className="badge b-amber">needed</span>}</td>
                    <td>{b.status === 'paid' ? <span className="badge b-green">✓ Paid {b.paidDate}</span>
                      : b.denied ? <span className="badge b-red">Denied — {b.denialReason}</span>
                      : (b.hasBill && b.hasNote) ? <span className="badge b-blue">Approved — payment scheduled</span>
                      : <span className="badge b-amber">Awaiting records</span>}</td>
                  </tr>))}
              </tbody></table></div></div>
          </div>
        )}

        {tab === 'patients' && !detail && (
          <div className="card">
            <div className="chead"><input placeholder="⌕ Search your patients…" value={q} onChange={e => setQ(e.target.value)} style={{ ...inp, width: 260 }} />
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>{patients.length} patients</span></div>
            <div className="cbody">
              <table><tbody>
                <tr><th>Patient</th><th>Stage</th><th>Branch</th><th>Authorized</th><th>Billed</th><th>Auth remaining</th><th></th></tr>
                {patients.map((p: any) => (
                  <tr key={p.patientId}>
                    <td><span className="link" onClick={() => openPatient(p.patientId)}><b>{p.patientName}</b></span> <span className="idchip">{p.patientId}</span></td>
                    <td><span className="badge b-blue">{STAGES[p.stage]}</span></td>
                    <td>{p.branch || '—'}</td>
                    <td>{fmt$(p.authAmount)}</td>
                    <td>{fmt$(p.billed)}</td>
                    <td><b style={{ color: p.authRemaining > 0 ? 'var(--green)' : 'var(--red)' }}>{fmt$(p.authRemaining)}</b></td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn sm" onClick={() => authForm(p)}>Request auth</button>{' '}
                      <button className="btn sm" onClick={() => orderForm(p)}>Order/estimate</button>
                    </td>
                  </tr>))}
                {!patients.length && <tr><td colSpan={7} style={{ color: 'var(--muted)' }}>No matches.</td></tr>}
              </tbody></table>
            </div>
          </div>
        )}

        {tab === 'payments' && (
          <div className="card">
            <div className="chead"><h3>Every bill you've submitted, and where it stands</h3></div>
            <div className="cbody">
              <table><tbody>
                <tr><th>Patient</th><th>DOS</th><th>Billed</th><th>Status</th></tr>
                {data.paymentStatus.map((b: any) => (
                  <tr key={b.id}>
                    <td><span className="link" onClick={() => { setTab('patients'); openPatient(b.patientId); }}>{b.patientName}</span></td>
                    <td>{fmtDate(b.dos)}</td><td>{fmt$(b.billed)}</td>
                    <td>{b.stage === 'paid' ? <span className="badge b-green">✓ Paid {b.paidDate}</span>
                      : b.stage === 'denied' ? <span className="badge b-red">Denied — {b.denialReason}</span>
                      : b.stage === 'approved-pending-payment' ? <span className="badge b-blue">Approved — payment scheduled</span>
                      : <span className="badge b-amber">Received — records needed</span>}</td>
                  </tr>))}
                {!data.paymentStatus.length && <tr><td colSpan={4} style={{ color: 'var(--muted)' }}>No bills yet.</td></tr>}
              </tbody></table>
            </div>
          </div>
        )}

        {tab === 'submit' && <ProviderSubmit patients={data.patients} onDone={load} />}

        {tab === 'account' && (
          <div className="grid2">
            <div className="card"><div className="chead"><h3>Your agreement with Trilogy</h3></div>
              <div className="cbody">
                {data.orgRole === 'admin'
                  ? data.branches.map((b: any, i: number) => (
                    <div key={i} style={{ marginBottom: 8 }}><b>{b.name}</b>
                      <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{b.rate || '—'}{b.ratePct != null ? ` · ${b.ratePct}%${b.rateCap ? ` (cap ${fmt$(b.rateCap)})` : ''}` : ''}</div></div>))
                  : (<>
                    {data.branches.map((b: any, i: number) => <div key={i} style={{ marginBottom: 6 }}><b>{b.name}</b></div>)}
                    <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 8 }}>Contract and rate details are visible to your organization's admin account.</div>
                  </>)}
              </div></div>
            <div className="card"><div className="chead"><h3>Credentialing on file</h3></div>
              <div className="cbody"><dl className="kv">
                <dt>NPI</dt><dd>{data.credentialing?.npi || <span className="badge b-amber">missing</span>}</dd>
                <dt>License #</dt><dd>{data.credentialing?.licenseNo || <span className="badge b-amber">missing</span>}</dd>
                <dt>License expires</dt><dd>{fmtDate(data.credentialing?.licenseExp)}</dd>
                <dt>Malpractice</dt><dd>{data.credentialing?.malpracticeCarrier || <span className="badge b-amber">missing</span>}</dd>
                <dt>W-9</dt><dd>{data.credentialing?.w9OnFile ? <span className="badge b-green">✓</span> : <span className="badge b-amber">needed</span>}</dd>
                <dt>BAA</dt><dd>{data.credentialing?.baaSigned ? <span className="badge b-green">✓</span> : <span className="badge b-amber">needed</span>}</dd>
              </dl></div></div>
          </div>
        )}
      </div>
      {modal}
    </>
  );
}

/* Generic small portal form modal (plain inputs — no remount-on-keystroke bugs). */
function PortalForm({ title, fields, onSubmit, onClose }: {
  title: string;
  fields: { k: string; label: string; type?: string; textarea?: boolean; select?: [string, string][]; file?: boolean }[];
  onSubmit: (v: Record<string, any>) => Promise<string>;
  onClose: () => void;
}) {
  const [v, setV] = useState<Record<string, any>>({});
  const [msg, setMsg] = useState('');
  const submit = async () => {
    try { setMsg(await onSubmit(v)); } catch (e: any) { alert(e.message); }
  };
  return (
    <div className="overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <h2>{title}</h2>
        {msg ? (<>
          <div className="badge b-green" style={{ display: 'block', padding: 10 }}>✓ {msg}</div>
          <div className="mactions"><button className="btn primary" onClick={onClose}>Done</button></div>
        </>) : (<>
          <div className="mgrid">
            {fields.map(f => (
              <div key={f.k} className={'mfield' + (f.textarea || f.file ? ' full' : '')}>
                <label>{f.label}</label>
                {f.select ? (
                  <select value={v[f.k] || f.select[0][0]} onChange={e => setV(s => ({ ...s, [f.k]: e.target.value }))}>
                    {f.select.map(([val, l]) => <option key={val} value={val}>{l}</option>)}
                  </select>
                ) : f.textarea ? (
                  <textarea value={v[f.k] || ''} onChange={e => setV(s => ({ ...s, [f.k]: e.target.value }))} />
                ) : f.file ? (
                  <input type="file" onChange={e => setV(s => ({ ...s, [f.k]: e.target.files?.[0] }))} />
                ) : (
                  <input type={f.type || 'text'} value={v[f.k] || ''} onChange={e => setV(s => ({ ...s, [f.k]: e.target.value }))} />
                )}
              </div>))}
          </div>
          <div className="mactions">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" onClick={submit}>Submit</button>
          </div>
        </>)}
      </div>
    </div>
  );
}

/* Multi-pair bill+note submission. */
function ProviderSubmit({ patients, onDone }: { patients: any[]; onDone: () => void }) {
  const empty = () => ({ dos: todayISO(), amount: '', billType: 'hcfa', bill: null as File | null, note: null as File | null });
  const [patientQ, setPatientQ] = useState('');
  const [patientId, setPatientId] = useState('');
  const [rows, setRows] = useState([empty()]);
  const [msg, setMsg] = useState(''); const [busy, setBusy] = useState(false);
  const matches = patients.filter(p => (p.patientName + p.patientId).toLowerCase().includes(patientQ.toLowerCase())).slice(0, 6);
  const setRow = (i: number, k: string, val: any) => setRows(rs => rs.map((r, j) => j === i ? { ...r, [k]: val } : r));

  const submit = async () => {
    if (!patientId) { alert('Search and select the patient — every submission must be assigned to a patient'); return; }
    for (const r of rows) {
      if (!r.bill) { alert('Each row needs a bill file'); return; }
      if (!(parseFloat(r.amount) > 0)) { alert('Billed amount is required on every row'); return; }
    }
    setBusy(true);
    try {
      let last = '';
      for (const r of rows) {
        const fd = new FormData();
        fd.append('bill', r.bill!); if (r.note) fd.append('note', r.note);
        fd.append('patientId', patientId); fd.append('dos', r.dos);
        fd.append('amount', r.amount); fd.append('billType', r.billType);
        const res = await fetch('/api/portal/provider/submit', { method: 'POST', body: fd, credentials: 'same-origin' });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || 'Submit failed');
        last = data.message;
      }
      setMsg(`${rows.length} bill${rows.length === 1 ? '' : 's'} filed to the patient. ${last}`);
      setRows([empty()]); onDone();
    } catch (e: any) { alert(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="card" style={{ maxWidth: 860 }}>
      <div className="chead"><h3>Submit bills & records — bill and visit note go in together</h3></div>
      <div className="cbody">
        {msg && <div className="badge b-green" style={{ display: 'block', padding: 10, marginBottom: 12 }}>✓ {msg}</div>}
        <div className="mfield" style={{ maxWidth: 380, marginBottom: 12 }}>
          <label>Patient* (type to search)</label>
          <input placeholder="⌕ name or ID" value={patientId ? (patients.find(p => p.patientId === patientId)?.patientName + ' · ' + patientId) : patientQ}
            onChange={e => { setPatientQ(e.target.value); setPatientId(''); }} />
          {patientQ && !patientId && (
            <div style={{ border: '1px solid var(--line)', borderRadius: 8, marginTop: 4 }}>
              {matches.map(p => <div key={p.patientId} className="um" onClick={() => { setPatientId(p.patientId); setPatientQ(''); }}>{p.patientName} · {p.patientId}</div>)}
              {!matches.length && <div className="um" style={{ cursor: 'default', color: 'var(--muted)' }}>No matches — contact Trilogy if this patient should be on your list.</div>}
            </div>)}
        </div>
        <table><tbody>
          <tr><th>DOS*</th><th>Bill type</th><th>Billed $*</th><th>Bill file*</th><th>Visit note</th><th></th></tr>
          {rows.map((r, i) => (
            <tr key={i}>
              <td><input type="date" value={r.dos} onChange={e => setRow(i, 'dos', e.target.value)} style={inp} /></td>
              <td><select value={r.billType} onChange={e => setRow(i, 'billType', e.target.value)} style={inp}>
                <option value="hcfa">HCFA-1500</option><option value="invoice">General invoice</option><option value="other">Other</option></select></td>
              <td><input type="number" placeholder="0.00" value={r.amount} onChange={e => setRow(i, 'amount', e.target.value)} style={{ ...inp, width: 90 }} /></td>
              <td><input type="file" onChange={e => setRow(i, 'bill', e.target.files?.[0] || null)} style={{ fontSize: 11.5, maxWidth: 170 }} /></td>
              <td><input type="file" onChange={e => setRow(i, 'note', e.target.files?.[0] || null)} style={{ fontSize: 11.5, maxWidth: 170 }} /></td>
              <td>{rows.length > 1 && <span style={{ color: 'var(--red)', cursor: 'pointer' }} onClick={() => setRows(rs => rs.filter((_, j) => j !== i))}>✕</span>}</td>
            </tr>))}
        </tbody></table>
        <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
          <button className="btn sm" onClick={() => setRows(rs => [...rs, empty()])}>＋ Another bill+note pair</button>
          <div className="spacer" />
          <button className="btn primary" disabled={busy} onClick={submit}>Submit {rows.length > 1 ? `all ${rows.length}` : ''} to Trilogy</button>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 10 }}>
          Bills without a visit note are received but payment stays blocked until the note arrives. Everything files directly to the patient's account.</div>
      </div>
    </div>
  );
}

/* ================= CARRIER PORTAL ================= */
export function CarrierPortal({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [data, setData] = useState<any>(null);
  const [tab, setTab] = useState<'cases' | 'roster' | 'refer'>('cases');
  const [q, setQ] = useState('');
  const [caseView, setCaseView] = useState<any>(null);
  const [setup, setSetup] = useState(false);
  const load = () => api('GET', '/portal/carrier/overview').then(setData).catch((e: any) => alert(e.message));
  useEffect(() => { load(); }, []);
  if (!data) return null;

  const isOrgAdmin = data.orgRole === 'admin';
  const openCase = async (id: string) => setCaseView(await api('GET', '/portal/carrier/cases/' + id));
  const cases = data.cases.filter((c: any) => (c.name + c.id + (c.claimNumber || '')).toLowerCase().includes(q.toLowerCase()));

  return (
    <>
      <div className="stopbar">
        <TrilogyLogo size={20} /> <span className="badge b-purple">Carrier Portal</span>
        <div className="spacer" />
        <span style={{ fontSize: 13, fontWeight: 600 }}>{data.org?.name}{data.myAdjusterName ? ` · ${data.myAdjusterName}` : ''}</span>
        {isOrgAdmin && <span className="rolechip">org admin</span>}
        {isOrgAdmin && <button className="btn sm" onClick={() => setSetup(true)}>⚙ Partnership setup</button>}
        <button className="btn sm" onClick={onLogout}>Log out</button>
      </div>
      {setup && <CarrierWizard insurerId={user.orgId || ''} insurerName={data.org?.name || ''} mode="portal" onClose={() => setSetup(false)} />}
      <div className="page">
        <div className="tabs">
          {(([['refer', 'Send Us a Patient'], ['cases', isOrgAdmin ? `All Cases (${data.cases.length})` : `My Active Cases (${data.cases.length})`]] as [string, string][])
            .concat(isOrgAdmin ? [['roster', 'Adjuster Roster']] : []) as [typeof tab, string][]).map(([k, l]) => (
            <div key={k} className={'tab' + (tab === k ? ' active' : '')} onClick={() => { setTab(k); setCaseView(null); }}>{l}</div>))}
        </div>

        {tab === 'cases' && !caseView && (
          <div className="card">
            <div className="chead"><input placeholder="⌕ Search name, case ID, or claim #…" value={q} onChange={e => setQ(e.target.value)} style={{ ...inp, width: 280 }} />
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>{cases.length} shown</span></div>
            <div className="cbody">
              <table><tbody>
                <tr><th>Patient</th><th>Claim #</th><th>Stage</th><th>Adjuster</th><th>Providers</th><th>Billed to date</th></tr>
                {cases.map((c: any) => (
                  <tr key={c.id}>
                    <td><span className="link" onClick={() => openCase(c.id)}><b>{c.name}</b></span> <span className="idchip">{c.id}</span></td>
                    <td>{c.claimNumber || '—'}</td>
                    <td><span className={'badge ' + (c.stage >= 4 ? 'b-green' : 'b-blue')}>{STAGES[c.stage]}</span></td>
                    <td>{c.adjusterName || '—'}</td>
                    <td style={{ fontSize: 12.5 }}>{c.providers.join(', ') || '—'}</td>
                    <td><b>{fmt$(c.billedTotal)}</b></td>
                  </tr>))}
                {!cases.length && <tr><td colSpan={6} style={{ color: 'var(--muted)' }}>No cases match.</td></tr>}
              </tbody></table>
            </div>
          </div>
        )}

        {caseView && (
          <div>
            <span className="backlink" onClick={() => setCaseView(null)}>← All cases</span>
            <div className="grid2" style={{ marginBottom: 16 }}>
              <div className="card"><div className="chead"><h3>{caseView.name} · {caseView.claimNumber || 'no claim #'}</h3></div>
                <div className="cbody"><dl className="kv">
                  <dt>Trilogy case</dt><dd>{caseView.id}</dd>
                  <dt>DOB / DOI</dt><dd>{fmtDate(caseView.dob)} / {fmtDate(caseView.doi)}</dd>
                  <dt>State</dt><dd>{caseView.state || '—'}</dd>
                  <dt>Stage</dt><dd><span className="badge b-blue">{STAGES[caseView.stage]}</span></dd>
                  <dt>Adjuster</dt><dd>{caseView.adjuster?.name || '—'}</dd>
                  <dt>Treating</dt><dd>{caseView.providers.map((p: any) => p.name).join(', ') || '—'}</dd>
                  <dt>Billed to date</dt><dd><b>{fmt$(caseView.billedTotal)}</b></dd>
                </dl>
                <button className="btn sm" style={{ marginTop: 10 }} onClick={async () => {
                  const amount = prompt('Payment amount you are reporting ($):'); if (!amount) return;
                  const ref = prompt('Check / ACH reference:') || '';
                  const r = await api('POST', '/portal/carrier/report-payment', { patientId: caseView.id, amount, ref });
                  alert(r.message);
                }}>Report a payment sent</button>
              </div></div>
              <div className="card"><div className="chead"><h3>Case messages</h3></div>
                <div className="cbody"><Thread pid={caseView.id} /></div></div>
            </div>
            <div className="card"><div className="chead"><h3>Bills & records</h3>
              {!caseView.consentOnFile && <span className="badge b-amber">Documents unlock once the patient's records-sharing consent is signed</span>}</div>
              <div className="cbody">
                <table><tbody>
                  <tr><th>Provider</th><th>DOS</th><th>Billed</th><th>Bill</th><th>Records</th></tr>
                  {caseView.bills.map((b: any) => (
                    <tr key={b.id}>
                      <td>{b.providerName}</td><td>{fmtDate(b.dos)}</td><td>{fmt$(b.billed)}</td>
                      <td>{b.billFileId ? <span className="pdf" onClick={() => window.open('/api/portal/files/' + b.billFileId)}>{b.billFileName || 'Bill'}</span> : '—'}</td>
                      <td>{b.noteFileId ? <span className="pdf" onClick={() => window.open('/api/portal/files/' + b.noteFileId)}>{b.noteFileName || 'Notes'}</span> : '—'}</td>
                    </tr>))}
                  {!caseView.bills.length && <tr><td colSpan={5} style={{ color: 'var(--muted)' }}>No bills submitted yet.</td></tr>}
                </tbody></table>
              </div></div>
          </div>
        )}

        {tab === 'roster' && (
          <div className="card">
            <div className="chead"><h3>Adjusters</h3>
              {isOrgAdmin && <button className="btn sm primary" onClick={async () => {
                const name = prompt('Adjuster name:'); if (!name) return;
                const email = prompt('Adjuster email (lets them log in and see their cases):') || '';
                const phone = prompt('Phone:') || '';
                await api('POST', '/portal/carrier/adjusters', { name, email, phone });
                load();
              }}>＋ Add adjuster</button>}
            </div>
            <div className="cbody">
              <table><tbody>
                <tr><th>Adjuster</th><th>Phone</th><th>Email</th><th>Active Trilogy cases</th><th>All-time</th></tr>
                {data.roster.map((a: any) => (
                  <tr key={a.id}><td><b>{a.name}</b></td><td>{a.phone || '—'}</td><td>{a.email || '—'}</td>
                    <td><b>{a.activeCases}</b></td><td>{a.totalCases}</td></tr>))}
              </tbody></table>
              {!isOrgAdmin && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>Your carrier admin manages the roster.</div>}
            </div>
          </div>
        )}

        {tab === 'refer' && <ReferForm isOrgAdmin={isOrgAdmin} myAdjusterName={data.myAdjusterName} roster={data.roster} onDone={load} />}
      </div>
    </>
  );
}

/* Referral form — plain inline inputs (fixes the one-letter-at-a-time focus bug). */
function ReferForm({ isOrgAdmin, myAdjusterName, roster, onDone }: any) {
  const [v, setV] = useState<any>({ caseType: 'trilopay' });
  const [files, setFiles] = useState<File[]>([]);
  const [msg, setMsg] = useState('');
  const set = (k: string) => (e: any) => setV((s: any) => ({ ...s, [k]: e.target.value }));

  const submit = async () => {
    if (!v.name?.trim()) { alert('Claimant name is required'); return; }
    try {
      const fd = new FormData();
      for (const [k, val] of Object.entries(v)) fd.append(k, String(val ?? ''));
      for (const f of files) fd.append('files', f);
      const res = await fetch('/api/portal/carrier/refer', { method: 'POST', body: fd, credentials: 'same-origin' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed');
      setMsg(data.message); setV({ caseType: v.caseType }); setFiles([]); onDone();
    } catch (e: any) { alert(e.message); }
  };

  return (
    <div className="card" style={{ maxWidth: 720 }}>
      <div className="chead"><h3>Refer a claimant to Trilogy</h3></div>
      <div className="cbody">
        {msg && <div className="badge b-green" style={{ display: 'block', padding: 10, marginBottom: 12 }}>✓ {msg}</div>}
        <div className="mgrid">
          <div className="mfield"><label>Claimant name*</label><input value={v.name || ''} onChange={set('name')} /></div>
          <div className="mfield"><label>Line of business</label>
            <select value={v.caseType} onChange={set('caseType')}>
              <option value="trilopay">PIP (1st party)</option>
              <option value="trilogy">BI (3rd party)</option>
            </select></div>
          <div className="mfield"><label>Phone</label><input value={v.phone || ''} onChange={set('phone')} /></div>
          <div className="mfield"><label>Date of birth</label><input type="date" value={v.dob || ''} onChange={set('dob')} /></div>
          <div className="mfield"><label>Date of injury</label><input type="date" value={v.doi || ''} onChange={set('doi')} /></div>
          <div className="mfield"><label>Accident state</label><input value={v.state || ''} onChange={set('state')} /></div>
          <div className="mfield"><label>Claim #</label><input value={v.claimNumber || ''} onChange={set('claimNumber')} /></div>
          <div className="mfield"><label>Policy #</label><input value={v.policyNumber || ''} onChange={set('policyNumber')} /></div>
          <div className="mfield"><label>Coverage / PIP limits</label><input placeholder="e.g. $15,000" value={v.limits || ''} onChange={set('limits')} /></div>
          <div className="mfield"><label>Liability accepted?</label>
            <select value={v.liability || ''} onChange={set('liability')}>
              <option value="">—</option><option>Accepted</option><option>Denied</option><option>Under investigation</option>
            </select></div>
          <div className="mfield full"><label>Assigned adjuster {isOrgAdmin ? '(type to search the roster)' : ''}</label>
            {isOrgAdmin ? (<>
              <input list="adjdl" placeholder="⌕ adjuster name" value={v.adjusterName || ''} onChange={set('adjusterName')} autoComplete="off" />
              <datalist id="adjdl">{roster.map((a: any) => <option key={a.id} value={a.name} />)}</datalist>
            </>) : (
              <input value={myAdjusterName || 'Your adjuster account'} disabled />
            )}
          </div>
          <div className="mfield full"><label>Injury / accident description</label>
            <textarea value={v.description || ''} onChange={set('description')} /></div>
          <div className="mfield full"><label>Claim documents (traffic report, dec page, EOB… — multiple OK)</label>
            <input type="file" multiple onChange={e => setFiles(Array.from(e.target.files || []))} />
            {files.length > 0 && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>{files.map(f => f.name).join(' · ')}</div>}</div>
        </div>
        <div className="mactions"><button className="btn primary" onClick={submit}>Send referral</button></div>
      </div>
    </div>
  );
}
