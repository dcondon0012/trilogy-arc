import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../App';
import { FormModal } from '../ui';
import type { AiRequest } from '../types';

interface AdminUser { id: string; name: string; email: string; role: string; active: number; mfaEnrolled: boolean; approved?: number; orgName?: string | null; }
interface AuditRow { id: number; time: string; userName: string; action: string; entity: string | null; entityId: string | null; detail: string | null; }

export function AdminScreen() {
  const { boot, go, refresh } = useApp();
  const [tab, setTab] = useState<'users' | 'audit' | 'ai' | 'data'>('users');
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [ai, setAi] = useState<AiRequest[]>([]);
  const [filter, setFilter] = useState('');
  const [userQ, setUserQ] = useState('');
  const [modal, setModal] = useState<React.ReactNode>(null);

  const loadUsers = () => api('GET', '/admin/users').then(setUsers);
  useEffect(() => { loadUsers(); }, []);
  useEffect(() => {
    if (tab === 'audit') api('GET', '/admin/audit').then(setAudit);
    if (tab === 'ai') api('GET', '/ai').then(setAi);
  }, [tab]);

  if (boot.user.role !== 'admin') return <div className="card"><div className="cbody">Admins only.</div></div>;

  const act = async (fn: () => Promise<any>) => {
    try { await fn(); await loadUsers(); await refresh(); } catch (e: any) { alert(e.message || 'Error'); }
  };

  const addUser = () => setModal(
    <FormModal title="Add user" onClose={() => setModal(null)} saveLabel="Create account"
      fields={[
        { key: 'name', label: 'Full name*' },
        { key: 'role', label: 'Role / permissions', type: 'select', options: [
          { v: 'coordinator', l: 'Coordinator — day-to-day case work; no financials, stats, audit log, or admin tools' },
          { v: 'admin', l: 'Admin — everything, incl. financials, business stats, user management' }] },
        { key: 'email', label: 'Email*', type: 'email', full: true },
        { key: 'password', label: 'Temporary password* (8+ chars — they should change it via you resetting after first login)', full: true },
      ]}
      onSave={async v => { await act(() => api('POST', '/admin/users', v)); setModal(null); }} />);

  const resetPw = (u: AdminUser) => setModal(
    <FormModal title={'Reset password — ' + u.name} onClose={() => setModal(null)} saveLabel="Reset"
      fields={[{ key: 'password', label: 'New temporary password (8+ chars)', full: true }]}
      onSave={async v => { await act(() => api('POST', `/admin/users/${u.id}/reset-password`, v)); setModal(null); }} />);

  const auditShown = audit.filter(a =>
    (a.userName + a.action + (a.entity || '') + (a.entityId || '') + (a.detail || '')).toLowerCase().includes(filter.toLowerCase()));

  return (
    <div>
      <span className="backlink" onClick={() => go({ screen: 'home' })}>← Back</span>
      <div className="pt-head">
        <div className="pt-id" style={{ background: 'var(--ink)' }}>⚙</div>
        <div className="pt-title" style={{ flex: 1 }}>
          <h2>Admin Control Panel</h2>
          <div className="pt-meta"><span className="badge b-purple">Admins only — every action here is written to the audit log</span></div>
        </div>
      </div>

      <div className="tabs">
        {([['users', 'Users & Permissions'], ['audit', 'Audit Log'], ['ai', 'AI Change Requests'], ['data', 'Data & Backups']] as const).map(([k, l]) => (
          <div key={k} className={'tab' + (tab === k ? ' active' : '')} onClick={() => setTab(k)}>{l}</div>))}
      </div>

      {tab === 'users' && users.some(u => u.approved === 0) && (
        <div className="card" style={{ marginBottom: 16, borderColor: 'var(--amber)' }}>
          <div className="chead"><h3>⏳ Portal access requests awaiting approval</h3></div>
          <div className="cbody">
            <table><tbody>
              <tr><th>Name</th><th>Email</th><th>Type</th><th>Organization</th><th></th></tr>
              {users.filter(u => u.approved === 0).map(u => (
                <tr key={u.id}>
                  <td><b>{u.name}</b></td><td>{u.email}</td>
                  <td><span className={'badge ' + (u.role === 'provider' ? 'b-green' : 'b-purple')}>{u.role}</span></td>
                  <td>{u.orgName || '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn sm primary" onClick={() => act(() => api('POST', `/admin/users/${u.id}/approve`, { approve: true, orgRole: 'worker' }))}>✓ Approve as worker</button>{' '}
                    <button className="btn sm" onClick={() => confirm(`Approve ${u.name} as ORG ADMIN? They'll see contract rates (providers) or all cases + roster management (carriers).`) && act(() => api('POST', `/admin/users/${u.id}/approve`, { approve: true, orgRole: 'admin' }))}>✓ As org admin</button>{' '}
                    <button className="btn sm" style={{ color: 'var(--red)' }} onClick={() => confirm('Deny and deactivate this request?') && act(() => api('POST', `/admin/users/${u.id}/approve`, { approve: false }))}>✕ Deny</button>
                  </td>
                </tr>))}
            </tbody></table>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 8 }}>Verify the person actually works at the organization before approving — call the office line on file, not a number they provide.</div>
          </div>
        </div>
      )}
      {tab === 'users' && (
        <div className="card">
          <div className="chead"><h3>All accounts (staff + portal)</h3>
            <div style={{ display: 'flex', gap: 8 }}>
              <input placeholder="🔍 Search name, email, org…" value={userQ} onChange={e => setUserQ(e.target.value)}
                style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '6px 10px', fontSize: 12.5, width: 230 }} />
              <button className="btn sm primary" onClick={addUser}>＋ Add user</button>
            </div></div>
          <div className="cbody">
            <table><tbody>
              <tr><th>Name</th><th>Email</th><th>Role</th><th>MFA</th><th>Status</th><th>Actions</th></tr>
              {users.filter(u => (u.name + u.email + (u.orgName || '') + u.role).toLowerCase().includes(userQ.toLowerCase())).map(u => (
                <tr key={u.id} style={u.active ? undefined : { opacity: 0.5 }}>
                  <td><b>{u.name}</b>{u.id === boot.user.id && <span className="badge b-blue" style={{ marginLeft: 6 }}>you</span>}</td>
                  <td>{u.email}</td>
                  <td>
                    {u.role === 'provider' || u.role === 'carrier'
                      ? <span className={'badge ' + (u.role === 'provider' ? 'b-green' : 'b-purple')}>{u.role}{u.orgName ? ' · ' + u.orgName : ''}</span>
                      : <select value={u.role} disabled={u.id === boot.user.id}
                          onChange={e => act(() => api('PATCH', `/admin/users/${u.id}`, { role: e.target.value }))}
                          style={{ border: '1px solid var(--line)', borderRadius: 6, padding: '4px 6px', fontSize: 12 }}>
                          <option value="admin">Admin</option>
                          <option value="coordinator">Coordinator</option>
                        </select>}
                  </td>
                  <td>{u.mfaEnrolled ? <span className="badge b-green">✓ Enrolled</span> : <span className="badge b-amber">Not set up</span>}</td>
                  <td>{u.active ? <span className="badge b-green">Active</span> : <span className="badge b-red">Deactivated</span>}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn sm" onClick={() => resetPw(u)}>Reset password</button>{' '}
                    <button className="btn sm" disabled={!u.mfaEnrolled}
                      onClick={() => confirm(`Reset MFA for ${u.name}? They'll scan a fresh QR at next login.`) && act(() => api('POST', `/admin/users/${u.id}/reset-mfa`))}>Reset MFA</button>{' '}
                    {u.id !== boot.user.id && (u.active
                      ? <button className="btn sm" style={{ color: 'var(--red)' }}
                          onClick={() => confirm(`Deactivate ${u.name}? They'll be signed out and unable to log in.`) && act(() => api('PATCH', `/admin/users/${u.id}`, { active: 0 }))}>Deactivate</button>
                      : <button className="btn sm" onClick={() => act(() => api('PATCH', `/admin/users/${u.id}`, { active: 1 }))}>Reactivate</button>)}
                  </td>
                </tr>))}
            </tbody></table>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 10 }}>
              Roles are the permission system: <b>Admin</b> sees internal financials, business stats, the audit log, and this panel. <b>Coordinator</b> works cases without any of that. Finer-grained permissions (per-widget, provider/carrier portal roles) come with the hosted deployment.</div>
          </div>
        </div>
      )}

      {tab === 'audit' && (
        <div className="card">
          <div className="chead"><h3>Audit log — last 500 actions</h3>
            <input placeholder="🔍 Filter by user, action, patient…" value={filter} onChange={e => setFilter(e.target.value)}
              style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '6px 10px', fontSize: 12.5, width: 260 }} /></div>
          <div className="cbody" style={{ maxHeight: 520, overflowY: 'auto' }}>
            <table><tbody>
              <tr><th>When (UTC)</th><th>Who</th><th>Action</th><th>Record</th><th>Detail</th></tr>
              {auditShown.map(a => (
                <tr key={a.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{a.time.replace('T', ' ').slice(0, 19)}</td>
                  <td>{a.userName}</td>
                  <td><span className="idchip">{a.action}</span></td>
                  <td>{a.entityId || '—'}</td>
                  <td>{a.detail || '—'}</td>
                </tr>))}
              {!auditShown.length && <tr><td colSpan={5} style={{ color: 'var(--muted)' }}>No matching entries.</td></tr>}
            </tbody></table>
          </div>
        </div>
      )}

      {tab === 'ai' && (
        <div className="card">
          <div className="chead"><h3>AI site-change requests</h3></div>
          <div className="cbody">
            {ai.map(r => (
              <div key={r.id} className="aireq">{r.text}
                <div className="rmeta"><span>{r.time} · {r.by}</span>
                  <span>{r.status === 'pending' ? (<>
                    <span className="badge b-amber">Pending review</span>{' '}
                    <button className="btn sm" onClick={() => api('POST', `/ai/${r.id}/decide`, { status: 'approved' }).then(setAi)}>✓ Approve</button>{' '}
                    <button className="btn sm" onClick={() => api('POST', `/ai/${r.id}/decide`, { status: 'denied' }).then(setAi)}>✕ Deny</button>
                  </>) : r.status === 'approved' ? <span className="badge b-green">✓ Approved</span> : <span className="badge b-red">Denied</span>}</span>
                </div>
              </div>))}
            {!ai.length && <div style={{ color: 'var(--muted)' }}>No requests yet. The team submits these from the ✨ button, bottom-right of any page.</div>}
          </div>
        </div>
      )}

      {tab === 'data' && (
        <div className="grid2">
          <div className="card">
            <div className="chead"><h3>Backup</h3></div>
            <div className="cbody">
              <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 12 }}>
                Downloads every record as JSON. The uploaded files live in <b>trilogy-app/data/uploads</b> — copy that folder along with the export for a complete backup.</p>
              <button className="btn primary" onClick={() => window.open('/api/admin/export')}>⬇ Export full data backup</button>
            </div>
          </div>
          <div className="card">
            <div className="chead"><h3>Danger zone</h3></div>
            <div className="cbody">
              <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 12 }}>
                Deletes every patient, provider, insurer, and file record. User accounts survive. Export a backup first.</p>
              <button className="btn" style={{ color: 'var(--red)', borderColor: 'var(--red)' }}
                onClick={async () => {
                  if (!confirm('Wipe ALL case data? This cannot be undone. (User accounts are kept.)')) return;
                  if (!confirm('Really sure? Export a backup first if there is any doubt.')) return;
                  await api('POST', '/admin/wipe-demo'); await refresh(); go({ screen: 'home' });
                }}>🗑 Wipe all case data</button>
            </div>
          </div>
        </div>
      )}
      {modal}
    </div>
  );
}
