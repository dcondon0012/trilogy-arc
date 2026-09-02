import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, apiUpload } from '../api';
import { useApp } from '../App';
import { FormModal, FieldSpec, Widget, statusBadge, cap } from '../ui';
import type { Patient, Task } from '../types';
import { STAGES, fmtDate, fmt$, todayISO, initials } from '../types';

type Tab = 'overview' | 'trans' | 'contracts' | 'prov' | 'insurance' | 'docs' | 'map' | 'messages' | 'fin';

export function PatientScreen({ id }: { id: string }) {
  const { boot, go, refresh } = useApp();
  const [p, setP] = useState<Patient | null>(null);
  const [ins, setIns] = useState<any>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [modal, setModal] = useState<React.ReactNode>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pendingAttach = useRef<{ bid: string; field: 'bill' | 'note' } | null>(null);

  const loadIns = () => api('GET', `/patients/${id}/insights`).then(setIns).catch(() => {});
  useEffect(() => { setTab('overview'); api('GET', '/patients/' + id).then(setP); loadIns(); }, [id]);
  if (!p) return null;

  const insurer = boot.insurers.find(i => i.id === p.insurerId) || null;
  const adj = insurer?.adjusters.find(a => a.id === p.adjusterId) || null;
  const comp = boot.patients.find(x => x.id === p.companionId) || null;
  const coord = boot.users.find(u => u.id === p.coordinator) || null;
  const md = (pid: string) => boot.providers.find(x => x.id === pid);
  const isAdmin = boot.user.role === 'admin';
  const today = todayISO();

  const mut = async (fn: () => Promise<Patient>) => {
    try { setP(await fn()); loadIns(); } catch (e: any) { alert(e.message || 'Error'); }
  };

  /* ---------- header actions ---------- */
  const setStage = (i: number) => {
    if (i === p.stage) return;
    if (confirm(`Set status to "${STAGES[i]}"?`)) mut(() => api('POST', `/patients/${p.id}/stage`, { stage: i })).then(refresh);
  };
  const editProfile = () => setModal(
    <FormModal title="Edit patient" onClose={() => setModal(null)}
      fields={[
        { key: 'name', label: 'Full name', value: p.name },
        { key: 'caseType', label: 'Case type', type: 'select', value: p.caseType, options: [{ v: 'trilopay', l: 'Trilopay — PIP' }, { v: 'trilogy', l: 'Trilogy — BI' }] },
        { key: 'phone', label: 'Phone', value: p.phone }, { key: 'email', label: 'Email', value: p.email },
        { key: 'address', label: 'Address', value: p.address, full: true },
        { key: 'dob', label: 'DOB', type: 'date', value: p.dob }, { key: 'doi', label: 'DOI', type: 'date', value: p.doi },
        { key: 'state', label: 'State of accident', value: p.state },
        { key: 'insurerId', label: 'Insurance (search)', type: 'search', value: p.insurerId || '', options: boot.insurers.map(i => ({ v: i.id, l: i.name })) },
        { key: 'claimNumber', label: 'Claim #', value: p.claimNumber }, { key: 'policyNumber', label: 'Policy #', value: p.policyNumber },
        { key: 'adjusterId', label: 'Adjuster (search)', type: 'search', value: p.adjusterId || '', options: insurer ? insurer.adjusters.map(a => ({ v: a.id, l: a.name })) : [] },
        { key: 'agentName', label: 'Insurance agent name', value: p.agentName || '' },
        { key: 'agentContact', label: 'Agent phone/email', value: p.agentContact || '' },
        { key: 'agentAuth', label: 'Authorization to contact agent?', type: 'select', value: String(p.agentAuth || 0), options: [{ v: '0', l: 'Not yet' }, { v: '1', l: 'Yes — signed' }] },
        { key: 'referralSource', label: 'Referral source', type: 'select', value: p.referralSource || '', options: [{ v: '', l: '—' }, { v: 'carrier', l: 'Carrier / adjuster' }, { v: 'agent', l: 'Insurance agent' }, { v: 'provider', l: 'Provider' }, { v: 'other', l: 'Other' }] },
        { key: 'consentSharing', label: 'Records-sharing consent signed?', type: 'select', value: String(p.consentSharing || 0), options: [{ v: '0', l: 'No — carrier docs locked' }, { v: '1', l: 'Yes — signed (unlocks carrier docs)' }] },
        { key: 'attorneyRetained', label: 'Attorney retained? (thesis metric)', type: 'select', value: String(p.attorneyRetained || 0), options: [{ v: '0', l: 'No' }, { v: '1', l: 'Yes — attorney involved' }] },
        { key: 'attorneyDate', label: 'Date retained (if yes)', type: 'date', value: p.attorneyDate || '' },
        { key: 'attorneyFirm', label: 'Law firm (if yes)', value: p.attorneyFirm || '' },
        { key: 'accident', label: 'Accident description', type: 'textarea', value: p.accident, full: true },
      ]}
      onSave={async v => { await mut(() => api('PATCH', '/patients/' + p.id, { ...v, attorneyRetained: Number(v.attorneyRetained), agentAuth: Number(v.agentAuth), consentSharing: Number(v.consentSharing) })); await refresh(); setModal(null); }} />);
  const changeCoordinator = () => setModal(
    <FormModal title="Assign case coordinator" onClose={() => setModal(null)}
      fields={[{ key: 'c', label: 'Coordinator (search)', type: 'search', value: p.coordinator || '', options: boot.users.map(u => ({ v: u.id, l: u.name })) }]}
      onSave={async v => { if (!v.c) { alert('No match'); return; } await mut(() => api('POST', `/patients/${p.id}/coordinator`, { coordinator: v.c })); setModal(null); }} />);
  const linkCompanion = () => setModal(
    <FormModal title="Link companion claim" onClose={() => setModal(null)}
      fields={[{ key: 'c', label: 'Patient (search — leave blank to unlink)', type: 'search', value: p.companionId || '', options: boot.patients.filter(x => x.id !== p.id).map(x => ({ v: x.id, l: `${x.name} (${x.id})` })) }]}
      onSave={async v => { await mut(() => api('POST', `/patients/${p.id}/companion`, { companionId: v.c || null })); setModal(null); }} />);

  /* ---------- file attach ---------- */
  const attach = (bid: string, field: 'bill' | 'note') => { pendingAttach.current = { bid, field }; if (fileRef.current) { fileRef.current.value = ''; fileRef.current.click(); } };
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; const pa = pendingAttach.current;
    if (!f || !pa) return;
    pendingAttach.current = null;
    await mut(() => apiUpload(`/bills/${pa.bid}/attach/${pa.field}`, f));
  };

  return (
    <div className={'screen-patient' + (p.caseType === 'trilogy' ? ' trilogy' : '')}>
      <span className="backlink" onClick={() => go({ screen: 'home' })}>← Back</span>
      <div className="pt-head">
        <div className="pt-id">{initials(p.name)}</div>
        <div className="pt-title" style={{ flex: 1 }}>
          <h2>{p.name} <span className="idchip">{p.id}</span>{' '}
            <span className="casebadge">{p.caseType === 'trilogy' ? 'TRILOGY · BI' : 'TRILOPAY · PIP'}</span></h2>
          <div className="pt-meta">
            <span className="badge b-blue" style={{ cursor: 'pointer' }} onClick={changeCoordinator}>Coordinator: {coord?.name || '—'} ▾</span>
            {comp && <span className="badge b-purple" style={{ cursor: 'pointer' }} onClick={() => go({ screen: 'patient', id: comp.id })}>Companion: {comp.name} · {comp.id}</span>}
          </div>
        </div>
        <button className="btn sm" onClick={linkCompanion}>Link companion</button>
        <button className="btn sm" onClick={editProfile}>✎ Edit profile</button>
      </div>

      <div className="pipeline">
        {STAGES.map((s, i) => (
          <div key={s} className={'stage' + (i < p.stage ? ' done' : i === p.stage ? ' now' : '')} title="Click to set stage" onClick={() => setStage(i)}>{s}</div>
        ))}
      </div>

      {(() => {
        const outside = p.uw.outsideBills.reduce((s: number, b: any) => s + b.amt, 0);
        const usage = p.bills.reduce((s: number, b: any) => s + (b.voided ? 0 : b.billed || 0), 0);
        const avail = (p.uw.limit || 0) - outside - usage;
        const pct = p.uw.limit ? Math.round((outside + usage) / p.uw.limit * 100) : null;
        return (
          <div className="ctx-strip">
            <div className="ctx-cell"><div className="cl">Coverage remaining</div><div className={'cv' + (avail < 0 ? ' bad' : '')}>{p.uw.limit ? `$${avail.toLocaleString()}` : '—'}</div></div>
            <div className="ctx-cell"><div className="cl">Coverage used</div><div className={'cv' + (pct !== null && pct >= 75 ? ' warn' : '')}>{pct !== null ? pct + '%' : '—'}</div></div>
            <div className="ctx-cell"><div className="cl">Consent on file</div><div className={'cv' + (p.consentSharing ? ' good' : ' warn')}>{p.consentSharing ? 'Yes' : 'Not yet'}</div></div>
            <div className="ctx-cell"><div className="cl">Attorney</div><div className={'cv' + (p.attorneyRetained ? ' bad' : ' good')}>{p.attorneyRetained ? 'Retained' : 'None'}</div></div>
            <div className="ctx-cell"><div className="cl">Carrier confirmed</div><div className={'cv' + (p.carrierConfirmed ? ' good' : ' warn')}>{p.carrierConfirmed ? 'Yes' : 'Pending'}</div></div>
            <div className="ctx-cell"><div className="cl">Open tasks</div><div className="cv">{p.tasks.filter((t: any) => !t.done).length}</div></div>
            {ins?.health && <div className="ctx-cell" title={ins.health.reds.map((r: any) => `[${r.kind}] ${r.text}`).join('\n') || 'No reds'}>
              <div className="cl">Health</div>
              <div className={'cv' + (ins.health.band === 'green' ? ' good' : ins.health.band === 'amber' ? ' warn' : ' bad')}>{ins.health.score} · {ins.health.status}</div></div>}
            {ins?.strip?.costVsPlan && <div className="ctx-cell"><div className="cl">Cost vs plan</div><div className="cv">{ins.strip.costVsPlan}</div></div>}
            {ins?.strip?.sol && <div className="ctx-cell" title="Statute of limitations (2yr PI)"><div className="cl">SOL</div>
              <div className={'cv' + ((ins.strip.solDays ?? 999) < 180 ? ' warn' : '')}>{fmtDate(ins.strip.sol)}</div></div>}
            {ins?.tier && <div className="ctx-cell"><div className="cl">Carrier tier</div><div className="cv">{ins.tier}</div></div>}
          </div>);
      })()}

      <div className="tabs">
        {([['overview', 'Overview'], ['trans', 'Transactions'], ['contracts', 'Contracts'], ['prov', 'Treating Providers'], ['insurance', 'Insurance'], ['docs', 'Documents'], ['map', 'Provider Map'], ['messages', `Messages${p.messages?.length ? ` (${p.messages.length})` : ''}`],
          ...(isAdmin ? [['fin', 'Financials']] : [])] as [Tab, string][]).map(([k, l]) => (
          <div key={k} className={'tab' + (tab === k ? ' active' : '')} onClick={() => setTab(k)}>{l}</div>
        ))}
      </div>

      {tab === 'overview' && <Overview p={p} mut={mut} setModal={setModal} insurer={insurer} adj={adj} md={md} isAdmin={isAdmin} today={today} go={go} />}
      {tab === 'trans' && <Transactions p={p} mut={mut} setModal={setModal} md={md} attach={attach} isAdmin={isAdmin} ins={ins} />}
      {tab === 'contracts' && <Contracts p={p} mut={mut} insurer={insurer} md={md} loadIns={loadIns} />}
      {tab === 'prov' && <Providers p={p} mut={mut} setModal={setModal} md={md} go={go} boot={boot} />}
      {tab === 'insurance' && <InsuranceTab p={p} insurer={insurer} adj={adj} go={go} mut={mut} />}
      {tab === 'docs' && <Docs p={p} mut={mut} />}
      {tab === 'map' && <MapTab p={p} mut={mut} boot={boot} go={go} />}
      {tab === 'messages' && <MessagesTab p={p} mut={mut} />}
      {tab === 'fin' && isAdmin && <FinancialsTab p={p} />}

      <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={onFile} />
      {modal}
    </div>
  );
}

