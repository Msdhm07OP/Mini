import { useCallback, useEffect, useState } from 'react';
import { CalendarCheck, CalendarDays, CheckCircle2, Clock3, Loader2, RefreshCw, Send, XCircle } from 'lucide-react';
import { getMyBookings, getPortalVenues, requestPortalBooking } from '../services/api';

/**
 * Self-service portal for approved client accounts.
 *
 * Clients request events and follow their status here. The API scopes every call
 * to the client record linked to the signed-in user, and requests go through the
 * same allocation engine as bookings made by staff.
 */

const emptyRequest = {
  event_name: '', event_date: '', event_start: '', event_end: '', attendees: '',
  preferred_venue_id: '', projectors_requested: 0, audio_systems_requested: 0, staff_requested: 0,
  waitlist_if_full: true,
};

const STATUS_STYLES = {
  confirmed: 'bg-emerald-50 text-emerald-700',
  waitlisted: 'bg-amber-50 text-amber-700',
  rejected: 'bg-red-50 text-red-700',
  cancelled: 'bg-gray-100 text-gray-600',
};

const time = value => String(value || '').slice(0, 5);

export default function ClientPortal({ profile }) {
  const [venues, setVenues] = useState([]);
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState(emptyRequest);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [venueResponse, bookingResponse] = await Promise.all([getPortalVenues(), getMyBookings()]);
      setVenues(venueResponse.data || []);
      setBookings(bookingResponse.data || []);
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Could not load your bookings.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const update = event => {
    const { name, value, type, checked } = event.target;
    setForm(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
  };

  const submit = async event => {
    event.preventDefault();
    setSubmitting(true);
    setOutcome(null);
    const payload = {
      ...form,
      attendees: Number(form.attendees),
      preferred_venue_id: Number(form.preferred_venue_id),
      projectors_requested: Number(form.projectors_requested) || 0,
      audio_systems_requested: Number(form.audio_systems_requested) || 0,
      staff_requested: Number(form.staff_requested) || 0,
    };
    try {
      const result = await requestPortalBooking(payload);
      setOutcome(result);
      if (result.success || result.waitlisted) setForm(emptyRequest);
    } catch (err) {
      const data = err.response?.data;
      setOutcome(data && typeof data === 'object'
        ? { ...data, message: data.errors?.join('; ') || data.message }
        : { success: false, message: err.message || 'The request could not be processed.' });
    } finally {
      setSubmitting(false);
      load();
    }
  };

  const counts = bookings.reduce((acc, booking) => ({ ...acc, [booking.status]: (acc[booking.status] || 0) + 1 }), {});

  return <div className="min-h-screen bg-slate-50">
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-5 sm:px-6">
        <div className="flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-indigo-600 text-white"><CalendarDays className="h-6 w-6" /></div>
          <div><h1 className="text-xl font-bold text-slate-900">EventSync Client Portal</h1><p className="text-sm text-slate-500">Welcome, {profile?.display_name || profile?.email}</p></div>
        </div>
        <button className="btn btn-secondary" onClick={load} disabled={loading}><RefreshCw className="mr-2 inline h-4 w-4" />Refresh</button>
      </div>
    </header>

    <main className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Total requests" value={bookings.length} />
        <Stat label="Confirmed" value={counts.confirmed || 0} tone="text-emerald-700" />
        <Stat label="On waitlist" value={counts.waitlisted || 0} tone="text-amber-700" />
        <Stat label="Not available" value={counts.rejected || 0} tone="text-red-700" />
      </div>

      {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">{error}</div>}

      <div className="grid gap-6 lg:grid-cols-5">
        <section className="card p-5 lg:col-span-2">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-900"><Send className="h-5 w-5 text-indigo-600" />Request a booking</h2>
          <p className="mt-1 text-sm text-slate-500">We find the best available hall and equipment automatically. Each event holds its hall for 30 minutes before and after for setup and cleanup.</p>

          <form onSubmit={submit} className="mt-4 space-y-3">
            <Field label="Event name"><input className="input w-full" name="event_name" required value={form.event_name} onChange={update} /></Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Date"><input className="input w-full" type="date" name="event_date" required value={form.event_date} onChange={update} /></Field>
              <Field label="Start"><input className="input w-full" type="time" name="event_start" required value={form.event_start} onChange={update} /></Field>
              <Field label="End"><input className="input w-full" type="time" name="event_end" required value={form.event_end} onChange={update} /></Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Guests"><input className="input w-full" type="number" min="1" name="attendees" required value={form.attendees} onChange={update} /></Field>
              <Field label="Preferred venue">
                <select className="input w-full" name="preferred_venue_id" required value={form.preferred_venue_id} onChange={update}>
                  <option value="">Select…</option>
                  {venues.map(venue => <option key={venue.id} value={venue.id}>{venue.name}</option>)}
                </select>
              </Field>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Projectors"><input className="input w-full" type="number" min="0" name="projectors_requested" value={form.projectors_requested} onChange={update} /></Field>
              <Field label="Audio systems"><input className="input w-full" type="number" min="0" name="audio_systems_requested" value={form.audio_systems_requested} onChange={update} /></Field>
              <Field label="Support staff"><input className="input w-full" type="number" min="0" name="staff_requested" value={form.staff_requested} onChange={update} /></Field>
            </div>
            <label className="flex items-start gap-2 text-sm text-slate-700">
              <input type="checkbox" className="mt-1" name="waitlist_if_full" checked={form.waitlist_if_full} onChange={update} />
              <span>Join the waitlist if nothing is available. We confirm it automatically when space frees up.</span>
            </label>
            <button className="btn btn-primary w-full justify-center" disabled={submitting}>
              {submitting ? <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> : <Send className="mr-2 inline h-4 w-4" />}
              {submitting ? 'Checking availability…' : 'Submit request'}
            </button>
          </form>

          {outcome && <Outcome outcome={outcome} />}
        </section>

        <section className="card overflow-hidden lg:col-span-3">
          <div className="border-b border-slate-100 p-5"><h2 className="flex items-center gap-2 text-lg font-semibold text-slate-900"><CalendarCheck className="h-5 w-5 text-indigo-600" />My bookings</h2></div>
          {loading ? <div className="p-12 text-center text-slate-500">Loading your bookings…</div>
            : bookings.length === 0 ? <div className="p-12 text-center"><CalendarDays className="mx-auto mb-3 h-10 w-10 text-slate-300" /><h3 className="font-semibold text-slate-800">No bookings yet</h3><p className="mt-1 text-sm text-slate-500">Submit your first request using the form.</p></div>
            : <ul className="divide-y divide-slate-100">{bookings.map(booking => <li key={booking.id} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-slate-900">{booking.event_name}</p>
                  <p className="text-sm text-slate-500">{booking.event_date} · {time(booking.event_start)}–{time(booking.event_end)} · {booking.attendees} guests</p>
                </div>
                <span className={`rounded-full px-2 py-1 text-xs font-medium capitalize ${STATUS_STYLES[booking.status] || 'bg-slate-100 text-slate-600'}`}>{booking.status}</span>
              </div>
              <p className="mt-2 text-sm text-slate-700">
                {booking.status === 'confirmed' && <>Confirmed at <strong>{booking.venue_name}</strong>, hall <strong>{booking.hall_name}</strong>{booking.venue_name !== booking.preferred_venue_name && booking.preferred_venue_name ? ` (you asked for ${booking.preferred_venue_name}, which was full)` : ''}.</>}
                {booking.status === 'waitlisted' && <>Waiting for space at {booking.preferred_venue_name || 'a suitable venue'}. {booking.rejection_reason}</>}
                {booking.status === 'rejected' && <>{booking.rejection_reason || 'No suitable hall was available.'}</>}
                {booking.status === 'cancelled' && <>This booking was cancelled.</>}
              </p>
            </li>)}</ul>}
        </section>
      </div>
    </main>
  </div>;
}

function Outcome({ outcome }) {
  const booking = outcome.booking;
  if (outcome.success) {
    return <div role="status" className="mt-4 flex gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800"><CheckCircle2 className="h-5 w-5 shrink-0" /><span>Confirmed! {outcome.message}</span></div>;
  }
  if (outcome.waitlisted) {
    return <div role="status" className="mt-4 flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"><Clock3 className="h-5 w-5 shrink-0" /><span>You're on the waitlist. {booking?.rejection_reason || outcome.message}</span></div>;
  }
  return <div role="alert" className="mt-4 flex gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"><XCircle className="h-5 w-5 shrink-0" /><span>{booking?.rejection_reason || outcome.message || 'The request could not be processed.'}</span></div>;
}

function Field({ label, children }) {
  return <label className="block text-sm font-medium text-slate-700"><span className="mb-1 block">{label}</span>{children}</label>;
}

function Stat({ label, value, tone = 'text-slate-900' }) {
  return <div className="card p-4"><p className="text-xs text-slate-500">{label}</p><p className={`text-2xl font-semibold ${tone}`}>{value}</p></div>;
}
