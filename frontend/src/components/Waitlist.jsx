import { useCallback, useEffect, useState } from 'react';
import { Clock3, RefreshCw, Users } from 'lucide-react';
import { getWaitlist } from '../services/api';

export default function Waitlist({ refreshTrigger = 0 }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try { const response = await getWaitlist(); setItems(response.data || []); }
    catch (err) { setError(err.response?.data?.message || err.message || 'Could not load the waitlist.'); }
    finally { setLoading(false); }
  }, [refreshTrigger]);
  useEffect(() => { load(); }, [load]);

  return <section className="space-y-6">
    <header className="flex items-end justify-between gap-3"><div><h2 className="text-2xl font-bold text-gray-900">Waitlist</h2><p className="text-gray-600 mt-1">Requests are re-evaluated in arrival order when resources are released.</p></div><button className="btn btn-secondary" onClick={load} disabled={loading}><RefreshCw className="w-4 h-4 mr-2 inline"/>Refresh</button></header>
    {error && <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 p-4">{error}</div>}
    {loading ? <div className="card p-12 text-center text-gray-500">Loading queue…</div> : items.length === 0 ? <div className="card p-12 text-center"><Clock3 className="w-10 h-10 text-gray-300 mx-auto mb-3"/><h3 className="font-semibold text-gray-800">No pending requests</h3><p className="text-sm text-gray-500 mt-1">When a client chooses to wait, the request will appear here.</p></div> : <div className="card overflow-hidden"><div className="overflow-x-auto"><table className="min-w-full text-sm"><thead className="bg-gray-50 text-gray-500 text-left"><tr>{['Position','Request','Client','Guests','Requested resources','Why it is waiting'].map(label => <th key={label} className="px-4 py-3 font-medium">{label}</th>)}</tr></thead><tbody className="divide-y divide-gray-100">{items.map((item, index) => <tr key={item.id} className="align-top"><td className="px-4 py-4"><span className="inline-flex w-8 h-8 rounded-full bg-indigo-50 text-indigo-700 items-center justify-center font-semibold">{index + 1}</span></td><td className="px-4 py-4"><div className="font-semibold text-gray-900">{item.event_name}</div><div className="text-gray-500 mt-1">{item.event_date} · {String(item.event_start).slice(0,5)}–{String(item.event_end).slice(0,5)}</div><div className="text-xs text-gray-400 mt-1">Requested venue: {item.preferred_venue_name || 'Any suitable venue'}</div></td><td className="px-4 py-4 text-gray-700">{item.client_name}</td><td className="px-4 py-4"><span className="inline-flex items-center gap-1"><Users className="w-3.5 h-3.5"/>{item.attendees}</span></td><td className="px-4 py-4 text-gray-600 whitespace-nowrap">{item.projectors_requested || 0} projectors<br/>{item.audio_systems_requested || 0} audio<br/>{item.staff_requested || 0} staff</td><td className="px-4 py-4 text-gray-600 min-w-64">{item.rejection_reason || 'Waiting for a compatible hall and resource combination.'}</td></tr>)}</tbody></table></div></div>}
  </section>;
}
