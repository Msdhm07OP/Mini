import { query } from '../database/config.js';

/**
 * Analytics and data-quality reporting.
 *
 * Every number here is produced by SQL defined in migration 002 and aggregated
 * in the database. Nothing loads the booking table into memory to count it.
 * Metric definitions live beside each view in the migration; this layer only
 * applies filters, bounds result sets, and formats output.
 */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (!DATE_PATTERN.test(String(value))) {
    const error = new Error(`${field} must be an ISO date (YYYY-MM-DD)`);
    error.status = 400;
    throw error;
  }
  return String(value);
}

function assertVenueId(value) {
  if (value === undefined || value === null || value === '') return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    const error = new Error('venue_id must be a positive integer');
    error.status = 400;
    throw error;
  }
  return id;
}

/**
 * Bound every analytics response. An unbounded report is a denial-of-service
 * waiting to happen once the booking history grows.
 */
function assertLimit(value, fallback = 500, max = 5000) {
  if (value === undefined || value === null || value === '') return fallback;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit <= 0 || limit > max) {
    const error = new Error(`limit must be an integer between 1 and ${max}`);
    error.status = 400;
    throw error;
  }
  return limit;
}

class AnalyticsService {
  /**
   * Request outcomes by date. Denominator is requests recorded, including
   * rejected and waitlisted ones — not confirmed bookings.
   */
  async requestOutcomes({ date_from, date_to, limit } = {}) {
    const from = assertDate(date_from, 'date_from');
    const to = assertDate(date_to, 'date_to');
    const rows = (await query(`
      SELECT * FROM v_booking_request_outcomes
      WHERE ($1::date IS NULL OR event_date >= $1::date)
        AND ($2::date IS NULL OR event_date <= $2::date)
      ORDER BY event_date DESC
      LIMIT $3
    `, [from, to, assertLimit(limit)])).rows;

    const totals = rows.reduce((acc, row) => ({
      requests: acc.requests + Number(row.requests),
      confirmed: acc.confirmed + Number(row.confirmed),
      rejected: acc.rejected + Number(row.rejected),
      cancelled: acc.cancelled + Number(row.cancelled),
      waitlisted: acc.waitlisted + Number(row.waitlisted),
    }), { requests: 0, confirmed: 0, rejected: 0, cancelled: 0, waitlisted: 0 });

    return {
      definition: 'Rates are a share of all requests recorded for the date, including rejected and waitlisted requests.',
      totals: {
        ...totals,
        confirmation_rate_pct: totals.requests
          ? Number((100 * totals.confirmed / totals.requests).toFixed(2)) : null,
        rejection_rate_pct: totals.requests
          ? Number((100 * totals.rejected / totals.requests).toFixed(2)) : null,
      },
      rows,
    };
  }

  /**
   * Hall utilisation: merged reserved minutes over the 840-minute operating day.
   */
  async hallUtilisation({ date_from, date_to, venue_id, limit } = {}) {
    const rows = (await query(`
      SELECT * FROM v_hall_utilisation
      WHERE ($1::date IS NULL OR event_date >= $1::date)
        AND ($2::date IS NULL OR event_date <= $2::date)
        AND ($3::integer IS NULL OR venue_id = $3)
      ORDER BY event_date DESC, venue_id, hall_name
      LIMIT $4
    `, [assertDate(date_from, 'date_from'), assertDate(date_to, 'date_to'),
        assertVenueId(venue_id), assertLimit(limit)])).rows;

    return {
      definition: 'Reserved minutes (event plus 30-minute setup and cleanup buffers, overlapping intervals merged) divided by the 840-minute operating window, per hall per day.',
      rows,
    };
  }

