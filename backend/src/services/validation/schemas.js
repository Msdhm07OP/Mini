import { z } from 'zod';

/**
 * Base booking request shape and shared refinements. Keep the object shape separate
 * from the refinements so the reschedule schema can safely extend it.
 */
const bookingRequestObjectSchema = z.object({
  client_id: z.number().int().positive('Client ID must be a positive integer'),
  event_name: z.string().min(1, 'Event name is required').max(255, 'Event name too long'),
  event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format'),
  event_start: z.string().regex(/^([0-1][0-9]|2[0-3]):[0-5][0-9]$/, 'Start time must be in HH:MM format'),
  event_end: z.string().regex(/^([0-1][0-9]|2[0-3]):[0-5][0-9]$/, 'End time must be in HH:MM format'),
  attendees: z.number().int().positive('Attendees must be a positive integer'),
  preferred_venue_id: z.number().int().positive('Preferred venue ID must be a positive integer'),
  projectors_requested: z.number().int().min(0, 'Projectors cannot be negative').default(0),
  audio_systems_requested: z.number().int().min(0, 'Audio systems cannot be negative').default(0),
  staff_requested: z.number().int().min(0, 'Staff cannot be negative').default(0),
  waitlist_if_full: z.boolean().default(false)
});

const addBookingRefinements = schema => schema.refine(
  data => {
    const parsedDate = new Date(`${data.event_date}T00:00:00.000Z`);
    const calendarDateIsValid = Number.isFinite(parsedDate.getTime()) && parsedDate.toISOString().slice(0, 10) === data.event_date;
    const todayUtc = new Date().toISOString().slice(0, 10);
    return calendarDateIsValid && data.event_date >= todayUtc;
  },
  { message: 'Event date must be a real calendar date and cannot be in the past', path: ['event_date'] }
).refine(
  data => data.event_start < data.event_end,
  { message: 'Event start time must be before end time', path: ['event_end'] }
).refine(
  data => data.event_start >= '00:30' && data.event_end <= '23:29',
  { message: 'Event times must leave room for the 30-minute buffers within one calendar day', path: ['event_start'] }
);

export const bookingRequestSchema = addBookingRefinements(bookingRequestObjectSchema);

/**
 * Reschedule request schema uses the same booking rules, with an explicit booking ID.
 */
export const rescheduleRequestSchema = addBookingRefinements(bookingRequestObjectSchema.extend({
  booking_id: z.number().int().positive('Booking ID must be a positive integer')
}));

/**
 * Client creation validation schema
 */
export const clientSchema = z.object({
  name: z.string().min(1, 'Client name is required').max(200, 'Name too long'),
  email: z.preprocess(value => value === '' ? null : value, z.string().email('Invalid email format').optional().nullable()),
  phone: z.string().max(50, 'Phone number too long').optional().nullable(),
  organization: z.string().max(200, 'Organization name too long').optional().nullable()
});

/**
 * Query filters validation schema
 */
export const queryFiltersSchema = z.object({
  status: z.enum(['confirmed', 'cancelled', 'rejected', 'waitlisted']).optional(),
  venue_id: z.number().int().positive().optional(),
  client_id: z.number().int().positive().optional(),
  event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.number().int().positive().max(1000).optional().default(100),
  offset: z.number().int().min(0).optional().default(0)
});

/**
 * Cancellation request schema
 */
export const cancellationSchema = z.object({
  reason: z.string().max(500).optional().nullable()
});

/**
 * What-if simulation schema.
 *
 * A scenario is a list of hypothetical requests. They are deliberately not
 * validated against the booking schema: a simulation has no client_id, creates
 * no record, and may legitimately describe a request that could never be
 * booked, which is often exactly what the operator wants to find out.
 */
const simulationRequestItemSchema = z.object({
  label: z.string().max(120).optional(),
  event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'event_date must be YYYY-MM-DD'),
  event_start: z.string().regex(/^\d{2}:\d{2}$/, 'event_start must be HH:MM'),
  event_end: z.string().regex(/^\d{2}:\d{2}$/, 'event_end must be HH:MM'),
  attendees: z.number().int().positive('attendees must be a positive integer'),
  preferred_venue_id: z.number().int().positive().optional().nullable(),
  projectors_requested: z.number().int().min(0).optional().default(0),
  audio_systems_requested: z.number().int().min(0).optional().default(0),
  staff_requested: z.number().int().min(0).optional().default(0)
}).refine(data => data.event_start < data.event_end, {
  message: 'event_end must be after event_start', path: ['event_end']
});

export const simulationRequestSchema = z.object({
  scenario_name: z.string().max(160).optional(),
  requests: z.array(simulationRequestItemSchema)
    .min(1, 'At least one hypothetical request is required')
    .max(25, 'A scenario is limited to 25 hypothetical requests')
});
