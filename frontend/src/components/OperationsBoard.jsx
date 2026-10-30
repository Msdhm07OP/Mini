import { useCallback, useEffect, useState } from 'react';
import { CalendarDays, RefreshCw, Boxes, Users, Projector, Volume2 } from 'lucide-react';
import { getBookings, getVenues } from '../services/api';

const OPEN = 8 * 60;
const CLOSE = 22 * 60;
const SPAN = CLOSE - OPEN;
const timeMinutes = value => {
  if (!value) return OPEN;
  const [hours, minutes] = String(value).slice(0, 5).split(':').map(Number);
  return hours * 60 + minutes;
};
const timeLabel = value => String(value || '').slice(0, 5);
const clamp = value => Math.max(0, Math.min(100, value));

function peakUsage(bookings, field) {
  const events = [];
  for (const booking of bookings) {
    const quantity = Number(booking[field] || 0);
    if (!quantity) continue;
    events.push({ time: timeMinutes(booking.reserved_start), delta: quantity, type: 1 });
    events.push({ time: timeMinutes(booking.reserved_end), delta: -quantity, type: 0 });
  }
  events.sort((a, b) => a.time - b.time || a.type - b.type); // half-open intervals: ends before starts
  let active = 0;
  let peak = 0;
  for (const event of events) {
    active += event.delta;
    peak = Math.max(peak, active);
  }
  return peak;
}

const resourceRows = [
  { key: 'projectors_requested', type: 'projector', label: 'Projectors', Icon: Projector },
  { key: 'audio_systems_requested', type: 'audio_system', label: 'Audio systems', Icon: Volume2 },
  { key: 'staff_requested', type: 'support_staff', label: 'Support staff', Icon: Users },
];

