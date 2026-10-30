import { useEffect, useState } from 'react';
import { getBookingStats } from '../services/api';
import {
  Activity,
  ArrowRight,
  CalendarCheck,
  Clock,
  CalendarDays,
  CheckCircle2,
  XCircle,
  Clock3,
  ListChecks,
  RefreshCw,
  Sparkles,
} from 'lucide-react';

const metricStyles = {
  indigo: { '--stat-accent': '#6c4ce0', '--stat-tint': '#f0f1ff', '--stat-tint-border': '#e0e3ff' },
  green: { '--stat-accent': '#159b72', '--stat-tint': '#eafaf4', '--stat-tint-border': '#d5f4e8' },
  amber: { '--stat-accent': '#bf8512', '--stat-tint': '#fff7e8', '--stat-tint-border': '#f8e9c9' },
  rose: { '--stat-accent': '#ff3d8a', '--stat-tint': '#fff0f5', '--stat-tint-border': '#ffd9e8' },
  violet: { '--stat-accent': '#9372df', '--stat-tint': '#f5f0ff', '--stat-tint-border': '#e8ddff' },
  blue: { '--stat-accent': '#438dd8', '--stat-tint': '#edf6ff', '--stat-tint-border': '#dceeff' },
};

function DashboardSkeleton() {
  return <div className="space-y-5" aria-label="Loading dashboard" role="status">
    <div className="dashboard-hero"><div className="dashboard-hero-copy"><div className="loading-skeleton" style={{ width: 120, height: 10, marginBottom: 14, background: 'rgba(255,255,255,.12)' }} /><div className="loading-skeleton" style={{ width: 'min(340px, 70vw)', height: 28, marginBottom: 10, background: 'rgba(255,255,255,.13)' }} /><div className="loading-skeleton" style={{ width: 'min(460px, 78vw)', height: 11, background: 'rgba(255,255,255,.09)' }} /></div></div>
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-3 2xl:grid-cols-6">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="card stat-card"><div className="loading-skeleton" style={{ width: '58%', height: 10 }} /><div className="loading-skeleton" style={{ width: '35%', height: 30, marginTop: 17 }} /></div>)}</div>
    <div className="card p-6"><div className="loading-skeleton" style={{ width: 190, height: 15, marginBottom: 23 }} />{[0,1,2,3].map(i => <div key={i} className="loading-skeleton" style={{ width: `${92 - i * 7}%`, height: 24, margin: '14px 0' }} />)}</div>
    <span className="sr-only">Loading statistics…</span>
  </div>;
}

