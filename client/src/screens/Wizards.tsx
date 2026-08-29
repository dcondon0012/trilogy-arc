import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { TrilogyLogo } from '../ui';

/* ═══════════ CARRIER PARTNERSHIP WIZARD (the JSF packet, digitized) ═══════════
   Dual-mode: staff fill it on a call, or a carrier org-admin fills it in their portal.
   Answers are configuration that executes: thresholds arm alerts, cadences schedule reports. */

const STEPS = ['Goals', 'Intake', 'Thresholds', 'Reporting', 'Milestones', 'Contacts', 'Steering', 'SLA'];

export function CarrierWizard({ insurerId, insurerName, mode, onClose }: {
  insurerId: string; insurerName: string; mode: 'staff' | 'portal'; onClose: () => void;
}) {
  const base = mode === 'staff' ? `/insurers/${insurerId}/onboarding` : '/portal/carrier/onboarding';
  const [step, setStep] = useState(0);
  const [cfg, setCfg] = useState<any>({ goals: {}, intake: {}, thresholds: {}, reporting: {}, milestones: {}, contacts: [{}, {}], steering: {}, sla: {} });
  const [savedMsg, setSavedMsg] = useState('');
  useEffect(() => {
    api('GET', base).then((c: any) => { if (c && Object.keys(c).length) setCfg((prev: any) => ({ ...prev, ...c })); }).catch(() => {});
  }, []);

  const set = (section: string, key: string, val: any) =>
    setCfg((c: any) => ({ ...c, [section]: { ...c[section], [key]: val } }));
  const setContact = (i: number, key: string, val: string) =>
    setCfg((c: any) => ({ ...c, contacts: c.contacts.map((x: any, j: number) => j === i ? { ...x, [key]: val } : x) }));

  const save = async (finish = false) => {
    try {
      await api('POST', base, cfg);
      setSavedMsg(finish ? 'Configuration saved and live — thresholds, cadences, and routing are now active.' : 'Progress saved.');
      if (finish) setTimeout(onClose, 1600);
      else setTimeout(() => setSavedMsg(''), 1500);
    } catch (e: any) { alert(e.message); }
  };

  const F = ({ s, k, label, ph, type, full }: any) => (
    <div className={'mfield' + (full ? ' full' : '')}>
      <label>{label}</label>
      <input type={type || 'text'} value={cfg[s]?.[k] ?? ''} placeholder={ph || ''} onChange={e => set(s, k, e.target.value)} />
    </div>);
  const Sel = ({ s, k, label, opts, full }: any) => (
    <div className={'mfield' + (full ? ' full' : '')}>
      <label>{label}</label>
      <select value={cfg[s]?.[k] ?? ''} onChange={e => set(s, k, e.target.value)}>
        <option value="">— choose —</option>
        {opts.map((o: string) => <option key={o}>{o}</option>)}
      </select>
    </div>);
  const Check = ({ s, k, label }: any) => (
    <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, fontWeight: 500, padding: '4px 0', cursor: 'pointer' }}>
      <input type="checkbox" checked={!!cfg[s]?.[k]} onChange={e => set(s, k, e.target.checked)} /> {label}
    </label>);

  return (
    <div className="overlay">
      <div className="modal" style={{ width: 800, maxWidth: '96vw' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <TrilogyLogo size={18} />
          <span className="eyebrow">Partnership configuration · {insurerName}</span>
          <span className="spacer" />
          {savedMsg && <span className="badge b-green">{savedMsg}</span>}
          <span className="link" onClick={onClose}>save & close</span>
        </div>
        <div className="wiz-steps">
          {STEPS.map((s, i) => (
            <div key={s} className={'wiz-step' + (i === step ? ' on' : i < step ? ' done' : '')} onClick={() => setStep(i)}>{s}</div>))}
        </div>

        {step === 0 && (<div>
          <h2 className="serif">What does a successful partnership look like?</h2>
          <p className="wsub">Your answers become the goals we report against — every enterprise report leads with these.</p>
          <div className="mgrid">
            <F s="goals" k="primary" label="Primary goal for working with Trilogy" ph="e.g. Reduce medical spend on unrepresented claimants" full />
            <F s="goals" k="volumeMonthly" label="Expected referrals per month" type="number" ph="25" />
            <Sel s="goals" k="lineOfBusiness" label="Line of business" opts={['PIP (1st party)', 'BI (3rd party)', 'Both']} />
            <F s="goals" k="successMetric" label="The number you'll judge us by" ph="e.g. Avg medical cost per claim vs. your book" full />
            <F s="goals" k="states" label="States in scope" ph="TX, OR" />
            <F s="goals" k="renewalDate" label="Partnership review date" type="date" />
          </div>
        </div>)}

        {step === 1 && (<div>
          <h2 className="serif">How do referrals reach us?</h2>
          <p className="wsub">Every channel lands in the same queue — your adjusters use whatever they already use.</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginBottom: 12 }}>
            <Check s="intake" k="chPortal" label="Trilogy carrier portal (fastest)" />
            <Check s="intake" k="chEmail" label="Email to our intake address" />
            <Check s="intake" k="chFax" label="Fax" />
            <Check s="intake" k="chPhone" label="Phone / warm transfer" />
          </div>
          <div className="mgrid">
            <F s="intake" k="requiredFields" label="Fields you'll always send" ph="claim #, policy #, limits, adjuster" full />
            <F s="intake" k="screening" label="Custom screening questions — injected into our intake form" ph="e.g. Any head injury? Loss of consciousness?" full />
            <Sel s="intake" k="liabilityInfo" label="Liability status provided at referral?" opts={['Always', 'Usually', 'On request']} />
            <Sel s="intake" k="docsAtReferral" label="Claim docs at referral (dec page, report)?" opts={['Attached with referral', 'On request', 'Rarely available']} />
          </div>
        </div>)}

        {step === 2 && (<div>
          <h2 className="serif">When do you want a flag raised?</h2>
          <p className="wsub">These numbers arm our alert engine the moment you save — a case crossing them pages your team per your protocol.</p>
          <div className="mgrid">
            <F s="thresholds" k="coveragePct" label="Flag when % of coverage used reaches" type="number" ph="33" />
            <F s="thresholds" k="balanceFlag" label="Flag when total billed reaches ($)" type="number" ph="20000" />
            <F s="thresholds" k="imagingByDay" label="Expect imaging complete by day" type="number" ph="90" />
            <F s="thresholds" k="treatmentStallDays" label="Flag if no treatment activity for (days)" type="number" ph="21" />
            <F s="thresholds" k="highValue" label="High-value protocol kicks in at ($ est. exposure)" type="number" ph="50000" />
            <Sel s="thresholds" k="highValueProtocol" label="High-value protocol" opts={['Call primary contact same day', 'Email summary within 24h', 'Weekly call cadence']} />
          </div>
        </div>)}

        {step === 3 && (<div>
          <h2 className="serif">Reporting — cadence and depth</h2>
          <p className="wsub">Reports generate and send themselves on this schedule; each recipient gets their chosen depth.</p>
          <div className="mgrid">
            <Sel s="reporting" k="cadence" label="Book-of-business report cadence" opts={['Weekly', 'Every other week', 'Monthly', 'Quarterly']} />
            <Sel s="reporting" k="day" label="Delivery day" opts={['Monday', 'Wednesday', 'Friday', '1st of month']} />
            <F s="reporting" k="recipients" label="Recipients (email, one per line — add '· summary' or '· detail')" ph={'jsmith@carrier.com · detail\ncfo@carrier.com · summary'} full />
            <Check s="reporting" k="leadWithSavings" label="Lead with savings vs. your baseline (recommended — it's why we exist)" />
            <Check s="reporting" k="includeAttorneyRate" label="Include attorney-retention comparison" />
          </div>
        </div>)}

        {step === 4 && (<div>
          <h2 className="serif">Case-level notifications</h2>
          <p className="wsub">Check what your adjusters want to hear about the moment it happens — everything else waits for the report.</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
            <Check s="milestones" k="firstAppt" label="First appointment booked" />
            <Check s="milestones" k="imagingResulted" label="Imaging completed / resulted" />
            <Check s="milestones" k="surgeryRec" label="Surgery or injection recommended" />
            <Check s="milestones" k="noShow" label="Patient no-show" />
            <Check s="milestones" k="stalled" label="Treatment stalled past your threshold" />
            <Check s="milestones" k="doneTreating" label="Done treating / discharge" />
            <Check s="milestones" k="attorney" label="Attorney appears on the case" />
            <Check s="milestones" k="coverageFlag" label="Coverage threshold crossed" />
          </div>
          <div className="mgrid" style={{ marginTop: 10 }}>
            <Sel s="milestones" k="channel" label="Notify via" opts={['Portal message + email', 'Email only', 'Portal only']} />
            <Sel s="milestones" k="routing" label="Route to" opts={['Assigned adjuster', 'Primary contact', 'Both']} />
          </div>
        </div>)}

        {step === 5 && (<div>
          <h2 className="serif">Who do we call?</h2>
          <p className="wsub">Primary and backup — both required, so nothing ever waits on finding a phone number.</p>
          {[0, 1].map(i => (
            <div key={i} className="mgrid" style={{ marginBottom: 14, paddingBottom: 12, borderBottom: i === 0 ? '1px solid var(--line-soft)' : 'none' }}>
              <div className="mfield"><label>{i === 0 ? 'Primary contact — name*' : 'Backup contact — name*'}</label>
                <input value={cfg.contacts?.[i]?.name || ''} onChange={e => setContact(i, 'name', e.target.value)} /></div>
              <div className="mfield"><label>Role</label>
                <input value={cfg.contacts?.[i]?.role || ''} placeholder="e.g. Claims supervisor" onChange={e => setContact(i, 'role', e.target.value)} /></div>
              <div className="mfield"><label>Email*</label>
                <input value={cfg.contacts?.[i]?.email || ''} onChange={e => setContact(i, 'email', e.target.value)} /></div>
              <div className="mfield"><label>Phone*</label>
                <input value={cfg.contacts?.[i]?.phone || ''} onChange={e => setContact(i, 'phone', e.target.value)} /></div>
            </div>))}
        </div>)}

        {step === 6 && (<div>
          <h2 className="serif">Provider steering</h2>
          <p className="wsub">Preferences and exclusions the routing engine honors automatically. We never direct care — doctors decide; this decides which contracted doctors we route to.</p>
          <div className="mgrid">
            <F s="steering" k="preferred" label="Providers/groups you prefer (one per line)" full />
            <F s="steering" k="excluded" label="Providers to avoid (one per line, with reason)" ph="Dr. X — litigation history" full />
            <Check s="steering" k="conservativeOnly" label="Prefer conservative-philosophy providers (work-comp style)" />
            <Check s="steering" k="ptFirst" label="Where clinically appropriate, PT-first pathways preferred" />
          </div>
        </div>)}

        {step === 7 && (<div>
          <h2 className="serif">Our commitments to you</h2>
          <p className="wsub">This is the SLA we hold ourselves to — measured live in your portal, not just promised.</p>
          <div className="card" style={{ boxShadow: 'none', marginBottom: 14 }}><div className="cbody" style={{ fontSize: 13.5, lineHeight: 2 }}>
            <b>Trilogy commits to:</b><br />
            · Referrals processed within <b>1 business hour</b> of receipt<br />
            · First patient contact within <b>1 business day</b><br />
            · Contracted rates only — your cost per procedure is locked before care starts<br />
            · Flags raised at <span className="mono">{cfg.thresholds?.coveragePct || '—'}%</span> coverage / <span className="mono">${cfg.thresholds?.balanceFlag || '—'}</span> billed, per your configuration<br />
            · Reports every <b>{cfg.reporting?.cadence || '—'}</b>, savings-first<br />
            · No surprise balances — over-coverage treatment requires a decision, never a default
          </div></div>
          <div className="mgrid">
            <F s="sla" k="acceptedBy" label="Accepted by (name + title)" full />
            <F s="sla" k="acceptedDate" label="Date" type="date" />
          </div>
        </div>)}

        <div className="wiz-foot">
          {step > 0 && <button className="btn" onClick={() => setStep(s => s - 1)}>← Back</button>}
          <span className="spacer" />
          <button className="btn" onClick={() => save(false)}>Save progress</button>
          {step < STEPS.length - 1
            ? <button className="btn primary" onClick={() => { save(false); setStep(s => s + 1); }}>Next →</button>
            : <button className="btn accent" onClick={() => save(true)}>✓ Activate configuration</button>}
        </div>
      </div>
    </div>
  );
}