  async venueUtilisation({ date_from, date_to, venue_id, limit } = {}) {
    const rows = (await query(`
      SELECT * FROM v_venue_utilisation
      WHERE ($1::date IS NULL OR event_date >= $1::date)
        AND ($2::date IS NULL OR event_date <= $2::date)
        AND ($3::integer IS NULL OR venue_id = $3)
      ORDER BY event_date DESC, venue_id
      LIMIT $4
    `, [assertDate(date_from, 'date_from'), assertDate(date_to, 'date_to'),
        assertVenueId(venue_id), assertLimit(limit)])).rows;

    return {
      definition: 'Merged reserved minutes across a venue\'s active halls divided by (active halls x 840 minutes). Not an average of hall percentages.',
      rows,
    };
  }

  /**
   * Peak simultaneous resource demand, from the SQL sweep line.
   */
  async resourceDemand({ date_from, date_to, venue_id, limit } = {}) {
    const rows = (await query(`
      SELECT * FROM v_resource_peak_demand
      WHERE ($1::date IS NULL OR event_date >= $1::date)
        AND ($2::date IS NULL OR event_date <= $2::date)
        AND ($3::integer IS NULL OR venue_id = $3)
      ORDER BY event_date DESC, venue_id, resource_type
      LIMIT $4
    `, [assertDate(date_from, 'date_from'), assertDate(date_to, 'date_to'),
        assertVenueId(venue_id), assertLimit(limit)])).rows;

    return {
      definition: 'Maximum simultaneous allocation of each resource type at a venue on a date, computed by sweep line over half-open reserved intervals, against the venue capacity.',
      bottlenecks: rows.filter(r => r.capacity && Number(r.peak_utilisation_pct) >= 100),
      rows,
    };
  }

  async demandHeatmap({ venue_id, limit } = {}) {
    const rows = (await query(`
      SELECT * FROM v_demand_heatmap
      WHERE ($1::integer IS NULL OR venue_id = $1)
      ORDER BY weekday, start_hour
      LIMIT $2
    `, [assertVenueId(venue_id), assertLimit(limit)])).rows;

    return {
      definition: 'All requests bucketed by weekday (0=Sunday) and event start hour, with confirmed and rejected counts separated so demand is visible independently of whether it was met.',
      rows,
    };
  }

  async rejectionAnalysis({ date_from, date_to, limit } = {}) {
    const rows = (await query(`
      SELECT * FROM v_rejection_analysis
      WHERE ($1::date IS NULL OR event_date >= $1::date)
        AND ($2::date IS NULL OR event_date <= $2::date)
      ORDER BY rejections DESC
      LIMIT $3
    `, [assertDate(date_from, 'date_from'), assertDate(date_to, 'date_to'),
        assertLimit(limit)])).rows;

    return {
      definition: 'Rejected requests grouped into rule classes (operating_hours, hall_capacity, shared_resources, hall_conflict, other) derived from the stored refusal reason.',
      rows,
    };
  }

  async lifecycleTrends({ limit } = {}) {
    const rows = (await query(`
      SELECT * FROM v_lifecycle_trends ORDER BY requested_on DESC LIMIT $1
    `, [assertLimit(limit)])).rows;

    return {
      definition: 'Cancellation rate and average lead time by the date the request was made. Lead time covers confirmed bookings only.',
      rows,
    };
  }

  /**
   * Data-quality findings. Read-only by construction: the view only selects.
   */
  async dataQuality({ severity, limit } = {}) {
    if (severity && !['critical', 'warning'].includes(severity)) {
      const error = new Error('severity must be critical or warning');
      error.status = 400;
      throw error;
    }

    const rows = (await query(`
      SELECT *, NOW() AS detected_at FROM v_data_quality_findings
      WHERE ($1::text IS NULL OR severity = $1)
      ORDER BY CASE severity WHEN 'critical' THEN 0 ELSE 1 END, check_name, entity_id
      LIMIT $2
    `, [severity ?? null, assertLimit(limit, 1000)])).rows;

    const bySeverity = rows.reduce((acc, row) => ({
      ...acc, [row.severity]: (acc[row.severity] || 0) + 1
    }), {});

    return {
      note: 'Monitoring only. Nothing is repaired or deleted automatically.',
      total_findings: rows.length,
      by_severity: bySeverity,
      by_check: rows.reduce((acc, row) => ({
        ...acc, [row.check_name]: (acc[row.check_name] || 0) + 1
      }), {}),
      findings: rows,
    };
  }

