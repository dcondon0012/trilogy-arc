import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { todayISO, fmtDate } from '../types';
import type { User } from '../types';
import { FormModal, cap } from '../ui';

/* ═══════════ CRM — network build workspace ═══════════
   One pipeline for recruiting providers and carriers. Absorbs the old Growth
   screen. Outreach is draft-and-log (no live email/enrichment until phase 7). */

const STAGE_LABEL: Record<string, string> = {
  identify: 'Identify', outreach: 'Outreach', conversation: 'Conversation',
  meeting: 'Meeting', proposal: 'Proposal', signed: 'Signed', live: 'Live', dead: 'Dead',
};
const stageBadge = (s: string) =>
  s === 'live' ? 'b-green' : s === 'signed' ? 'b-green' : s === 'dead' ? 'b-red'
    : s === 'identify' ? 'b-gray' : s === 'proposal' || s === 'meeting' ? 'b-amber' : 'b-blue';
const kindBadge = (k: string) => (k === 'carrier' ? 'b-purple' : 'b-green');
const ACT_ICON: Record<string, string> = { call: '☎', email: '✉', meeting: '🤝', note: '✎', stage: '⇗' };

export function CrmPage({ user }: { user: User }) {
  const [ws, setWs] = useState<any>(null);
  const [tab, setTab] = useState<'today' | 'pipeline' | 'targets' | 'prospect' | 'blitz' | 'outreach' | 'cobrand' | 'report'>('today');
  const [sel, setSel] = useState<number | null>(null);
  const [modal, setModal] = useState<React.ReactNode>(null);
  const [err, setErr] = useState('');

  const load = () => api('GET', '/crm/workspace').then(setWs).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);
  if (err) return <div className="card"><div className="cbody">{err}</div></div>;
  if (!ws) return null;

  const targets: any[] = ws.targets;
  const today = todayISO();
  const active = targets.filter(t => t.stage !== 'dead' && t.stage !== 'live');
  const due = active.filter(t => t.nextAt && t.nextAt <= today);

  const addTarget = (preset?: any) => setModal(
    <FormModal title="Add to pipeline" onClose={() => setModal(null)} saveLabel="Add target"
      fields={[
        { key: 'name', label: 'Practice / company name*', full: true, value: preset?.name || '' },
        { key: 'kind', label: 'Type', type: 'select', value: preset?.kind === 'carrier' ? 'carrier' : 'provider', options: [{ v: 'provider', l: 'Medical provider' }, { v: 'carrier', l: 'Insurance carrier' }] },
        { key: 'specialty', label: 'Specialty', ph: 'Chiropractic / PT / Imaging…' },
        { key: 'market', label: 'Market', ph: 'e.g. Dallas–Fort Worth' },
        { key: 'state', label: 'State', value: 'TX' },
        { key: 'phone', label: 'Phone' },
        { key: 'email', label: 'Email' },
        { key: 'website', label: 'Website' },
        { key: 'notes', label: 'Notes', type: 'textarea', full: true, value: preset?.notes || '' },
      ]}
      onSave={async v => { await api('POST', '/crm/targets', { ...v, source: preset?.source || 'manual' }); setModal(null); load(); }} />);

  const T = ({ t }: { t: any }) => (
    <span className="link" onClick={() => setSel(t.id)}><b>{t.name}</b></span>);

  return (
    <div>
      <div className="pagehead">
        <h1 className="serif">CRM — network build</h1>
        <div className="sub">Recruit the Texas network: every target, every touch, one pipeline. Signed targets promote straight into operations.</div>
        <span className="spacer" />
        <button className="btn primary" onClick={() => addTarget()}>＋ Add target</button>
      </div>

      {sel != null
        ? <TargetDetail id={sel} user={user} onBack={() => { setSel(null); load(); }} />
        : (<>
          <div className="statrow" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
            {[['Due today', ws.stats.dueToday], ['In pipeline', active.length], ['Signed / live', (ws.stats.byStage.signed || 0) + (ws.stats.byStage.live || 0)], ['Touches (7d)', ws.stats.activity7d]].map(([l, v]) => (
              <div key={String(l)} className="card" style={{ padding: '10px 18px', flex: 1, minWidth: 130 }}>
                <div className="mono" style={{ fontSize: 22, fontWeight: 600 }}>{v as any}</div>
                <div className="eyebrow">{l}</div>
              </div>))}
          </div>

          <div className="tabs">
            {([['today', 'Today'], ['pipeline', 'Pipeline'], ['targets', 'Targets'], ['prospect', 'Prospecting'], ['blitz', 'Call blitz'], ['outreach', 'Outreach'], ['cobrand', 'Co-brand'], ['report', 'Reporting']] as const).map(([k, l]) => (
              <div key={k} className={'tab' + (tab === k ? ' active' : '')} onClick={() => setTab(k)}>{l}</div>))}
          </div>

          {tab === 'today' && (
            <div className="grid2">
              <div className="card">
                <div className="chead"><h3>Follow-ups due</h3></div>
                <div className="cbody">
                  {due.map(t => (
                    <div key={t.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '7px 0', borderBottom: '1px solid var(--line-soft)' }}>
                      <T t={t} />
                      <span className={'badge ' + stageBadge(t.stage)}>{STAGE_LABEL[t.stage]}</span>
                      <span style={{ flex: 1, fontSize: 12.5, color: 'var(--ink-soft)' }}>{t.nextNote || ''}</span>
                      <span className="mono" style={{ fontSize: 11.5, color: t.nextAt < today ? 'var(--red)' : 'var(--ink-mute)' }}>{fmtDate(t.nextAt)}</span>
                    </div>))}
                  {!due.length && <div className="badge b-green" style={{ padding: 10 }}>✓ Nothing due — work the blitz queue or add targets</div>}
                </div>
              </div>
              <div className="card">
                <div className="chead"><h3>Signals from operations</h3></div>
                <div className="cbody">
                  <div style={{ fontSize: 12, color: 'var(--ink-mute)', marginBottom: 8 }}>
                    Found automatically: recurring one-time-agreement gaps and cooling relationships, not yet in the pipeline.</div>
                  {ws.signals.map((s: any, i: number) => (
                    <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '7px 0', borderBottom: '1px solid var(--line-soft)' }}>
                      <b style={{ fontSize: 13 }}>{s.name}</b>
                      <span className={'badge ' + (s.kind === 'carrier' ? 'b-purple' : s.kind === 'gap' ? 'b-blue' : 'b-green')}>{s.kind}</span>
                      <span style={{ flex: 1, fontSize: 12, color: 'var(--ink-soft)' }}>{s.why}</span>
                      {s.kind === 'gap' && <button className="btn sm" onClick={() => addTarget({ name: s.name, kind: 'provider', source: 'gap-engine', notes: s.why })}>＋ Pipeline</button>}
                    </div>))}
                  {!ws.signals.length && <div style={{ color: 'var(--muted)' }}>No unworked signals.</div>}
                </div>
              </div>
              <div className="card" style={{ gridColumn: '1 / -1' }}>
                <div className="chead"><h3>Recent activity</h3></div>
                <div className="cbody">
                  {ws.recent.map((a: any) => (
                    <div key={a.id} style={{ display: 'flex', gap: 8, padding: '5px 0', fontSize: 12.5, borderBottom: '1px solid var(--line-soft)' }}>
                      <span>{ACT_ICON[a.kind] || '·'}</span>
                      <b>{a.targetName}</b>
                      <span style={{ flex: 1, color: 'var(--ink-soft)' }}>{a.text}</span>
                      <span className="mono" style={{ fontSize: 11, color: 'var(--ink-mute)' }}>{a.by} · {fmtDate(a.at)}</span>
                    </div>))}
                  {!ws.recent.length && <div style={{ color: 'var(--muted)' }}>No activity yet.</div>}
                </div>
              </div>
            </div>)}

          {tab === 'pipeline' && (
            <div className="card">
              <div className="chead"><h3>Pipeline by stage</h3></div>
              <div className="cbody">
                {ws.stages.map((s: string) => {
                  const list = targets.filter(t => t.stage === s);
                  return (
                    <div key={s} style={{ marginBottom: 14 }}>
                      <div className="eyebrow" style={{ marginBottom: 6 }}>{STAGE_LABEL[s]} · {list.length}</div>
                      {list.map(t => (
                        <div key={t.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--line-soft)' }}>
                          <T t={t} />
                          <span className={'badge ' + kindBadge(t.kind)}>{t.kind}</span>
                          <span style={{ fontSize: 12, color: 'var(--ink-soft)' }}>{[t.specialty, t.market].filter(Boolean).join(' · ')}</span>
                          <span className="spacer" />
                          {t.promotedId && <span className="idchip">{t.promotedId}</span>}
                          <StageAdvance t={t} stages={ws.stages} onDone={load} />
                        </div>))}
                      {!list.length && <div style={{ color: 'var(--muted)', fontSize: 12.5, padding: '2px 0 6px' }}>—</div>}
                    </div>);
                })}
              </div>
            </div>)}

          {tab === 'targets' && <TargetsTable targets={targets} onOpen={setSel} />}
          {tab === 'prospect' && <ProspectTab onOpen={setSel} reloadWs={load} />}
          {tab === 'blitz' && <BlitzTab targets={active} onOpen={setSel} reload={load} />}
          {tab === 'outreach' && <OutreachTab targets={active} reload={load} />}
          {tab === 'cobrand' && <CobrandTab targets={targets.filter(t => t.kind === 'provider' && t.stage !== 'dead')} />}
          {tab === 'report' && <ReportTab />}
        </>)}
      {modal}
    </div>
  );
}

