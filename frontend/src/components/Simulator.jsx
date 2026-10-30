import { useEffect, useState } from 'react';
import { FlaskConical, Plus, Trash2, AlertTriangle, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { getVenues, runSimulation } from '../services/api';

/**
 * What-if planner.
 *
 * Every result shown here is hypothetical. The backend evaluates the scenario
 * against a consistent snapshot and writes nothing, so nothing on this screen
 * can change the real schedule. The banner says so and never disappears.
 */

const blankRequest = (index) => ({
  label: `Request ${index + 1}`,
  event_date: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
  event_start: '10:00',
  event_end: '13:00',
  attendees: 100,
  preferred_venue_id: '',
  projectors_requested: 1,
  audio_systems_requested: 0,
  staff_requested: 2,
});

const RULE_LABELS = {
  operating_hours: 'Outside operating hours',
  hall_capacity: 'No hall large enough',
  hall_conflict: 'Halls already held',
  shared_resources: 'Shared resources exhausted',
  no_feasible_venue: 'No feasible venue',
};

export default function Simulator() {
  const [venues, setVenues] = useState([]);
  const [requests, setRequests] = useState([blankRequest(0)]);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    getVenues().then(setVenues).catch(() => setVenues([]));
  }, []);

  const update = (index, field, value) => {
    setRequests(prev => prev.map((item, i) => (i === index ? { ...item, [field]: value } : item)));
  };

  const addRequest = () => setRequests(prev => [...prev, blankRequest(prev.length)]);
  const removeRequest = (index) => setRequests(prev => prev.filter((_, i) => i !== index));

  const submit = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const payload = {
        scenario_name: 'Operator scenario',
        requests: requests.map(item => ({
          label: item.label || undefined,
          event_date: item.event_date,
          event_start: item.event_start,
          event_end: item.event_end,
          attendees: Number(item.attendees),
          preferred_venue_id: item.preferred_venue_id ? Number(item.preferred_venue_id) : undefined,
          projectors_requested: Number(item.projectors_requested) || 0,
          audio_systems_requested: Number(item.audio_systems_requested) || 0,
          staff_requested: Number(item.staff_requested) || 0,
        })),
      };
      setResult(await runSimulation(payload));
    } catch (err) {
      const data = err?.response?.data;
      setError(data?.errors?.join('; ') || data?.message || err.message || 'Simulation failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden="true" />
        <div>
          <h2 className="font-semibold text-amber-900">Hypothetical planning only</h2>
          <p className="text-sm text-amber-800">
            Nothing on this screen books anything. Requests are evaluated against a
            consistent snapshot of the live schedule, and against each other, so two
            hypothetical events that would together exhaust a venue are reported
            correctly. No hall is held and no resource is reserved.
          </p>
        </div>
      </div>

      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-lg font-semibold text-gray-900">
            <FlaskConical className="h-5 w-5 text-primary-600" aria-hidden="true" />
            Scenario
          </h3>
          <button type="button" onClick={addRequest}
            className="flex items-center gap-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50">
            <Plus className="h-4 w-4" aria-hidden="true" /> Add request
          </button>
        </div>

        <div className="space-y-4">
          {requests.map((item, index) => (
            <div key={index} className="rounded-md border border-gray-200 p-4">
              <div className="mb-3 flex items-center gap-3">
                <input
                  aria-label={`Label for request ${index + 1}`}
                  value={item.label}
                  onChange={e => update(index, 'label', e.target.value)}
                  className="flex-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium"
                  placeholder={`Request ${index + 1}`}
                />
                {requests.length > 1 && (
                  <button type="button" onClick={() => removeRequest(index)}
                    aria-label={`Remove request ${index + 1}`}
                    className="rounded-md p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600">
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Field label="Date">
                  <input type="date" value={item.event_date}
                    onChange={e => update(index, 'event_date', e.target.value)} className={inputClass} />
                </Field>
                <Field label="Start">
                  <input type="time" value={item.event_start}
                    onChange={e => update(index, 'event_start', e.target.value)} className={inputClass} />
                </Field>
                <Field label="End">
                  <input type="time" value={item.event_end}
                    onChange={e => update(index, 'event_end', e.target.value)} className={inputClass} />
                </Field>
                <Field label="Guests">
                  <input type="number" min="1" value={item.attendees}
                    onChange={e => update(index, 'attendees', e.target.value)} className={inputClass} />
                </Field>
                <Field label="Preferred venue">
                  <select value={item.preferred_venue_id}
                    onChange={e => update(index, 'preferred_venue_id', e.target.value)} className={inputClass}>
                    <option value="">No preference</option>
                    {venues.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                </Field>
                <Field label="Projectors">
                  <input type="number" min="0" value={item.projectors_requested}
                    onChange={e => update(index, 'projectors_requested', e.target.value)} className={inputClass} />
                </Field>
                <Field label="Audio systems">
                  <input type="number" min="0" value={item.audio_systems_requested}
                    onChange={e => update(index, 'audio_systems_requested', e.target.value)} className={inputClass} />
                </Field>
                <Field label="Support staff">
                  <input type="number" min="0" value={item.staff_requested}
                    onChange={e => update(index, 'staff_requested', e.target.value)} className={inputClass} />
                </Field>
              </div>
            </div>
          ))}
        </div>

        <button type="button" onClick={submit} disabled={loading}
          className="mt-4 flex items-center gap-2 rounded-md bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-60">
          {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          {loading ? 'Evaluating scenario…' : 'Run simulation'}
        </button>

        {error && (
          <p role="alert" className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
        )}
      </section>

      {result && <SimulationResult result={result} />}
    </div>
  );
}

const inputClass = 'w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm';

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-600">{label}</span>
      {children}
    </label>
  );
}

function SimulationResult({ result }) {
  const { summary, results } = result;
  return (
    <section className="rounded-lg border border-gray-200 bg-white p-5">
      <h3 className="mb-1 text-lg font-semibold text-gray-900">Hypothetical outcome</h3>
      <p className="mb-4 text-sm text-gray-600">{result.disclaimer}</p>

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Requested" value={summary.requested} />
        <Stat label="Would confirm" value={summary.accepted} tone="text-green-700" />
        <Stat label="Would refuse" value={summary.rejected} tone="text-red-700" />
        <Stat label="Pushed off preferred venue" value={summary.moved_from_preferred} tone="text-amber-700" />
      </div>

      <ul className="space-y-3">
        {results.map(item => (
          <li key={item.index}
            className={`rounded-md border-l-4 p-4 ${item.accepted ? 'border-green-500 bg-green-50' : 'border-red-500 bg-red-50'}`}>
            <div className="flex items-start gap-2">
              {item.accepted
                ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-green-600" aria-hidden="true" />
                : <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" aria-hidden="true" />}
              <div className="min-w-0 flex-1">
                <p className="font-medium text-gray-900">
                  {item.label}
                  <span className="ml-2 text-sm font-normal text-gray-600">
                    {item.event_date} · {item.event_start}–{item.event_end}
                    {' '}(holds {item.reserved_start}–{item.reserved_end})
                  </span>
                </p>
                <p className="mt-1 text-sm text-gray-800">{item.explanation}</p>
                {!item.accepted && item.blocking_rule && (
                  <p className="mt-1 text-xs font-medium uppercase tracking-wide text-red-700">
                    {RULE_LABELS[item.blocking_rule] || item.blocking_rule}
                  </p>
                )}

                {item.candidates?.length > 0 && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-sm text-primary-700">
                      Why this venue ({item.candidates.length} considered)
                    </summary>
                    <ul className="mt-2 space-y-1 border-l border-gray-300 pl-3">
                      {item.candidates.map((candidate, i) => (
                        <li key={i} className="text-sm text-gray-700">
                          <span className={candidate.outcome === 'selected' ? 'font-medium text-green-700' : 'text-gray-500'}>
                            {candidate.venue_name}{candidate.preferred ? ' (preferred)' : ''}:
                          </span>{' '}
                          {candidate.detail}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Stat({ label, value, tone = 'text-gray-900' }) {
  return (
    <div className="rounded-md bg-gray-50 p-3">
      <p className="text-xs text-gray-600">{label}</p>
      <p className={`text-2xl font-semibold ${tone}`}>{value}</p>
    </div>
  );
}
