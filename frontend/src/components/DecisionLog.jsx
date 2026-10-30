import { useCallback, useEffect, useState } from 'react';
import { Activity, RefreshCw, Search } from 'lucide-react';
import { getDecisionEvents } from '../services/api';

const humanize = value => String(value || 'event').replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase());
const eventTone = value => value?.includes('rejected') || value?.includes('failed') || value?.includes('conflict') || value?.includes('validation') ? 'bg-red-50 text-red-700 border-red-100' : value?.includes('cancelled') || value?.includes('released') ? 'bg-amber-50 text-amber-700 border-amber-100' : 'bg-teal-50 text-teal-700 border-teal-100';

export default function DecisionLog({ refreshTrigger = 0 }) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [bookingId, setBookingId] = useState('');
  const [submittedId, setSubmittedId] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const response = await getDecisionEvents({ limit: 200, ...(submittedId ? { booking_id: submittedId } : {}) });
      setEvents(response.data || []);
    } catch (err) { setError(err.response?.data?.message || err.message || 'Could not load decision events.'); }
    finally { setLoading(false); }
  }, [refreshTrigger, submittedId]);
  useEffect(() => { load(); }, [load]);

  return <section className="space-y-6">
    <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4"><div><h2 className="text-2xl font-bold text-gray-900">Decision Log</h2><p className="text-gray-600 mt-1">Auditable history of allocation decisions, status changes, waitlist promotions and resource releases.</p></div><form className="flex gap-2" onSubmit={e => { e.preventDefault(); setSubmittedId(bookingId.trim()); }}><div className="relative"><Search className="w-4 h-4 absolute left-3 top-3 text-gray-400"/><input value={bookingId} onChange={e => setBookingId(e.target.value)} placeholder="Booking ID (optional)" className="input pl-9" type="number" min="1"/></div><button className="btn btn-secondary" type="submit">Filter</button><button className="btn btn-secondary" type="button" onClick={load} disabled={loading}><RefreshCw className="w-4 h-4"/></button></form></header>
    {error && <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 p-4">{error}</div>}
    {loading ? <div className="card p-12 text-center text-gray-500">Loading decisions…</div> : events.length === 0 ? <div className="card p-12 text-center"><Activity className="w-10 h-10 text-gray-300 mx-auto mb-3"/><p className="font-semibold text-gray-800">No decision events found</p><p className="text-sm text-gray-500 mt-1">New booking actions will be recorded here.</p></div> : <div className="space-y-3">{events.map(event => <article key={event.event_id || event.id} className="card p-5"><div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3"><div className="flex items-start gap-3"><div className="rounded-lg bg-gray-50 p-2"><Activity className="w-4 h-4 text-gray-500"/></div><div><div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold text-gray-900">{humanize(event.event_type)}</h3><span className={`inline-flex rounded-full border px-2 py-0.5 text-xs ${eventTone(event.event_type)}`}>{event.current_booking_status || 'audit event'}</span></div><p className="text-sm text-gray-500 mt-1">{event.event_name || 'System event'}{event.booking_id ? ` · Booking #${event.booking_id}` : ''}{event.client_name ? ` · ${event.client_name}` : ''}</p><p className="text-xs text-gray-400 mt-1">{new Date(event.created_at).toLocaleString()} {event.correlation_id ? `· Request ${event.correlation_id}` : ''}</p></div></div></div>{event.event_data && <details className="mt-4"><summary className="text-sm text-indigo-700 cursor-pointer font-medium">View decision details</summary><pre className="mt-2 p-3 rounded bg-gray-50 border border-gray-100 text-xs text-gray-700 overflow-x-auto whitespace-pre-wrap">{JSON.stringify(event.event_data, null, 2)}</pre></details>}</article>)}</div>}
  </section>;
}