export default function OperationsBoard({ refreshTrigger = 0 }) {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [venues, setVenues] = useState([]);
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [venueResponse, bookingResponse] = await Promise.all([
        getVenues(),
        getBookings({ event_date: date, status: 'confirmed', limit: 1000 }),
      ]);
      setVenues(venueResponse.data || []);
      setBookings(bookingResponse.data || []);
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Could not load the operations board.');
    } finally {
      setLoading(false);
    }
  }, [date, refreshTrigger]);

  useEffect(() => { load(); }, [load]);

  return (
    <section className="space-y-6">
      <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Operations Board</h2>
          <p className="text-gray-600 mt-1">Hall reservations include setup and cleanup buffers. Resource loads are based on overlapping reserved intervals.</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor="operations-date">Board date</label>
          <div className="relative"><CalendarDays className="w-4 h-4 absolute left-3 top-3 text-gray-400" /><input id="operations-date" type="date" className="input pl-9" value={date} onChange={e => setDate(e.target.value)} /></div>
          <button className="btn btn-secondary" onClick={load} disabled={loading}><RefreshCw className={`w-4 h-4 mr-2 inline ${loading ? 'animate-spin' : ''}`} />Refresh</button>
        </div>
      </header>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 p-4">{error}</div>}
      {loading ? <div className="card p-12 text-center text-gray-500">Loading venue schedule…</div> : (
        <>
          <div className="flex flex-wrap gap-4 text-xs text-gray-500">
            <span className="flex items-center gap-2"><i className="inline-block w-5 h-3 rounded border border-dashed border-amber-500 bg-amber-50" /> Setup/cleanup reservation</span>
            <span className="flex items-center gap-2"><i className="inline-block w-5 h-3 rounded bg-indigo-600" /> Event time</span>
            <span className="flex items-center gap-2"><span className="font-semibold text-gray-700">08:00–22:00</span> operating window</span>
          </div>

          {venues.map(venue => {
            const venueBookings = bookings.filter(b => Number(b.venue_id) === Number(venue.id));
            return <article className="card overflow-hidden" key={venue.id}>
              <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-2 px-5 py-4 border-b border-gray-100">
                <div><h3 className="text-lg font-semibold text-gray-900">{venue.name}</h3><p className="text-xs text-gray-500">{venueBookings.length} confirmed booking(s) on {date}</p></div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-5 gap-y-2 min-w-0 lg:min-w-[470px]">
                  {resourceRows.map(resource => {
                    const item = (venue.resources || []).find(r => r.resource_type === resource.type);
                    const capacity = Number(item?.capacity || 0);
                    const peak = peakUsage(venueBookings, resource.key);
                    const ratio = capacity ? clamp(peak / capacity * 100) : (peak ? 100 : 0);
                    return <div key={resource.key} className="min-w-0">
                      <div className="flex items-center justify-between gap-2 text-xs text-gray-600 mb-1"><span className="truncate flex items-center gap-1"><resource.Icon className="w-3.5 h-3.5" />{resource.label}</span><strong className="text-gray-800">{peak}/{capacity}</strong></div>
                      <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden"><div className={`h-full rounded-full ${peak > capacity ? 'bg-red-500' : 'bg-teal-500'}`} style={{ width: `${ratio}%` }} /></div>
                    </div>;
                  })}
                </div>
              </div>
              <div className="overflow-x-auto p-5">
                <div className="min-w-[800px]">
                  <div className="flex ml-28 mb-3 text-[11px] text-gray-500">
                    {Array.from({ length: 15 }, (_, i) => <div key={i} className="flex-1 border-l border-gray-100 pl-1">{String(8 + i).padStart(2, '0')}:00</div>)}
                  </div>
                  <div className="space-y-3">
                    {(venue.halls || []).filter(h => h.is_active !== false).map(hall => {
                      const hallBookings = venueBookings.filter(b => Number(b.hall_id) === Number(hall.id)).sort((a, b) => timeMinutes(a.reserved_start) - timeMinutes(b.reserved_start));
                      return <div className="flex items-center gap-3" key={hall.id}>
                        <div className="w-28 shrink-0"><div className="font-medium text-sm text-gray-800">{hall.name}</div><div className="text-xs text-gray-500">Capacity {hall.capacity}</div></div>
                        <div className="relative flex-1 h-12 rounded-md border border-gray-100 bg-gray-50 overflow-hidden" style={{ backgroundImage: 'linear-gradient(to right, rgba(148,163,184,.12) 1px, transparent 1px)', backgroundSize: `${100 / 14}% 100%` }}>
                          {hallBookings.map(booking => {
                            const reservedStart = timeMinutes(booking.reserved_start);
                            const reservedEnd = timeMinutes(booking.reserved_end);
                            const eventStart = timeMinutes(booking.event_start);
                            const eventEnd = timeMinutes(booking.event_end);
                            const left = clamp((reservedStart - OPEN) / SPAN * 100);
                            const right = clamp((reservedEnd - OPEN) / SPAN * 100);
                            const width = Math.max(1, right - left);
                            const eventLeft = clamp((eventStart - reservedStart) / Math.max(1, reservedEnd - reservedStart) * 100);
                            const eventWidth = clamp((eventEnd - eventStart) / Math.max(1, reservedEnd - reservedStart) * 100);
                            return <div key={booking.id} title={`${booking.event_name}: ${timeLabel(booking.event_start)}–${timeLabel(booking.event_end)}; hall reserved ${timeLabel(booking.reserved_start)}–${timeLabel(booking.reserved_end)}`} className="absolute top-1 h-10 rounded border border-dashed border-amber-500/70 bg-amber-50/90 overflow-hidden" style={{ left: `${left}%`, width: `${width}%` }}>
                              <div className="absolute top-0 bottom-0 rounded-sm bg-indigo-600 text-white px-1 flex items-center overflow-hidden whitespace-nowrap text-[10px] font-medium shadow-sm" style={{ left: `${eventLeft}%`, width: `${eventWidth}%` }}>
                                <span className="truncate">{booking.event_name} · {timeLabel(booking.event_start)}</span>
                              </div>
                            </div>;
                          })}
                          {!hallBookings.length && <span className="absolute inset-0 grid place-items-center text-[11px] text-gray-300">Available</span>}
                        </div>
                      </div>;
                    })}
                  </div>
                </div>
              </div>
              {venueBookings.length > 0 && <div className="px-5 pb-4 flex flex-wrap gap-2">{venueBookings.map(booking => <span key={booking.id} className="inline-flex items-center gap-2 bg-gray-50 border border-gray-100 rounded-full px-3 py-1 text-xs text-gray-600"><Boxes className="w-3 h-3" />{booking.event_name}: {booking.hall_name || 'Hall pending'} · {timeLabel(booking.event_start)}–{timeLabel(booking.event_end)}</span>)}</div>}
            </article>;
          })}
          {venues.length === 0 && <div className="card p-10 text-center text-gray-500">No venues have been seeded yet.</div>}
        </>
      )}
    </section>
  );
}
