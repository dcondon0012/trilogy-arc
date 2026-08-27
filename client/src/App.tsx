import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { api } from './api';
import type { AiRequest, Bootstrap, User, AlertItem } from './types';
import { initials, STAGES } from './types';
import { PrefsCtx, FormModal, TrilogyLogo } from './ui';
import { Today } from './screens/Today';
import { CasesPage, CarriersPage, ProvidersPage } from './screens/Lists';
import { IntelPage } from './screens/Intel';
import { SchedulePage, GrowthPage } from './screens/Ops';
import { PatientScreen } from './screens/Patient';
import { ProviderScreen } from './screens/Provider';
import { InsurerScreen } from './screens/Insurer';
import { AdminScreen } from './screens/Admin';
import { InboxScreen } from './screens/Inbox';
import { ProviderPortal, CarrierPortal } from './screens/Portal';

export type Nav =
  | { screen: 'today' | 'cases' | 'carriers' | 'providers' | 'intel' | 'admin' | 'inbox' | 'home' | 'directory' | 'schedule' | 'growth' }
  | { screen: 'patient' | 'provider' | 'insurance'; id: string };

export const AppCtx = createContext<{ boot: Bootstrap; go: (n: Nav) => void; refresh: () => Promise<void>; }>(null as any);
export const useApp = () => useContext(AppCtx);

