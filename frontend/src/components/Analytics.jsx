import { useCallback, useEffect, useState } from 'react';
import { Download, Loader2, ShieldAlert, Info } from 'lucide-react';
import {
  getAnalyticsOverview, getHallUtilisation, getResourceDemand,
  getRejectionAnalysis, getDataQuality, downloadCsv,
} from '../services/api';

/**
 * Analytics and data quality.
 *
 * Every figure here is aggregated by a SQL view (migration 002) and arrives
 * through the API. Nothing is computed in the browser and nothing is hardcoded,
 * so a number shown here can always be traced to a definition and a query.
 */
export default function Analytics() {
  const [range, setRange] = useState({ date_from: '', date_to: '' });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [overview, halls, resources, rejections, quality] = await Promise.all([
        getAnalyticsOverview(range),
        getHallUtilisation({ ...range, limit: 50 }),
        getResourceDemand({ ...range, limit: 50 }),
        getRejectionAnalysis({ ...range, limit: 20 }),
        getDataQuality({ limit: 100 }),
      ]);
      setData({ overview, halls, resources, rejections, quality });
    } catch (err) {
      setError(err?.response?.data?.message || err.message || 'Could not load analytics');
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => { load(); }, [load]);

  const exportCsv = async (dataset) => {
    setExporting(dataset);
    try {
      await downloadCsv(dataset, range);
    } catch (err) {
      setError(err?.response?.data?.message || 'Export failed');
    } finally {
      setExporting(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-10 text-gray-600">
        <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /> Loading analytics…
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" className="rounded-md border border-red-300 bg-red-50 p-4 text-red-800">
        <p className="font-medium">Analytics unavailable</p>
        <p className="text-sm">{error}</p>
        <button type="button" onClick={load}
          className="mt-2 rounded-md border border-red-300 px-3 py-1 text-sm hover:bg-red-100">
          Try again
        </button>
      </div>
    );
  }

  const totals = data.overview.totals;

  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 bg-white p-4">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600">From</span>
          <input type="date" value={range.date_from} className={inputClass}
            onChange={e => setRange(r => ({ ...r, date_from: e.target.value }))} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600">To</span>
          <input type="date" value={range.date_to} className={inputClass}
            onChange={e => setRange(r => ({ ...r, date_to: e.target.value }))} />
        </label>
        <button type="button" onClick={() => setRange({ date_from: '', date_to: '' })}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50">
          All dates
        </button>
        <div className="ml-auto flex flex-wrap gap-2">
          {['bookings', 'allocations', 'hall-utilisation', 'resource-demand', 'data-quality'].map(dataset => (
            <button key={dataset} type="button" onClick={() => exportCsv(dataset)} disabled={exporting === dataset}
              className="flex items-center gap-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-60">
              {exporting === dataset
                ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                : <Download className="h-4 w-4" aria-hidden="true" />}
              {dataset}
            </button>
          ))}
        </div>
      </section>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Requests" value={totals.requests} />
        <Stat label="Confirmed" value={totals.confirmed} tone="text-green-700" />
        <Stat label="Rejected" value={totals.rejected} tone="text-red-700" />
        <Stat label="Cancelled" value={totals.cancelled} tone="text-gray-700" />
        <Stat label="Confirmation rate"
          value={totals.confirmation_rate_pct === null ? '—' : `${totals.confirmation_rate_pct}%`}
          tone="text-primary-700" />
      </section>
      <Definition text={data.overview.definitions.outcomes} />

      <Panel title="Hall utilisation" definition={data.halls.definition}
        empty="No confirmed bookings in this range.">
        {data.halls.rows.length > 0 && (
          <Table
            head={['Date', 'Venue', 'Hall', 'Reserved min', 'Utilisation', 'Unused min']}
            rows={data.halls.rows.map(r => [
              String(r.event_date).slice(0, 10), r.venue_name, r.hall_name,
              Math.round(Number(r.reserved_minutes)),
              <Bar key="b" pct={Number(r.utilisation_pct)} />,
              Math.round(Number(r.unused_minutes)),
            ])} />
        )}
      </Panel>

      <Panel title="Peak shared-resource demand" definition={data.resources.definition}
        empty="No resource allocations in this range.">
        {data.resources.rows.length > 0 && (
          <>
            {data.resources.bottlenecks.length > 0 && (
              <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
                {data.resources.bottlenecks.length} resource pool(s) reached full commitment.
                Any further request needing them in that window will be refused.
              </p>
            )}
            <Table
              head={['Date', 'Venue', 'Resource', 'Peak', 'Capacity', 'At peak']}
              rows={data.resources.rows.map(r => [
                String(r.event_date).slice(0, 10), r.venue_name, r.resource_type,
                r.peak_concurrent, r.capacity ?? '—',
                <Bar key="b" pct={Number(r.peak_utilisation_pct ?? 0)} />,
              ])} />
          </>
        )}
      </Panel>

      <Panel title="Why requests were refused" definition={data.rejections.definition}
        empty="No refusals in this range.">
        {data.rejections.rows.length > 0 && (
          <Table
            head={['Date', 'Rule', 'Refusals', 'Avg guests']}
            rows={data.rejections.rows.map(r => [
              String(r.event_date).slice(0, 10), r.rule_class, r.rejections, r.avg_attendees ?? '—',
            ])} />
        )}
      </Panel>

      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <h3 className="mb-1 flex items-center gap-2 text-lg font-semibold text-gray-900">
          <ShieldAlert className="h-5 w-5 text-primary-600" aria-hidden="true" />
          Data quality
        </h3>
        <p className="mb-3 text-sm text-gray-600">{data.quality.note}</p>

        {data.quality.total_findings === 0 ? (
          <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">
            No anomalies detected across {Object.keys(data.quality.by_check).length || 10} checks:
            every confirmed booking holds a hall, no cancelled booking consumes capacity, no
            resource pool is over-allocated, and every reserved interval matches its buffers.
          </p>
        ) : (
          <Table
            head={['Severity', 'Check', 'Entity', 'ID', 'Detail', 'Recommended action']}
            rows={data.quality.findings.map(f => [
              <span key="s" className={f.severity === 'critical'
                ? 'rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800'
                : 'rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800'}>
                {f.severity}
              </span>,
              f.check_name, f.entity, f.entity_id, f.detail, f.recommended_action,
            ])} />
        )}
      </section>
    </div>
  );
}

