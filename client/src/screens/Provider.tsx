import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../App';
import { FormModal, RatesCard } from '../ui';
import type { Provider, Branch } from '../types';
import { fmtK, initials } from '../types';

const stBadge = (s: string) => (s === 'Preferred' ? 'b-green' : s === 'Under contract' ? 'b-blue' : 'b-amber');

export function ProviderScreen({ id }: { id: string }) {
  const { boot, go, refresh } = useApp();
  const [tab, setTab] = useState<'corp' | 'branch'>('corp');
  const [stats, setStats] = useState<any[]>([]);
  const [modal, setModal] = useState<React.ReactNode>(null);
  const pr = boot.providers.find(x => x.id === id) as Provider | undefined;

  useEffect(() => { setTab('corp'); }, [id]);
  useEffect(() => { if (tab === 'branch') api('GET', `/providers/${id}/stats`).then(setStats); }, [tab, id, boot]);
  const [score, setScore] = useState<any>(null);
  useEffect(() => { api('GET', `/providers/${id}/score`).then(setScore).catch(() => {}); }, [id, boot]);
  if (!pr) return null;

  const saveProvider = async (v: Record<string, string>) => {
    await api('PATCH', '/providers/' + pr.id, {
      name: v.name, type: v.type, status: v.status.split(','), taxId: v.taxId,
      corpAddress: v.corpAddress, corpPhone: v.corpPhone, corpEmail: v.corpEmail,
      rules: v.rules.split('\n').filter(x => x.trim()),
      conservative: Number(v.conservative) || 0,
    });
    await refresh(); setModal(null);
  };
  const editProvider = () => setModal(
    <FormModal title="Edit provider" onClose={() => setModal(null)}
      fields={[
        { key: 'name', label: 'Name', value: pr.name },
        { key: 'type', label: 'Type', value: pr.type },
        { key: 'status', label: 'Status', type: 'select', value: pr.status.join(','), options: [{ v: 'Preferred,Under contract', l: 'Preferred + under contract' }, { v: 'Under contract', l: 'Under contract' }, { v: 'Single case agreement', l: 'Single case agreement' }] },
        { key: 'taxId', label: 'Tax ID', value: pr.taxId },
        { key: 'conservative', label: 'Conservative-care philosophy (optimizer boost)', type: 'select', value: String((pr as any).conservative || 0), options: [{ v: '0', l: 'Not tagged' }, { v: '1', l: '✓ Conservative-care network' }] },
        { key: 'corpAddress', label: 'Corporate address', value: pr.corpAddress, full: true },
        { key: 'corpPhone', label: 'Corporate phone', value: pr.corpPhone },
        { key: 'corpEmail', label: 'Corporate email', value: pr.corpEmail },
        { key: 'rules', label: 'Business rules (one per line)', type: 'textarea', value: pr.rules.join('\n'), full: true },
      ]} onSave={saveProvider} />);

  const branchFields = (b?: Branch) => [
    { key: 'name', label: 'Branch name*', value: b?.name, full: true },
    { key: 'address', label: 'Address', value: b?.address, full: true },
    { key: 'phone', label: 'Phone', value: b?.phone }, { key: 'email', label: 'Email', value: b?.email },
    { key: 'contacts', label: 'Contacts', value: b?.contacts, full: true },
    { key: 'rate', label: 'Payment rate (description)', value: b?.rate, ph: 'e.g. 60% of billed / $280 cap', full: true },
    { key: 'ratePct', label: 'Rate % (for auto-payout)', type: 'number' as const, value: b?.ratePct != null ? String(b.ratePct) : '', ph: 'e.g. 60' },
    { key: 'rateCap', label: 'Per-visit cap $ (optional)', type: 'number' as const, value: b?.rateCap != null ? String(b.rateCap) : '', ph: 'e.g. 280' },
    { key: 'status', label: 'Status', type: 'select' as const, value: b?.status || 'Under contract', options: ['Preferred', 'Under contract', 'Single case agreement'].map(x => ({ v: x, l: x })) },
    ...(b ? [{ key: 'disputes', label: 'Disputes (manual)', type: 'number' as const, value: String(b.disputes || 0) }] : []),
  ];
  const addBranch = () => setModal(
    <FormModal title={'Add branch — ' + pr.name} fields={branchFields()} onClose={() => setModal(null)} saveLabel="Add branch"
      onSave={async v => {
        if (!v.name.trim()) { alert('Name required'); return; }
        await api('POST', `/providers/${pr.id}/branches`, v); await refresh(); setModal(null);
      }} />);
  const editBranch = (b: Branch) => setModal(
    <FormModal title={'Edit branch — ' + b.name} fields={branchFields(b)} onClose={() => setModal(null)}
      onSave={async v => { await api('PATCH', `/branches/${b.id}`, v); await refresh(); setModal(null); }} />);
  const attachContract = (b: Branch) => setModal(
    <FormModal title={'Attach signed contract — ' + b.name} onClose={() => setModal(null)} saveLabel="Attach"
      fields={[{ key: 'contract', label: 'Contract file name', value: 'Signed lien agreement.pdf', full: true }]}
      onSave={async v => { await api('PATCH', `/branches/${b.id}`, { contract: v.contract }); await refresh(); setModal(null); }} />);

  return (
    <div>
      <span className="backlink" onClick={() => go({ screen: 'home' })}>← Back</span>
      <div className="pt-head">
        <div className="pt-id" style={{ background: 'var(--green)' }}>{initials(pr.name)}</div>
        <div className="pt-title" style={{ flex: 1 }}>
          <h2>{pr.name} <span className="idchip">{pr.id}</span></h2>
          <div className="pt-meta">
            {pr.status.map(s => <span key={s} className={'badge ' + stBadge(s)}>{s === 'Preferred' ? '★ ' : ''}{s}</span>)}
            <span className="badge b-purple">{pr.type} · {pr.branches.length} branch{pr.branches.length === 1 ? '' : 'es'}</span>
            {(pr as any).conservative ? <span className="badge b-blue">conservative care</span> : null}
            {score && <span className={'badge ' + (score.band === 'A' ? 'b-green' : score.band === 'B' ? 'b-amber' : 'b-red')}
              title={score.parts.map((x: any) => `${x.k}: ${x.v} (+${x.pts})`).join('\n')}>Score {score.score} · {score.band}</span>}
          </div>
        </div>
        <button className="btn sm" onClick={editProvider}>✎ Edit</button>
      </div>

      <div className="tabs">
        <div className={'tab' + (tab === 'corp' ? ' active' : '')} onClick={() => setTab('corp')}>Corporate Office</div>
        <div className={'tab' + (tab === 'branch' ? ' active' : '')} onClick={() => setTab('branch')}>Branches</div>
      </div>

      {tab === 'corp' ? (
        <div className="grid2">
          {boot.user.role === 'admin' && <div style={{ gridColumn: '1/-1' }}><RatesCard kind="provider" id={pr.id} label={pr.name} /></div>}
          <div className="card">
            <div className="chead"><h3>Corporate office</h3></div>
            <div className="cbody"><dl className="kv">
              <dt>Location</dt><dd>{pr.corpAddress || '—'}</dd>
              <dt>Phone</dt><dd>{pr.corpPhone || '—'}</dd>
              <dt>Email</dt><dd>{pr.corpEmail || '—'}</dd>
              <dt>Tax ID</dt><dd>{pr.taxId || '—'}</dd>
              <dt>Status</dt><dd>{pr.status.map(s => <span key={s} className={'badge ' + stBadge(s)} style={{ marginRight: 4 }}>{s === 'Preferred' ? '★ ' : ''}{s}</span>)}
                <div style={{ fontWeight: 400, fontSize: 11.5, color: 'var(--muted)', marginTop: 3 }}>Options: Preferred · Under contract · Single case agreement</div></dd>
            </dl></div>
          </div>
          <div className="card">
            <div className="chead"><h3>Business rules</h3></div>
            <div className="cbody" style={{ fontSize: 13, lineHeight: 1.8 }}>
              {pr.rules.map((r, i) => <div key={i}>• {r}</div>)}
              {!pr.rules.length && '—'}
            </div>
          </div>
        </div>
      ) : (
        <div className="grid2">
          {pr.branches.map(b => {
            const st = stats.find(s => s.branchId === b.id) || { pts: 0, billed: 0, paid: 0, authSent: 0, missNotes: '0%' };
            return (
              <div key={b.id} className="card">
                <div className="chead"><h3>{b.name}</h3>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <span className={'badge ' + stBadge(b.status)}>{b.status === 'Preferred' ? '★ ' : ''}{b.status}</span>
                    <button className="btn sm" onClick={() => editBranch(b)}>✎ Edit</button>
                  </div></div>
                <div className="cbody">
                  <dl className="kv">
                    <dt>Location</dt><dd>{b.address || '—'}</dd>
                    <dt>Phone</dt><dd>{b.phone || '—'}</dd>
                    <dt>Email</dt><dd>{b.email || '—'}</dd>
                    <dt>Contacts</dt><dd>{b.contacts || '—'}</dd>
                    <dt>Payment rate</dt><dd>{b.rate || '—'}
                      {b.ratePct != null && <span className="badge b-green" style={{ marginLeft: 6 }}>auto-payout: {b.ratePct}%{b.rateCap ? ` · $${b.rateCap} cap` : ''}</span>}
                      {b.ratePct == null && <span className="badge b-amber" style={{ marginLeft: 6 }} title="Set Rate % in Edit to enable auto-payout on bills">no auto-payout</span>}</dd>
                    <dt>Contract</dt><dd>{b.contract
                      ? <span className="pdf" onClick={() => alert('Opens the stored contract PDF (file storage per-branch ships with e-sign integration).')}>📄 {b.contract}</span>
                      : <span className="addpdf" onClick={() => attachContract(b)}>＋ attach signed contract</span>}</dd>
                  </dl>
                  <div style={{ marginTop: 12 }}>
                    <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--muted)', fontWeight: 700, marginBottom: 8 }}>
                      Branch stats — auto-updated from live data</div>
                    <div className="statrow">
                      <div className="stat"><div className="sv">{st.pts}</div><div className="sl">Patients sent</div></div>
                      <div className="stat"><div className="sv">{fmtK(st.billed)}</div><div className="sl">Total billed</div></div>
                      <div className="stat"><div className="sv">{fmtK(st.paid)}</div><div className="sl">Total paid</div></div>
                      <div className="stat"><div className="sv">{fmtK(st.authSent)}</div><div className="sl">Auth sent</div></div>
                      <div className="stat"><div className="sv">{b.disputes || 0}</div><div className="sl">Disputes</div></div>
                      <div className="stat"><div className="sv">{st.missNotes}</div><div className="sl">Missing-notes rate</div></div>
                    </div>
                  </div>
                </div>
              </div>);
          })}
          <div className="card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 160, borderStyle: 'dashed', cursor: 'pointer' }} onClick={addBranch}>
            <div style={{ textAlign: 'center', color: 'var(--muted)' }}><div style={{ fontSize: 24 }}>＋</div>Add branch</div>
          </div>
        </div>
      )}
      {modal}
    </div>
  );
}
