import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { AppCtx, SearchBox, useApp } from '../App';
import { FormModal, FieldSpec } from '../ui';
import type { HomeTask } from '../types';
import { STAGES, fmtDate, fmtK, todayISO } from '../types';

export function Home() {
  const { boot, go, refresh } = useApp();
  const [tasks, setTasks] = useState<HomeTask[]>([]);
  const [modal, setModal] = useState<'pt' | 'md' | 'ins' | null>(null);
  const [dash, setDash] = useState<any>(null);

  const loadTasks = () => api('GET', '/tasks').then(setTasks);
  useEffect(() => {
    loadTasks();
    if (boot.user.role === 'admin') api('GET', '/dashboard').then(setDash).catch(() => {});
  }, []);

  const today = todayISO();
  const active = boot.patients.filter(p => p.stage < 4).length;
  const closed = boot.patients.filter(p => p.stage >= 4).length;
  const tl = boot.patients.filter(p => p.caseType === 'trilopay' && p.stage < 4).length;
  const tg = boot.patients.filter(p => p.caseType === 'trilogy' && p.stage < 4).length;
  const overdue = tasks.filter(t => t.due && t.due < today).length;
  const dueToday = tasks.filter(t => t.due && t.due <= today).length;

  const complete = async (id: string) => { await api('POST', `/tasks/${id}/complete`); loadTasks(); };

  const ptFields: FieldSpec[] = [
    { key: 'name', label: 'Full name*' },
    { key: 'caseType', label: 'Case type*', type: 'select', options: [{ v: 'trilopay', l: 'Trilopay — PIP (1st party)' }, { v: 'trilogy', l: 'Trilogy — BI (3rd party)' }] },
    { key: 'phone', label: 'Phone' }, { key: 'email', label: 'Email', type: 'email' },
    { key: 'address', label: 'Address', full: true },
    { key: 'dob', label: 'Date of birth', type: 'date' }, { key: 'doi', label: 'Date of injury', type: 'date' },
    { key: 'state', label: 'State of accident', ph: 'e.g. Oregon' },
    { key: 'insurerId', label: 'Insurance company (search)', type: 'search', options: boot.insurers.map(i => ({ v: i.id, l: `${i.name} (${i.id})` })) },
    { key: 'claimNumber', label: 'Claim #' }, { key: 'policyNumber', label: 'Policy #' },
    { key: 'adjusterName', label: 'Adjuster (name, if known)' },
    { key: 'agentName', label: 'Insurance agent (name)' },
    { key: 'agentContact', label: 'Agent phone/email' },
    { key: 'referralSource', label: 'Referral source', type: 'select', options: [{ v: '', l: '—' }, { v: 'carrier', l: 'Carrier / adjuster' }, { v: 'agent', l: 'Insurance agent' }, { v: 'provider', l: 'Provider' }, { v: 'other', l: 'Other' }] },
    { key: 'coordinator', label: 'Case coordinator (search)', type: 'search', value: boot.user.id, options: boot.users.map(u => ({ v: u.id, l: u.name })) },
    { key: 'companionId', label: 'Companion claim (search patient)', type: 'search', options: boot.patients.map(p => ({ v: p.id, l: `${p.name} (${p.id})` })) },
    { key: 'accident', label: 'Accident description', type: 'textarea', full: true },
  ];
  const mdFields: FieldSpec[] = [
    { key: 'name', label: 'Provider name*' },
    { key: 'type', label: 'Type', type: 'select', options: ['Chiropractic', 'Imaging / MRI', 'PT / Rehab', 'Orthopedic', 'Pain management', 'Other'].map(x => ({ v: x, l: x })) },
    { key: 'status', label: 'Status', type: 'select', options: [{ v: 'Preferred,Under contract', l: 'Preferred + under contract' }, { v: 'Under contract', l: 'Under contract' }, { v: 'Single case agreement', l: 'Single case agreement' }] },
    { key: 'taxId', label: 'Tax ID' },
    { key: 'corpAddress', label: 'Corporate address', full: true },
    { key: 'corpPhone', label: 'Corporate phone' }, { key: 'corpEmail', label: 'Corporate email', type: 'email' },
    { key: 'rules', label: 'Business rules (one per line)', type: 'textarea', full: true },
    { key: 'bName', label: 'First branch — name', full: true },
    { key: 'bAddress', label: 'Branch address', full: true },
    { key: 'bPhone', label: 'Branch phone' }, { key: 'bEmail', label: 'Branch email', type: 'email' },
    { key: 'bContacts', label: 'Branch contacts', full: true },
    { key: 'bRate', label: 'Agreed payment rate', ph: 'e.g. 60% of billed / $280 per visit cap', full: true },
  ];
  const insFields: FieldSpec[] = [
    { key: 'name', label: 'Company name*' },
    { key: 'hq', label: 'HQ address', full: true },
    { key: 'phone', label: 'Phone' }, { key: 'email', label: 'Email', type: 'email' },
    { key: 'relationship', label: 'Relationship contact', ph: 'e.g. Regional claims VP — name', full: true },
    { key: 'payRate', label: 'Payment rate (if any)', full: true },
    { key: 'states', label: 'States active (comma separated)', ph: 'OR, WA, ID', full: true },
    { key: 'rules', label: 'Business rules (one per line)', type: 'textarea', full: true },
    { key: 'aName', label: 'First adjuster — name' }, { key: 'aPhone', label: 'Adjuster phone' },
    { key: 'aEmail', label: 'Adjuster email', type: 'email', full: true },
  ];

  const createPt = async (v: Record<string, string>) => {
    if (!v.name.trim()) { alert('Name is required'); return; }
    let p;
    try {
      p = await api('POST', '/patients', v);
    } catch (e: any) {
      if (e.status === 409 && e.data?.duplicates) {
        const list = e.data.duplicates.map((d: any) => `• ${d.name} (${d.id})${d.dob ? ' · DOB ' + fmtDate(d.dob) : ''}`).join('\n');
        if (!confirm(`⚠ Possible duplicate patient:\n\n${list}\n\nCreate a new profile anyway?`)) return;
        p = await api('POST', '/patients', { ...v, force: true });
      } else throw e;
    }
    await refresh(); setModal(null); go({ screen: 'patient', id: p.id });
  };
  const createMd = async (v: Record<string, string>) => {
    if (!v.name.trim()) { alert('Name is required'); return; }
    const p = await api('POST', '/providers', {
      name: v.name, type: v.type, status: v.status.split(','), taxId: v.taxId,
      corpAddress: v.corpAddress, corpPhone: v.corpPhone, corpEmail: v.corpEmail,
      rules: v.rules.split('\n').filter(x => x.trim()),
      branch: v.bName ? { name: v.bName, address: v.bAddress, phone: v.bPhone, email: v.bEmail, contacts: v.bContacts, rate: v.bRate } : undefined,
    });
    await refresh(); setModal(null); go({ screen: 'provider', id: p.id });
  };
  const createIns = async (v: Record<string, string>) => {
    if (!v.name.trim()) { alert('Name is required'); return; }
    const c = await api('POST', '/insurers', {
      name: v.name, hq: v.hq, phone: v.phone, email: v.email, relationship: v.relationship, payRate: v.payRate,
      states: v.states.split(',').map(s => s.trim()).filter(Boolean),
      rules: v.rules.split('\n').filter(x => x.trim()),
      adjuster: v.aName ? { name: v.aName, phone: v.aPhone, email: v.aEmail } : undefined,
    });
    await refresh(); setModal(null); go({ screen: 'insurance', id: c.id });
  };

  return (
    <div>
      <div className="home-hero">
        <h1>Good {new Date().getHours() < 12 ? 'morning' : 'afternoon'}, {boot.user.name.split(' ')[0]}</h1>
        <p>{new Date().toLocaleDateString('en-US', { weekday: 'long', month: '2-digit', day: '2-digit', year: 'numeric' })} · {new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Denver' })} MST</p>
        <SearchBox big />
      </div>

      <div className="overview-cards">
        <div className="ovcard"><div className="num" style={{ color: 'var(--accent)' }}>{active}</div>
          <div className="lbl">Active patients</div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{tl} Trilopay · {tg} Trilogy</div></div>
        <div className="ovcard"><div className="num" style={{ color: 'var(--green)' }}>{closed}</div>
          <div className="lbl">Closed / paid out</div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>All-time</div></div>
        <div className="ovcard"><div className="num" style={{ color: 'var(--amber)' }}>{dueToday}</div>
          <div className="lbl">Tasks due today</div>
          <div style={{ fontSize: 11, color: overdue ? 'var(--red)' : 'var(--muted)', marginTop: 4 }}>includes {overdue} overdue</div></div>
      </div>

      <div className="addrow">
        <div className="addbtn" onClick={() => setModal('pt')}>
          <div className="ic" style={{ background: 'var(--accent)' }}>＋</div>
          <h4>New Patient</h4><span>Create profile · auto-ID</span></div>
        <div className="addbtn" onClick={() => setModal('md')}>
          <div className="ic" style={{ background: 'var(--green)' }}>＋</div>
          <h4>New Provider</h4><span>Corporate + branch</span></div>
        <div className="addbtn" onClick={() => setModal('ins')}>
          <div className="ic" style={{ background: 'var(--purple)' }}>＋</div>
          <h4>New Insurance</h4><span>Carrier + adjusters</span></div>
      </div>

      {dash && (
        <div className="card" style={{ maxWidth: 980, margin: '0 auto 26px' }}>
          <div className="chead"><h3>Operations dashboard 🔒 admin only — live</h3></div>
          <div className="cbody">
            <div className="statrow" style={{ marginBottom: 14 }}>
              <div className="stat"><div className="sv money-out">{fmtK(dash.payable)}</div><div className="sl">Owed to providers ({dash.payableCount})</div></div>
              <div className="stat"><div className="sv" style={{ color: 'var(--amber)' }}>{fmtK(dash.pendingIn)}</div><div className="sl">Pending from carriers ({dash.pendingInCount})</div></div>
              <div className="stat"><div className="sv money-in">{fmtK(dash.received)}</div><div className="sl">Received all-time</div></div>
              <div className="stat"><div className="sv">{fmtK(dash.margin)}</div><div className="sl">Margin ({dash.marginPct}%)</div></div>
              <div className="stat"><div className="sv" style={dash.agingCount ? { color: 'var(--red)' } : undefined}>{dash.agingCount}</div><div className="sl">Bills 30+ days old</div></div>
            </div>
            <div className="grid2">
              <div>
                <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--muted)', fontWeight: 700, marginBottom: 6 }}>By carrier</div>
                <table><tbody>
                  <tr><th>Carrier</th><th>Active</th><th>Received</th><th>Paid</th><th>Margin</th></tr>
                  {dash.byCarrier.map((c: any) => (
                    <tr key={c.id}><td><span className="link" onClick={() => go({ screen: 'insurance', id: c.id })}>{c.name}</span></td>
                      <td>{c.act}</td><td className="money-in">{fmtK(c.received)}</td><td className="money-out">{fmtK(c.paidOut)}</td>
                      <td><b>{fmtK(c.profit)}</b> ({c.margin}%)</td></tr>))}
                </tbody></table>
                <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--muted)', fontWeight: 700, margin: '12px 0 6px' }}>By line of business (active)</div>
                <table><tbody>
                  {dash.byCaseType.map((x: any) => (
                    <tr key={x.caseType}><td><span className={'badge ' + (x.caseType === 'trilogy' ? 'b-yellow' : 'b-blue')}>{x.caseType === 'trilogy' ? 'Trilogy — BI' : 'Trilopay — PIP'}</span></td><td><b>{x.c}</b> active cases</td></tr>))}
                </tbody></table>
              </div>
              <div>
                <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--muted)', fontWeight: 700, marginBottom: 6 }}>Pipeline</div>
                <table><tbody>
                  {dash.byStage.map((s: any) => (
                    <tr key={s.stage}><td>{STAGES[s.stage]}</td><td><b>{s.c}</b></td></tr>))}
                </tbody></table>
                <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--muted)', fontWeight: 700, margin: '12px 0 6px' }}>Coordinator workload</div>
                <table><tbody>
                  <tr><th>Coordinator</th><th>Active cases</th><th>Open tasks</th></tr>
                  {dash.coordinators.map((c: any) => (
                    <tr key={c.id}><td>{c.name}</td><td>{c.activeCases}</td><td>{c.openTasks}</td></tr>))}
                </tbody></table>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="card" style={{ maxWidth: 760, margin: '0 auto' }}>
        <div className="chead"><h3>My tasks — all patients</h3></div>
        <div className="cbody">
          {tasks.map(t => {
            const od = !!t.due && t.due < today; const dt = t.due === today;
            return (
              <div key={t.id} className={'task' + (od ? ' overdue' : '')}>
                <div className="trow">
                  <input type="checkbox" onChange={() => complete(t.id)} />
                  <div style={{ flex: 1 }}><b>{t.title}</b>
                    <div className="due">Due <b>{fmtDate(t.due)}</b>{od ? ' — overdue' : ''} ·{' '}
                      <span className="link" onClick={() => go({ screen: 'patient', id: t.patientId })}>{t.patientName} · {t.patientId}</span></div>
                  </div>
                  <span className={'badge ' + (od ? 'b-red' : dt ? 'b-amber' : 'b-blue')}>{od ? 'Overdue' : dt ? 'Today' : 'Upcoming'}</span>
                </div>
              </div>);
          })}
          {!tasks.length && <div style={{ color: 'var(--muted)', textAlign: 'center', padding: 12 }}>No open tasks 🎉</div>}
        </div>
      </div>

      {modal === 'pt' && <FormModal title="New Patient" fields={ptFields} onSave={createPt} onClose={() => setModal(null)} saveLabel="Create patient" />}
      {modal === 'md' && <FormModal title="New Medical Provider" fields={mdFields} onSave={createMd} onClose={() => setModal(null)} saveLabel="Create provider" />}
      {modal === 'ins' && <FormModal title="New Insurance Company" fields={insFields} onSave={createIns} onClose={() => setModal(null)} saveLabel="Create insurance company" />}
    </div>
  );
}