  /**
   * Flat rows for CSV export.
   */
  async exportRows(dataset, filters = {}) {
    switch (dataset) {
      case 'bookings':
        return (await query(`
          SELECT b.id, b.event_name AS title, c.name AS client, v.name AS venue, h.name AS hall,
                 b.event_date, b.event_start, b.event_end,
                 b.reserved_start, b.reserved_end, b.attendees, b.status,
                 b.rejection_reason, b.created_at
          FROM bookings b
          LEFT JOIN clients c ON c.id = b.client_id
          LEFT JOIN venues v ON v.id = b.venue_id
          LEFT JOIN halls h ON h.id = b.hall_id
          WHERE ($1::date IS NULL OR b.event_date >= $1::date)
            AND ($2::date IS NULL OR b.event_date <= $2::date)
          ORDER BY b.event_date DESC, b.id DESC
          LIMIT $3
        `, [assertDate(filters.date_from, 'date_from'), assertDate(filters.date_to, 'date_to'),
            assertLimit(filters.limit, 5000)])).rows;

      case 'allocations':
        return (await query(`
          SELECT bra.id, bra.booking_id, b.event_name AS title, v.name AS venue, rt.name AS resource_type,
                 bra.quantity_allocated, b.event_date, b.reserved_start, b.reserved_end, b.status
          FROM booking_resource_allocations bra
          JOIN bookings b ON b.id = bra.booking_id
          JOIN resource_types rt ON rt.id = bra.resource_type_id
          LEFT JOIN venues v ON v.id = b.venue_id
          WHERE ($1::date IS NULL OR b.event_date >= $1::date)
            AND ($2::date IS NULL OR b.event_date <= $2::date)
          ORDER BY b.event_date DESC, bra.booking_id
          LIMIT $3
        `, [assertDate(filters.date_from, 'date_from'), assertDate(filters.date_to, 'date_to'),
            assertLimit(filters.limit, 5000)])).rows;

      case 'audit':
        return (await query(`
          SELECT h.id, h.booking_id, h.from_status, h.to_status, h.reason, h.changed_at
          FROM booking_status_history h
          ORDER BY h.changed_at DESC
          LIMIT $1
        `, [assertLimit(filters.limit, 5000)])).rows;

      case 'hall-utilisation':
        return (await this.hallUtilisation({ ...filters, limit: filters.limit ?? 5000 })).rows;

      case 'resource-demand':
        return (await this.resourceDemand({ ...filters, limit: filters.limit ?? 5000 })).rows;

      case 'data-quality':
        return (await this.dataQuality({ ...filters, limit: filters.limit ?? 5000 })).findings;

      default: {
        const error = new Error(`Unknown export dataset '${dataset}'`);
        error.status = 400;
        throw error;
      }
    }
  }
}

/**
 * CSV serialisation with formula-injection protection.
 *
 * A cell starting with = + - @ or a leading tab/CR is executed as a formula by
 * Excel and Sheets when the file is opened. Prefixing with a single quote
 * neutralises it while staying readable, and every field is quoted so that
 * commas, quotes and newlines in titles or refusal reasons cannot break the
 * row structure.
 */
export function toCsv(rows, columns = null) {
  if (!rows || rows.length === 0) return '';
  const headers = columns || Object.keys(rows[0]);

  const escape = (value) => {
    if (value === null || value === undefined) return '""';
    let text = value instanceof Date ? value.toISOString() : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };

  return [
    headers.map(escape).join(','),
    ...rows.map(row => headers.map(header => escape(row[header])).join(',')),
  ].join('\r\n');
}

export default new AnalyticsService();