/* ================= overview ================= */
function Overview({ p, mut, setModal, insurer, adj, md, isAdmin, today, go }: any) {
  const [note, setNote] = useState('');
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDue, setTaskDue] = useState('');
  const [openCmts, setOpenCmts] = useState<Record<string, boolean>>({});
  const [obNote, setObNote] = useState('');
  const [obAmt, setObAmt] = useState('');
  const [cwTab, setCwTab] = useState<'ins' | 'prov' | 'pt'>('ins');

  const outside = p.uw.outsideBills.reduce((s: number, b: any) => s + b.amt, 0);
  const usage = p.bills.reduce((s: number, b: any) => s + (b.voided ? 0 : b.billed || 0), 0);
  const avail = (p.uw.limit || 0) - outside - usage;

  const postNote = async () => { if (!note.trim()) return; await mut(() => api('POST', `/patients/${p.id}/notes`, { text: note })); setNote(''); };
  const quickTask = async () => {
    if (!taskTitle.trim()) return;
    await mut(() => api('POST', `/patients/${p.id}/tasks`, { title: taskTitle, due: taskDue || null }));
    setTaskTitle(''); setTaskDue('');
  };
  const addOutside = async () => {
    if (!obNote.trim() || !parseFloat(obAmt)) { alert('Enter both a note and an amount'); return; }
    await mut(() => api('POST', `/patients/${p.id}/outside-bills`, { desc: obNote, amt: parseFloat(obAmt) }));
    setObNote(''); setObAmt('');
  };
  const editUW = () => setModal(
    <FormModal title="Edit underwriting" onClose={() => setModal(null)}
      fields={[
        { key: 'status', label: 'Status', type: 'select', value: p.uw.status, options: ['Not started', 'In review', 'Approved', 'Declined'].map(x => ({ v: x, l: x })) },
        { key: 'coverage', label: 'Coverage type', value: p.uw.coverage },
        { key: 'limit', label: 'Coverage limit ($)', type: 'number', value: String(p.uw.limit || 0) },
        { key: 'riskFlags', label: 'Risk flags', value: p.uw.riskFlags },
        { key: 'approvedBy', label: 'Approved by', value: p.uw.approvedBy, full: true },
      ]}
      onSave={async v => { await mut(() => api('PATCH', `/patients/${p.id}/uw`, v)); setModal(null); }} />);

  const mbpa = p.sentDocs.find((d: any) => d.name.includes('Medical Bill Pay'));

  return (
    <div className="wgrid">
      <Widget wkey="details" title="Patient details">
        <dl className="kv">
          <dt>Case type</dt><dd><span className={'badge ' + (p.caseType === 'trilogy' ? 'b-yellow' : 'b-blue')}>{p.caseType === 'trilogy' ? 'Trilogy — BI (3rd party)' : 'Trilopay — PIP (1st party)'}</span></dd>
          <dt>Phone</dt><dd>{p.phone || '—'}</dd>
          <dt>Email</dt><dd>{p.email || '—'}</dd>
          <dt>Address</dt><dd>{p.address || '—'}</dd>
          <dt>DOB</dt><dd>{fmtDate(p.dob)}</dd>
          <dt>DOI</dt><dd>{fmtDate(p.doi)}</dd>
          <dt>Accident state</dt><dd>{p.state || '—'}</dd>
          <dt>Insurance</dt><dd>{insurer ? (<><span className="link" onClick={() => go({ screen: 'insurance', id: insurer.id })}>{insurer.name}</span> <span className="idchip">{insurer.id}</span></>) : '—'}{' '}
            {p.carrierConfirmed
              ? <span className="badge b-green">✓ coverage verified</span>
              : <span className="badge b-red" style={{ cursor: 'pointer' }} title="Click when coverage is confirmed with the carrier"
                  onClick={() => confirm('Mark coverage as VERIFIED with the carrier?') && mut(() => api('PATCH', '/patients/' + p.id, { carrierConfirmed: 1 }))}>unverified — click when confirmed</span>}</dd>
          <dt>Consent</dt><dd>{p.consentSharing
            ? <span className="badge b-green">✓ Records-sharing consent signed</span>
            : <span className="badge b-amber" title="Carrier portal cannot access bills/records until the patient agreement with the sharing clause is signed">Not on file — carrier docs locked</span>}</dd>
          <dt>Ins. agent</dt><dd>{p.agentName ? <>{p.agentName}{p.agentContact ? ' · ' + p.agentContact : ''} {p.agentAuth ? <span className="badge b-green">auth ✓</span> : <span className="badge b-amber">no auth</span>}</> : '—'}</dd>
          <dt>Referral source</dt><dd>{p.referralSource || '—'}</dd>
          {p.appointments?.length > 0 && <><dt>Next appt</dt><dd><span className="badge b-blue">{p.appointments[0].whenAt}</span> <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--muted)' }}>{p.appointments[0].note || ''}</span></dd></>}
          <dt>Claim #</dt><dd>{p.claimNumber || '—'}</dd>
          <dt>Policy #</dt><dd>{p.policyNumber || '—'}</dd>
          <dt>Adjuster</dt><dd>{adj ? `${adj.name} · ${adj.phone || ''} · ${adj.email || ''}` : '—'}</dd>
          <dt>Attorney</dt><dd>{p.attorneyRetained
            ? <span className="badge b-red">Retained{p.attorneyFirm ? ': ' + p.attorneyFirm : ''}{p.attorneyDate ? ' · ' + fmtDate(p.attorneyDate) : ''}</span>
            : <span className="badge b-green">None (thesis metric ✓)</span>}</dd>
          <dt>Accident</dt><dd style={{ fontWeight: 400 }}>{p.accident || '—'}</dd>
        </dl>
      </Widget>

      <Widget wkey="notes" title={<>NOTES & ACTIVITY <span style={{ color: 'var(--ink)', textTransform: 'none' }}>· MST · auto-logs events</span></>}>
        <div className="notescroll">
          <div className="notesticky">
            <input placeholder="Add a note… (MST time + author auto-saved)" value={note}
              onChange={e => setNote(e.target.value)} onKeyDown={e => e.key === 'Enter' && postNote()} />
            <button className="btn sm primary" onClick={postNote}>Add</button>
          </div>
          {p.notes.map((n: any) => (
            <div key={n.id} className={'note' + (n.kind === 'portal' ? ' portal' : n.sys ? ' sys' : '')}>
              <div className="nmeta">{n.time} · {n.kind === 'portal' ? `Portal (${n.by})` : n.sys ? `System (by ${n.by})` : n.by}</div>
              {n.kind === 'portal' ? '' : n.sys ? '⚙ ' : ''}{n.text}
            </div>))}
          {!p.notes.length && <div style={{ color: 'var(--muted)' }}>No notes yet.</div>}
        </div>
      </Widget>

      <Widget wkey="tasks" title="Tasks" defSize="s">
        <div className="notesticky">
          <input placeholder="Add a task…" value={taskTitle} onChange={e => setTaskTitle(e.target.value)} onKeyDown={e => e.key === 'Enter' && quickTask()} />
          <input type="date" title="Due date" value={taskDue} onChange={e => setTaskDue(e.target.value)}
            style={{ width: 130, fontSize: 12, padding: '8px 6px' }} />
          <button className="btn sm primary" onClick={quickTask}>Add</button>
        </div>
        {p.tasks.map((t: Task) => {
          const od = !!t.due && t.due < today;
          return (
            <div key={t.id} className={'task' + (od ? ' overdue' : '')}>
              <div className="trow">
                <input type="checkbox" onChange={() => mut(() => api('POST', `/tasks/${t.id}/complete`))} />
                <div style={{ flex: 1 }}>
                  <b>{t.title}</b>
                  <div className="due">Due <b>{fmtDate(t.due)}</b>{od ? ' — overdue' : ''}</div>
                  <div className="made">Created {t.created} by {t.by}</div>
                  <span className="cmtlink" onClick={() => setOpenCmts(s => ({ ...s, [t.id]: !s[t.id] }))}>
                    {t.comments.length} comment{t.comments.length === 1 ? '' : 's'}</span>{' '}
                  <span className="cmtlink" style={{ color: 'var(--amber)' }} onClick={() => {
                    const due = prompt('Push this task out to (YYYY-MM-DD):', t.due || todayISO());
                    if (due) mut(() => api('POST', `/tasks/${t.id}/snooze`, { due }));
                  }}>Push out</span>
                </div>
              </div>
              {openCmts[t.id] && (
                <div className="cmts">
                  {t.comments.map(c => <div key={c.id} className="cmt">{c.text}<div className="cmeta">{c.by} · {c.time}</div></div>)}
                  <input placeholder="Add comment… (Enter to post)" onKeyDown={e => {
                    if (e.key === 'Enter') { const v = (e.target as HTMLInputElement).value; if (v.trim()) mut(() => api('POST', `/tasks/${t.id}/comments`, { text: v })); }
                  }} />
                </div>)}
            </div>);
        })}
        {!p.tasks.length && <div style={{ color: 'var(--muted)' }}>No open tasks. Completed tasks are logged in Notes.</div>}
      </Widget>

      <Widget wkey="uw" title="Underwriting" defSize="s">
        <dl className="kv" style={{ gridTemplateColumns: '150px 1fr' }}>
          <dt>Status</dt><dd><span className={'badge ' + (p.uw.status === 'Approved' ? 'b-green' : 'b-amber')}>{p.uw.status}</span></dd>
          <dt>Coverage</dt><dd>{p.uw.coverage || '—'}{p.uw.limit && !(p.uw.coverage || '').includes('$') ? ' · ' + fmt$(p.uw.limit) + ' limit' : ''}</dd>
          <dt>Trilogy usage</dt><dd>{fmt$(usage)} <span style={{ fontWeight: 400, fontSize: 11, color: 'var(--muted)' }}>(auto — total billed)</span></dd>
          <dt>Outside med bills</dt>
          <dd>{fmt$(outside)}
            {p.uw.outsideBills.map((b: any) => (
              <div key={b.id} style={{ fontWeight: 400, fontSize: 12, color: 'var(--muted)', display: 'flex', justifyContent: 'space-between', gap: 6, marginTop: 3 }}>
                <span>{b.desc}</span>
                <span>{fmt$(b.amt)} <span style={{ color: 'var(--red)', cursor: 'pointer', fontWeight: 700 }} title="Remove"
                  onClick={() => mut(() => api('DELETE', `/outside-bills/${b.id}`))}>✕</span></span>
              </div>))}
            <div style={{ display: 'flex', gap: 5, marginTop: 7 }}>
              <input placeholder="What is it? (e.g. ER visit)" value={obNote} onChange={e => setObNote(e.target.value)}
                style={{ flex: 1, minWidth: 0, border: '1px solid var(--line)', borderRadius: 6, padding: '5px 7px', fontSize: 12, fontWeight: 400 }} />
              <input type="number" placeholder="$" value={obAmt} onChange={e => setObAmt(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addOutside()}
                style={{ width: 64, flexShrink: 0, border: '1px solid var(--line)', borderRadius: 6, padding: '5px 7px', fontSize: 12 }} />
              <button className="btn sm" onClick={addOutside}>＋</button>
            </div>
          </dd>
          <dt><b>Coverage remaining</b></dt>
          <dd style={{ color: avail > 0 ? 'var(--green)' : 'var(--red)', fontSize: 16 }}>{fmt$(avail)}{' '}
            <span style={{ fontWeight: 400, fontSize: 11, color: 'var(--muted)' }}>(auto: limit − outside − usage)</span></dd>
          <dt>Risk flags</dt><dd>{p.uw.riskFlags ? <span className="badge b-amber">{p.uw.riskFlags}</span> : '—'}</dd>
          <dt>Approved by</dt><dd>{p.uw.approvedBy || '—'}</dd>
        </dl>
        <button className="btn sm" style={{ marginTop: 10 }} onClick={editUW}>✎ Edit underwriting</button>
      </Widget>

      <Widget wkey="provs" title="Treating providers" defSize="s">
        {p.provLinks.map((l: any) => {
          const pr = md(l.providerId); if (!pr) return null;
          return (
            <div key={l.id} style={{ paddingBottom: 10, borderBottom: '1px solid var(--line)', marginBottom: 10 }}>
              <b className="link" onClick={() => go({ screen: 'provider', id: pr.id })}>{pr.name}</b>{' '}
              <span className={'badge ' + statusBadge(l.status)}>{cap(l.status)}</span>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
                Auth sent: <b style={{ color: 'var(--ink)' }}>{fmt$(l.authAmount)}</b> ({l.authCount} auth{l.authCount === 1 ? '' : 's'}) ·
                Billed: <b style={{ color: 'var(--ink)' }}>{fmt$(l.billed)}</b>
                {l.billed > l.authAmount && l.authAmount > 0 && <span style={{ color: 'var(--red)', fontWeight: 700 }}> over auth</span>}<br />
                Rules: {(pr.rules || []).slice(0, 2).join(' · ') || '—'}
              </div>
            </div>);
        })}
        {!p.provLinks.length && <div style={{ color: 'var(--muted)' }}>No providers linked yet — use the Provider Map or Medical Providers tab.</div>}
      </Widget>

      <Widget wkey="contracts" title="Contract status" defSize="f">
        <div className="subtabs">
          {([['ins', 'Insurance'], ['prov', 'Medical providers'], ['pt', 'Patient']] as ['ins' | 'prov' | 'pt', string][]).map(([k, l]) => (
            <span key={k} className={'subtab' + (cwTab === k ? ' active' : '')} onClick={() => setCwTab(k)}>{l}</span>))}
        </div>
        {cwTab === 'ins' && (
          <table><tbody>
            <tr><th>Company</th><th>Contract</th><th>Status</th></tr>
            {insurer ? (
              <tr><td><b>{insurer.name}</b> <span className="idchip">{insurer.id}</span></td>
                <td>{p.caseType === 'trilogy' ? 'Trilogy' : 'Trilopay'} carrier agreement</td>
                <td>{insurer.contracts.length ? <span className="badge b-green">✓ On file</span> : <span className="badge b-amber">Not on file</span>}</td></tr>
            ) : <tr><td colSpan={3} style={{ color: 'var(--muted)' }}>No insurance linked</td></tr>}
          </tbody></table>)}
        {cwTab === 'prov' && (
          <table><tbody>
            <tr><th>Provider</th><th>Relationship</th><th>Agreement</th><th>Status</th></tr>
            {p.provLinks.map((l: any) => {
              const pr = md(l.providerId); if (!pr) return null;
              const oneTime = pr.status.includes('Single case agreement');
              const signed = p.sentDocs.some((d: any) => d.name.includes('Lien') && d.to.toLowerCase().includes(pr.name.split(' ')[0].toLowerCase()) && d.status === 'Signed');
              return (
                <tr key={l.id}><td><b>{pr.name}</b> <span className="idchip">{pr.id}</span></td>
                  <td><span className={'badge ' + (oneTime ? 'b-gray' : 'b-green')}>{oneTime ? 'One-time provider' : 'Contracted provider'}</span></td>
                  <td>{oneTime ? 'One-time lien' : 'Lien agreement'}</td>
                  <td>{signed ? <span className="badge b-green">✓ Signed</span> : <span className="badge b-amber">Sent — awaiting</span>}</td></tr>);
            })}
            {!p.provLinks.length && <tr><td colSpan={4} style={{ color: 'var(--muted)' }}>No providers linked</td></tr>}
          </tbody></table>)}
        {cwTab === 'pt' && (
          <table><tbody>
            <tr><th>Document</th><th>Status</th><th>Sent / signed</th></tr>
            <tr><td><b>Medical Bill Pay Agreement</b></td>
              <td>{mbpa ? (mbpa.status === 'Signed' ? <span className="badge b-green">✓ Signed</span> : <span className="badge b-amber">{mbpa.status}</span>) : <span className="badge b-red">Not sent</span>}</td>
              <td>{mbpa ? mbpa.time : '—'}</td></tr>
          </tbody></table>)}
      </Widget>
    </div>
  );
}