function StageAdvance({ t, stages, onDone }: { t: any; stages: string[]; onDone: () => void }) {
  const idx = stages.indexOf(t.stage);
  if (t.stage === 'dead' || idx >= stages.length - 1) return null;
  const next = stages[idx + 1];
  return (
    <button className="btn sm" onClick={async () => { await api('POST', `/crm/targets/${t.id}/stage`, { stage: next }); onDone(); }}>
      → {STAGE_LABEL[next]}</button>);
}

function TargetsTable({ targets, onOpen }: { targets: any[]; onOpen: (id: number) => void }) {
  const [q, setQ] = useState('');
  const shown = targets.filter(t => (t.name + ' ' + (t.market || '') + ' ' + (t.specialty || '') + ' ' + t.stage).toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="card">
      <div className="chead"><h3>All targets ({targets.length})</h3>
        <input placeholder="🔍 Filter…" value={q} onChange={e => setQ(e.target.value)}
          style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '6px 10px', fontSize: 12.5, width: 220 }} /></div>
      <div className="cbody" style={{ overflowX: 'auto' }}>
        <table><tbody>
          <tr><th>Name</th><th>Type</th><th>Specialty</th><th>Market</th><th>Stage</th><th>Owner</th><th>Next follow-up</th></tr>
          {shown.map(t => (
            <tr key={t.id}>
              <td><span className="link" onClick={() => onOpen(t.id)}><b>{t.name}</b></span></td>
              <td><span className={'badge ' + kindBadge(t.kind)}>{t.kind}</span></td>
              <td style={{ fontSize: 12.5 }}>{t.specialty || '—'}</td>
              <td style={{ fontSize: 12.5 }}>{t.market || '—'}</td>
              <td><span className={'badge ' + stageBadge(t.stage)}>{STAGE_LABEL[t.stage]}</span></td>
              <td style={{ fontSize: 12.5 }}>{t.owner || '—'}</td>
              <td className="mono" style={{ fontSize: 12 }}>{t.nextAt ? fmtDate(t.nextAt) : '—'}</td>
            </tr>))}
          {!shown.length && <tr><td colSpan={7} style={{ color: 'var(--muted)' }}>Nothing matches.</td></tr>}
        </tbody></table>
      </div>
    </div>);
}