/* ═══════════ PROVIDER 10-MINUTE ONBOARDING (staff-run) ═══════════ */

const PSTEPS = ['Organization', 'Credentialing', 'Branch & rates', 'Go live'];

export function ProviderWizard({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const [step, setStep] = useState(0);
  const [v, setV] = useState<any>({ type: 'Chiropractic', status: 'Under contract' });
  const [busy, setBusy] = useState(false);
  const set = (k: string) => (e: any) => setV((s: any) => ({ ...s, [k]: e.target.value }));

  const finish = async () => {
    if (!v.name?.trim()) { alert('Provider name required'); setStep(0); return; }
    setBusy(true);
    try {
      const pr = await api('POST', '/providers', {
        name: v.name, type: v.type, status: v.status === 'Preferred' ? ['Preferred', 'Under contract'] : [v.status],
        taxId: v.taxId, corpAddress: v.corpAddress, corpPhone: v.corpPhone, corpEmail: v.corpEmail,
        rules: (v.rules || '').split('\n').filter((x: string) => x.trim()),
        branch: v.bName ? { name: v.bName, address: v.bAddress, phone: v.bPhone, email: v.bEmail, contacts: v.bContacts, rate: v.bRate, ratePct: v.ratePct, rateCap: v.rateCap } : undefined,
      });
      await api('PATCH', '/providers/' + pr.id, {
        name: v.name, type: v.type, status: pr.status, taxId: v.taxId,
        corpAddress: v.corpAddress, corpPhone: v.corpPhone, corpEmail: v.corpEmail, rules: pr.rules,
        npi: v.npi, licenseNo: v.licenseNo, licenseExp: v.licenseExp,
        malpracticeCarrier: v.malpracticeCarrier, malpracticeExp: v.malpracticeExp,
      });
      if (v.cptRates?.trim()) await api('POST', `/rates/provider/${pr.id}`, { paste: v.cptRates }).catch(() => {});
      onDone(pr.id);
    } catch (e: any) { alert(e.message); } finally { setBusy(false); }
  };

  const F = ({ k, label, ph, type, full }: any) => (
    <div className={'mfield' + (full ? ' full' : '')}>
      <label>{label}</label>
      <input type={type || 'text'} value={v[k] || ''} placeholder={ph || ''} onChange={set(k)} />
    </div>);

  return (
    <div className="overlay">
      <div className="modal" style={{ width: 760, maxWidth: '96vw' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <TrilogyLogo size={18} />
          <span className="eyebrow">Provider onboarding · target: 10 minutes</span>
          <span className="spacer" /><span className="link" onClick={onClose}>cancel</span>
        </div>
        <div className="wiz-steps">
          {PSTEPS.map((s, i) => <div key={s} className={'wiz-step' + (i === step ? ' on' : i < step ? ' done' : '')} onClick={() => setStep(i)}>{s}</div>)}
        </div>

        {step === 0 && (<div>
          <h2 className="serif">The organization</h2>
          <p className="wsub">Corporate-level facts — branches come next.</p>
          <div className="mgrid">
            <F k="name" label="Provider name*" full />
            <div className="mfield"><label>Type</label>
              <select value={v.type} onChange={set('type')}>
                {['Chiropractic', 'Imaging / MRI', 'PT / Rehab', 'Orthopedic', 'Pain management', 'Other'].map(t => <option key={t}>{t}</option>)}
              </select></div>
            <div className="mfield"><label>Relationship</label>
              <select value={v.status} onChange={set('status')}>
                <option>Under contract</option><option>Preferred</option><option>Single case agreement</option>
              </select></div>
            <F k="corpAddress" label="Corporate address" full />
            <F k="corpPhone" label="Phone" /><F k="corpEmail" label="Email" />
            <F k="rules" label="Business rules (one per line — how they like to work)" full />
          </div>
        </div>)}

        {step === 1 && (<div>
          <h2 className="serif">Credentialing</h2>
          <p className="wsub">What carriers will ask us for — captured once, expiry-tracked. (NPI/license auto-verification arrives with deployment.)</p>
          <div className="mgrid">
            <F k="taxId" label="Tax ID" /><F k="npi" label="NPI" ph="10 digits" />
            <F k="licenseNo" label="License #" /><F k="licenseExp" label="License expires" type="date" />
            <F k="malpracticeCarrier" label="Malpractice carrier" /><F k="malpracticeExp" label="Malpractice expires" type="date" />
          </div>
        </div>)}

        {step === 2 && (<div>
          <h2 className="serif">First branch & the money</h2>
          <p className="wsub">The numeric rate powers auto-payout; per-CPT rates power the contracted-rate engine.</p>
          <div className="mgrid">
            <F k="bName" label="Branch name*" full />
            <F k="bAddress" label="Address" full />
            <F k="bPhone" label="Phone" /><F k="bEmail" label="Email" />
            <F k="bContacts" label="Contacts (treating + office mgr)" full />
            <F k="bRate" label="Rate description" ph="60% of billed / $280 cap" />
            <F k="ratePct" label="Rate % (auto-payout)" type="number" ph="60" />
            <F k="rateCap" label="Per-visit cap $ (optional)" type="number" />
            <div className="mfield full"><label>Per-CPT payouts (optional — one "CPT amount" per line)</label>
              <textarea value={v.cptRates || ''} placeholder={'98940 55\n97110 40'} onChange={set('cptRates')} style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }} /></div>
          </div>
        </div>)}

        {step === 3 && (<div>
          <h2 className="serif">Go live</h2>
          <p className="wsub">On finish: profile created, rates active, four-check armed. E-signature of the agreement goes out at deployment; until then, attach the signed PDF on the branch.</p>
          <div className="card" style={{ boxShadow: 'none' }}><div className="cbody" style={{ fontSize: 13.5, lineHeight: 2 }}>
            <b>{v.name || '—'}</b> · {v.type} · {v.status}<br />
            Branch: {v.bName || '—'} {v.ratePct ? `· auto-payout ${v.ratePct}%${v.rateCap ? ` (cap $${v.rateCap})` : ''}` : '· no numeric rate — payouts will be manual'}<br />
            Credentialing: NPI {v.npi || 'missing'} · license {v.licenseNo ? `on file, exp ${v.licenseExp || '?'}` : 'missing'}<br />
            CPT rates: {v.cptRates?.trim() ? v.cptRates.trim().split('\n').length + ' lines' : 'none (percentage fallback)'}
          </div></div>
        </div>)}

        <div className="wiz-foot">
          {step > 0 && <button className="btn" onClick={() => setStep(s => s - 1)}>← Back</button>}
          <span className="spacer" />
          {step < PSTEPS.length - 1
            ? <button className="btn primary" onClick={() => setStep(s => s + 1)}>Next →</button>
            : <button className="btn accent" disabled={busy} onClick={finish}>✓ Create & go live</button>}
        </div>
      </div>
    </div>
  );
}