/* ================= transactions ================= */
function Transactions({ p, mut, setModal, md, attach, isAdmin, ins }: any) {
  const fourCheck = (b: any) => {
    const fc = ins?.checks?.[b.id];
    if (!fc) return null;
    return (
      <span title={fc.checks.map((c: any) => `${c.status === 'pass' ? '✓' : c.status === 'warn' ? '~' : '✕'} ${c.label}: ${c.detail}`).join('\n')}
        style={{ fontFamily: 'var(--mono)', fontSize: 12, letterSpacing: 2, cursor: 'help' }}>
        {fc.checks.map((c: any, i: number) => (
          <span key={i} style={{ color: c.status === 'pass' ? 'var(--green)' : c.status === 'warn' ? 'var(--amber)' : 'var(--red)' }}>●</span>))}
        {fc.dup && <span className="badge b-red" style={{ marginLeft: 6 }}>dup?</span>}
      </span>);
  };
  const eob = (b: any) => setModal(
    <FormModal title={`EOB — DOS ${fmtDate(b.dos)} (${md(b.providerId)?.name})`} onClose={() => setModal(null)} saveLabel="Record EOB"
      fields={[
        { key: 'allowed', label: 'EOB allowed ($)', type: 'number', value: b.eobAllowed || '' },
        { key: 'paid', label: 'EOB paid ($)', type: 'number', value: b.eobPaid || '' },
        { key: 'note', label: 'Adjustment note', full: true, value: b.eobNote || '' },
      ]}
      onSave={async v => { await mut(() => api('POST', `/bills/${b.id}/eob`, v)); setModal(null); }} />);

  const voidBill = (b: any) => {
    const reason = prompt(`Void this ${md(b.providerId)?.name} bill (DOS ${fmtDate(b.dos)}, ${fmt$(b.billed)})?\n\nEnter the reason (required — goes in the permanent record):`);
    if (reason?.trim()) mut(() => api('POST', `/bills/${b.id}/void`, { reason }));
  };
  const voidReceipt = (r: any) => {
    const reason = prompt(`Void this receipt (${fmt$(r.amount)})?\n\nEnter the reason (required):`);
    if (reason?.trim()) mut(() => api('POST', `/receipts/${r.id}/void`, { reason }));
  };
  const reconcile = (r: any) => setModal(
    <ReconcileModal p={p} receipt={r} md={md} onClose={() => setModal(null)}
      onSave={async (billIds: string[]) => { await mut(() => api('POST', `/receipts/${r.id}/link`, { billIds })); setModal(null); }} />);

  const addBill = () => {
    if (!p.provLinks.length) { alert('Link a provider first (Treating Providers tab or map).'); return; }
    setModal(<BillModal p={p} md={md} mut={mut} onClose={() => setModal(null)} />);
  };
  const addReceipt = () => setModal(
    <FormModal title="Record insurance receipt" onClose={() => setModal(null)} saveLabel="Record"
      fields={[
        { key: 'date', label: 'Date', type: 'date', value: todayISO() },
        { key: 'ref', label: 'Reference', ph: 'Claim # · batch', full: true },
        { key: 'amount', label: 'Amount ($)', type: 'number' },
        { key: 'status', label: 'Status', type: 'select', options: [{ v: 'Pending', l: 'Pending' }, { v: 'Cleared', l: 'Cleared' }] },
      ]}
      onSave={async v => { await mut(() => api('POST', `/patients/${p.id}/receipts`, v)); setModal(null); }} />);
  const pay = (b: any) => {
    const pr = md(b.providerId);
    if (confirm(`Release payment to ${pr?.name} for DOS ${fmtDate(b.dos)} (bill of ${fmt$(b.billed)})?\n\nPays at the contracted rate. (v1: logs the payment; payment rails arrive with the clearinghouse integration.)`))
      mut(() => api('POST', `/bills/${b.id}/pay`));
  };
  // Carrier-paid state: any linked receipt cleared → paid; linked but pending → pending.
  const carrierPaid = (b: any) => {
    const recs = (b.coveredBy || []).map((rid: number) => p.receipts.find((r: any) => r.id === rid)).filter(Boolean);
    if (recs.some((r: any) => r.status === 'Cleared' && !r.voided)) return <span className="badge b-green">✓ Carrier paid</span>;
    if (recs.length) return <span className="badge b-amber">Receipt pending</span>;
    return <span className="badge b-gray">Not yet</span>;
  };

  return (
    <div className="card">
      <div className="chead"><h3>Bills, notes & payments</h3>
        <div><button className="btn sm" onClick={() => window.open(`/api/patients/${p.id}/batch-packet`)}>Batch bill packet</button>{' '}
          <button className="btn sm primary" onClick={addBill}>＋ Add bill / invoice</button>{' '}
          <button className="btn sm" onClick={addReceipt}>↓ Record insurance receipt</button></div>
      </div>
      <div className="cbody">
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
          One entry per date of service. A bill can’t be paid until its visit note is attached. Payouts are calculated automatically from contracted terms.</div>
        <table><tbody>
          <tr><th>Provider · DOS</th><th>Billed</th><th>4-check</th><th>Bill</th><th>Visit note</th><th>Carrier → us</th><th>Us → provider</th><th></th></tr>
          {p.bills.map((b: any) => b.voided ? (
            <tr key={b.id} style={{ opacity: 0.45 }}>
              <td><s><b>{md(b.providerId)?.name || '?'}</b></s><br /><span style={{ color: 'var(--muted)' }}>DOS {fmtDate(b.dos)}</span></td>
              <td><s>{fmt$(b.billed)}</s></td>
              <td colSpan={5}><span className="badge b-red">VOIDED</span> <span style={{ fontSize: 12 }}>{b.voidReason}</span></td>
              <td />
            </tr>
          ) : (
            <tr key={b.id}>
              <td><b>{md(b.providerId)?.name || '?'}</b><br /><span style={{ color: 'var(--muted)' }}>DOS {fmtDate(b.dos)}{b.descr ? ` · ${b.descr}` : ''}</span></td>
              <td>{fmt$(b.billed)}</td>
              <td>{fourCheck(b) || <span style={{ color: 'var(--muted)' }}>—</span>}</td>
              <td>{b.hasBill
                ? <span className="pdf" title={b.billFileName || ''} onClick={() => b.billFileId ? window.open('/api/files/' + b.billFileId) : alert('Demo record — no stored file')}>Bill</span>
                : <span className="addpdf" onClick={() => attach(b.id, 'bill')}>＋ attach bill</span>}</td>
              <td>{b.hasNote
                ? <span className="pdf" title={b.noteFileName || ''} onClick={() => b.noteFileId ? window.open('/api/files/' + b.noteFileId) : alert('Demo record — no stored file')}>Note</span>
                : <span className="addpdf" onClick={() => attach(b.id, 'note')}>＋ attach note</span>}</td>
              <td>{carrierPaid(b)}</td>
              <td>{b.status === 'paid' ? <span className="badge b-green">✓ Paid in full {b.paidDate}</span>
                : (b.hasBill && b.hasNote ? <span className="badge b-blue">Ready to pay</span>
                  : <span className="badge b-amber">Blocked — missing {b.hasBill ? 'note' : 'bill'}</span>)}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                {b.status === 'paid' ? <button className="btn sm" disabled>Paid ✓</button>
                  : <button className="btn sm primary" disabled={!(b.hasBill && b.hasNote)} title={!(b.hasBill && b.hasNote) ? 'Attach bill + visit note first' : 'Releases payment at the contracted rate'} onClick={() => pay(b)}>Pay</button>}{' '}
                <button className="btn sm" title="Void (correction — permanent record kept)" onClick={() => voidBill(b)}>Void</button>{' '}
                {b.denied
                  ? <button className="btn sm" style={{ color: 'var(--amber)' }} title={b.denialReason || ''} onClick={() => {
                      const s = prompt('Appeal status: none / appealing / won / lost / written-off', b.appealStatus || 'none');
                      if (s) mut(() => api('POST', `/bills/${b.id}/denial`, { denied: 1, denialReason: b.denialReason, appealStatus: s }));
                    }}>Denied: {b.appealStatus || 'none'}</button>
                  : <button className="btn sm" onClick={() => {
                      const reason = prompt('Carrier denied this bill — reason:');
                      if (reason?.trim()) mut(() => api('POST', `/bills/${b.id}/denial`, { denied: 1, denialReason: reason, appealStatus: 'none' }));
                    }}>Mark denied</button>}{' '}
                {p.caseType === 'trilopay' && <button className="btn sm" title={b.eobAt ? `EOB ${b.eobAt}: allowed ${b.eobAllowed ?? '—'} / paid ${b.eobPaid ?? '—'}` : 'Record the carrier EOB'} onClick={() => eob(b)}>
                  {b.eobAt ? `EOB ✓` : 'EOB'}</button>}
              </td>
            </tr>))}
          {!p.bills.length && <tr><td colSpan={8} style={{ color: 'var(--muted)' }}>No bills yet.</td></tr>}
        </tbody></table>

        <div style={{ margin: '16px 0 6px', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--muted)', fontWeight: 700 }}>Insurance receipts</div>
        <table><tbody>
          <tr><th>Date</th><th>Reference</th><th>Amount</th><th>Covers</th><th>Status</th><th></th></tr>
          {p.receipts.map((r: any) => r.voided ? (
            <tr key={r.id} style={{ opacity: 0.45 }}>
              <td>{fmtDate(r.date)}</td><td><s>{r.ref}</s></td><td><s>{fmt$(r.amount)}</s></td>
              <td colSpan={3}><span className="badge b-red">VOIDED</span> <span style={{ fontSize: 12 }}>{r.voidReason}</span></td>
            </tr>
          ) : (
            <tr key={r.id}>
              <td>{fmtDate(r.date)}</td><td>{r.ref}</td><td className="money-in">+ {fmt$(r.amount)}</td>
              <td>{r.billIds?.length
                ? <span className="link" onClick={() => reconcile(r)}>✓ {r.billIds.length} bill{r.billIds.length === 1 ? '' : 's'}</span>
                : <span className="addpdf" onClick={() => reconcile(r)}>link bills</span>}</td>
              <td><span className={'badge ' + (r.status === 'Cleared' ? 'b-green' : 'b-amber')} style={{ cursor: 'pointer' }}
                title="Click to toggle cleared/pending" onClick={() => mut(() => api('POST', `/receipts/${r.id}/toggle`))}>{r.status}</span></td>
              <td><button className="btn sm" onClick={() => voidReceipt(r)}>Void</button></td>
            </tr>))}
          {!p.receipts.length && <tr><td colSpan={6} style={{ color: 'var(--muted)' }}>No receipts yet.</td></tr>}
        </tbody></table>
        {isAdmin && <div style={{ fontSize: 11.5, color: 'var(--ink-mute)', marginTop: 12 }}>Case margins and payout detail moved to the admin-only <b>Financials</b> tab.</div>}
      </div>
    </div>
  );
}

/* ================= add bill / invoice (files inline, payout auto) ================= */
function BillModal({ p, md, mut, onClose }: any) {
  const [mode, setMode] = useState<'itemized' | 'invoice'>('itemized');
  const [providerId, setProviderId] = useState(p.provLinks[0]?.providerId || '');
  const [dos, setDos] = useState(todayISO());
  const [billed, setBilled] = useState('');
  const [descr, setDescr] = useState('');
  const [items, setItems] = useState([{ cpt: '', units: '1', charge: '' }]);
  const [busy, setBusy] = useState(false);
  const billRef = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLInputElement>(null);
  const [billName, setBillName] = useState('');
  const [noteName, setNoteName] = useState('');
  const [ocring, setOcring] = useState(false);

  // OCR autofill: sends the attached bill to /bills/parse (Textract). Fills what it read;
  // everything stays editable, and the CPT-lines-must-equal-billed check still applies.
  const ocr = async () => {
    const billFile = billRef.current?.files?.[0];
    if (!billFile) return alert('Attach the bill document first — then I can read it');
    const fd = new FormData();
    fd.append('file', billFile);
    setOcring(true);
    try {
      const res = await fetch('/api/bills/parse', { method: 'POST', body: fd, credentials: 'same-origin' });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || res.statusText);
      if (data.dos) setDos(data.dos);
      if (data.total) setBilled(String(data.total));
      if (data.lines?.length) {
        setMode('itemized');
        setItems(data.lines.map((l: any) => ({ cpt: l.cpt || '', units: String(l.units || 1), charge: String(l.charge || '') })));
      }
      if (!data.dos && !data.total && !data.lines?.length) alert("Couldn't find a date, total, or line items on that document — enter them by hand");
    } catch (e: any) { alert(e.message); } finally { setOcring(false); }
  };

  const lineSum = items.reduce((s, x) => s + (parseFloat(x.charge) || 0) * (parseFloat(x.units) || 1), 0);
  const billedNum = parseFloat(billed) || 0;
  const mismatch = mode === 'itemized' && billedNum > 0 && Math.abs(lineSum - billedNum) > 0.01;
  const setItem = (i: number, k: string, v: string) => setItems(xs => xs.map((x, j) => j === i ? { ...x, [k]: v } : x));

  const save = async () => {
    const billFile = billRef.current?.files?.[0];
    const noteFile = noteRef.current?.files?.[0];
    if (!providerId) return alert('Pick the provider');
    if (!billFile) return alert('Attach the bill document — it’s required');
    if (mode === 'invoice' && !descr.trim()) return alert('General invoices need a description');
    if (mode === 'itemized' && mismatch) return alert(`CPT lines total ${fmt$(lineSum)} but the billed amount is ${fmt$(billedNum)} — they must match exactly`);
    const fd = new FormData();
    fd.append('bill', billFile);
    if (noteFile) fd.append('note', noteFile);
    fd.append('providerId', providerId); fd.append('dos', dos); fd.append('billed', billed);
    fd.append('mode', mode); fd.append('descr', descr);
    fd.append('items', JSON.stringify(items.filter(x => x.cpt.trim()).map(x => ({ cpt: x.cpt.trim(), units: parseFloat(x.units) || 1, charge: parseFloat(x.charge) || 0 }))));
    setBusy(true);
    try {
      await mut(async () => {
        const res = await fetch(`/api/patients/${p.id}/bills2`, { method: 'POST', body: fd, credentials: 'same-origin' });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error || res.statusText);
        return data;
      });
      onClose();
    } catch (e: any) { alert(e.message); } finally { setBusy(false); }
  };

  const inp = { border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px', fontSize: 13, width: '100%' } as const;
  return (
    <div className="overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ maxWidth: 640 }}>
        <h2>Add bill — one date of service</h2>
        <div className="subtabs" style={{ marginBottom: 12 }}>
          <span className={'subtab' + (mode === 'itemized' ? ' active' : '')} onClick={() => setMode('itemized')}>Itemized bill (CPT lines)</span>
          <span className={'subtab' + (mode === 'invoice' ? ' active' : '')} onClick={() => setMode('invoice')}>General invoice</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 10 }}>
          <div><label style={{ fontSize: 11.5, color: 'var(--ink-mute)' }}>Provider*</label>
            <select style={inp} value={providerId} onChange={e => setProviderId(e.target.value)}>
              {p.provLinks.map((l: any) => <option key={l.providerId} value={l.providerId}>{md(l.providerId)?.name || l.providerId}</option>)}
            </select></div>
          <div><label style={{ fontSize: 11.5, color: 'var(--ink-mute)' }}>Date of service*</label>
            <input style={inp} type="date" value={dos} onChange={e => setDos(e.target.value)} /></div>
          <div><label style={{ fontSize: 11.5, color: 'var(--ink-mute)' }}>Billed amount ($)*</label>
            <input style={inp} type="number" value={billed} onChange={e => setBilled(e.target.value)} /></div>
        </div>
        {mode === 'itemized' ? (
          <div style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 11.5, color: 'var(--ink-mute)' }}>CPT lines* — must total the billed amount</label>
            {items.map((x, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 80px 110px 30px', gap: 6, marginTop: 6 }}>
                <input style={inp} placeholder="CPT (e.g. 98941)" value={x.cpt} onChange={e => setItem(i, 'cpt', e.target.value)} />
                <input style={inp} type="number" placeholder="Units" value={x.units} onChange={e => setItem(i, 'units', e.target.value)} />
                <input style={inp} type="number" placeholder="Charge $" value={x.charge} onChange={e => setItem(i, 'charge', e.target.value)} />
                <button className="btn sm" onClick={() => setItems(xs => xs.length > 1 ? xs.filter((_, j) => j !== i) : xs)}>✕</button>
              </div>))}
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8 }}>
              <button className="btn sm" onClick={() => setItems(xs => [...xs, { cpt: '', units: '1', charge: '' }])}>＋ Add line</button>
              <span className="mono" style={{ fontSize: 12.5, color: mismatch ? 'var(--red)' : 'var(--green-dark)' }}>
                Lines total {fmt$(lineSum)}{billedNum > 0 ? ` of ${fmt$(billedNum)}` : ''}{mismatch ? ' — must match' : lineSum > 0 && !mismatch && billedNum > 0 ? ' ✓' : ''}</span>
            </div>
          </div>
        ) : (
          <div style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 11.5, color: 'var(--ink-mute)' }}>Description*</label>
            <input style={inp} placeholder="e.g. MRI lumbar spine — outside imaging invoice" value={descr} onChange={e => setDescr(e.target.value)} />
          </div>)}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 4 }}>
          <div><label style={{ fontSize: 11.5, color: 'var(--ink-mute)' }}>Bill document* (PDF/image)</label>
            <input ref={billRef} type="file" style={{ fontSize: 12 }} onChange={e => setBillName(e.target.files?.[0]?.name || '')} />
            {billName && <div style={{ fontSize: 11, color: 'var(--green-dark)' }}>✓ {billName}</div>}</div>
          <div><label style={{ fontSize: 11.5, color: 'var(--ink-mute)' }}>Visit note (unlocks payment)</label>
            <input ref={noteRef} type="file" style={{ fontSize: 12 }} onChange={e => setNoteName(e.target.files?.[0]?.name || '')} />
            {noteName && <div style={{ fontSize: 11, color: 'var(--green-dark)' }}>✓ {noteName}</div>}</div>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--ink-mute)', margin: '8px 0 4px' }}>
          Payout is calculated automatically from contracted terms — nothing to enter.{' '}
          <button className="btn sm" disabled={ocring || !billName} title={billName ? 'Read DOS, total, and CPT lines off the attached bill' : 'Attach the bill document first'}
            onClick={ocr}>{ocring ? 'Reading…' : 'Read from upload'}</button>
        </div>
        <div className="mactions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Add bill'}</button>
        </div>
      </div>
    </div>
  );
}