/* Call blitz: due-first queue with one-click outcomes that log the call and set the next touch. */
function BlitzTab({ targets, onOpen, reload }: { targets: any[]; onOpen: (id: number) => void; reload: () => void }) {
  const today = todayISO();
  const queue = targets
    .filter(t => t.phone)
    .sort((a, b) => String(a.nextAt || '9999').localeCompare(String(b.nextAt || '9999')));
  const plusDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const log = async (t: any, outcome: string, text: string, nextInDays: number | null, nextNote?: string) => {
    await api('POST', `/crm/targets/${t.id}/activity`, {
      kind: 'call', text, outcome,
      ...(nextInDays != null ? { nextAt: plusDays(nextInDays), nextNote: nextNote || `Follow up: ${outcome}` } : {}),
    });
    reload();
  };
  return (
    <div className="card">
      <div className="chead"><h3>Call blitz — {queue.length} with phone numbers, due first</h3></div>
      <div className="cbody">
        <div style={{ fontSize: 12, color: 'var(--ink-mute)', marginBottom: 10 }}>
          One click logs the call and books the next touch. No answer retries in 2 days; conversations get a 5-day follow-up; meetings land on the follow-up list for scheduling.</div>
        {queue.map(t => (
          <div key={t.id} style={{ border: '1px solid var(--line)', borderRadius: 10, padding: '10px 12px', marginBottom: 8, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="link" onClick={() => onOpen(t.id)}><b>{t.name}</b></span>
            <span className={'badge ' + stageBadge(t.stage)}>{STAGE_LABEL[t.stage]}</span>
            <a className="mono" style={{ fontSize: 13 }} href={'tel:' + t.phone}>{t.phone}</a>
            {t.nextAt && t.nextAt <= today && <span className="badge b-amber">due {fmtDate(t.nextAt)}</span>}
            <span className="spacer" />
            <button className="btn sm" onClick={() => log(t, 'no-answer', 'Called — no answer', 2)}>No answer</button>
            <button className="btn sm" onClick={() => log(t, 'voicemail', 'Called — left voicemail', 3)}>Voicemail</button>
            <button className="btn sm primary" onClick={() => log(t, 'conversation', 'Called — had a conversation', 5, 'Continue the conversation')}>Talked</button>
            <button className="btn sm primary" onClick={() => log(t, 'meeting-set', 'Called — meeting agreed, needs scheduling', 1, 'Schedule the meeting')}>Meeting set</button>
          </div>))}
        {!queue.length && <div style={{ color: 'var(--muted)' }}>No targets with phone numbers yet — add phones on the target cards.</div>}
      </div>
    </div>);
}

/* Outreach: template + merge fields → per-target mailto drafts, logged when sent. */
function OutreachTab({ targets, reload }: { targets: any[]; reload: () => void }) {
  const [stage, setStage] = useState('identify');
  const [subject, setSubject] = useState('Faster payment for accident care — Trilogy Medical Networks');
  const [body, setBody] = useState(
    `Hi {name},\n\nTrilogy coordinates care for people injured in auto accidents. Providers in our network treat at pre-agreed published rates and are paid as bills come in — no waiting on settlement, no collections risk, and the patient owes nothing.\n\nWould a 15-minute call this week make sense?\n\n— {me}\nTrilogy Medical Networks · trilogyconnections.com`);
  const [logged, setLogged] = useState<Set<number>>(new Set());
  const list = targets.filter(t => t.stage === stage && t.email);
  const merge = (tpl: string, t: any) => tpl.replace(/\{name\}/g, t.name).replace(/\{me\}/g, '');
  const markLogged = async (t: any) => {
    await api('POST', `/crm/targets/${t.id}/activity`, { kind: 'email', text: `Outreach email sent: "${subject}"`, nextAt: new Date(Date.now() + 4 * 86400000).toISOString().slice(0, 10), nextNote: 'Follow up on outreach email' });
    setLogged(s => new Set(s).add(t.id));
    reload();
  };
  return (
    <div className="grid2">
      <div className="card">
        <div className="chead"><h3>Draft</h3>
          <select value={stage} onChange={e => setStage(e.target.value)} style={{ border: '1px solid var(--line)', borderRadius: 6, padding: '4px 6px', fontSize: 12 }}>
            {['identify', 'outreach', 'conversation', 'meeting', 'proposal'].map(s => <option key={s} value={s}>{STAGE_LABEL[s]} stage</option>)}
          </select></div>
        <div className="cbody">
          <div style={{ fontSize: 12, color: 'var(--ink-mute)', marginBottom: 8 }}>
            Sending stays in your own email for now (opens a pre-filled draft); every send is logged to the target. Automated sending arrives with the email integration. <b>{'{name}'}</b> merges the practice name.</div>
          <input value={subject} onChange={e => setSubject(e.target.value)}
            style={{ width: '100%', border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px', fontSize: 13, marginBottom: 8 }} />
          <textarea value={body} onChange={e => setBody(e.target.value)}
            style={{ width: '100%', height: 220, border: '1px solid var(--line)', borderRadius: 8, padding: 10, fontSize: 12.5 }} />
        </div>
      </div>
      <div className="card">
        <div className="chead"><h3>{list.length} recipient{list.length === 1 ? '' : 's'} with email at this stage</h3></div>
        <div className="cbody">
          {list.map(t => (
            <div key={t.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '7px 0', borderBottom: '1px solid var(--line-soft)' }}>
              <b style={{ fontSize: 13 }}>{t.name}</b>
              <span style={{ flex: 1, fontSize: 12, color: 'var(--ink-soft)' }}>{t.email}</span>
              {logged.has(t.id)
                ? <span className="badge b-green">✓ Sent & logged</span>
                : (<>
                  <a className="btn sm" href={`mailto:${encodeURIComponent(t.email)}?subject=${encodeURIComponent(merge(subject, t))}&body=${encodeURIComponent(merge(body, t))}`}>✉ Open draft</a>
                  <button className="btn sm primary" onClick={() => markLogged(t)}>Mark sent</button>
                </>)}
            </div>))}
          {!list.length && <div style={{ color: 'var(--muted)' }}>No targets with an email address at this stage.</div>}
        </div>
      </div>
    </div>);
}

/* ── Prospecting: paste candidates, triage by score, top picks into the pipeline.
   Auto-search (Google Places) and contact-finding (Apollo/Seamless-style) are
   parked until API accounts exist — buttons are visible but honest about it. ── */
function ProspectTab({ onOpen, reloadWs }: { onOpen: (id: number) => void; reloadWs: () => void }) {
  const [data, setData] = useState<any>(null);
  const [market, setMarket] = useState('');
  const [specialty, setSpecialty] = useState('');
  const [text, setText] = useState('');
  const [lastImport, setLastImport] = useState('');
  const load = (m?: string) => api('GET', '/crm/prospects' + (m ? '?market=' + encodeURIComponent(m) : '')).then(setData).catch(() => {});
  useEffect(() => { load(); }, []);
  if (!data) return null;

  const doImport = async () => {
    try {
      const r = await api('POST', '/crm/prospects/import', { market: market.trim(), specialty: specialty.trim(), text });
      setLastImport(`${r.added} added · ${r.dupes} already known · ${r.dropped} out-of-scope (hospitals, urgent care, dental are filtered)`);
      setText(''); load(market.trim());
    } catch (e: any) { alert(e.message); }
  };
  const act = async (fn: () => Promise<any>) => { try { await fn(); load(market || undefined); reloadWs(); } catch (e: any) { alert(e.message); } };
  const list: any[] = data.prospects;
  const fresh = list.filter(p => p.status === 'new');
  const addTop = () => act(async () => { for (const p of fresh.slice(0, 5)) await api('POST', `/crm/prospects/${p.id}/add`); });
  const scoreColor = (s: number) => s >= 70 ? 'var(--green-dark)' : s >= 45 ? 'var(--yellow)' : 'var(--ink-mute)';

  return (
    <div className="grid2">
      <div className="card">
        <div className="chead"><h3>Bring in candidates</h3>
          <button className="btn sm" disabled title="Auto-search needs the Google Places integration — parked until API accounts exist">🔍 Find providers (soon)</button>
        </div>
        <div className="cbody">
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <input placeholder="Market* — e.g. Dallas–Fort Worth" value={market} onChange={e => setMarket(e.target.value)} list="pmarkets"
              style={{ flex: 1, border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px', fontSize: 13 }} />
            <datalist id="pmarkets">{data.markets.map((m: string) => <option key={m} value={m} />)}</datalist>
            <input placeholder="Specialty — e.g. Chiropractic" value={specialty} onChange={e => setSpecialty(e.target.value)}
              style={{ flex: 1, border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px', fontSize: 13 }} />
          </div>
          <textarea value={text} onChange={e => setText(e.target.value)}
            placeholder={'One practice per line — pasted straight from Google Maps or a list:\nDallas Spine & Injury Center | 4310 Gaston Ave, Dallas | (214) 555-0132 | dallasspine.com\nLakewood Chiropractic Group | (214) 555-0177'}
            style={{ width: '100%', height: 140, border: '1px solid var(--line)', borderRadius: 8, padding: 10, fontSize: 12.5 }} />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
            <button className="btn primary sm" onClick={doImport}>Score & add candidates</button>
            <span style={{ fontSize: 12, color: 'var(--ink-mute)' }}>{lastImport}</span>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--ink-mute)', marginTop: 10, lineHeight: 1.6 }}>
            <b>How scoring works:</b> starts at 35. A website and phone number add; a missing phone subtracts. Names mentioning injury or accident add (they already do this work). Group / associates / clinics adds (one signature, several locations). Hospitals, urgent care, dental, and anything already in the pipeline or the network are filtered out before you see them.
          </div>
        </div>
      </div>

      <div className="card">
        <div className="chead"><h3>{list.length} candidate{list.length === 1 ? '' : 's'}{market ? ` — ${market}` : ''} · {fresh.length} to review</h3>
          <div style={{ display: 'flex', gap: 6 }}>
            {data.markets.length > 1 && <select onChange={e => { setMarket(e.target.value); load(e.target.value || undefined); }} value={market}
              style={{ border: '1px solid var(--line)', borderRadius: 6, padding: '4px 6px', fontSize: 12 }}>
              <option value="">All markets</option>{data.markets.map((m: string) => <option key={m} value={m}>{m}</option>)}</select>}
            {fresh.length > 0 && <button className="btn sm" onClick={addTop}>＋ Add the top five</button>}
            {market && <button className="btn sm" onClick={() => confirm('Clear un-added candidates in this market?') && act(() => api('POST', '/crm/prospects/clear', { market }))}>Clear</button>}
          </div>
        </div>
        <div className="cbody" style={{ maxHeight: 560, overflowY: 'auto' }}>
          {list.map(p => (
            <div key={p.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '9px 0', borderBottom: '1px solid var(--line-soft)', opacity: p.status === 'rejected' ? 0.45 : 1 }}>
              <div className="mono" style={{ fontSize: 17, fontWeight: 600, color: scoreColor(p.score), width: 34, textAlign: 'center' }}>{p.score}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <b style={{ fontSize: 13.5 }}>{p.name}</b>
                <div style={{ fontSize: 11.5, color: 'var(--ink-soft)' }}>{[p.address, p.phone || 'no phone', p.website].filter(Boolean).join(' · ')}</div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 3 }}>
                  {p.flags.map((f: string) => <span key={f} className={'badge ' + (f === 'Injury focused' ? 'b-green' : f === 'Group or multi site' ? 'b-blue' : 'b-gray')}>{f}</span>)}
                  {p.status === 'added' && <span className="badge b-green">✓ In the pipeline</span>}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {p.status === 'added'
                  ? <button className="btn sm" onClick={() => onOpen(p.targetId)}>Open</button>
                  : <button className="btn sm primary" onClick={() => act(() => api('POST', `/crm/prospects/${p.id}/add`))}>＋ Pipeline</button>}
                <button className="btn sm" disabled title="Contact discovery needs the Apollo/Seamless integrations — parked until API accounts exist">Find contacts (soon)</button>
                {p.status !== 'added' && <button className="btn sm" onClick={() => act(() => api('POST', `/crm/prospects/${p.id}/reject`))}>{p.status === 'rejected' ? 'Restore' : 'Not a fit'}</button>}
              </div>
            </div>))}
          {!list.length && <div style={{ color: 'var(--muted)' }}>No candidates yet — paste a list on the left. Auto-search from Google arrives with the integrations.</div>}
        </div>
      </div>
    </div>);
}

/* ── Co-brand: a provider-facing one-pager, Trilogy + their name. Prints to PDF.
   Copy is structural (rates, speed, zero patient cost, no clinical direction) —
   and watermarked DRAFT until messaging is cleared for external use. ── */
function CobrandTab({ targets }: { targets: any[] }) {
  const [pick, setPick] = useState('');
  const [headline, setHeadline] = useState('Treat the patient. Get paid as care happens.');
  const [standfirst, setStandfirst] = useState('Trilogy Medical Networks coordinates care for people injured in auto accidents — and pays network providers at pre-agreed rates as bills come in, not at settlement.');
  const [accent, setAccent] = useState('#45A8EB');
  const [contact, setContact] = useState('Miles Manthe · Trilogy Medical Networks\ntrilogyconnections.com');
  const [points, setPoints] = useState([
    { h: 'Paid as care is incurred', b: 'Bills are paid at the contracted rate as treatment happens — no waiting on a settlement, no collections effort, no write-offs.' },
    { h: 'Published, pre-agreed rates', b: 'One rate schedule, agreed up front. No per-bill negotiation and no repricing surprises.' },
    { h: 'Your patient stays yours', b: 'The patient owes nothing and keeps their choice of provider. Treatment decisions stay with the clinician — Trilogy exercises no clinical direction.' },
  ]);
  const t = targets.find(x => String(x.id) === pick);
  const name = t?.name || 'Your practice';

  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const pageHtml = () => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(name)} × Trilogy</title>
<style>
  body{margin:0;font:15px/1.6 Arial,Helvetica,sans-serif;color:#2A3346;background:#fff}
  .page{max-width:760px;margin:0 auto;padding:56px 52px;position:relative}
  .wm{position:fixed;inset:0;display:grid;place-items:center;pointer-events:none;z-index:9}
  .wm span{transform:rotate(-28deg);font:700 42px/1 Arial;letter-spacing:.12em;color:rgba(168,58,58,.13);text-transform:uppercase;white-space:nowrap}
  .eyebrow{font:700 11px/1 Arial;letter-spacing:.2em;text-transform:uppercase;color:${accent};margin-bottom:14px}
  h1{font:700 34px/1.15 Arial;margin:0 0 14px;color:#2D3647}
  .stand{font-size:16px;color:#5A6474;margin:0 0 30px;max-width:60ch}
  .band{height:5px;background:${accent};border-radius:3px;margin:0 0 30px;width:120px}
  .pts{display:grid;grid-template-columns:1fr 1fr 1fr;gap:18px;margin-bottom:34px}
  .pt{border:1px solid #E5E2D6;border-top:4px solid ${accent};border-radius:9px;padding:16px 16px}
  .pt h3{font:700 15px/1.3 Arial;margin:0 0 8px;color:#2D3647}
  .pt p{font-size:13px;color:#5A6474;margin:0}
  .ask{background:#F7F6F1;border-radius:10px;padding:20px 22px;margin-bottom:34px}
  .ask h3{font:700 15px/1 Arial;margin:0 0 8px}
  .ask p{margin:0;font-size:14px;color:#5A6474}
  footer{display:flex;justify-content:space-between;align-items:flex-end;border-top:1px solid #E5E2D6;padding-top:16px;font-size:12.5px;color:#5A6474;white-space:pre-line}
  .tri{color:#2D3647;font-weight:700;font-size:15px}
  @media print{.wm span{color:rgba(168,58,58,.13)}}
</style></head><body>
<div class="wm"><span>Draft — not cleared for external use</span></div>
<div class="page">
  <div class="eyebrow">Prepared for ${esc(name)}</div>
  <h1>${esc(headline)}</h1>
  <p class="stand">${esc(standfirst)}</p>
  <div class="band"></div>
  <div class="pts">${points.map(p => `<div class="pt"><h3>${esc(p.h)}</h3><p>${esc(p.b)}</p></div>`).join('')}</div>
  <div class="ask"><h3>The ask</h3><p>A 15-minute conversation about whether ${esc(name)} fits the network — rates and terms in writing before anything starts.</p></div>
  <footer><span>${esc(contact)}</span><span class="tri">tril△gy</span></footer>
</div></body></html>`;

  const openPrint = () => { const w = window.open('', '_blank'); if (w) { w.document.write(pageHtml()); w.document.close(); } };
  const download = () => {
    const blob = new Blob([pageHtml()], { type: 'text/html' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name.replace(/[^A-Za-z0-9 ]/g, '')} x Trilogy.html`;
    a.click(); URL.revokeObjectURL(a.href);
  };
  const logIt = async () => {
    if (!t) return alert('Pick a target first');
    await api('POST', `/crm/targets/${t.id}/activity`, { kind: 'note', text: `Co-branded one-pager prepared: "${headline}"` });
    alert('Logged on the target.');
  };

  return (
    <div className="grid2">
      <div className="card">
        <div className="chead"><h3>Compose</h3></div>
        <div className="cbody">
          <div className="badge b-amber" style={{ display: 'inline-flex', padding: '6px 10px', marginBottom: 10 }}>
            ⚠ DRAFT watermarked — external messaging isn't legally cleared yet; the watermark comes off when it is.</div>
          <div style={{ display: 'grid', gap: 8 }}>
            <select value={pick} onChange={e => setPick(e.target.value)} style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px', fontSize: 13 }}>
              <option value="">Build for… (pick a provider target)</option>
              {targets.map(x => <option key={x.id} value={x.id}>{x.name}{x.market ? ' · ' + x.market : ''}</option>)}
            </select>
            <input value={headline} onChange={e => setHeadline(e.target.value)} style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px', fontSize: 13, fontWeight: 600 }} />
            <textarea value={standfirst} onChange={e => setStandfirst(e.target.value)} style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 10, fontSize: 12.5, height: 64 }} />
            {points.map((p, i) => (
              <div key={i} style={{ border: '1px solid var(--line-soft)', borderRadius: 8, padding: '8px 10px' }}>
                <input value={p.h} onChange={e => setPoints(ps => ps.map((x, j) => j === i ? { ...x, h: e.target.value } : x))}
                  style={{ border: 0, width: '100%', fontWeight: 600, fontSize: 13, background: 'transparent', color: 'inherit' }} />
                <textarea value={p.b} onChange={e => setPoints(ps => ps.map((x, j) => j === i ? { ...x, b: e.target.value } : x))}
                  style={{ border: 0, width: '100%', fontSize: 12, height: 48, background: 'transparent', color: 'var(--ink-soft)', resize: 'vertical' }} />
              </div>))}
            <textarea value={contact} onChange={e => setContact(e.target.value)} placeholder="Your contact block"
              style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 10, fontSize: 12.5, height: 52 }} />
            <label style={{ fontSize: 12.5, display: 'flex', gap: 8, alignItems: 'center' }}>
              Accent color (theirs, if they have one) <input type="color" value={accent} onChange={e => setAccent(e.target.value)} /></label>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn primary sm" onClick={openPrint}>🖨 Open & print to PDF</button>
            <button className="btn sm" onClick={download}>⬇ Download HTML</button>
            <button className="btn sm" onClick={logIt} disabled={!t}>✎ Log on the target</button>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--ink-mute)', marginTop: 10, lineHeight: 1.6 }}>
            Copy guardrails are baked into the defaults: structural differentiators only — pre-agreed rates, payment as care is incurred, zero patient cost, no clinical direction. Keep it that way.
          </div>
        </div>
      </div>
      <div className="card">
        <div className="chead"><h3>Preview — {name}</h3></div>
        <div className="cbody" style={{ background: 'var(--line-soft)', borderRadius: '0 0 12px 12px' }}>
          <iframe title="One-pager preview" srcDoc={pageHtml()} style={{ width: '100%', height: 620, border: 0, borderRadius: 8, background: '#fff' }} />
        </div>
      </div>
    </div>);
}

function ReportTab() {
  const [r, setR] = useState<any>(null);
  useEffect(() => { api('GET', '/crm/report').then(setR).catch(() => {}); }, []);
  if (!r) return null;
  const max = Math.max(1, ...r.funnel.map((f: any) => f.count));
  return (
    <div className="grid2">
      <div className="card">
        <div className="chead"><h3>Funnel</h3></div>
        <div className="cbody">
          {r.funnel.map((f: any) => (
            <div key={f.stage} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 7 }}>
              <span style={{ width: 100, fontSize: 12.5 }}>{STAGE_LABEL[f.stage]}</span>
              <div style={{ flex: 1, background: 'var(--line-soft)', borderRadius: 6, height: 18 }}>
                <div style={{ width: `${(f.count / max) * 100}%`, minWidth: f.count ? 20 : 0, background: 'var(--blue)', height: '100%', borderRadius: 6, color: '#fff', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{f.count || ''}</div>
              </div>
            </div>))}
          <div style={{ fontSize: 12, color: 'var(--ink-mute)', marginTop: 8 }}>
            {r.dead ? `${r.dead} marked dead. ` : ''}Average identify → signed: <b>{r.avgDaysToSigned != null ? `${r.avgDaysToSigned} days` : '— (no signings yet)'}</b>
          </div>
        </div>
      </div>
      <div className="card">
        <div className="chead"><h3>Effort (last 30 days) & owners</h3></div>
        <div className="cbody">
          <table><tbody>
            <tr><th>Touch</th><th>Count</th></tr>
            {r.touches30d.map((t: any) => <tr key={t.kind}><td>{ACT_ICON[t.kind]} {cap(t.kind)}</td><td className="mono">{t.c}</td></tr>)}
            {!r.touches30d.length && <tr><td colSpan={2} style={{ color: 'var(--muted)' }}>No touches logged yet.</td></tr>}
          </tbody></table>
          <table style={{ marginTop: 14 }}><tbody>
            <tr><th>Owner</th><th>Targets</th><th>Signed</th></tr>
            {r.owners.map((o: any) => <tr key={o.owner}><td>{o.owner}</td><td className="mono">{o.targets}</td><td className="mono">{o.signed}</td></tr>)}
          </tbody></table>
        </div>
      </div>
    </div>);
}

/* ── target detail: contacts, timeline, touches, follow-up, stage, promote ── */
function TargetDetail({ id, user, onBack }: { id: number; user: User; onBack: () => void }) {
  const [t, setT] = useState<any>(null);
  const [modal, setModal] = useState<React.ReactNode>(null);
  const load = () => api('GET', `/crm/targets/${id}`).then(setT).catch(() => onBack());
  useEffect(() => { load(); }, [id]);
  if (!t) return null;

  const logTouch = (kind: string) => setModal(
    <FormModal title={`Log ${kind}`} onClose={() => setModal(null)} saveLabel="Log it"
      fields={[
        { key: 'text', label: 'What happened*', type: 'textarea', full: true },
        { key: 'nextAt', label: 'Next follow-up (optional)', type: 'date' },
        { key: 'nextNote', label: 'Follow-up note', full: true },
      ]}
      onSave={async v => { await api('POST', `/crm/targets/${t.id}/activity`, { kind, ...v }); setModal(null); load(); }} />);

  const edit = () => setModal(
    <FormModal title="Edit target" onClose={() => setModal(null)} saveLabel="Save"
      fields={[
        { key: 'name', label: 'Name*', full: true, value: t.name },
        { key: 'specialty', label: 'Specialty', value: t.specialty || '' },
        { key: 'market', label: 'Market', value: t.market || '' },
        { key: 'state', label: 'State', value: t.state || '' },
        { key: 'phone', label: 'Phone', value: t.phone || '' },
        { key: 'email', label: 'Email', value: t.email || '' },
        { key: 'website', label: 'Website', value: t.website || '' },
        { key: 'owner', label: 'Owner', value: t.owner || '' },
        { key: 'proposedRate', label: 'Proposed rate', value: t.proposedRate || '', ph: 'e.g. 140% Medicare' },
        { key: 'acceptedRate', label: 'Accepted rate', value: t.acceptedRate || '' },
        { key: 'notes', label: 'Notes', type: 'textarea', full: true, value: t.notes || '' },
      ]}
      onSave={async v => { await api('PATCH', `/crm/targets/${t.id}`, v); setModal(null); load(); }} />);

  const addContact = () => setModal(
    <FormModal title="Add contact" onClose={() => setModal(null)} saveLabel="Add"
      fields={[
        { key: 'name', label: 'Name*' }, { key: 'title', label: 'Title' },
        { key: 'phone', label: 'Phone' }, { key: 'email', label: 'Email' },
        { key: 'notes', label: 'Notes', full: true },
      ]}
      onSave={async v => { await api('POST', `/crm/targets/${t.id}/contacts`, v); setModal(null); load(); }} />);

  const setStage = (stage: string) => api('POST', `/crm/targets/${t.id}/stage`, { stage }).then(load);
  const promote = async () => {
    if (!confirm(`Create a real ${t.kind} record for ${t.name}? This adds them to operations (rates and branches get set up there).`)) return;
    const r = await api('POST', `/crm/targets/${t.id}/promote`);
    alert(`Done — ${t.name} is now ${r.id}.`);
    load();
  };

  return (
    <div>
      <span className="backlink" onClick={onBack}>← Back to CRM</span>
      <div className="pt-head">
        <div className="pt-id" style={{ background: 'var(--slate)' }}>{t.kind === 'carrier' ? '🛡' : '⚕'}</div>
        <div className="pt-title" style={{ flex: 1 }}>
          <h2>{t.name}</h2>
          <div className="pt-meta">
            <span className={'badge ' + kindBadge(t.kind)}>{t.kind}</span>{' '}
            <span className={'badge ' + stageBadge(t.stage)}>{STAGE_LABEL[t.stage]}</span>{' '}
            {t.promotedId && <span className="idchip">{t.promotedId}</span>}{' '}
            <span style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>{[t.specialty, t.market, t.state].filter(Boolean).join(' · ')}</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button className="btn sm" onClick={() => logTouch('call')}>☎ Log call</button>
          <button className="btn sm" onClick={() => logTouch('email')}>✉ Log email</button>
          <button className="btn sm" onClick={() => logTouch('meeting')}>🤝 Log meeting</button>
          <button className="btn sm" onClick={() => logTouch('note')}>✎ Note</button>
          <button className="btn sm" onClick={edit}>Edit</button>
        </div>
      </div>

      <div className="grid2">
        <div>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="chead"><h3>Stage</h3>
              {user.role === 'admin' && (t.stage === 'signed' || t.stage === 'live') && !t.promotedId &&
                <button className="btn sm primary" onClick={promote}>⇗ Promote to network</button>}
            </div>
            <div className="cbody">
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {['identify', 'outreach', 'conversation', 'meeting', 'proposal', 'signed', 'live'].map(s => (
                  <button key={s} className={'btn sm' + (t.stage === s ? ' primary' : '')} onClick={() => t.stage !== s && setStage(s)}>{STAGE_LABEL[s]}</button>))}
                <button className="btn sm" style={{ color: 'var(--red)' }} onClick={() => t.stage !== 'dead' && confirm('Mark dead? It stays on file and can be revived.') && setStage('dead')}>Dead</button>
              </div>
              {(t.proposedRate || t.acceptedRate) && (
                <div style={{ marginTop: 10, fontSize: 12.5 }}>
                  {t.proposedRate && <>Proposed: <b>{t.proposedRate}</b>&nbsp;&nbsp;</>}
                  {t.acceptedRate && <>Accepted: <b>{t.acceptedRate}</b></>}
                </div>)}
              {t.nextAt && <div style={{ marginTop: 8, fontSize: 12.5 }}>Next follow-up: <b className="mono">{fmtDate(t.nextAt)}</b> {t.nextNote && <>— {t.nextNote}</>}</div>}
            </div>
          </div>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="chead"><h3>Details</h3></div>
            <div className="cbody" style={{ fontSize: 13 }}>
              {[['Phone', t.phone && <a href={'tel:' + t.phone}>{t.phone}</a>], ['Email', t.email && <a href={'mailto:' + t.email}>{t.email}</a>],
                ['Website', t.website && <a href={t.website.startsWith('http') ? t.website : 'https://' + t.website} target="_blank" rel="noreferrer">{t.website}</a>],
                ['Address', t.address], ['Owner', t.owner], ['Source', t.source], ['Notes', t.notes]]
                .map(([l, v]) => (
                  <div key={String(l)} style={{ display: 'flex', gap: 10, padding: '4px 0', borderBottom: '1px solid var(--line-soft)' }}>
                    <span style={{ width: 70, color: 'var(--ink-mute)', fontSize: 12 }}>{l}</span>
                    <span style={{ flex: 1 }}>{(v as any) || '—'}</span>
                  </div>))}
            </div>
          </div>
          <div className="card">
            <div className="chead"><h3>Contacts</h3><button className="btn sm" onClick={addContact}>＋ Add</button></div>
            <div className="cbody">
              {t.contacts.map((c: any) => (
                <div key={c.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--line-soft)', fontSize: 13 }}>
                  <b>{c.name}</b>{c.title && <span style={{ color: 'var(--ink-soft)' }}> — {c.title}</span>}
                  <div className="mono" style={{ fontSize: 12, color: 'var(--ink-soft)' }}>{[c.phone, c.email].filter(Boolean).join(' · ') || '—'}</div>
                  {c.notes && <div style={{ fontSize: 12, color: 'var(--ink-mute)' }}>{c.notes}</div>}
                </div>))}
              {!t.contacts.length && <div style={{ color: 'var(--muted)', fontSize: 12.5 }}>No contacts yet.</div>}
            </div>
          </div>
        </div>
        <div className="card">
          <div className="chead"><h3>Timeline</h3></div>
          <div className="cbody" style={{ maxHeight: 640, overflowY: 'auto' }}>
            {t.activities.map((a: any) => (
              <div key={a.id} style={{ display: 'flex', gap: 8, padding: '7px 0', borderBottom: '1px solid var(--line-soft)', fontSize: 12.5 }}>
                <span>{ACT_ICON[a.kind] || '·'}</span>
                <div style={{ flex: 1 }}>
                  <div>{a.text}{a.outcome && a.kind !== 'stage' && <span className="badge b-gray" style={{ marginLeft: 6 }}>{a.outcome}</span>}</div>
                  <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-mute)' }}>{a.by} · {a.at?.slice(0, 10)}</div>
                </div>
              </div>))}
            {!t.activities.length && <div style={{ color: 'var(--muted)' }}>Nothing logged yet.</div>}
          </div>
        </div>
      </div>
      {modal}
    </div>);
}
