import { useCallback, useEffect, useMemo, useState } from 'react';
import { ClipboardCheck, Printer, RefreshCw, Save, Search, CheckCircle2, Clock3, AlertCircle, FileText } from 'lucide-react';
import { getEventOrders, updateEventOrder } from '../services/api';

const today = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const timeLabel = value => String(value || '').slice(0, 5);
const displayDate = value => value ? new Date(`${String(value).slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }) : 'Date not set';
const DEFAULT_TASKS = [
  { id: 'room_setup', label: 'Room layout and seating prepared', done: false },
  { id: 'av_check', label: 'Projectors and audio tested', done: false },
  { id: 'staff_briefing', label: 'Support staff briefed', done: false },
  { id: 'client_ready', label: 'Client arrival and access confirmed', done: false },
  { id: 'cleanup', label: 'Cleanup and resource return completed', done: false },
];

function parseRunOfShow(value) {
  return String(value || '').split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const [time = '', activity = '', ...notes] = line.split('|').map(part => part.trim());
    return { time, activity, notes: notes.join(' | ') };
  });
}
function renderRunOfShow(value) {
  return (value || []).map(item => [item.time, item.activity, item.notes].filter(Boolean).join(' | ')).join('\n');
}
function defaultForm(order) {
  return {
    status: order?.status || 'draft',
    setup_notes: order?.setup_notes || '',
    av_notes: order?.av_notes || '',
    catering_notes: order?.catering_notes || '',
    accessibility_notes: order?.accessibility_notes || '',
    special_instructions: order?.special_instructions || '',
    run_of_show: order?.run_of_show || [],
    setup_checklist: Array.isArray(order?.setup_checklist) && order.setup_checklist.length ? order.setup_checklist : DEFAULT_TASKS,
    version: Number(order?.version || 0),
  };
}

export default function StaffPortal({ refreshTrigger = 0 }) {
  const [date, setDate] = useState(today);
  const [orders, setOrders] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [form, setForm] = useState(defaultForm(null));
  const [runText, setRunText] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const response = await getEventOrders(date);
      const rows = response.data || [];
      setOrders(rows);
      setSelectedId(current => rows.some(row => Number(row.booking_id) === Number(current)) ? current : rows[0]?.booking_id ?? null);
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Unable to load event orders.');
    } finally { setLoading(false); }
  }, [date, refreshTrigger]);
  useEffect(() => { load(); }, [load]);

  const selected = useMemo(() => orders.find(order => Number(order.booking_id) === Number(selectedId)) || null, [orders, selectedId]);
  useEffect(() => {
    setForm(defaultForm(selected));
    setRunText(renderRunOfShow(selected?.run_of_show));
    setNotice('');
  }, [selected?.booking_id, selected?.version, selected?.updated_at]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return orders;
    return orders.filter(order => [order.event_name, order.client_name, order.venue_name, order.hall_name, order.client_organization].some(value => String(value || '').toLowerCase().includes(q)));
  }, [orders, search]);

  const updateField = (field, value) => setForm(current => ({ ...current, [field]: value }));
  const toggleTask = (taskId, checked) => updateField('setup_checklist', form.setup_checklist.map(task => task.id === taskId ? { ...task, done: checked } : task));

  const save = async () => {
    if (!selected) return;
    setSaving(true); setError(''); setNotice('');
    try {
      const response = await updateEventOrder(selected.booking_id, { ...form, run_of_show: parseRunOfShow(runText) });
      const saved = response.event_order;
      setOrders(rows => rows.map(row => Number(row.booking_id) === Number(selected.booking_id) ? {
        ...row, ...form, ...saved, booking_id: selected.booking_id,
        run_of_show: saved.run_of_show || parseRunOfShow(runText),
        setup_checklist: saved.setup_checklist || form.setup_checklist,
      } : row));
      setForm(current => ({ ...current, version: Number(saved.version || current.version + 1) }));
      setNotice('Event order saved successfully.');
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Unable to save the event order.');
    } finally { setSaving(false); }
  };

  return <section className="space-y-6">
    <header className="no-print flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div><div className="mb-2 inline-flex items-center gap-2 rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700"><ClipboardCheck className="h-4 w-4" /> STAFF OPERATIONS</div><h2 className="text-2xl font-bold text-gray-900">Staff Portal & Digital Event Orders</h2><p className="mt-1 max-w-3xl text-sm text-gray-600">Live operational briefs for confirmed events. Track setup, AV readiness, accessibility notes, run-of-show and cleanup from one place.</p></div>
      <div className="flex items-center gap-2"><label htmlFor="beo-date" className="sr-only">Event date</label><input id="beo-date" type="date" className="input" value={date} onChange={event => setDate(event.target.value)} /><button className="btn btn-secondary" onClick={load} disabled={loading}><RefreshCw className={`mr-2 inline h-4 w-4 ${loading ? 'animate-spin' : ''}`} />Refresh</button></div>
    </header>

    {error && <div role="alert" className="no-print flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{error}</div>}
    {notice && <div role="status" className="no-print flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800"><CheckCircle2 className="h-4 w-4" />{notice}</div>}

    <div className="grid gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
      <aside className="no-print card overflow-hidden">
        <div className="border-b border-gray-100 p-4"><div className="flex items-center justify-between gap-2"><h3 className="font-semibold text-gray-900">Confirmed events</h3><span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">{filtered.length}</span></div><div className="relative mt-3"><Search className="absolute left-3 top-3 h-4 w-4 text-gray-400" /><input className="input w-full pl-9" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search event, client, hall…" /></div></div>
        {loading ? <div className="p-8 text-center text-sm text-gray-500">Loading events…</div> : filtered.length ? <div className="max-h-[68vh] overflow-y-auto">{filtered.map(order => <button key={order.booking_id} onClick={() => setSelectedId(order.booking_id)} className={`block w-full border-b border-gray-100 p-4 text-left transition hover:bg-slate-50 ${Number(order.booking_id) === Number(selectedId) ? 'border-l-4 border-l-indigo-600 bg-indigo-50/70' : ''}`}><div className="flex items-start justify-between gap-2"><span className="font-semibold text-gray-900">{order.event_name}</span><span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${order.status === 'completed' ? 'bg-emerald-100 text-emerald-700' : order.status === 'ready' ? 'bg-sky-100 text-sky-700' : 'bg-amber-100 text-amber-700'}`}>{order.status || 'draft'}</span></div><p className="mt-1 text-xs text-gray-500">{order.client_name} · {order.venue_name} / {order.hall_name}</p><p className="mt-2 flex items-center gap-1 text-xs text-gray-600"><Clock3 className="h-3.5 w-3.5" />{timeLabel(order.event_start)}–{timeLabel(order.event_end)} <span className="text-gray-400">(reserved {timeLabel(order.reserved_start)}–{timeLabel(order.reserved_end)})</span></p></button>)}</div> : <div className="p-8 text-center text-sm text-gray-500">No confirmed bookings for this date.</div>}
      </aside>

      {selected ? <div className="beo-print-area space-y-5">
        <div className="card overflow-hidden">
          <div className="flex flex-col gap-4 border-b border-gray-100 p-5 sm:flex-row sm:items-start sm:justify-between"><div><div className="text-xs font-semibold uppercase tracking-widest text-indigo-600">Event order · #{selected.booking_id}</div><h3 className="mt-1 text-xl font-bold text-gray-900">{selected.event_name}</h3><p className="mt-1 text-sm text-gray-600">{selected.client_name}{selected.client_organization ? ` · ${selected.client_organization}` : ''}</p></div><div className="no-print flex flex-wrap gap-2"><button className="btn btn-secondary" onClick={() => window.print()}><Printer className="mr-2 h-4 w-4" />Print BEO</button><button className="btn btn-primary" onClick={save} disabled={saving}><Save className="mr-2 h-4 w-4" />{saving ? 'Saving…' : 'Save changes'}</button></div></div>
          <div className="grid gap-4 bg-slate-50 p-5 sm:grid-cols-2 xl:grid-cols-4"><div><p className="text-xs text-gray-500">Venue / Hall</p><p className="mt-1 font-semibold text-gray-900">{selected.venue_name} · {selected.hall_name}</p><p className="text-xs text-gray-500">Capacity {selected.hall_capacity || '—'}</p></div><div><p className="text-xs text-gray-500">Date</p><p className="mt-1 font-semibold text-gray-900">{displayDate(selected.event_date)}</p></div><div><p className="text-xs text-gray-500">Event time</p><p className="mt-1 font-semibold text-gray-900">{timeLabel(selected.event_start)}–{timeLabel(selected.event_end)}</p><p className="text-xs text-gray-500">Hall/resources reserved {timeLabel(selected.reserved_start)}–{timeLabel(selected.reserved_end)}</p></div><div><p className="text-xs text-gray-500">Attendance / resources</p><p className="mt-1 font-semibold text-gray-900">{selected.attendees} attendees</p><p className="text-xs text-gray-500">{selected.projectors_requested} projectors · {selected.audio_systems_requested} audio · {selected.staff_requested} staff</p></div></div>
        </div>

        <div className="card space-y-5 p-5">
          <div className="no-print flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><div><h4 className="font-semibold text-gray-900">Operations status</h4><p className="text-xs text-gray-500">Changes are versioned so concurrent edits can be detected.</p></div><select className="input sm:max-w-xs" value={form.status} onChange={event => updateField('status', event.target.value)}><option value="draft">Draft</option><option value="ready">Ready for event</option><option value="in_progress">In progress</option><option value="completed">Completed</option></select></div>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="block text-sm font-medium text-gray-700">Setup & room layout<textarea className="input mt-1 min-h-24 w-full" value={form.setup_notes} onChange={event => updateField('setup_notes', event.target.value)} placeholder="Seating layout, room reset, access times…" /></label>
            <label className="block text-sm font-medium text-gray-700">Audio-visual requirements<textarea className="input mt-1 min-h-24 w-full" value={form.av_notes} onChange={event => updateField('av_notes', event.target.value)} placeholder="Projector inputs, microphone checks, screen setup…" /></label>
            <label className="block text-sm font-medium text-gray-700">Catering & hospitality<textarea className="input mt-1 min-h-24 w-full" value={form.catering_notes} onChange={event => updateField('catering_notes', event.target.value)} placeholder="Service timings, dietary notes, refreshment stations…" /></label>
            <label className="block text-sm font-medium text-gray-700">Accessibility & special arrangements<textarea className="input mt-1 min-h-24 w-full" value={form.accessibility_notes} onChange={event => updateField('accessibility_notes', event.target.value)} placeholder="Accessible seating, routes, interpreters, accommodations…" /></label>
          </div>
          <label className="block text-sm font-medium text-gray-700">Special instructions<textarea className="input mt-1 min-h-24 w-full" value={form.special_instructions} onChange={event => updateField('special_instructions', event.target.value)} placeholder="Client contact, emergency plan, important handoffs…" /></label>
        </div>

        <div className="grid gap-5 xl:grid-cols-2">
          <div className="card p-5"><div className="mb-4 flex items-center justify-between"><div><h4 className="font-semibold text-gray-900">Setup checklist</h4><p className="text-xs text-gray-500">Mark tasks complete as the team prepares the venue.</p></div><span className="text-xs font-semibold text-gray-600">{form.setup_checklist.filter(task => task.done).length}/{form.setup_checklist.length}</span></div><div className="space-y-3">{form.setup_checklist.map(task => <label key={task.id} className="flex items-start gap-3 rounded-lg border border-gray-100 p-3"><input className="mt-0.5 h-4 w-4 rounded border-gray-300 text-indigo-600" type="checkbox" checked={task.done === true} onChange={event => toggleTask(task.id, event.target.checked)} /><span className={`text-sm ${task.done ? 'text-gray-400 line-through' : 'text-gray-700'}`}>{task.label}</span></label>)}</div></div>
          <div className="card p-5"><div className="mb-3"><h4 className="font-semibold text-gray-900">Run of show</h4><p className="text-xs text-gray-500">One item per line: <code>HH:MM | Activity | Notes</code>.</p></div><textarea className="input min-h-[250px] w-full font-mono text-sm" value={runText} onChange={event => setRunText(event.target.value)} placeholder={'09:30 | Setup complete | AV check\n10:00 | Guest arrival | Registration desk\n10:15 | Opening remarks |'} /><p className="mt-2 text-xs text-gray-500">Use 24-hour time. The saved BEO preserves the agenda as structured data.</p></div>
        </div>
        <div className="hidden border-t border-gray-300 pt-5 text-sm text-gray-700 print:block"><p><strong>EventSync Digital Event Order</strong> · Generated {new Date().toLocaleString()}</p><p className="mt-1">Operational note: the full reservation includes the mandatory 30-minute setup and cleanup buffers.</p></div>
      </div> : <div className="card grid min-h-72 place-items-center p-10 text-center text-gray-500"><div><FileText className="mx-auto mb-3 h-10 w-10 text-gray-300" /><p className="font-medium">Select an event to open its digital event order.</p><p className="mt-1 text-sm">Confirmed bookings appear here for staff preparation and delivery.</p></div></div>}
    </div>
  </section>;
}