/* ================= financials — admin-only margins tab ================= */
function FinancialsTab({ p }: any) {
  const [fin, setFin] = useState<any>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api('GET', `/patients/${p.id}/financials`).then(setFin).catch(e => setErr(e.message)); }, [p.id]);
  if (err) return <div className="card"><div className="cbody">{err}</div></div>;
  if (!fin) return null;
  const c = fin.case;
  const money = (n: number | null | undefined) => n == null ? '—' : fmt$(n);
  return (
    <div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="chead"><h3>Case economics — admin only</h3>
          <span style={{ fontSize: 11.5, color: 'var(--ink-mute)' }}>Payout figures live only on this tab. Everywhere else shows bills as paid in full.</span></div>
        <div className="cbody">
          <div className="statrow">
            <div className="stat"><div className="sv">{money(c.billedTotal)}</div><div className="sl">Total billed</div></div>
            <div className="stat"><div className="sv money-in">{money(c.received)}</div><div className="sl">Carrier paid us (cleared)</div></div>
            <div className="stat"><div className="sv" style={{ color: 'var(--amber)' }}>{money(c.pendingIn)}</div><div className="sl">Receipts pending</div></div>
            <div className="stat"><div className="sv money-out">{money(c.payoutPaid)}</div><div className="sl">Paid to providers (actual)</div></div>
            <div className="stat"><div className="sv">{money(c.marginRealized)}{c.marginRealizedPct != null ? ` (${c.marginRealizedPct}%)` : ''}</div><div className="sl">Margin realized (cash)</div></div>
            <div className="stat"><div className="sv">{money(c.marginProjected)}{c.marginProjectedPct != null ? ` (${c.marginProjectedPct}%)` : ''}</div><div className="sl">Margin projected (contracted)</div></div>
            <div className="stat"><div className="sv">{c.carrierPctOfBilled != null ? c.carrierPctOfBilled + '%' : '—'}</div><div className="sl">Carrier pays (% of billed)</div></div>
          </div>
        </div>
      </div>
      <div className="card">
        <div className="chead"><h3>Per-provider margins{fin.zip ? ` · Medicare benchmarked at ZIP ${fin.zip}` : ' · no ZIP on the patient address — Medicare comparison unavailable'}</h3></div>
        <div className="cbody" style={{ overflowX: 'auto' }}>
          <table><tbody>
            <tr><th>Provider</th><th>Bills</th><th>Billed</th><th>We pay (contracted)</th><th>% of billed</th><th>Medicare total</th><th>× Medicare</th><th>Carrier pays</th><th>% of billed</th><th>Margin (proj.)</th></tr>
            {fin.providers.map((x: any) => (
              <tr key={x.providerId}>
                <td><b>{x.name}</b><div style={{ fontSize: 11, color: 'var(--ink-mute)' }}>{x.type || ''} · {x.medicareCoverage}</div></td>
                <td className="mono">{x.bills}</td>
                <td className="mono">{money(x.billedTotal)}</td>
                <td className="mono money-out">{money(x.payoutTotal)}</td>
                <td className="mono">{x.payoutPctOfBilled != null ? x.payoutPctOfBilled + '%' : '—'}</td>
                <td className="mono">{money(x.medicareTotal)}</td>
                <td className="mono">{x.medicareMultiple != null ? x.medicareMultiple + '×' : '—'}</td>
                <td className="mono money-in">{money(x.revenueTotal || null)}</td>
                <td className="mono">{x.carrierPctOfBilled != null ? x.carrierPctOfBilled + '%' : '—'}</td>
                <td className="mono">{money(x.marginProjected)}</td>
              </tr>))}
            {!fin.providers.length && <tr><td colSpan={10} style={{ color: 'var(--muted)' }}>No bills yet.</td></tr>}
          </tbody></table>
          <div style={{ fontSize: 11.5, color: 'var(--ink-mute)', marginTop: 10, lineHeight: 1.6 }}>
            <b>× Medicare</b> = contracted payout ÷ the Medicare-allowed total for the same CPT lines at this patient’s ZIP (from the fee tool’s live CMS data). Lines without CPT codes or outside the loaded code list aren’t benchmarked. <b>Margin projected</b> uses contracted carrier revenue where on file, billed otherwise.
          </div>
        </div>
      </div>
    </div>
  );
}