/* ═══════════ login / signup ═══════════ */
function Signup({ onBack }: { onBack: () => void }) {
  const [orgs, setOrgs] = useState<any>(null);
  const [v, setV] = useState<any>({ orgType: 'provider' });
  const [msg, setMsg] = useState(''); const [err, setErr] = useState('');
  useEffect(() => { api('GET', '/public/orgs').then(setOrgs); }, []);
  const set = (k: string, val: string) => setV((s: any) => ({ ...s, [k]: val }));
  const submit = async () => {
    setErr('');
    try { const r = await api('POST', '/auth/register-portal', v); setMsg(r.message); }
    catch (e: any) { setErr(e.message); }
  };
  const list = v.orgType === 'provider' ? orgs?.providers : orgs?.carriers;
  return (
    <div className="loginwrap">
      <BrandPanel />
      <div className="loginside"><div className="loginbox">
        <TrilogyLogo size={26} />
        <p className="sub">Request portal access — for medical providers and insurance carriers working with Trilogy.</p>
        {err && <div className="loginerr">{err}</div>}
        {msg ? (<>
          <div className="badge b-green" style={{ display: 'flex', padding: 12 }}>✓ {msg}</div>
          <button className="btn" style={{ width: '100%', justifyContent: 'center', marginTop: 14 }} onClick={onBack}>Back to sign in</button>
        </>) : (<>
          <div className="field"><label>I am a…</label>
            <select value={v.orgType} onChange={e => set('orgType', e.target.value)}>
              <option value="provider">Medical provider</option>
              <option value="carrier">Insurance carrier</option>
            </select></div>
          <div className="field"><label>Organization</label>
            <select value={v.orgId || ''} onChange={e => set('orgId', e.target.value)}>
              <option value="">— select —</option>
              {(list || []).map((o: any) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select></div>
          <div className="field"><label>Your name</label><input value={v.name || ''} onChange={e => set('name', e.target.value)} /></div>
          <div className="field"><label>Work email</label><input type="email" value={v.email || ''} onChange={e => set('email', e.target.value)} /></div>
          <div className="field"><label>Password (8+ characters)</label><input type="password" value={v.password || ''} onChange={e => set('password', e.target.value)} /></div>
          <button className="btn primary" style={{ width: '100%', justifyContent: 'center', padding: 12 }} onClick={submit}>Request access</button>
          <div className="secnote"><span className="link" onClick={onBack}>← Back to sign in</span></div>
        </>)}
      </div></div>
    </div>
  );
}

function BrandPanel() {
  return (
    <div className="loginbrand">
      <TrilogyLogo size={34} light />
      <div className="bh">Care coordinated.<br />Costs contained.<br />Cases closed.</div>
      <div className="bs">The operating system for accident care — carriers refer, providers treat at contracted rates, and every case moves with the speed and discipline the claim deserves.</div>
      <div style={{ fontSize: 12, color: '#7C8AA3', fontFamily: 'var(--mono)' }}>trilogyconnections.com</div>
    </div>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<'creds' | 'enroll' | 'verify' | 'newpw'>('creds');
  const [signup, setSignup] = useState(false);
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [otpauthUrl, setOtpauthUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [code, setCode] = useState('');
  const [newPw, setNewPw] = useState('');
  const [newPw2, setNewPw2] = useState('');

  const login = async () => {
    setErr('');
    try {
      const r = await api('POST', '/auth/login', { email, password: pw });
      if (r.mfa === 'none') { if (r.user?.mustChangePw) setStep('newpw'); else onDone(); }
      else if (r.mfa === 'enroll') { setOtpauthUrl(r.otpauthUrl); setSecret(r.secret); setStep('enroll'); }
      else setStep('verify');
    } catch (e: any) { setErr(e.message); }
  };
  const verify = async () => {
    setErr('');
    try {
      const r = await api('POST', '/auth/mfa', { code });
      if (r.user.mustChangePw) setStep('newpw'); else onDone();
    } catch (e: any) { setErr(e.message); }
  };
  const setPassword = async () => {
    setErr('');
    if (newPw !== newPw2) { setErr('Passwords do not match'); return; }
    try { await api('POST', '/auth/change-password', { currentPassword: pw, newPassword: newPw }); onDone(); }
    catch (e: any) { setErr(e.message); }
  };

  if (signup) return <Signup onBack={() => setSignup(false)} />;
  return (
    <div className="loginwrap">
      <BrandPanel />
      <div className="loginside"><div className="loginbox">
        <TrilogyLogo size={26} />
        <p className="sub">Sign in to the platform.</p>
        {err && <div className="loginerr">{err}</div>}
        {step === 'creds' && (<>
          <div className="field"><label>Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} /></div>
          <div className="field"><label>Password</label>
            <input type="password" value={pw} onChange={e => setPw(e.target.value)} onKeyDown={e => e.key === 'Enter' && login()} /></div>
          <button className="btn primary" style={{ width: '100%', justifyContent: 'center', padding: 12 }} onClick={login}>Sign in</button>
          {location.hostname === 'localhost' && <div className="demobox"><b>Demo accounts</b><br />
            Admin: donny@trilogymed.com / admin123<br />
            Coordinator: nicole@trilogymed.com / coord123</div>}
          <div className="secnote">🔒 Encrypted sessions · full audit log · MFA at launch</div>
          <div className="secnote">Provider or carrier? <span className="link" onClick={() => setSignup(true)}>Request portal access</span></div>
        </>)}
        {step === 'enroll' && (<>
          <p className="sub" style={{ margin: '10px 0' }}><b>Set up MFA (one time)</b><br />
            Step 1: scan with any authenticator app. Step 2: type the 6-digit code it shows.</p>
          <div className="qrwrap">
            <QRCodeSVG value={otpauthUrl} size={150} />
            <div style={{ fontSize: 11, color: 'var(--ink-mute)' }}>Manual key: <code className="mono">{secret}</code></div>
          </div>
          <input className="mfainput" maxLength={6} placeholder="······" value={code}
            onChange={e => setCode(e.target.value.replace(/\D/g, ''))} onKeyDown={e => e.key === 'Enter' && verify()} />
          <button className="btn primary" style={{ width: '100%', justifyContent: 'center', padding: 12, marginTop: 12 }} onClick={verify}>Verify & continue</button>
        </>)}
        {step === 'verify' && (<>
          <p className="sub">Enter the 6-digit code from your authenticator app.</p>
          <input className="mfainput" maxLength={6} placeholder="······" value={code} autoFocus
            onChange={e => setCode(e.target.value.replace(/\D/g, ''))} onKeyDown={e => e.key === 'Enter' && verify()} />
          <button className="btn primary" style={{ width: '100%', justifyContent: 'center', padding: 12, marginTop: 12 }} onClick={verify}>Verify & continue</button>
        </>)}
        {step === 'newpw' && (<>
          <p className="sub"><b>Set your own password</b> — your temporary one expires now (8+ characters).</p>
          <div className="field"><label>New password</label>
            <input type="password" value={newPw} onChange={e => setNewPw(e.target.value)} autoFocus /></div>
          <div className="field"><label>Confirm</label>
            <input type="password" value={newPw2} onChange={e => setNewPw2(e.target.value)} onKeyDown={e => e.key === 'Enter' && setPassword()} /></div>
          <button className="btn primary" style={{ width: '100%', justifyContent: 'center', padding: 12 }} onClick={setPassword}>Save & enter Trilogy</button>
        </>)}
      </div></div>
    </div>
  );
}

/* ═══════════ search ═══════════ */
export function SearchBox({ big }: { big?: boolean }) {
  const { go } = useApp();
  const [q, setQ] = useState('');
  const [res, setRes] = useState<any>(null);
  const t = useRef<number>(0);
  const run = (v: string) => {
    setQ(v);
    window.clearTimeout(t.current);
    if (!v.trim()) { setRes(null); return; }
    t.current = window.setTimeout(() =>
      api('GET', '/search?q=' + encodeURIComponent(v)).then(setRes)
        .catch(() => setRes({ patients: [], providers: [], insurers: [], error: true })), 150);
  };
  const pick = (n: Nav) => { setQ(''); setRes(null); go(n); };
  return (
    <div className={big ? 'bigsearch' : 'searchwrap'} style={{ position: 'relative' }}>
      <span className="sicon" style={big ? { position: 'absolute', left: 12, top: 12 } : undefined}>🔍</span>
      <input className="search" style={big ? { padding: '12px 14px 12px 36px', fontSize: 15 } : undefined}
        placeholder="Search patients, providers, carriers…" value={q} onChange={e => run(e.target.value)} />
      {res && (
        <div className="sresults">
          {res.patients.map((p: any) => (
            <div key={p.id} className="sres" onClick={() => pick({ screen: 'patient', id: p.id })}>
              <span className="idchip">{p.id}</span>
              <div style={{ flex: 1 }}><b>{p.name}</b>
                <div style={{ fontSize: 11.5, color: 'var(--ink-mute)' }}>{p.caseType === 'trilogy' ? 'Trilogy' : 'Trilopay'} · {STAGES[p.stage]}</div></div>
              <span className="badge b-blue">Patient</span>
            </div>))}
          {res.providers.map((p: any) => (
            <div key={p.id} className="sres" onClick={() => pick({ screen: 'provider', id: p.id })}>
              <span className="idchip">{p.id}</span>
              <div style={{ flex: 1 }}><b>{p.name}</b><div style={{ fontSize: 11.5, color: 'var(--ink-mute)' }}>{p.type}</div></div>
              <span className="badge b-green">Provider</span>
            </div>))}
          {res.insurers.map((p: any) => (
            <div key={p.id} className="sres" onClick={() => pick({ screen: 'insurance', id: p.id })}>
              <span className="idchip">{p.id}</span>
              <div style={{ flex: 1 }}><b>{p.name}</b></div>
              <span className="badge b-purple">Carrier</span>
            </div>))}
          {!res.patients.length && !res.providers.length && !res.insurers.length &&
            <div className="sres">{(res as any).error ? 'Search error — is the server running?' : 'No matches'}</div>}
        </div>)}
    </div>
  );
}

/* ═══════════ command palette ═══════════ */
function CmdK({ onClose }: { onClose: () => void }) {
  const { boot, go } = useApp();
  const [q, setQ] = useState('');
  const [res, setRes] = useState<any>({ patients: [], providers: [], insurers: [] });
  const t = useRef<number>(0);
  useEffect(() => {
    window.clearTimeout(t.current);
    if (!q.trim()) { setRes({ patients: [], providers: [], insurers: [] }); return; }
    t.current = window.setTimeout(() => api('GET', '/search?q=' + encodeURIComponent(q)).then(setRes).catch(() => {}), 120);
  }, [q]);
  const jump = (n: Nav) => { onClose(); go(n); };
  const pages: [string, Nav][] = [['Today', { screen: 'today' }], ['Cases', { screen: 'cases' }], ['Schedule', { screen: 'schedule' }], ['Carriers', { screen: 'carriers' }], ['Providers', { screen: 'providers' }], ['Requests', { screen: 'inbox' }]];
  if (boot.user.role === 'admin') pages.push(['Growth', { screen: 'growth' }], ['Intelligence', { screen: 'intel' }], ['Admin', { screen: 'admin' }]);
  return (
    <div className="cmdk" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cmdk-box">
        <input autoFocus placeholder="Jump to a patient, provider, carrier, or page…" value={q}
          onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Escape' && onClose()} />
        <div className="cmdk-list">
          {!q.trim() && pages.map(([l, n]) => (
            <div key={l} className="cmdk-item" onClick={() => jump(n)}>→ {l}<span className="k">page</span></div>))}
          {res.patients.map((p: any) => (
            <div key={p.id} className="cmdk-item" onClick={() => jump({ screen: 'patient', id: p.id })}>
              {p.name}<span className="k">{p.id}</span></div>))}
          {res.providers.map((p: any) => (
            <div key={p.id} className="cmdk-item" onClick={() => jump({ screen: 'provider', id: p.id })}>
              {p.name}<span className="k">{p.id}</span></div>))}
          {res.insurers.map((p: any) => (
            <div key={p.id} className="cmdk-item" onClick={() => jump({ screen: 'insurance', id: p.id })}>
              {p.name}<span className="k">{p.id}</span></div>))}
        </div>
      </div>
    </div>
  );
}

/* ═══════════ AI request widget ═══════════ */
function AiWidget({ user }: { user: User }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<AiRequest[]>([]);
  const [text, setText] = useState('');
  useEffect(() => { if (open) api('GET', '/ai').then(setList); }, [open]);
  const submit = async () => { if (!text.trim()) return; setList(await api('POST', '/ai', { text })); setText(''); };
  const decide = async (id: number, status: string) => setList(await api('POST', `/ai/${id}/decide`, { status }));
  if (!open) return <button className="aifab" title="AI site editor" onClick={() => setOpen(true)}>✨</button>;
  return (
    <div className="aipanel">
      <div className="aihead"><b>✨ Site change requests</b>
        <span style={{ cursor: 'pointer', fontSize: 18 }} onClick={() => setOpen(false)}>✕</span></div>
      <div className="aibody">
        <div style={{ fontSize: 12, color: 'var(--ink-soft)', marginBottom: 8 }}>Describe a change; an admin reviews before it goes live.</div>
        <textarea value={text} onChange={e => setText(e.target.value)} placeholder='e.g. "Add a column for…"' />
        <button className="btn primary" style={{ width: '100%', justifyContent: 'center', margin: '8px 0 14px' }} onClick={submit}>Submit for review</button>
        {list.map(r => (
          <div key={r.id} className="aireq">{r.text}
            <div className="rmeta"><span>{r.time} · {r.by}</span>
              <span>{r.status === 'pending' ? (<>
                <span className="badge b-amber">Pending</span>
                {user.role === 'admin' && <> <button className="btn sm" onClick={() => decide(r.id, 'approved')}>✓</button>
                  <button className="btn sm" onClick={() => decide(r.id, 'denied')}>✕</button></>}
              </>) : r.status === 'approved' ? <span className="badge b-green">✓ Live</span> : <span className="badge b-red">Denied</span>}</span>
            </div></div>))}
        {!list.length && <div style={{ color: 'var(--ink-mute)', fontSize: 12 }}>No requests yet.</div>}
      </div>
    </div>
  );
}

/* ═══════════ shell ═══════════ */
export default function App() {
  const [me, setMe] = useState<User | null | undefined>(undefined);
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [nav, setNav] = useState<Nav>({ screen: 'today' });
  const [menu, setMenu] = useState(false);
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [pwModal, setPwModal] = useState(false);
  const [inboxCount, setInboxCount] = useState(0);
  const [cmdk, setCmdk] = useState(false);

  const isStaff = me && (me.role === 'admin' || me.role === 'coordinator');
  const refresh = async () => setBoot(await api('GET', '/bootstrap'));
  const loadAlerts = () => api('GET', '/alerts').then(setAlerts).catch(() => {});
  const loadInbox = () => api('GET', '/intake')
    .then(r => setInboxCount(r.items.filter((i: any) => i.status === 'triage' || i.status === 'queued').length))
    .catch(() => {});
  const fetchMe = () => api('GET', '/auth/me').then(r => setMe(r.user)).catch(() => setMe(null));
  useEffect(() => { fetchMe(); }, []);
  useEffect(() => {
    if (!isStaff) return;
    refresh().catch(() => setMe(null));
    loadAlerts(); loadInbox();
    const iv = setInterval(() => { loadAlerts(); loadInbox(); }, 5 * 60 * 1000);
    return () => clearInterval(iv);
  }, [isStaff]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setCmdk(v => !v); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const logoutPortal = async () => { await api('POST', '/auth/logout'); location.reload(); };
  if (me === undefined) return null;
  if (me === null) return <Login onDone={fetchMe} />;
  if (me.role === 'provider') return <ProviderPortal user={me} onLogout={logoutPortal} />;
  if (me.role === 'carrier') return <CarrierPortal user={me} onLogout={logoutPortal} />;
  if (!boot) return null;

  const screen = nav.screen === 'home' ? 'today' : nav.screen === 'directory' ? 'cases' : nav.screen;
  const go = (n: Nav) => { setNav(n); setMenu(false); setAlertsOpen(false); setCmdk(false); loadAlerts(); window.scrollTo(0, 0); };
  const logout = async () => { await api('POST', '/auth/logout'); location.reload(); };
  const wipe = async () => {
    if (!confirm('Wipe ALL demo data and start clean? Export a backup first if unsure.')) return;
    await api('POST', '/admin/wipe-demo'); await refresh(); go({ screen: 'today' });
  };
  const high = alerts.filter(a => a.severity === 'high').length;

  const NAV: [string, string, Nav['screen'], number?][] = [
    ['◈', 'Today', 'today'],
    ['▤', 'Cases', 'cases'],
    ['📅', 'Schedule', 'schedule'],
    ['🛡', 'Carriers', 'carriers'],
    ['⚕', 'Providers', 'providers'],
    ['📥', 'Requests', 'inbox', inboxCount],
  ];
  if (boot.user.role === 'admin') NAV.push(['⇗', 'Growth', 'growth'], ['◎', 'Intelligence', 'intel'], ['⚙', 'Admin', 'admin']);

  return (
    <AppCtx.Provider value={{ boot, go, refresh }}>
      <PrefsCtx.Provider value={{ prefs: boot.prefs, setPrefs: p => setBoot({ ...boot, prefs: p }) }}>
        <div className="shell">
          <aside className="sidebar">
            <div className="slogo" onClick={() => go({ screen: 'today' })}>
              <span className="word"><TrilogyLogo size={21} light /></span>
            </div>
            {NAV.map(([icon, label, s, cnt]) => (
              <div key={s} className={'snav-item' + (screen === s ? ' on' : '')} onClick={() => go({ screen: s } as Nav)}>
                <span>{icon}</span><span className="lbl">{label}</span>
                {cnt ? <span className="cnt">{cnt}</span> : null}
              </div>))}
            <div className="snav-sep" />
            <div className="snav-item" onClick={() => setCmdk(true)}>
              <span>⌘</span><span className="lbl">Jump anywhere</span><span className="cnt" style={{ background: 'rgba(255,255,255,.14)' }}>K</span>
            </div>
            <div className="suser" onClick={() => setMenu(m => !m)}>
              <div className="un">{boot.user.name}</div>
              <div className="ur">{boot.user.role}</div>
            </div>
          </aside>

          <div className="main">
            <div className="stopbar">
              <SearchBox />
              <span className="spacer" />
              <div style={{ position: 'relative' }}>
                <button className="btn sm" onClick={() => setAlertsOpen(o => !o)} title="Alerts">
                  🔔{alerts.length > 0 && <span className={'badge ' + (high ? 'b-red' : 'b-amber')} style={{ marginLeft: 4 }}>{alerts.length}</span>}
                </button>
                {alertsOpen && (
                  <div className="usermenu" style={{ right: 0, top: 40, minWidth: 380, maxHeight: 420, overflowY: 'auto' }}>
                    <div className="um" style={{ cursor: 'default', fontWeight: 700 }}>
                      Alerts {boot.user.role === 'coordinator' ? '— your cases' : '— all cases'}</div>
                    {alerts.map((a, i) => (
                      <div key={i} className="um" onClick={() => go({ screen: 'patient', id: a.patientId })}>
                        <span className={'badge ' + (a.severity === 'high' ? 'b-red' : 'b-amber')} style={{ marginRight: 6 }}>{a.severity === 'high' ? '!' : '•'}</span>
                        <b>{a.patientName}</b> · {a.text}
                      </div>))}
                    {!alerts.length && <div className="um" style={{ cursor: 'default', color: 'var(--ink-mute)' }}>All clear 🎉</div>}
                  </div>)}
              </div>
              <span className="rolechip">{boot.user.role}</span>
              <div className="avatar" onClick={() => setMenu(m => !m)}>{initials(boot.user.name)}</div>
              {menu && (
                <div className="usermenu">
                  <div className="um" style={{ cursor: 'default', fontWeight: 700 }}>{boot.user.name} — {boot.user.email}</div>
                  <div className="um" onClick={() => { setPwModal(true); setMenu(false); }}>🔑 Change my password</div>
                  {boot.user.role === 'admin' && <div className="um" onClick={() => { window.open('/api/admin/export'); setMenu(false); }}>⬇ Export data backup</div>}
                  {boot.user.role === 'admin' && <div className="um" style={{ color: 'var(--red)' }} onClick={wipe}>🗑 Wipe demo data</div>}
                  <div className="um" onClick={logout}>Log out</div>
                </div>)}
            </div>

            <div className="page">
              {screen === 'today' && <Today />}
              {screen === 'cases' && <CasesPage />}
              {screen === 'carriers' && <CarriersPage />}
              {screen === 'providers' && <ProvidersPage />}
              {screen === 'inbox' && <InboxScreen />}
              {screen === 'schedule' && <SchedulePage />}
              {screen === 'growth' && <GrowthPage />}
              {screen === 'intel' && <IntelPage />}
              {screen === 'admin' && <AdminScreen />}
              {nav.screen === 'patient' && <PatientScreen id={nav.id} />}
              {nav.screen === 'provider' && <ProviderScreen id={nav.id} />}
              {nav.screen === 'insurance' && <InsurerScreen id={nav.id} />}
            </div>
          </div>
        </div>

        {cmdk && <CmdK onClose={() => setCmdk(false)} />}
        <AiWidget user={boot.user} />
        {pwModal && (
          <FormModal title="Change my password" onClose={() => setPwModal(false)} saveLabel="Change password"
            fields={[
              { key: 'currentPassword', label: 'Current password', type: 'text', full: true },
              { key: 'newPassword', label: 'New password (8+ characters)', type: 'text', full: true },
            ]}
            onSave={async v => { await api('POST', '/auth/change-password', v); alert('Password changed.'); setPwModal(false); }} />)}
      </PrefsCtx.Provider>
    </AppCtx.Provider>
  );
}
