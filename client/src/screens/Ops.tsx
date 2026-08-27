import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../App';
import { FormModal } from '../ui';
import { fmtDate, todayISO } from '../types';

/* ================= Schedule — the day runs itself ================= */
export function SchedulePage() {
  const { boot, go } = useApp();
  const [data, setData] = useState<any>(null);
  const [outbound, setOutbound] = useState<any[] | null>(null);
  const [modal, setModal] = useState<React.ReactNode>(null);
  const [sentIds, setSentIds] = useState<Set<string>>(new Set());
  const load = () => { api('GET', '/schedule').then(setData).catch(() => {}); api('GET', '/outbound').then(setOutbound).catch(() => {}); };
  useEffect(load, []);
  if (!data) return null;

  const book = (p: any) => setModal(
    <FormModal title={`Book ${p.name}`} onClose={() => setModal(null)} saveLabel="Book it"
      fields={[
        { key: 'whenAt', label: 'Date', type: 'date', value: todayISO() },
        { key: 'providerId', label: 'Provider (search)', type: 'search', options: boot.providers.map((pr: any) => ({ v: pr.id, l: pr.name })) },
        { key: 'note', label: 'Note', full: true, ph: 'e.g. re-eval, 2:30 PM' },
      ]}
      onSave={async v => { await api('POST', `/patients/${p.id}/appointments`, v); setModal(null); load(); }} />);

  const send = async (d: any) => {
    await api('POST', '/outbound/send', d);
    setSentIds(s => new Set(s).add(d.kind + d.toId));
  };

  const byDay: Record<string, any[]> = {};
  for (const a of data.upcoming) (byDay[a.whenAt] = byDay[a.whenAt] || []).push(a);

  return (
    <div>
      <div className="pagehead">
        <h1 className="serif">Schedule</h1>
        <div className="sub">Patients in care stay booked — gaps get caught the same day, not at discharge</div>
      </div>

      <div className="grid2">
        <div className="card">
          <div className="chead"><h3>Next 14 days</h3></div>
          <div className="cbody">
            {Object.entries(byDay).map(([day, appts]) => (
              <div key={day} style={{ marginBottom: 12 }}>
                <div className="eyebrow" style={{ marginBottom: 4 }}>{fmtDate(day)}</div>
                {appts.map((a: any) => (
                  <div key={a.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--line-soft)' }}>
                    <span className="link" onClick={() => go({ screen: 'patient', id: a.patientId })}><b>{a.ptName}</b></span>
                    <span style={{ color: 'var(--ink-soft)', fontSize: 12.5 }}>{a.prName || '—'}</span>
                    <span style={{ color: 'var(--ink-mute)', fontSize: 12 }}>{a.note || ''}</span>
                  </div>))}
              </div>))}
            {!data.upcoming.length && <div style={{ color: 'var(--muted)' }}>Nothing booked in the next two weeks.</div>}
          </div>
        </div>

        <div className="card">
          <div className="chead"><h3>⚠ Treating with no next appointment</h3></div>
          <div className="cbody">
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
              Drop-out risk: patients who feel forgotten call attorneys. Book the next touchpoint.</div>
            {data.gaps.map((p: any) => (
              <div key={p.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '7px 0', borderBottom: '1px solid var(--line-soft)' }}>
                <span className="link" style={{ flex: 1 }} onClick={() => go({ screen: 'patient', id: p.id })}><b>{p.name}</b></span>
                <span className={'badge ' + (p.caseType === 'trilogy' ? 'b-yellow' : 'b-blue')}>{p.caseType === 'trilogy' ? 'BI' : 'PIP'}</span>
                <button className="btn sm primary" onClick={() => book(p)}>📅 Book</button>
              </div>))}
            {!data.gaps.length && <div className="badge b-green" style={{ padding: 10 }}>✓ Every treating patient has a next appointment</div>}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="chead"><h3>Daily consolidated outbound</h3></div>
        <div className="cbody">
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
            One update per partner per day — records chases and payment nudges bundled, not twelve separate emails. Sends log to every case touched.</div>
          {(outbound || []).map((d: any) => {
            const done = sentIds.has(d.kind + d.toId);
            return (
              <div key={d.kind + d.toId} style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 12, marginBottom: 10, opacity: done ? 0.55 : 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span className={'badge ' + (d.kind === 'carrier' ? 'b-purple' : 'b-green')}>{d.kind}</span>
                  <b>{d.toName}</b>
                  <span style={{ color: 'var(--ink-soft)', fontSize: 13 }}>— {d.subject}</span>
                  <span className="spacer" />
                  {done ? <span className="badge b-green">✓ Sent & logged</span>
                    : <button className="btn sm primary" onClick={() => send(d)}>✉ Send & log</button>}
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--ink-soft)', whiteSpace: 'pre-line' }}>{d.lines.join('\n')}</div>
              </div>);
          })}
          {outbound && !outbound.length && <div className="badge b-green" style={{ padding: 10 }}>✓ Nothing owed to anyone today</div>}
        </div>
      </div>
      {modal}
    </div>
  );
}

