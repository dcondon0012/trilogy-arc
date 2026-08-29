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
          <div className="chead"><h3>Treating with no next appointment</h3></div>
          <div className="cbody">
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
              Drop-out risk: patients who feel forgotten call attorneys. Book the next touchpoint.</div>
            {data.gaps.map((p: any) => (
              <div key={p.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '7px 0', borderBottom: '1px solid var(--line-soft)' }}>
                <span className="link" style={{ flex: 1 }} onClick={() => go({ screen: 'patient', id: p.id })}><b>{p.name}</b></span>
                <span className={'badge ' + (p.caseType === 'trilogy' ? 'b-yellow' : 'b-blue')}>{p.caseType === 'trilogy' ? 'BI' : 'PIP'}</span>
                <button className="btn sm primary" onClick={() => book(p)}>Book</button>
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

/* Growth was absorbed into the CRM module (screens/Crm.tsx) on 08/27/2026. */
