import { ArrowRight, BarChart3, CalendarCheck, CalendarDays, Clock3, FlaskConical, ShieldCheck, Sparkles, Users } from 'lucide-react';

const features = [
  { icon: CalendarCheck, title: 'Smart allocation', text: 'Your preferred venue first, the smallest hall that fits, and an automatic fall-back to another venue when it is full.' },
  { icon: Sparkles, title: 'Shared resources', text: 'Projectors, audio systems and staff are tracked across every overlapping event, so nothing is ever promised twice.' },
  { icon: Clock3, title: 'Waitlist and buffers', text: '30-minute setup and cleanup buffers on every event, plus a first-come waitlist that confirms itself when space frees up.' },
  { icon: FlaskConical, title: 'What-if planner', text: 'Test several tentative enquiries against the live schedule before committing to any of them.' },
  { icon: BarChart3, title: 'Analytics', text: 'Venue utilisation, peak demand, rejection reasons and data-quality checks, all exportable as CSV.' },
  { icon: ShieldCheck, title: 'Secure by role', text: 'Admin-approved accounts, role-based access, and database-level security so clients only ever see their own events.' },
];

const steps = [
  ['Register', 'Create an account in seconds with your email.'],
  ['Get approved', 'An administrator approves you as a client or a team member.'],
  ['Book', 'Request an event and get an instant, explained decision.'],
];

export default function LandingPage({ onSignIn, onRegister }) {
  return <div className="auth-screen min-h-screen text-white">
    <nav className="mx-auto flex max-w-6xl items-center justify-between px-4 py-5 sm:px-6">
      <div className="flex items-center gap-3"><div className="grid h-10 w-10 place-items-center rounded-xl bg-indigo-600"><CalendarDays className="h-5 w-5" /></div><span className="text-lg font-bold">EventSync</span></div>
      <div className="flex items-center gap-2">
        <button className="rounded-lg px-4 py-2 text-sm font-medium text-slate-200 hover:bg-white/10" onClick={onSignIn}>Sign in</button>
        <button className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-100" onClick={onRegister}>Get started</button>
      </div>
    </nav>

    <header className="mx-auto max-w-4xl px-4 pb-16 pt-14 text-center sm:px-6 sm:pt-20">
      <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-medium text-indigo-200"><Sparkles className="h-3.5 w-3.5" />Resource-aware event scheduling</span>
      <h1 className="mt-6 text-4xl font-bold leading-tight sm:text-6xl">Book the right hall,<br /><span className="bg-gradient-to-r from-indigo-300 to-pink-300 bg-clip-text text-transparent">without the double-booking.</span></h1>
      <p className="mx-auto mt-6 max-w-2xl text-base text-slate-300 sm:text-lg">EventSync schedules events across multiple venues, checks hall capacity and shared equipment in real time, and explains every decision, even when many people book at once.</p>
      <div className="mt-9 flex flex-wrap justify-center gap-3">
        <button className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-6 py-3 font-semibold hover:bg-indigo-500" onClick={onRegister}>Create an account<ArrowRight className="h-4 w-4" /></button>
        <button className="rounded-xl border border-white/20 px-6 py-3 font-semibold hover:bg-white/10" onClick={onSignIn}>Sign in</button>
      </div>
      <div className="mx-auto mt-12 grid max-w-2xl grid-cols-3 gap-4 text-center">
        {[['3', 'venues'], ['6', 'halls'], ['08:00–22:00', 'operating hours']].map(([value, label]) => <div key={label} className="rounded-xl border border-white/10 bg-white/5 p-4"><p className="text-xl font-bold sm:text-2xl">{value}</p><p className="text-xs text-slate-400">{label}</p></div>)}
      </div>
    </header>

    <section className="mx-auto max-w-6xl px-4 pb-16 sm:px-6">
      <h2 className="text-center text-2xl font-bold sm:text-3xl">Everything an events team needs</h2>
      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {features.map(({ icon: Icon, title, text }) => <div key={title} className="rounded-2xl border border-white/10 bg-white/5 p-6">
          <div className="grid h-10 w-10 place-items-center rounded-lg bg-indigo-500/20 text-indigo-200"><Icon className="h-5 w-5" /></div>
          <h3 className="mt-4 font-semibold">{title}</h3>
          <p className="mt-2 text-sm leading-relaxed text-slate-300">{text}</p>
        </div>)}
      </div>
    </section>

    <section className="mx-auto max-w-4xl px-4 pb-20 sm:px-6">
      <h2 className="text-center text-2xl font-bold sm:text-3xl">How it works</h2>
      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        {steps.map(([title, text], index) => <div key={title} className="rounded-2xl border border-white/10 bg-white/5 p-6 text-center">
          <span className="mx-auto grid h-9 w-9 place-items-center rounded-full bg-indigo-600 font-bold">{index + 1}</span>
          <h3 className="mt-3 font-semibold">{title}</h3>
          <p className="mt-1 text-sm text-slate-300">{text}</p>
        </div>)}
      </div>
      <div className="mt-12 rounded-2xl border border-white/10 bg-gradient-to-r from-indigo-600/40 to-pink-600/30 p-8 text-center">
        <Users className="mx-auto h-8 w-8" />
        <h3 className="mt-3 text-xl font-bold">Ready to plan your next event?</h3>
        <button className="mt-5 inline-flex items-center gap-2 rounded-xl bg-white px-6 py-3 font-semibold text-slate-900 hover:bg-slate-100" onClick={onRegister}>Get started<ArrowRight className="h-4 w-4" /></button>
      </div>
    </section>

    <footer className="border-t border-white/10 py-6 text-center text-xs text-slate-400">EventSync · Venue operations suite</footer>
  </div>;
}