/* ================= messages (portal thread, staff side) ================= */
function MessagesTab({ p, mut }: any) {
  const [text, setText] = useState('');
  const send = async () => {
    if (!text.trim()) return;
    await mut(() => api('POST', `/patients/${p.id}/messages`, { text }));
    setText('');
  };
  return (
    <div className="card" style={{ maxWidth: 760 }}>
      <div className="chead"><h3>Case messages — visible to the provider & carrier portals</h3></div>
      <div className="cbody">
        <div className="notesticky">
          <input placeholder="Reply to the provider/carrier on this case…" value={text}
            onChange={e => setText(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()} />
          <button className="btn sm primary" onClick={send}>Send</button>
        </div>
        {(p.messages || []).map((m: any) => (
          <div key={m.id} className={'note' + (m.authorType === 'staff' ? ' sys' : '')}>
            <div className="nmeta">{m.time} · {m.authorName} · <span className={'badge ' + (m.authorType === 'staff' ? 'b-blue' : m.authorType === 'provider' ? 'b-green' : 'b-purple')}>{m.authorType}</span></div>
            {m.text}
          </div>))}
        {!(p.messages || []).length && <div style={{ color: 'var(--muted)' }}>No portal messages on this case yet.</div>}
      </div>
    </div>
  );
}

/* ================= reconcile modal ================= */
function ReconcileModal({ p, receipt, md, onClose, onSave }: any) {
  const [sel, setSel] = useState<string[]>(receipt.billIds || []);
  const candidates = p.bills.filter((b: any) => !b.voided);
  const toggle = (id: string) => setSel(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);
  const selSum = candidates.filter((b: any) => sel.includes(b.id)).reduce((s: number, b: any) => s + b.billed, 0);
  return (
    <div className="overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <h2>Reconcile receipt — {fmt$(receipt.amount)} ({receipt.ref || 'no ref'})</h2>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 12 }}>
          Check the bills this insurance payment covers. Selected billed total: <b style={{ color: 'var(--ink)' }}>{fmt$(selSum)}</b>
          {selSum > 0 && Math.abs(selSum - receipt.amount) > 0.01 && <span style={{ color: 'var(--amber)' }}> (differs from receipt by {fmt$(Math.abs(selSum - receipt.amount))})</span>}
        </div>
        <table><tbody>
          <tr><th></th><th>Provider</th><th>DOS</th><th>Billed</th><th>Status</th></tr>
          {candidates.map((b: any) => (
            <tr key={b.id} style={{ cursor: 'pointer' }} onClick={() => toggle(b.id)}>
              <td><input type="checkbox" checked={sel.includes(b.id)} readOnly /></td>
              <td>{md(b.providerId)?.name}</td>
              <td>{fmtDate(b.dos)}</td>
              <td>{fmt$(b.billed)}</td>
              <td>{b.status === 'paid' ? <span className="badge b-green">Paid</span> : <span className="badge b-amber">Unpaid</span>}</td>
            </tr>))}
          {!candidates.length && <tr><td colSpan={5} style={{ color: 'var(--muted)' }}>No bills on this case yet.</td></tr>}
        </tbody></table>
        <div className="mactions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => onSave(sel)}>Save reconciliation</button>
        </div>
      </div>
    </div>
  );
}

/* ================= contracts (send) ================= */
const TPL: Record<string, string[]> = {
  pt: ['Medical Bill Pay Agreement', 'HIPAA Release'],
  md: ['Lien Agreement', 'One-Time Lien', "Add'l Authorization Request Form", 'Cancellation of Authorization Form'],
  ins: ['Trilopay Carrier Agreement', 'Trilogy Carrier Agreement'],
};
const isAuthDoc = (name: string) => /auth/i.test(name);

function Contracts({ p, mut, insurer, md, loadIns }: any) {
  const [sendTab, setSendTab] = useState<'pt' | 'md' | 'ins'>('pt');
  const [tpl, setTpl] = useState(TPL.pt[0]);
  const [toIdx, setToIdx] = useState(0);
  const [extra, setExtra] = useState('');
  const [byEmail, setByEmail] = useState(true);
  const [byText, setByText] = useState(false);

  const recips = useMemo(() => ({
    pt: [{ l: `${p.name} — ${p.email || 'no email'}` }],
    md: p.provLinks.map((l: any) => { const pr = md(l.providerId); return { l: `${pr?.name} (corporate) — ${pr?.corpEmail || ''}` }; }),
    ins: insurer ? [{ l: `${insurer.name} — ${insurer.email || ''}` }] : [],
  }), [p, insurer, md])[sendTab];

  useEffect(() => { setTpl(TPL[sendTab][0]); setToIdx(0); }, [sendTab]);

  const send = async () => {
    const methods = [byEmail && 'Email', byText && 'Text'].filter(Boolean).join(' + ');
    if (!methods) { alert('Pick at least one send method'); return; }
    const label = recips[toIdx]?.l || '—';
    const toLabel = label.split(' — ')[0];
    const email = (label.match(/[\w.+-]+@[\w.-]+\.\w+/) || [''])[0];
    try {
      const r = await api('POST', `/patients/${p.id}/sentdocs`, {
        name: tpl, method: methods, email,
        to: toLabel + (extra.trim() ? ` +${extra.split(',').length} more` : ''),
      });
      await mut(async () => r);
      openDocFlow(r._doc);   // generated document + prewritten email draft
    } catch (e: any) { alert(e.message || 'Error'); }
    setExtra('');
  };

  const SentTable = ({ authOnly }: { authOnly: boolean }) => {
    const rows = p.sentDocs.filter((d: any) => isAuthDoc(d.name) === authOnly).slice().reverse();
    if (!rows.length) return <div style={{ color: 'var(--muted)', fontSize: 13 }}>Nothing here yet.</div>;
    return (
      <table><tbody>
        <tr><th>Document</th><th>To</th><th>Via</th><th>Sent</th><th>Status</th></tr>
        {rows.map((d: any) => (
          <tr key={d.id}><td><b>{d.name}</b></td><td>{d.to}</td><td>{d.method}</td><td>{d.time}</td>
            <td><span className={'badge ' + (d.status === 'Signed' ? 'b-green' : d.status === 'Viewed' ? 'b-amber' : 'b-blue')}
              style={{ cursor: 'pointer' }} title="Click to advance (stands in for the e-sign webhook)"
              onClick={() => d.status !== 'Signed' && mut(() => api('POST', `/sentdocs/${d.id}/advance`))}>
              {d.status === 'Signed' ? '✓ Signed' : d.status}</span></td></tr>))}
      </tbody></table>);
  };

  return (
    <div className="grid2">
      <div className="card">
        <div className="chead"><h3>Send a contract or templated doc</h3></div>
        <div className="cbody">
          <div className="subtabs">
            {([['pt', 'Patient'], ['md', 'Medical provider'], ['ins', 'Insurance']] as ['pt' | 'md' | 'ins', string][]).map(([k, l]) => (
              <span key={k} className={'subtab' + (sendTab === k ? ' active' : '')} onClick={() => setSendTab(k)}>{l}</span>))}
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 10 }}>
            Templates auto-fill with <b style={{ color: 'var(--ink)' }}>{p.name} · {p.id}</b> and case details. Recipient auto-fills — add more below.</div>
          <div className="mfield" style={{ marginBottom: 10 }}><label>Template</label>
            <select value={tpl} onChange={e => setTpl(e.target.value)}>
              {TPL[sendTab].map(t => <option key={t}>{t}</option>)}</select></div>
          <div className="mfield" style={{ marginBottom: 10 }}><label>Recipient (auto-filled)</label>
            <select value={toIdx} onChange={e => setToIdx(Number(e.target.value))}>
              {recips.length ? recips.map((r: any, i: number) => <option key={i} value={i}>{r.l}</option>) : <option value={0}>— none on file —</option>}
            </select></div>
          <div className="mfield" style={{ marginBottom: 10 }}><label>Additional recipients (emails or phone #s, comma separated)</label>
            <input value={extra} onChange={e => setExtra(e.target.value)} placeholder="e.g. attorney@firm.com, (503) 555-0000" /></div>
          <div className="mfield" style={{ marginBottom: 12 }}><label>Send by</label>
            <div style={{ display: 'flex', gap: 16, padding: '4px 0' }}>
              <label style={{ fontWeight: 600, fontSize: 13 }}><input type="checkbox" checked={byEmail} onChange={e => setByEmail(e.target.checked)} /> ✉ Email</label>
              <label style={{ fontWeight: 600, fontSize: 13 }}><input type="checkbox" checked={byText} onChange={e => setByText(e.target.checked)} /> Text (SMS)</label>
            </div></div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" onClick={send}>Send</button>
            <button className="btn" onClick={() => alert("Preview: template auto-filled with this patient's details (rendering ships with the e-sign integration).")}>Preview filled doc</button>
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 10 }}>
            Sends are logged & tracked. Live e-sign + email/SMS delivery are wired at deployment.</div>
        </div>
      </div>
      <div>
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="chead"><h3>Authorizations sent</h3></div>
          <div className="cbody"><SentTable authOnly={true} /></div>
        </div>
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="chead"><h3>Contracts & documents sent</h3></div>
          <div className="cbody"><SentTable authOnly={false} /></div>
        </div>
        <OneTimeAgreements p={p} mut={mut} loadIns={loadIns} />
      </div>
    </div>
  );
}