export default function Dashboard({ onCreateBooking = () => {}, onViewBookings = () => {} }) {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setLoadError('');
    getBookingStats()
      .then((response) => { if (current) setStats(response.data); })
      .catch((error) => {
        console.error('Error loading stats:', error);
        if (current) setLoadError(error.response?.data?.message || 'We could not load the latest booking statistics.');
      })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [reloadKey]);

  if (loading) return <DashboardSkeleton />;

  if (!stats) {
    return <section className="card mx-auto my-12 max-w-lg p-8 text-center">
      <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl border border-amber-100 bg-amber-50 text-amber-600"><Activity size={25} /></div>
      <h2 className="text-lg font-bold text-gray-900">Dashboard is taking a breather</h2>
      <p className="mt-2 text-sm leading-6 text-gray-500">{loadError || 'Statistics are currently unavailable.'}</p>
      <button className="btn btn-primary mt-5" onClick={() => setReloadKey((value) => value + 1)}><RefreshCw size={15} /> Try again</button>
    </section>;
  }

  const statCards = [
    { title: 'Total bookings', value: stats.total ?? 0, icon: CalendarDays, tone: 'indigo' },
    { title: 'Confirmed', value: stats.confirmed ?? 0, icon: CheckCircle2, tone: 'green' },
    { title: 'Cancelled', value: stats.cancelled ?? 0, icon: CalendarCheck, tone: 'amber' },
    { title: 'Rejected', value: stats.rejected ?? 0, icon: XCircle, tone: 'rose' },
    { title: 'Waitlisted', value: stats.waitlisted ?? 0, icon: Clock3, tone: 'violet' },
    { title: 'Upcoming events', value: stats.upcoming ?? 0, icon: Clock, tone: 'blue' },
  ];

  return (
    <div className="space-y-6">
      <section className="dashboard-hero">
        <div className="dashboard-hero-copy">
          <span className="dashboard-hero-eyebrow">Operations overview</span>
          <h2>Keep every event in sync.</h2>
          <p>One calm command center for venue bookings, shared resources, and the moving parts behind every event.</p>
          <div className="mt-5 flex flex-wrap gap-2.5">
            <button className="dashboard-hero-action" onClick={onCreateBooking}><Sparkles size={15} /> Plan an event <ArrowRight size={15} /></button>
            <button className="dashboard-hero-secondary" onClick={onViewBookings}>View bookings</button>
          </div>
        </div>
        <div className="dashboard-hero-art" aria-hidden="true"><CalendarDays size={43} strokeWidth={1.45} /></div>
      </section>

      <section aria-label="Booking statistics">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div><h3 className="m-0 text-sm font-extrabold tracking-tight text-slate-800">Booking snapshot</h3><p className="m-0 mt-1 text-xs text-slate-400">The current state of your event pipeline</p></div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[9px] font-bold uppercase tracking-wider text-slate-500"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Summary</span>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-3 2xl:grid-cols-6">
          {statCards.map((stat, index) => {
            const Icon = stat.icon;
            return <div key={stat.title} className="card stat-card" style={{ ...metricStyles[stat.tone], animationDelay: `${index * 45}ms` }}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0"><p className="stat-card-title">{stat.title}</p><p className="stat-card-value">{Number(stat.value) || 0}</p></div>
                <div className="stat-card-icon"><Icon size={19} strokeWidth={2} /></div>
              </div>
              <div className="mt-5 flex items-center gap-1.5 text-[9px] font-semibold text-slate-400"><ListChecks size={12} /><span>Booking records</span></div>
            </div>;
          })}
        </div>
      </section>

      <section className="card p-5 sm:p-6">
        <div className="dashboard-section-heading">
          <div><h3>Venue hall utilization</h3><p>Reserved hall-hours against available hall-hours for the next 30 days</p></div>
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-indigo-100 bg-indigo-50 px-2.5 py-1.5 text-[9px] font-bold text-indigo-600"><Activity size={13} /> Utilization</span>
        </div>
        <div>
          {stats.venueUtilization && stats.venueUtilization.length > 0 ? stats.venueUtilization.map((venue, index) => {
            const utilization = Number(venue.utilization_pct) || 0;
            const clamped = Math.min(Math.max(utilization, 0), 100);
            const overCapacity = utilization > 100;
            return <div key={venue.name} className="utilization-row" style={{ animationDelay: `${index * 45}ms` }}>
              <div className="utilization-venue"><span className="utilization-dot" style={overCapacity ? { background: '#e06678', boxShadow: '0 0 0 4px rgba(224,102,120,.1)' } : undefined} /><span>{venue.name}</span></div>
              <div className="utilization-metrics">
                <span className="utilization-label"><strong>{utilization}%</strong> <span className="hidden sm:inline">· {venue.reserved_hours} / {venue.available_hall_hours} hall-hours</span></span>
                <div className="utilization-track" role="progressbar" aria-label={`${venue.name} utilization`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={clamped} title={stats.utilizationDefinition || 'Reserved hall-hours / available hall-hours'}>
                  <div className="utilization-fill" style={{ width: `${clamped}%`, ...(overCapacity ? { background: 'linear-gradient(90deg,#e06c7e,#f0a0a8)' } : {}) }} />
                </div>
              </div>
            </div>;
          }) : <div className="flex flex-col items-center justify-center py-9 text-center"><div className="mb-3 grid h-11 w-11 place-items-center rounded-xl bg-slate-50 text-slate-400"><CalendarDays size={21} /></div><p className="text-xs font-bold text-slate-600">No venue utilization data yet</p><p className="mt-1 max-w-xs text-[10px] leading-5 text-slate-400">Once venue and booking records are available, utilization will appear here.</p><button className="btn btn-secondary mt-4 text-xs" onClick={onCreateBooking}><Sparkles size={13} /> Create a booking</button></div>}
        </div>
        {stats.utilizationDefinition && <p className="mt-4 border-t border-slate-100 pt-3 text-[9px] leading-5 text-slate-400">Metric definition: {stats.utilizationDefinition}</p>}
      </section>
    </div>
  );
}
