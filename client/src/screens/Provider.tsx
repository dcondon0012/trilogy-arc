import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useApp } from '../App';
import { FormModal, RatesCard } from '../ui';
import type { Provider, Branch } from '../types';
import { fmtK, initials } from '../types';

const stBadge = (s: string) => (s === 'Preferred' ? 'b-green' : s === 'Under contract' ? 'b-blue' : 'b-amber');

export function ProviderScreen({ id }: { id: string }) {
  const { boot, go, refresh } = useApp();
  const [tab, setTab] = useState<'corp' | 'branch' | 'contracts' | 'admin'>('corp');
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
      name: v.name, type: v.type, status: v.status.split(',').filter(Boolean), taxId: v.taxId,
      corpAddress: v.corpAddress, corpPhone: v.corpPhone, corpEmail: v.corpEmail,
      rules: v.rules.split('\n').filter(x => x.trim()),
      conservative: Number(v.conservative) || 0,
      orgType: v.orgType || 'corporate',
    });
    await refresh(); setModal(null);
  };
  const editProvider = () => setModal(
    <FormModal title="Edit provider" onClose={() => setModal(null)}
      fields={[
        { key: 'name', label: 'Name', value: pr.name },
        { key: 'type', label: 'Type', value: pr.type },
        { key: 'status', label: 'Status ("Under contract" is earned via signed BAA + rate agreement, not set here)', type: 'select', value: pr.status.filter(x => x !== 'Under contract').join(',') || 'Single case agreement', options: [{ v: 'Preferred', l: 'Preferred' }, { v: 'Single case agreement', l: 'Single case agreement' }, { v: '', l: '(no extra status)' }] },
        { key: 'orgType', label: 'Organization structure', type: 'select', value: (pr as any).orgType || 'corporate', options: [{ v: 'corporate', l: 'Corporate office — all branches under one agreement' }, { v: 'independent', l: 'Independent office — its own single-office contract' }] },
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
        <div className={'tab' + (tab === 'corp' ? ' active' : '')} onClick={() => setTab('corp')}>{(pr as any).orgType === 'independent' ? 'Office' : 'Corporate Office'}</div>
        <div className={'tab' + (tab === 'branch' ? ' active' : '')} onClick={() => setTab('branch')}>Branches</div>
        <div className={'tab' + (tab === 'contracts' ? ' active' : '')} onClick={() => setTab('contracts')}>Contracts</div>
        {boot.user.role === 'admin' && <div className={'tab' + (tab === 'admin' ? ' active' : '')} onClick={() => setTab('admin')}>Admin</div>}
      </div>

      {tab === 'contracts' && <ProviderContracts pr={pr} refresh={refresh} />}
      {tab === 'admin' && boot.user.role === 'admin' && <ProviderAdmin pr={pr} />}

      {tab === 'corp' && (
        <div className="grid2">
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
      )}
      {tab === 'branch' && (
        <div className="grid2">
          {(pr as any).orgType === 'independent' && <div className="card" style={{ gridColumn: '1/-1' }}><div className="cbody" style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>
            This is an <b>independent office on its own contract</b> — it has no corporate umbrella. Offices that operate under a shared corporate agreement belong as branches of the corporate profile instead.</div></div>}
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
                      ? <span className="pdf" onClick={() => alert('Opens the stored contract PDF (file storage per-branch ships with e-sign integration).')}>{b.contract}</span>
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
/* ── contracts: the BAA + rate agreement gate ── */
function ProviderContracts({ pr, refresh }: any) {
  const baaRef = useRef<HTMLInputElement>(null);
  const rateRef = useRef<HTMLInputElement>(null);
  const upload = async (kind: 'baa' | 'rate', file?: File, signed?: boolean) => {
    const fd = new FormData();
    if (file) fd.append('file', file);
    if (signed) fd.append('signed', '1');
    const res = await fetch(`/api/providers/${pr.id}/contract/${kind}`, { method: 'POST', body: fd, credentials: 'same-origin' });
    const d = await res.json().catch(() => null);
    if (!res.ok) return alert(d?.error || res.statusText);
    await refresh();
  };
  const doc = (kind: 'baa' | 'rate', label: string, fileId: string | null, signedAt: string | null, ref: any) => (
    <div className="card">
      <div className="chead"><h3>{label}</h3>
        {signedAt ? <span className="badge b-green">Signed</span> : <span className="badge b-amber">Not signed</span>}</div>
      <div className="cbody">
        <dl className="kv" style={{ gridTemplateColumns: '110px 1fr' }}>
          <dt>Signed</dt><dd>{signedAt || 'Not yet'}</dd>
          <dt>Document</dt><dd>{fileId
            ? <span className="pdf" onClick={() => window.open('/api/files/' + fileId)}>View stored copy</span>
            : <span style={{ color: 'var(--muted)' }}>No copy stored</span>}</dd>
        </dl>
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <button className="btn sm" onClick={() => ref.current?.click()}>Upload {fileId ? 'newer copy' : 'signed copy'}</button>
          {!signedAt && <button className="btn sm primary" onClick={() => confirm(`Mark the ${label} as signed for ${pr.name}? (Audited.)`) && upload(kind, undefined, true)}>Mark signed</button>}
          <input ref={ref} type="file" style={{ display: 'none' }}
            onChange={e => { const f = e.target.files?.[0]; if (f) upload(kind, f, !signedAt && confirm('Also mark it signed now?')); }} />
        </div>
      </div>
    </div>);
  return (
    <div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="cbody" style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>
          A provider is <b>Under contract</b> only when BOTH documents below are signed — the status flips automatically the moment the second one lands, and the four-check’s agreement gate keys off it. {(pr as any).orgType === 'independent' ? 'This independent office’s contract covers this office only.' : 'This corporate agreement covers every branch listed on this profile.'}
        </div>
      </div>
      <div className="grid2">
        {doc('baa', 'Business Associate Agreement (BAA)', (pr as any).baaFileId, (pr as any).baaSignedAt, baaRef)}
        {doc('rate', 'Contracted rate agreement', (pr as any).rateAgreementFileId, (pr as any).rateAgreementSignedAt, rateRef)}
      </div>
    </div>);
}

/* ── admin: contracted rate + business terms (admin-only, stripped from staff payloads) ── */
function ProviderAdmin({ pr }: any) {
  const [info, setInfo] = useState<any>(null);
  const load = () => api('GET', `/providers/${pr.id}/admin`).then(setInfo).catch(() => {});
  useEffect(() => { load(); }, [pr.id]);
  const setRate = async () => {
    const v = prompt(`Contracted rate for ${pr.name} (e.g. "140% of Medicare" or "60% of billed, $280 cap"):`, info?.contractedRate || '');
    if (v === null) return;
    await api('POST', `/providers/${pr.id}/contracted-rate`, { rate: v });
    load();
  };
  return (
    <div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="chead"><h3>Business terms — admin only</h3></div>
        <div className="cbody">
          <dl className="kv" style={{ gridTemplateColumns: '190px 1fr' }}>
            <dt>Contracted rate</dt><dd>{info?.contractedRate || <span style={{ color: 'var(--muted)' }}>not recorded</span>}{' '}
              <span className="addpdf" onClick={setRate}>edit</span></dd>
            <dt>BAA</dt><dd>{info?.baaSignedAt || 'not signed'}</dd>
            <dt>Rate agreement</dt><dd>{info?.rateAgreementSignedAt || 'not signed'}</dd>
            <dt>Structure</dt><dd>{info?.orgType === 'independent' ? 'Independent office — own contract' : 'Corporate — one agreement covers all branches'}</dd>
          </dl>
          <div style={{ fontSize: 11.5, color: 'var(--ink-mute)', marginTop: 8 }}>
            These terms never appear in non-admin payloads — coordinators and portals see billed amounts only.</div>
        </div>
      </div>
      <RatesCard kind="provider" id={pr.id} label={pr.name} />
    </div>);
}