/* ================= Growth — Miles's workspace ================= */
const STAGES_G = ['identify', 'outreach', 'negotiating', 'contracted', 'soft-launch'];
export function GrowthPage() {
  const { boot, go } = useApp();
  const [data, setData] = useState<any>(null);
  const [modal, setModal] = useState<React.ReactNode>(null);
  const load = () => { api('GET', '/growth').then(setData).catch(() => {}); };
  useEffect(load, []);
  if (boot.user.role !== 'admin') return <div className="card"><div className="cbody">Admins only.</div></div>;
  if (!data) return null;

  const addTarget = () => setModal(
    <FormModal title="Add growth target" onClose={() => setModal(null)} saveLabel="Add to pipeline"
      fields={[
        { key: 'name', label: 'Company / practice name', full: true },
        { key: 'kind', label: 'Type', type: 'select', options: [{ v: 'carrier', l: 'Insurance carrier' }, { v: 'provider', l: 'Medical provider' }] },
        { key: 'region', label: 'Region', ph: 'e.g. Dallas–Fort Worth' },
        { key: 'contact', label: 'Contact', ph: 'name · phone · email' },
        { key: 'notes', label: 'Notes', type: 'textarea', full: true },
      ]}
      onSave={async v => { await api('POST', '/campaigns', v); setModal(null); load(); }} />);

  const advance = async (c: any) => {
    const idx = STAGES_G.indexOf(c.stage);
    if (idx >= STAGES_G.length - 1) return;
    await api('POST', `/campaigns/${c.id}`, { stage: STAGES_G[idx + 1] });
    load();
  };

  const texas = data.campaigns.filter((c: any) => /tx|texas|dallas|houston|austin|antonio|worth/i.test(`${c.region} ${c.notes}`));
  const other = data.campaigns.filter((c: any) => !texas.includes(c));

  return (
    <div>
      <div className="pagehead">
        <h1 className="serif">Growth</h1>
        <div className="sub">Who to work today, ranked — plus the Texas campaign and network gaps the system found on its own</div>
        <span className="spacer" />
        <button className="btn primary" onClick={addTarget}>＋ Add target</button>
      </div>

      <div className="grid2">
        <div className="card">
          <div className="chead"><h3>Who to work today</h3></div>
          <div className="cbody">
            <table><tbody>
              <tr><th>#</th><th>Name</th><th>Why now</th></tr>
              {data.queue.map((q: any, i: number) => (
                <tr key={q.kind + q.id}>
                  <td className="mono">{i + 1}</td>
                  <td>{q.kind === 'carrier' || q.kind === 'provider'
                    ? <span className="link" onClick={() => go({ screen: q.kind === 'carrier' ? 'insurance' : 'provider', id: q.id } as any)}><b>{q.name}</b></span>
                    : <b>{q.name}</b>}{' '}
                    <span className={'badge ' + (q.kind === 'carrier' ? 'b-purple' : q.kind === 'gap' ? 'b-blue' : 'b-green')}>{q.kind}</span></td>
                  <td style={{ fontSize: 12.5 }}>{q.why}</td>
                </tr>))}
              {!data.queue.length && <tr><td colSpan={3} style={{ color: 'var(--muted)' }}>Queue is clear — everyone's warm.</td></tr>}
            </tbody></table>
          </div>
        </div>

        <div className="card">
          <div className="chead"><h3>Network gaps (from one-time agreements)</h3></div>
          <div className="cbody">
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
              Every one-time agreement is a hole in the network. Two or more with the same provider = contract candidate, auto-flagged.</div>
            <table><tbody>
              <tr><th>Provider</th><th>Agreements</th><th>Volume</th></tr>
              {data.gaps.map((g: any) => (
                <tr key={g.providerName}>
                  <td><b>{g.providerName}</b>{g.c >= 2 && <span className="badge b-blue" style={{ marginLeft: 6 }}>contract candidate</span>}</td>
                  <td className="mono">{g.c}</td>
                  <td className="mono">${(g.amt || 0).toLocaleString()}</td>
                </tr>))}
              {!data.gaps.length && <tr><td colSpan={3} style={{ color: 'var(--muted)' }}>No gaps — every dollar flows through contracts.</td></tr>}
            </tbody></table>
          </div>
        </div>
      </div>

      {[['🤠 Texas expansion', texas], ['Pipeline', other]].map(([title, list]: any) => (
        <div className="card" style={{ marginTop: 16 }} key={title}>
          <div className="chead"><h3>{title}</h3></div>
          <div className="cbody">
            <table><tbody>
              <tr><th>Target</th><th>Region</th><th>Stage</th><th>Contact</th><th>Notes</th><th></th></tr>
              {list.map((c: any) => (
                <tr key={c.id}>
                  <td><b>{c.name}</b> <span className={'badge ' + (c.kind === 'carrier' ? 'b-purple' : 'b-green')}>{c.kind}</span></td>
                  <td>{c.region || '—'}</td>
                  <td><span className={'badge ' + (c.stage === 'contracted' || c.stage === 'soft-launch' ? 'b-green' : c.stage === 'identify' ? 'b-gray' : 'b-amber')}>{c.stage}</span></td>
                  <td style={{ fontSize: 12 }}>{c.contact || '—'}</td>
                  <td style={{ fontSize: 12, maxWidth: 260 }}>{c.notes || '—'}</td>
                  <td>{c.stage !== 'soft-launch' && <button className="btn sm" onClick={() => advance(c)}>→ {STAGES_G[STAGES_G.indexOf(c.stage) + 1]}</button>}</td>
                </tr>))}
              {!list.length && <tr><td colSpan={6} style={{ color: 'var(--muted)' }}>Empty — add a target.</td></tr>}
            </tbody></table>
          </div>
        </div>))}
      {modal}
    </div>
  );
}