const inputClass = 'rounded-md border border-gray-300 px-2 py-1.5 text-sm';

function Panel({ title, definition, empty, children }) {
  const hasChildren = Array.isArray(children) ? children.some(Boolean) : Boolean(children);
  return (
    <section className="rounded-lg border border-gray-200 bg-white p-5">
      <h3 className="mb-1 text-lg font-semibold text-gray-900">{title}</h3>
      <Definition text={definition} />
      {hasChildren ? children : <p className="text-sm text-gray-500">{empty}</p>}
    </section>
  );
}

function Definition({ text }) {
  if (!text) return null;
  return (
    <p className="mb-3 flex items-start gap-1.5 text-xs text-gray-500">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{text}</span>
    </p>
  );
}

function Table({ head, rows }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
            {head.map(h => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-gray-100 last:border-0">
              {row.map((cell, j) => <td key={j} className="px-3 py-2 text-gray-800">{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Bar({ pct }) {
  const value = Number.isFinite(pct) ? pct : 0;
  const full = value >= 100;
  return (
    <span className="flex items-center gap-2">
      <span className="h-2 w-20 overflow-hidden rounded bg-gray-200">
        <span className={`block h-full ${full ? 'bg-amber-500' : 'bg-primary-500'}`}
          style={{ width: `${Math.min(value, 100)}%` }} />
      </span>
      <span className="tabular-nums text-xs text-gray-700">{value.toFixed(1)}%</span>
    </span>
  );
}

function Stat({ label, value, tone = 'text-gray-900' }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <p className="text-xs text-gray-600">{label}</p>
      <p className={`text-2xl font-semibold ${tone}`}>{value}</p>
    </div>
  );
}
