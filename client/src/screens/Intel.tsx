import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../App';
import { STAGES, fmtK } from '../types';

export function IntelPage() {
  const { boot, go } = useApp();
  const [dash, setDash] = useState<any>(null);
  const [drift, setDrift] = useState<any[]>([]);
  useEffect(() => {
    if (boot.user.role !== 'admin') return;
    api('GET', '/dashboard').then(setDash).catch(() => {});
    api('GET', '/drift').then(setDrift).catch(() => {});
  }, []);
  if (boot.user.role !== 'admin') return <div className="card"><div className="cbody">Admins only.</div></div>;
  if (!dash) return null;

  return (
    <div>
      <div className="pagehead">
        <h1 className="serif">Intelligence</h1>
        <div className="sub">The board-pack numbers, live — no waiting for someone to build the board pack</div>
      </div>

      <div className="statrow" style={{ marginBottom: 16 }}>
        <div className="stat"><div className="sv money-out serif">{fmtK(dash.payable)}</div><div className="sl">Owed to providers ({dash.payableCount})</div></div>
        <div className="stat"><div className="sv serif" style={{ color: 'var(--amber)' }}>{fmtK(dash.pendingIn)}</div><div className="sl">Pending from carriers</div></div>
        <div className="stat"><div className="sv money-in serif">{fmtK(dash.received)}</div><div className="sl">Received all-time</div></div>
        <div className="stat"><div className="sv serif">{fmtK(dash.margin)}</div><div className="sl">Margin ({dash.marginPct}%)</div></div>
        <div className="stat"><div className="sv serif" style={dash.agingCount ? { color: 'var(--red)' } : undefined}>{dash.agingCount}</div><div className="sl">Bills 30+ days</div></div>
        <div className="stat"><div className="sv serif">{dash.attorneyRate}%</div><div className="sl">Attorney retention · thesis</div></div>
        <div className="stat"><div className="sv serif">{dash.avgIntakeToTreating ?? '—'}{dash.avgIntakeToTreating ? 'd' : ''}</div><div className="sl">Intake → treating · thesis</div></div>
      </div>

      <div className="grid2">
        <div className="card">
          <div className="chead"><h3>By carrier — A/R view</h3></div>
          <div className="cbody">
            <table><tbody>
              <tr><th>Carrier</th><th>Active</th><th>Billed</th><th>Received</th><th>Outstanding</th><th>Margin</th></tr>
              {dash.byCarrier.map((c: any) => (
                <tr key={c.id}>
                  <td><span className="link" onClick={() => go({ screen: 'insurance', id: c.id })}>{c.name}</span></td>
                  <td>{c.act}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{fmtK(c.billedTotal)}</td>
                  <td className="money-in">{fmtK(c.received)}</td>
                  <td className="mono" style={{ fontSize: 12, color: c.outstanding > 0 ? 'var(--amber)' : undefined }}>{fmtK(c.outstanding)}</td>
                  <td><b>{fmtK(c.profit)}</b> <span style={{ color: 'var(--ink-mute)' }}>({c.margin}%)</span></td>
                </tr>))}
            </tbody></table>
          </div>
        </div>
        <div className="card">
          <div className="chead"><h3>Pipeline & team</h3></div>
          <div className="cbody">
            <table><tbody>
              {dash.byStage.map((s: any) => (
                <tr key={s.stage}><td>{STAGES[s.stage]}</td><td><b className="mono">{s.c}</b></td></tr>))}
            </tbody></table>
            <div className="eyebrow" style={{ margin: '14px 0 6px' }}>Coordinator load</div>
            <table><tbody>
              <tr><th>Coordinator</th><th>Active</th><th>Open tasks</th></tr>
              {dash.coordinators.map((c: any) => (
                <tr key={c.id}><td>{c.name}</td><td className="mono">{c.activeCases}</td><td className="mono">{c.openTasks}</td></tr>))}
            </tbody></table>
            <div className="eyebrow" style={{ margin: '14px 0 6px' }}>Line of business (active)</div>
            <table><tbody>
              {dash.byCaseType.map((x: any) => (
                <tr key={x.caseType}><td><span className={'badge ' + (x.caseType === 'trilogy' ? 'b-yellow' : 'b-blue')}>{x.caseType === 'trilogy' ? 'Trilogy — BI' : 'Trilopay — PIP'}</span></td><td><b className="mono">{x.c}</b> active</td></tr>))}
            </tbody></table>
          </div>
        </div>
      </div>

      <div className="grid2" style={{ marginTop: 16 }}>
        <div className="card">
          <div className="chead"><h3>Board pack — the numbers behind the thesis</h3></div>
          <div className="cbody">
            <table><tbody>
              <tr><th>Measure</th><th>Value</th></tr>
              {(dash.byLob || []).map((x: any) => (
                <tr key={x.caseType}><td>Margin — {x.caseType === 'trilogy' ? 'Trilogy (BI)' : 'Trilopay (PIP)'}</td>
                  <td className="mono">{fmtK(x.margin)} <span style={{ color: 'var(--ink-mute)' }}>({fmtK(x.received)} in / {fmtK(x.paidOut)} out)</span></td></tr>))}
              <tr><td>Avg billed per closed case</td><td className="mono">{dash.costPerCase != null ? fmtK(dash.costPerCase) : '—'}</td></tr>
              <tr><td>Carrier concentration (top carrier % of receipts)</td>
                <td className="mono" style={dash.concentration > 60 ? { color: 'var(--amber)' } : undefined}>{dash.concentration != null ? dash.concentration + '%' : '—'}</td></tr>
              <tr><td>Realized losses (written-off denials)</td><td className="mono">{fmtK(dash.writtenOff?.s || 0)} ({dash.writtenOff?.c || 0})</td></tr>
              <tr><td>Open drift findings</td><td className="mono" style={dash.driftCount ? { color: 'var(--amber)' } : undefined}>{dash.driftCount}</td></tr>
            </tbody></table>
          </div>
        </div>
        <div className="card">
          <div className="chead"><h3>Drift watch — charge · utilization · pay-cycle</h3></div>
          <div className="cbody">
            {drift.map((d, i) => (
              <div key={i} style={{ padding: '8px 0', borderBottom: '1px solid var(--line-soft)' }}>
                <span className={'badge ' + (d.kind === 'pay-cycle' ? 'b-purple' : 'b-amber')}>{d.kind}</span>{' '}
                <b>{d.who}</b>
                <div style={{ fontSize: 12.5, color: 'var(--ink-soft)', marginTop: 2 }}>{d.text}</div>
                <div style={{ fontSize: 11.5, color: 'var(--blue)', marginTop: 2 }}>→ {d.action}</div>
              </div>))}
            {!drift.length && <div className="badge b-green" style={{ padding: 10 }}>✓ No drift detected — charges, utilization, and pay cycles all steady</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