function OneTimeAgreements({ p, mut, loadIns }: any) {
  const [list, setList] = useState<any[]>([]);
  const [form, setForm] = useState(false);
  const [v, setV] = useState<any>({});
  const load = () => api('GET', '/agreements').then(all => setList(all.filter((a: any) => a.patientId === p.id))).catch(() => {});
  useEffect(() => { load(); }, [p.id]);
  const create = async () => {
    if (!String(v.providerName || '').trim()) { alert('Provider name required'); return; }
    try {
      await api('POST', '/agreements', { ...v, patientId: p.id, amount: Number(v.amount) || 0 });
      setForm(false); setV({}); load(); loadIns?.();
    } catch (e: any) { alert(e.message); }
  };
  const move = async (a: any, status: string) => { await api('POST', `/agreements/${a.id}/status`, { status }); load(); loadIns?.(); };
  return (
    <div className="card">
      <div className="chead"><h3>One-time agreements</h3>
        <button className="btn sm" onClick={() => setForm(f => !f)}>＋ Start agreement</button></div>
      <div className="cbody">
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
          For uncontracted providers: lock the rate in writing before any payment (four-check #4). Recurring gaps escalate to the Growth queue automatically.</div>
        {form && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
            <div className="mfield"><label>Provider / facility name</label><input value={v.providerName || ''} onChange={e => setV({ ...v, providerName: e.target.value })} /></div>
            <div className="mfield"><label>Service</label><input value={v.service || ''} onChange={e => setV({ ...v, service: e.target.value })} placeholder="e.g. MRI lumbar" /></div>
            <div className="mfield"><label>Agreed amount ($)</label><input type="number" value={v.amount || ''} onChange={e => setV({ ...v, amount: e.target.value })} /></div>
            <div className="mfield" style={{ display: 'flex', alignItems: 'end' }}><button className="btn primary" onClick={create}>Create draft</button></div>
          </div>)}
        <table><tbody>
          <tr><th>Provider</th><th>Service</th><th>Amount</th><th>Status</th><th></th></tr>
          {list.map(a => (
            <tr key={a.id}>
              <td><b>{a.providerName}</b></td><td>{a.service || '—'}</td><td>{a.amount ? fmt$(a.amount) : '—'}</td>
              <td><span className={'badge ' + (a.status === 'signed' ? 'b-green' : a.status === 'declined' ? 'b-red' : 'b-amber')}>{a.status}</span></td>
              <td style={{ whiteSpace: 'nowrap' }}>
                {a.status === 'draft' && <button className="btn sm" onClick={() => move(a, 'sent')}>✉ Mark sent</button>}{' '}
                {a.status === 'sent' && <><button className="btn sm primary" onClick={() => move(a, 'signed')}>✓ Signed</button>{' '}
                  <button className="btn sm" onClick={() => move(a, 'declined')}>✕ Declined</button></>}
              </td>
            </tr>))}
          {!list.length && <tr><td colSpan={5} style={{ color: 'var(--muted)' }}>None on this case.</td></tr>}
        </tbody></table>
      </div>
    </div>
  );
}

