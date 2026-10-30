import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, UserCheck, Users } from 'lucide-react';
import { getUsers, updateUserRole } from '../services/api';

const ROLES = ['client', 'staff', 'manager', 'admin'];
const roleStyles = {
  admin: 'bg-purple-50 text-purple-700',
  manager: 'bg-blue-50 text-blue-700',
  staff: 'bg-emerald-50 text-emerald-700',
  client: 'bg-amber-50 text-amber-700',
};

export default function UserApprovals({ refreshTrigger = 0 }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [savingId, setSavingId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try { const response = await getUsers(); setUsers(response.data || []); }
    catch (err) { setError(err.response?.data?.message || err.message || 'Could not load accounts.'); }
    finally { setLoading(false); }
  }, [refreshTrigger]);
  useEffect(() => { load(); }, [load]);

  const changeRole = async (userId, role) => {
    setSavingId(userId);
    setError('');
    try { await updateUserRole(userId, role); await load(); }
    catch (err) { setError(err.response?.data?.message || err.message || 'Could not update the role.'); }
    finally { setSavingId(null); }
  };

  const pending = users.filter(user => user.role === 'client');

  return <section className="space-y-6">
    <header className="flex items-end justify-between gap-3"><div><h2 className="text-2xl font-bold text-gray-900">User approvals</h2><p className="text-gray-600 mt-1">New registrations start as clients. Approve them by assigning a workspace role.</p></div><button className="btn btn-secondary" onClick={load} disabled={loading}><RefreshCw className="w-4 h-4 mr-2 inline"/>Refresh</button></header>
    {error && <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 p-4">{error}</div>}
    {!loading && <div className="card p-4 text-sm text-gray-700"><strong>{pending.length}</strong> account{pending.length === 1 ? '' : 's'} awaiting approval · {users.length} total</div>}
    {loading ? <div className="card p-12 text-center text-gray-500">Loading accounts…</div> : users.length === 0 ? <div className="card p-12 text-center"><Users className="w-10 h-10 text-gray-300 mx-auto mb-3"/><h3 className="font-semibold text-gray-800">No accounts yet</h3></div> : <div className="card overflow-hidden"><div className="overflow-x-auto"><table className="min-w-full text-sm"><thead className="bg-gray-50 text-gray-500 text-left"><tr>{['Account','Registered','Status','Role','Actions'].map(label => <th key={label} className="px-4 py-3 font-medium">{label}</th>)}</tr></thead><tbody className="divide-y divide-gray-100">{users.map(user => <tr key={user.user_id} className="align-middle">
      <td className="px-4 py-4"><div className="font-semibold text-gray-900">{user.display_name || user.email}</div><div className="text-gray-500">{user.email}</div></td>
      <td className="px-4 py-4 text-gray-600 whitespace-nowrap">{new Date(user.created_at).toLocaleString()}</td>
      <td className="px-4 py-4">{user.role === 'client' ? <span className="rounded-full bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700">Pending approval</span> : <span className="rounded-full bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700">Approved</span>}</td>
      <td className="px-4 py-4"><span className={`rounded-full px-2 py-1 text-xs font-medium ${roleStyles[user.role] || ''}`}>{user.role}</span></td>
      <td className="px-4 py-4"><div className="flex flex-wrap items-center gap-2">
        {user.role === 'client' && <button className="btn btn-primary" disabled={savingId === user.user_id} onClick={() => changeRole(user.user_id, 'staff')}><UserCheck className="w-4 h-4 mr-1 inline"/>Approve as staff</button>}
        <select className="input" value={user.role} disabled={savingId === user.user_id} onChange={e => changeRole(user.user_id, e.target.value)} aria-label={`Role for ${user.email}`}>{ROLES.map(role => <option key={role} value={role}>{role}</option>)}</select>
      </div></td>
    </tr>)}</tbody></table></div></div>}
  </section>;
}
