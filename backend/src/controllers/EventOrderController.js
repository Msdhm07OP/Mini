import { query } from '../database/config.js';

const DEFAULT_CHECKLIST = [
  { id: 'room_setup', label: 'Room layout and seating prepared', done: false },
  { id: 'av_check', label: 'Projectors and audio tested', done: false },
  { id: 'staff_briefing', label: 'Support staff briefed', done: false },
  { id: 'client_ready', label: 'Client arrival and access confirmed', done: false },
  { id: 'cleanup', label: 'Cleanup and resource return completed', done: false },
];
const ALLOWED_STATUSES = new Set(['draft', 'ready', 'in_progress', 'completed']);
const textField = (value, max = 5000) => typeof value === 'string' ? value.trim().slice(0, max) : '';

function cleanList(value, kind) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 40) {
    const error = new Error(`${kind} must be an array with no more than 40 items`);
    error.status = 400;
    throw error;
  }
  if (kind === 'setup_checklist') {
    return value.map((item, index) => ({
      id: textField(item?.id, 80) || `task_${index + 1}`,
      label: textField(item?.label, 240) || `Task ${index + 1}`,
      done: item?.done === true,
      ...(item?.assigned_to ? { assigned_to: textField(item.assigned_to, 120) } : {}),
    }));
  }
  return value.map((item, index) => ({
    time: textField(item?.time, 10),
    activity: textField(item?.activity, 240) || `Agenda item ${index + 1}`,
    notes: textField(item?.notes, 500),
  }));
}

const baseQuery = `
  SELECT b.id AS booking_id, b.event_name, b.event_date, b.event_start, b.event_end,
         b.reserved_start, b.reserved_end, b.attendees, b.projectors_requested,
         b.audio_systems_requested, b.staff_requested, b.status AS booking_status,
         v.name AS venue_name, h.name AS hall_name, h.capacity AS hall_capacity,
         c.name AS client_name, c.organization AS client_organization, c.phone AS client_phone,
         COALESCE(eo.id, 0) AS event_order_id, COALESCE(eo.status, 'draft') AS status,
         COALESCE(eo.setup_notes, '') AS setup_notes, COALESCE(eo.av_notes, '') AS av_notes,
         COALESCE(eo.catering_notes, '') AS catering_notes,
         COALESCE(eo.accessibility_notes, '') AS accessibility_notes,
         COALESCE(eo.special_instructions, '') AS special_instructions,
         COALESCE(eo.run_of_show, '[]'::jsonb) AS run_of_show,
         COALESCE(eo.setup_checklist, $2::jsonb) AS setup_checklist,
         COALESCE(eo.version, 0) AS version, eo.updated_at
  FROM bookings b JOIN venues v ON v.id = b.venue_id
  LEFT JOIN halls h ON h.id = b.hall_id
  JOIN clients c ON c.id = b.client_id
  LEFT JOIN event_orders eo ON eo.booking_id = b.id
`;

class EventOrderController {
  async list(req, res, next) {
    try {
      const date = req.query.event_date || null;
      if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ success: false, message: 'event_date must use YYYY-MM-DD format' });
      }
      const result = await query(`${baseQuery}
        WHERE b.status = 'confirmed' AND ($1::date IS NULL OR b.event_date = $1::date)
        ORDER BY b.event_date, b.reserved_start, v.id, h.id LIMIT 1000`,
      [date, JSON.stringify(DEFAULT_CHECKLIST)]);
      res.json({ success: true, count: result.rows.length, event_orders: result.rows });
    } catch (error) { next(error); }
  }

  async getOne(req, res, next) {
    try {
      const id = Number.parseInt(req.params.bookingId, 10);
      if (!Number.isInteger(id) || id < 1) return res.status(400).json({ success: false, message: 'Invalid booking ID' });
      const result = await query(`${baseQuery} WHERE b.id = $1 AND b.status = 'confirmed'`, [id, JSON.stringify(DEFAULT_CHECKLIST)]);
      if (!result.rows.length) return res.status(404).json({ success: false, message: 'Confirmed booking not found' });
      res.json({ success: true, event_order: result.rows[0] });
    } catch (error) { next(error); }
  }

  async update(req, res, next) {
    try {
      const bookingId = Number.parseInt(req.params.bookingId, 10);
      if (!Number.isInteger(bookingId) || bookingId < 1) return res.status(400).json({ success: false, message: 'Invalid booking ID' });
      const payload = req.body || {};
      const status = payload.status === undefined ? 'draft' : payload.status;
      if (!ALLOWED_STATUSES.has(status)) return res.status(400).json({ success: false, message: 'Invalid event-order status' });
      const runOfShow = cleanList(payload.run_of_show, 'run_of_show');
      const checklist = cleanList(payload.setup_checklist, 'setup_checklist');
      if (runOfShow?.some(item => item.time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(item.time))) {
        return res.status(400).json({ success: false, message: 'Run-of-show times must use 24-hour HH:MM format' });
      }
      const booking = await query("SELECT id FROM bookings WHERE id=$1 AND status='confirmed'", [bookingId]);
      if (!booking.rows.length) return res.status(404).json({ success: false, message: 'Confirmed booking not found' });
      const expectedVersion = Number.isInteger(payload.version) && payload.version >= 0 ? payload.version : null;
      const result = await query(`
        INSERT INTO event_orders (
          booking_id, status, setup_notes, av_notes, catering_notes, accessibility_notes,
          special_instructions, run_of_show, setup_checklist, last_updated_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::uuid)
        ON CONFLICT (booking_id) DO UPDATE SET
          status=EXCLUDED.status, setup_notes=EXCLUDED.setup_notes, av_notes=EXCLUDED.av_notes,
          catering_notes=EXCLUDED.catering_notes, accessibility_notes=EXCLUDED.accessibility_notes,
          special_instructions=EXCLUDED.special_instructions, run_of_show=EXCLUDED.run_of_show,
          setup_checklist=EXCLUDED.setup_checklist, last_updated_by=EXCLUDED.last_updated_by
        WHERE $11::integer IS NULL OR event_orders.version=$11::integer
        RETURNING *`,
      [bookingId, status, textField(payload.setup_notes), textField(payload.av_notes),
        textField(payload.catering_notes), textField(payload.accessibility_notes), textField(payload.special_instructions),
        JSON.stringify(runOfShow ?? []), JSON.stringify(checklist ?? DEFAULT_CHECKLIST), req.user?.id || null, expectedVersion]);
      if (!result.rows.length) {
        return res.status(409).json({ success: false, error: 'VersionConflict', message: 'This event order was updated by someone else. Reload it before saving your changes.' });
      }
      res.json({ success: true, event_order: result.rows[0], message: 'Digital event order saved.' });
    } catch (error) { next(error); }
  }
}

export default new EventOrderController();