/* ================= treating providers ================= */
function OptimizerPanel({ p }: any) {
  const [rank, setRank] = useState<any[] | null>(null);
  const [type, setType] = useState('');
  const types = ['', 'Chiropractic', 'PT / Rehab', 'Imaging / MRI', 'Orthopedic'];
  useEffect(() => {
    api('GET', `/optimizer?patientId=${p.id}${type ? '&type=' + encodeURIComponent(type) : ''}`).then(setRank).catch(() => {});
  }, [type, p.id]);
  if (!rank) return null;
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="chead"><h3>Provider optimizer — lowest contracted cost that still treats well</h3>
        <select value={type} onChange={e => setType(e.target.value)} style={{ fontSize: 12 }}>
          {types.map(t => <option key={t} value={t}>{t || 'All specialties'}</option>)}
        </select></div>
      <div className="cbody">
        <table><tbody>
          <tr><th>Rank</th><th>Provider</th><th>Score</th><th>Cost proxy</th><th>Why</th></tr>
          {rank.slice(0, 5).map((r, i) => (
            <tr key={r.id}>
              <td className="mono">#{i + 1}</td>
              <td><b>{r.name}</b> <span style={{ color: 'var(--ink-mute)', fontSize: 12 }}>{r.type}</span>
                {r.preferred && <span className="badge b-green" style={{ marginLeft: 6 }}>★ Preferred</span>}
                {r.conservative && <span className="badge b-blue" style={{ marginLeft: 4 }}>conservative</span>}</td>
              <td className="mono">{r.score}</td>
              <td className="mono">{r.costProxy != null ? (r.costProxy < 100 ? r.costProxy + '%' : fmt$(r.costProxy)) : '—'}</td>
              <td style={{ fontSize: 12 }}>{r.reasons.join(' · ') || '—'}</td>
            </tr>))}
        </tbody></table>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>
          Ranking = preferred status + conservative-care philosophy + contracted cost + proximity + credentialing. Doctors decide care; we decide who’s in the network. The same ranking drives the pins on the Provider Map.</div>
      </div>
    </div>
  );
}

/* Opens the generated document + the prewritten email draft (Outlook or default mail app).
   The attachment rides along automatically once the email integration is live — until
   then it’s one drag from the downloaded document into the draft. */
function openDocFlow(doc: any) {
  if (!doc) return;
  window.open(doc.url, '_blank');
  setTimeout(() => { window.location.href = doc.mailto; }, 600);
}

function Providers({ p, mut, setModal, md, go, boot }: any) {
  const [dd, setDd] = useState<number | null>(null);
  const [showFormer, setShowFormer] = useState(false);

  const linkProvider = () => {
    const avail = boot.providers.filter((pr: any) => !p.provLinks.some((l: any) => l.providerId === pr.id));
    if (!avail.length) { alert('All providers already linked.'); return; }
    setModal(
      <FormModal title="Link provider to patient" onClose={() => setModal(null)} saveLabel="Link provider"
        fields={[
          { key: 'providerId', label: 'Provider (search)', type: 'search', options: avail.map((pr: any) => ({ v: pr.id, l: `${pr.name} — ${pr.type}` })) },
          { key: 'branch', label: 'Branch', ph: 'e.g. SE Portland', full: true },
        ]}
        onSave={async v => {
          if (!v.providerId) { alert('No provider match'); return; }
          await mut(() => api('POST', `/patients/${p.id}/provlinks`, v)); setModal(null);
        }} />);
  };
  const action = async (l: any, kind: string) => {
    setDd(null);
    let amount: number | undefined;
    if (kind === 'auth' || kind === 'addauth') {
      const v = prompt('Authorization amount ($):', '500');
      if (!v) return;
      amount = parseFloat(v);
      if (!amount) return;
    }
    try {
      const r = await api('POST', `/provlinks/${l.id}/action`, { kind, amount });
      await mut(async () => r);
      openDocFlow(r._doc);
    } catch (e: any) { alert(e.message || 'Error'); }
  };
  const editAuth = async (l: any) => {
    const pr = md(l.providerId);
    const v = prompt(`Corrected authorization TOTAL for ${pr?.name} (currently ${fmt$(l.authAmount)}):`, String(l.authAmount || 0));
    if (v === null) return;
    const amt = parseFloat(v);
    if (!(amt >= 0)) return alert('Enter a valid amount');
    await mut(() => api('PATCH', `/provlinks/${l.id}`, { authAmount: amt }));
  };

  const active = p.provLinks.filter((l: any) => l.status === 'pending' || l.status === 'authorized');
  const former = p.provLinks.filter((l: any) => l.status === 'canceled' || l.status === 'finalized');
  const row = (l: any, i: number) => {
    const pr = md(l.providerId); if (!pr) return null;
    const oneTime = !pr.underContract;
    return (
      <tr key={l.id}>
        <td><span className="link" onClick={() => go({ screen: 'provider', id: pr.id })}>{pr.name}</span><br />
          <span className="idchip">{pr.id}</span> <span className={'badge ' + (oneTime ? 'b-gray' : 'b-green')}>{oneTime ? 'One-time' : 'Contracted'}</span></td>
        <td>{l.branch || '—'}</td><td>{pr.type}</td>
        <td><b>{fmt$(l.authAmount)}</b> <span style={{ color: 'var(--muted)', fontSize: 11 }}>({l.authCount} auth{l.authCount === 1 ? '' : 's'})</span>{' '}
          <span className="addpdf" title="Correct the authorized total (audited)" onClick={() => editAuth(l)}>edit</span></td>
        <td><b>{fmt$(l.billed)}</b>{l.billed > l.authAmount && l.authAmount > 0 && <span style={{ color: 'var(--red)', fontSize: 11, fontWeight: 700 }}> over auth</span>}</td>
        <td><span className={'badge ' + statusBadge(l.status)}>{cap(l.status)}</span></td>
        <td>
          <div className="dd">
            <button className="btn sm" onClick={() => setDd(dd === i ? null : i)}>Send… ▾</button>
            {dd === i && (
              <div className="ddmenu">
                <div className="ddi" onClick={() => action(l, 'auth')}><b>Send authorization</b><small>Creates the auth document + opens the email draft — sets Authorized</small></div>
                <div className="ddi" onClick={() => action(l, 'reqform')}><b>Send add’l auth request form</b><small>Blank form for the provider to fill & send back</small></div>
                <div className="ddi" onClick={() => action(l, 'addauth')}><b>Send add’l authorization</b><small>Grant additional $ — adds to the auth total</small></div>
                <div className={'ddi' + (l.status === 'canceled' || l.status === 'finalized' ? ' dis' : '')} onClick={() => action(l, 'cxl')}><b>Send cancel-auth form</b><small>Verifies all transactions; provider must sign — sets Canceled</small></div>
                <div className={'ddi' + (l.status !== 'canceled' ? ' dis' : '')} onClick={() => action(l, 'cxlback')}><b>Mark cxl form returned (signed)</b><small>Finalizes the provider on this case</small></div>
              </div>)}
          </div>
        </td>
      </tr>);
  };

  return (
    <div>
    <OptimizerPanel p={p} />
    <div className="card">
      <div className="chead"><h3>Treating providers — actively on this case</h3>
        <button className="btn sm primary" onClick={linkProvider}>＋ Add provider (or pick from map)</button></div>
      <div className="cbody">
        <table><tbody>
          <tr><th>Provider</th><th>Branch</th><th>Type</th><th>Auth total</th><th>Amount billed</th><th>Status</th><th></th></tr>
          {active.map(row)}
          {!active.length && <tr><td colSpan={7} style={{ color: 'var(--muted)' }}>No providers actively treating — add one above or from the map.</td></tr>}
        </tbody></table>
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 10 }}>
          Every send generates the actual document and opens a prewritten email — drag the downloaded doc into the draft (attaches automatically once the email integration is live).
          Status flow: <b>Pending</b> → <b>Authorized</b> → <b>Canceled</b> → <b>Finalized</b>.</div>
        {former.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <span className="fin-toggle" onClick={() => setShowFormer(f => !f)}>No longer treating ({former.length}) ▾</span>
            {showFormer && <table style={{ marginTop: 8 }}><tbody>
              <tr><th>Provider</th><th>Branch</th><th>Type</th><th>Auth total</th><th>Amount billed</th><th>Status</th><th></th></tr>
              {former.map(row)}
            </tbody></table>}
          </div>)}
      </div>
    </div>
    </div>
  );
}

/* ================= insurance tab ================= */
function InsuranceTab({ p, insurer, adj, go, mut }: any) {
  if (!insurer) return <div className="card"><div className="cbody" style={{ color: 'var(--muted)' }}>No insurance company linked. Edit the profile to add one.</div></div>;
  const authedOut = p.provLinks.reduce((s: number, l: any) => s + (l.authAmount || 0), 0);
  const carrierAuth = p.carrierAuthorized || 0;
  const remaining = carrierAuth - authedOut;
  const editCarrierAuth = async () => {
    const v = prompt(`Carrier-authorized amount for this case (what ${insurer.name} has approved us to spend):`, String(carrierAuth || ''));
    if (v === null) return;
    const amt = parseFloat(v);
    if (!(amt >= 0)) return alert('Enter a valid amount');
    await mut(() => api('PATCH', `/patients/${p.id}`, { carrierAuthorized: amt }));
  };
  return (
    <div className="grid2">
      <div className="card" style={{ gridColumn: '1/-1' }}>
        <div className="chead"><h3>Carrier authorization envelope</h3>
          <button className="btn sm" onClick={editCarrierAuth}>Edit carrier-authorized amount</button></div>
        <div className="cbody">
          <div className="statrow">
            <div className="stat"><div className="sv">{carrierAuth ? fmt$(carrierAuth) : '—'}</div><div className="sl">Carrier has authorized</div></div>
            <div className="stat"><div className="sv">{fmt$(authedOut)}</div><div className="sl">Authorized out to providers</div></div>
            <div className="stat"><div className={'sv' + (carrierAuth && remaining < 0 ? ' bad' : '')} style={carrierAuth && remaining < 0 ? { color: 'var(--red)' } : undefined}>{carrierAuth ? fmt$(remaining) : '—'}</div><div className="sl">Remaining to authorize</div></div>
          </div>
          <div style={{ fontSize: 12, color: 'var(--ink-mute)', marginTop: 8 }}>
            {carrierAuth
              ? remaining < 0
                ? 'Provider authorizations exceed what the carrier has approved — get the carrier authorization raised before sending more.'
                : 'You can send provider authorizations up to the remaining amount without going back to the carrier.'
              : 'No carrier authorization recorded yet — set it when the adjuster confirms what’s approved for this case.'}</div>
        </div>
      </div>
      <div className="card">
        <div className="chead"><h3>{insurer.name} — case info</h3>
          <button className="btn sm" onClick={() => go({ screen: 'insurance', id: insurer.id })}>Open full profile →</button></div>
        <div className="cbody"><dl className="kv">
          <dt>Claim #</dt><dd>{p.claimNumber || '—'}</dd>
          <dt>Policy #</dt><dd>{p.policyNumber || '—'}</dd>
          <dt>Adjuster</dt><dd>{adj?.name || '—'}</dd>
          <dt>Adjuster phone</dt><dd>{adj?.phone || '—'}</dd>
          <dt>Adjuster email</dt><dd>{adj?.email || '—'}</dd>
          <dt>Adjuster notes</dt><dd>{adj?.notes || '—'}</dd>
          <dt>Payment rate</dt><dd>{insurer.payRate || '—'}</dd>
        </dl></div>
      </div>
      <div className="card">
        <div className="chead"><h3>Business rules</h3></div>
        <div className="cbody" style={{ fontSize: 13, lineHeight: 1.8 }}>
          {insurer.rules.map((r: string, i: number) => <div key={i}>· {r}</div>)}
          {!insurer.rules.length && '—'}</div>
      </div>
      <div className="card" style={{ gridColumn: '1/-1' }}>
        <div className="chead"><h3>Contracts with {insurer.name}</h3></div>
        <div className="cbody">
          {insurer.contracts.map((c: any) => (
            <div key={c.id} className="doc"><div className="dic">▤</div>
              <div style={{ flex: 1 }}><b>{c.name}</b><div className="dmeta">{c.scope === 'adjuster' ? 'Adjuster contract · ' : 'Carrier master · '}{c.meta}</div></div>
              <span className={'badge ' + (c.status === 'Active' ? 'b-green' : 'b-amber')}>{c.status === 'Active' ? '✓ Active' : c.status}</span></div>))}
          {!insurer.contracts.length && <div style={{ color: 'var(--muted)' }}>No contracts on file.</div>}
        </div>
      </div>
    </div>
  );
}

/* ================= documents ================= */
const DOC_CATS = ['All', 'Other', 'Contract', 'Insurance', 'Medical', 'Billing'];
function Docs({ p, mut }: any) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [cat, setCat] = useState('Other');
  const [filter, setFilter] = useState('All');
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return;
    await mut(() => apiUpload(`/patients/${p.id}/documents`, f, { cat }));
    if (fileRef.current) fileRef.current.value = '';
  };
  const shown = p.documents.filter((d: any) => filter === 'All' || d.cat === filter);
  return (
    <div className="card">
      <div className="chead"><h3>Documents</h3>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select value={cat} onChange={e => setCat(e.target.value)} title="Category for the next upload"
            style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '6px 8px', fontSize: 12 }}>
            {DOC_CATS.slice(1).map(c => <option key={c}>{c}</option>)}
          </select>
          <button className="btn sm primary" onClick={() => fileRef.current?.click()}>＋ Upload</button>
          <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={onFile} />
        </div></div>
      <div className="cbody">
        <div className="mapfilters" style={{ marginBottom: 12 }}>
          <span style={{ fontWeight: 700, padding: '6px 4px 0 0', color: 'var(--muted)', fontSize: 12 }}>FILTER:</span>
          {DOC_CATS.map(c => {
            const n = c === 'All' ? p.documents.length : p.documents.filter((d: any) => d.cat === c).length;
            return <span key={c} className={'chipf' + (filter === c ? ' on' : '')} onClick={() => setFilter(c)}>{c}{n ? ` (${n})` : ''}</span>;
          })}
        </div>
        {shown.map((d: any) => (
          <div key={d.id} className="doc">
            <div className="dic">▤</div>
            <div style={{ flex: 1 }}><b>{d.name}</b><div className="dmeta">{d.cat} · {d.meta}</div></div>
            <button className="btn sm" onClick={() => d.fileId ? window.open('/api/files/' + d.fileId) : alert('Demo record — no stored file')}>View</button>
          </div>))}
        {!shown.length && <div style={{ color: 'var(--muted)' }}>{p.documents.length ? 'Nothing in this category.' : 'No documents yet.'}</div>}
      </div>
    </div>
  );
}

/* ================= provider map — pins, distance, drive time ================= */
declare const L: any;
function haversineMi(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const R = 3958.8, dLat = (b.lat - a.lat) * Math.PI / 180, dLon = (b.lon - a.lon) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function MapTab({ p, mut, boot, go }: any) {
  const [filter, setFilter] = useState('All');
  const [pins, setPins] = useState<any[]>([]);          // {provider, branch, lat, lon}
  const [ptLoc, setPtLoc] = useState<any>(null);
  const [sel, setSel] = useState<any>(null);            // selected pin + drive info
  const [status, setStatus] = useState('Loading map…');
  const [rank, setRank] = useState<any[]>([]);
  const mapRef = useRef<any>(null);
  const layerRef = useRef<any>(null);
  const divRef = useRef<HTMLDivElement>(null);
  const types = ['All', 'Chiropractic', 'Imaging / MRI', 'PT / Rehab', 'Orthopedic', 'Preferred only'];

  useEffect(() => { api('GET', `/optimizer?patientId=${p.id}`).then(setRank).catch(() => {}); }, [p.id]);

  // geocode patient + provider branches (server-side cache keeps this cheap)
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        let home: any = null;
        if (p.address) {
          try { home = await api('GET', '/geo/code?q=' + encodeURIComponent(p.address)); } catch { /* no patient pin */ }
        }
        if (!dead) setPtLoc(home);
        const out: any[] = [];
        for (const pr of boot.providers) {
          for (const b of pr.branches) {
            if (!b.address) continue;
            try {
              const g = await api('GET', '/geo/code?q=' + encodeURIComponent(b.address));
              out.push({ provider: pr, branch: b, lat: g.lat, lon: g.lon });
            } catch { /* skip unresolvable */ }
          }
        }
        if (!dead) { setPins(out); setStatus(out.length ? '' : 'No provider addresses could be located.'); }
      } catch { if (!dead) setStatus('Map data unavailable — geocoding service unreachable.'); }
    })();
    return () => { dead = true; };
  }, [p.id, boot.providers]);

  const shownPins = pins.filter(x =>
    filter === 'All' ? true : filter === 'Preferred only' ? x.provider.status.includes('Preferred') : x.provider.type === filter);

  // build / update the Leaflet map
  useEffect(() => {
    if (typeof L === 'undefined' || !divRef.current) return;
    if (!mapRef.current) {
      mapRef.current = L.map(divRef.current).setView([ptLoc?.lat || 32.78, ptLoc?.lon || -96.8], 10);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap contributors' }).addTo(mapRef.current);
      layerRef.current = L.layerGroup().addTo(mapRef.current);
    }
    const layer = layerRef.current;
    layer.clearLayers();
    const bounds: any[] = [];
    if (ptLoc) {
      L.circleMarker([ptLoc.lat, ptLoc.lon], { radius: 9, color: '#2D3647', fillColor: '#F5A623', fillOpacity: 1, weight: 2 })
        .bindTooltip(`${p.name} (patient)`).addTo(layer);
      bounds.push([ptLoc.lat, ptLoc.lon]);
    }
    for (const x of shownPins) {
      const linked = p.provLinks.some((l: any) => l.providerId === x.provider.id);
      const m = L.circleMarker([x.lat, x.lon], {
        radius: 8, weight: 2, color: '#2D3647',
        fillColor: linked ? '#45A8EB' : x.provider.status.includes('Preferred') ? '#5E9E44' : '#8B93A3', fillOpacity: 0.95,
      }).bindTooltip(`${x.provider.name} — ${x.branch.name}`).addTo(layer);
      m.on('click', async () => {
        const dist = ptLoc ? haversineMi(ptLoc, x) : null;
        const r = rank.find((z: any) => z.id === x.provider.id);
        setSel({ ...x, linked, dist, score: r?.score, reasons: r?.reasons || [], drive: null });
        if (ptLoc) {
          try {
            const rt = await api('GET', `/geo/route?flat=${ptLoc.lat}&flon=${ptLoc.lon}&tlat=${x.lat}&tlon=${x.lon}`);
            setSel((s: any) => s && s.provider.id === x.provider.id && s.branch.name === x.branch.name
              ? { ...s, drive: { min: Math.round(rt.seconds / 60), mi: Math.round(rt.meters / 1609 * 10) / 10 } } : s);
          } catch { setSel((s: any) => s ? { ...s, drive: 'unavailable' } : s); }
        }
      });
      bounds.push([x.lat, x.lon]);
    }
    if (bounds.length) mapRef.current.fitBounds(bounds, { padding: [30, 30], maxZoom: 12 });
  }, [shownPins.length, ptLoc, filter, rank, p.provLinks.length]);

  useEffect(() => () => { if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; } }, []);

  return (
    <div>
      <div className="mapfilters">
        <span style={{ fontWeight: 700, padding: '6px 4px 0 0', color: 'var(--muted)', fontSize: 12 }}>FILTER:</span>
        {types.map(t => <span key={t} className={'chipf' + (filter === t ? ' on' : '')} onClick={() => setFilter(t)}>{t}</span>)}
      </div>
      <div className="maplayout">
        <div className="card">
          <div className="chead"><h3>{sel ? 'Selected provider' : 'Click a pin'}</h3></div>
          <div className="cbody" style={{ maxHeight: 460, overflowY: 'auto' }}>
            {sel ? (
              <div>
                <b className="link" style={{ fontSize: 15 }} onClick={() => go({ screen: 'provider', id: sel.provider.id })}>{sel.provider.name}</b>
                {sel.provider.status.includes('Preferred') && <span className="badge b-green" style={{ marginLeft: 6 }}>★ Preferred</span>}
                <div style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: '4px 0 10px' }}>{sel.provider.type} · {sel.branch.name}<br />{sel.branch.address}</div>
                <div className="statrow">
                  <div className="stat"><div className="sv">{sel.dist != null ? sel.dist.toFixed(1) + ' mi' : '—'}</div><div className="sl">From patient (straight line)</div></div>
                  <div className="stat"><div className="sv">{sel.drive === 'unavailable' ? '—' : sel.drive ? `${sel.drive.min} min` : ptLoc ? '…' : '—'}</div><div className="sl">Drive time{sel.drive && sel.drive !== 'unavailable' ? ` (${sel.drive.mi} mi)` : ''}</div></div>
                  <div className="stat"><div className="sv">{sel.score ?? '—'}</div><div className="sl">Optimizer score</div></div>
                </div>
                {sel.reasons.length > 0 && <div style={{ fontSize: 12, color: 'var(--ink-soft)', margin: '8px 0' }}>{sel.reasons.join(' · ')}</div>}
                {sel.linked
                  ? <span className="badge b-blue">✓ Already on this case</span>
                  : <button className="btn sm primary" onClick={() => mut(() => api('POST', `/patients/${p.id}/provlinks`, { providerId: sel.provider.id, branch: sel.branch.name || null }))}>＋ Link to patient</button>}
              </div>
            ) : (
              <div style={{ fontSize: 12.5, color: 'var(--ink-soft)', lineHeight: 1.7 }}>
                {status || <>The patient is the marigold dot. <span style={{ color: '#45A8EB', fontWeight: 700 }}>Blue</span> pins are already on this case, <span style={{ color: 'var(--green-dark)', fontWeight: 700 }}>green</span> pins are preferred network, grey are the rest. Click any pin for distance, drive time, and the optimizer’s take.</>}
              </div>)}
            <div style={{ marginTop: 14, fontSize: 11, color: 'var(--ink-mute)' }}>
              Maps © OpenStreetMap · drive times via OSRM. The optimizer list view lives on the Treating Providers tab.</div>
          </div>
        </div>
        <div>
          <div ref={divRef} className="mapiframe" style={{ minHeight: 460 }} />
        </div>
      </div>
    </div>
  );
}
