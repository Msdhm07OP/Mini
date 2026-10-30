import bookingRepo from '../repositories/BookingRepository.js';
import { withRetry, transaction } from '../database/config.js';
import { calculateReservedInterval, isWithinOperatingHours, normalizeDateString } from '../utils/timeHelpers.js';
import { bookingRequestSchema } from './validation/schemas.js';
import logger from '../utils/logger/index.js';
import idempotencyService from './IdempotencyService.js';
import { v4 as uuidv4 } from 'uuid';
import { evaluateResourceCapacity } from '../utils/resourceSweep.js';
import { callSupabaseRpc, usesSupabaseRpc } from './supabaseRpc.js';

/**
 * Core scheduling service with concurrency-safe booking allocation
 */
class SchedulingService {
  /**
   * Confirm a booking with full concurrency safety
   * @param {object} request - Booking request
   * @param {string} correlationId - Request correlation ID
   * @returns {Promise<object>} { success: boolean, booking: object, message: string }
   */
  async confirmBooking(request, correlationId = null, idempotencyKey = null, actor = null) {
    const validated = bookingRequestSchema.parse(request);
    if (usesSupabaseRpc()) {
      const rpc = await callSupabaseRpc('create_booking', [validated, idempotencyKey || null], actor);
      return rpc.result;
    }

    return withRetry(async () => transaction(async (client) => {
      // Idempotency is checked and persisted inside the same transaction as the
      // booking. This closes the race where two retries could both pass an
      // external pre-check and create duplicate bookings.
      if (idempotencyKey) {
        await idempotencyService.acquireKeyLock(client, idempotencyKey);
        const cached = await idempotencyService.checkIdempotencyKey(idempotencyKey, request, client);
        if (cached.isDuplicate) return cached.cachedResponse;
      }

      const clientCheck = await client.query(
        'SELECT id FROM clients WHERE id = $1 AND is_active = true', [validated.client_id]
      );
      if (!clientCheck.rows.length) {
        const error = new Error('Client does not exist or is inactive');
        error.status = 400;
        throw error;
      }
      const venueCheck = await client.query(
        'SELECT id FROM venues WHERE id = $1', [validated.preferred_venue_id]
      );
      if (!venueCheck.rows.length) {
        const error = new Error('Preferred venue does not exist');
        error.status = 400;
        throw error;
      }

      const { reservedStart, reservedEnd } = calculateReservedInterval(
        validated.event_date, validated.event_start, validated.event_end
      );
      const validationErrors = await this.validateBookingRequest(validated);
      if (validationErrors.length > 0) {
        // Keep a durable rejected request and its reason when its computed
        // reservation interval remains representable by the same-day schema.
        // A request whose 30-minute buffer wraps midnight cannot be faithfully
        // represented by TIME-only columns, so return a controlled validation
        // result rather than attempting a corrupt write.
        if (reservedStart > validated.event_start || reservedEnd < validated.event_end) {
          return { success: false, booking: null, message: validationErrors.join('; '), errors: validationErrors };
        }
        const reason = validationErrors.join('; ');
        const booking = await bookingRepo.createBookingWithAllocations(client, {
          client_id: validated.client_id,
          hall_id: null,
          venue_id: validated.preferred_venue_id,
          preferred_venue_id: validated.preferred_venue_id,
          projectors_requested: validated.projectors_requested,
          audio_systems_requested: validated.audio_systems_requested,
          staff_requested: validated.staff_requested,
          event_name: validated.event_name,
          event_date: validated.event_date,
          event_start: validated.event_start,
          event_end: validated.event_end,
          reserved_start: reservedStart,
          reserved_end: reservedEnd,
          attendees: validated.attendees,
          status: 'rejected',
          rejection_reason: reason,
          rejection_code: 'OUTSIDE_OPERATING_HOURS',
          correlation_id: correlationId,
        }, []);
        const result = { success: false, booking, message: reason, errors: validationErrors };
        if (idempotencyKey) await idempotencyService.storeResult(idempotencyKey, request, booking.id, result, client);
        return result;
      }

      // The allocator may fall back to any venue, so lock the date across all
      // venues before reading availability. Locks block instead of spuriously
      // rejecting requests merely because another transaction is allocating.
      await bookingRepo.acquireAllocationLocks(client, [validated.event_date]);

      const allocation = await this.findAvailableHall(client, { ...validated, reservedStart, reservedEnd });
      let result;

      if (!allocation) {
        const rejectionReason = await this.generateRejectionReason(client, validated);
        const status = validated.waitlist_if_full ? 'waitlisted' : 'rejected';
        const booking = await bookingRepo.createBookingWithAllocations(client, {
          client_id: validated.client_id,
          hall_id: null,
          venue_id: validated.preferred_venue_id,
          preferred_venue_id: validated.preferred_venue_id,
          projectors_requested: validated.projectors_requested,
          audio_systems_requested: validated.audio_systems_requested,
          staff_requested: validated.staff_requested,
          event_name: validated.event_name,
          event_date: validated.event_date,
          event_start: validated.event_start,
          event_end: validated.event_end,
          reserved_start: reservedStart,
          reserved_end: reservedEnd,
          attendees: validated.attendees,
          status,
          rejection_reason: rejectionReason,
          rejection_code: 'NO_AVAILABILITY',
          correlation_id: correlationId
        }, []);
        result = {
          success: false,
          booking,
          message: status === 'waitlisted'
            ? `No immediate allocation is available. Request added to the waitlist. ${rejectionReason}`
            : rejectionReason,
          waitlisted: status === 'waitlisted'
        };
      } else {
        const resourceAllocations = await this.buildResourceAllocations(client, validated);
        const booking = await bookingRepo.createBookingWithAllocations(client, {
          client_id: validated.client_id,
          hall_id: allocation.hallId,
          venue_id: allocation.venueId,
          preferred_venue_id: validated.preferred_venue_id,
          projectors_requested: validated.projectors_requested,
          audio_systems_requested: validated.audio_systems_requested,
          staff_requested: validated.staff_requested,
          event_name: validated.event_name,
          event_date: validated.event_date,
          event_start: validated.event_start,
          event_end: validated.event_end,
          reserved_start: reservedStart,
          reserved_end: reservedEnd,
          attendees: validated.attendees,
          status: 'confirmed',
          correlation_id: correlationId
        }, resourceAllocations);
        result = {
          success: true,
          booking: { ...booking, venue_name: allocation.venueName, hall_name: allocation.hallName, hall_capacity: allocation.hallCapacity },
          message: `Event confirmed at ${allocation.venueName} - ${allocation.hallName}`,
          allocation
        };
      }

      if (idempotencyKey && result.booking) {
        await idempotencyService.storeResult(idempotencyKey, request, result.booking.id, result, client);
      }
      return result;
    }, { isolationLevel: 'READ COMMITTED' }), { maxRetries: 3 });
  }

  /**
   * Find available hall using required algorithm
   * @param {object} client - Database client
   * @param {object} request - Validated request with reserved times
   * @returns {Promise<object|null>} Allocation details or null
   */
  async findAvailableHall(client, request) {
    const {
      preferred_venue_id,
      event_date,
      reservedStart,
      reservedEnd,
      attendees,
      projectors_requested,
      audio_systems_requested,
      staff_requested,
      exclude_booking_id = null
    } = request;

    // Step 1: Try preferred venue first
    const preferredResult = await this.tryVenue(client, {
      venueId: preferred_venue_id,
      eventDate: event_date,
      reservedStart,
      reservedEnd,
      attendees,
      projectorsRequested: projectors_requested,
      audioSystemsRequested: audio_systems_requested,
      staffRequested: staff_requested,
      excludeBookingId: exclude_booking_id
    });

    if (preferredResult) {
      return preferredResult;
    }

    // Step 2: Try other venues in deterministic order (ascending ID)
    const otherVenuesResult = await client.query(
      'SELECT id FROM venues WHERE id != $1 ORDER BY id ASC',
      [preferred_venue_id]
    );

    for (const venue of otherVenuesResult.rows) {
      const result = await this.tryVenue(client, {
        venueId: venue.id,
        eventDate: event_date,
        reservedStart,
        reservedEnd,
        attendees,
        projectorsRequested: projectors_requested,
        audioSystemsRequested: audio_systems_requested,
        staffRequested: staff_requested,
        excludeBookingId: exclude_booking_id
      });

      if (result) {
        return result;
      }
    }

    return null; // No feasible allocation found
  }

  /**
   * Try to allocate at a specific venue
   * @param {object} client
   * @param {object} params
   * @returns {Promise<object|null>}
   */
  async tryVenue(client, params) {
    const {
      venueId,
      eventDate,
      reservedStart,
      reservedEnd,
      attendees,
      projectorsRequested,
      audioSystemsRequested,
      staffRequested,
      excludeBookingId
    } = params;

    // Get halls with sufficient capacity (smallest first)
    const halls = await bookingRepo.getHallsByCapacity(client, venueId, attendees);

    if (halls.length === 0) {
      return null; // No hall with sufficient capacity
    }

    // Check each hall (smallest first due to ORDER BY in query)
    for (const hall of halls) {
      // Check hall availability
      const hallAvailable = await bookingRepo.isHallAvailable(
        client,
        hall.id,
        eventDate,
        reservedStart,
        reservedEnd,
        excludeBookingId
      );

      if (!hallAvailable) {
        continue; // Hall has conflict, try next
      }

      // Check resource availability
      const resourcesAvailable = await this.checkResourceAvailability(client, {
        venueId,
        eventDate,
        reservedStart,
        reservedEnd,
        projectorsRequested,
        audioSystemsRequested,
        staffRequested,
        excludeBookingId
      });

      if (resourcesAvailable) {
        // Found feasible allocation
        const venueResult = await client.query(
          'SELECT name FROM venues WHERE id = $1',
          [venueId]
        );

        return {
          hallId: hall.id,
          hallName: hall.name,
          hallCapacity: hall.capacity,
          venueId,
          venueName: venueResult.rows[0].name
        };
      }
    }

    return null; // No feasible combination at this venue
  }

  /**
   * Check resource availability using sweep-line algorithm
   * @param {object} client
   * @param {object} params
   * @returns {Promise<boolean>}
   */
  async checkResourceAvailability(client, params) {
    const {
      venueId,
      eventDate,
      reservedStart,
      reservedEnd,
      projectorsRequested,
      audioSystemsRequested,
      staffRequested,
      excludeBookingId
    } = params;

    // Get venue resource capacity
    const capacity = await bookingRepo.getVenueResourceCapacity(client, venueId);

    // Get overlapping bookings
    const overlappingBookings = await bookingRepo.getOverlappingBookings(
      client,
      venueId,
      eventDate,
      reservedStart,
      reservedEnd,
      excludeBookingId
    );

    const result = evaluateResourceCapacity({
      reservedStart,
      reservedEnd,
      requested: {
        projectorsRequested: projectorsRequested,
        audioSystemsRequested: audioSystemsRequested,
        staffRequested: staffRequested,
      },
      overlappingBookings,
      capacities: capacity,
    });

    return result.available;
  }

  /**
   * Validate booking request
   * @param {object} request
   * @returns {Promise<Array<string>>} Validation errors
   */
  async validateBookingRequest(request) {
    const errors = [];

    // Check operating hours
    const { reservedStart, reservedEnd } = calculateReservedInterval(
      request.event_date,
      request.event_start,
      request.event_end
    );

    if (!isWithinOperatingHours(reservedStart, reservedEnd)) {
      errors.push(
        `Event with setup and cleanup (${reservedStart} - ${reservedEnd}) ` +
        `falls outside operating hours (08:00 - 22:00)`
      );
    }

    return errors;
  }

  /**
   * Generate detailed rejection reason
   * @param {object} client
   * @param {object} request
   * @returns {Promise<string>}
   */
  async generateRejectionReason(client, request) {
    const { reservedStart, reservedEnd } = calculateReservedInterval(
      request.event_date,
      request.event_start,
      request.event_end
    );

    const venuesResult = await client.query('SELECT id, name FROM venues ORDER BY id');
    const reasons = [];

    for (const venue of venuesResult.rows) {
      const halls = await bookingRepo.getHallsByCapacity(client, venue.id, request.attendees);

      if (halls.length === 0) {
        reasons.push(`${venue.name}: No hall with capacity for ${request.attendees} attendees`);
        continue;
      }

      let anyHallAvailable = false;
      for (const hall of halls) {
        const available = await bookingRepo.isHallAvailable(
          client,
          hall.id,
          request.event_date,
          reservedStart,
          reservedEnd,
          null
        );
        if (available) {
          anyHallAvailable = true;
          break;
        }
      }

      if (!anyHallAvailable) {
        reasons.push(`${venue.name}: All suitable halls booked during ${reservedStart}-${reservedEnd}`);
        continue;
      }

      const resourcesAvailable = await this.checkResourceAvailability(client, {
        venueId: venue.id,
        eventDate: request.event_date,
        reservedStart,
        reservedEnd,
        projectorsRequested: request.projectors_requested,
        audioSystemsRequested: request.audio_systems_requested,
        staffRequested: request.staff_requested,
        excludeBookingId: null
      });

      if (!resourcesAvailable) {
        reasons.push(`${venue.name}: Insufficient resources during requested time`);
      }
    }

    return reasons.length > 0
      ? `Cannot accommodate request. ${reasons.join('; ')}`
      : 'No suitable venue, hall, and resource combination available';
  }

  /**
   * Build resource allocations array
   * @param {object} client
   * @param {object} resources
   * @returns {Promise<Array>}
   */
  async buildResourceAllocations(client, resources) {
    const allocations = [];

    const typesResult = await client.query('SELECT id, name FROM resource_types');
    const typeMap = {};
    typesResult.rows.forEach(t => { typeMap[t.name] = t.id; });

    if (resources.projectors_requested > 0) {
      allocations.push({
        resource_type_id: typeMap['projector'],
        quantity: resources.projectors_requested
      });
    }

    if (resources.audio_systems_requested > 0) {
      allocations.push({
        resource_type_id: typeMap['audio_system'],
        quantity: resources.audio_systems_requested
      });
    }

    if (resources.staff_requested > 0) {
      allocations.push({
        resource_type_id: typeMap['support_staff'],
        quantity: resources.staff_requested
      });
    }

    return allocations;
  }

  /**
   * Cancel a booking
   * @param {number} bookingId
   * @param {string} reason
   * @param {string} correlationId
   * @returns {Promise<object>}
   */
  async cancelBooking(bookingId, reason = null, correlationId = null, actor = null) {
    if (usesSupabaseRpc()) {
      const rpc = await callSupabaseRpc('cancel_booking', [bookingId, reason], actor);
      return rpc.result;
    }
    return withRetry(() => transaction(async (client) => {
      await bookingRepo.acquireBookingLock(client, bookingId);
      const currentResult = await client.query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
      if (!currentResult.rows.length) throw new Error(`Booking ${bookingId} not found`);
      const current = currentResult.rows[0];
      await bookingRepo.acquireAllocationLocks(client, [current.event_date]);
      const refreshedResult = await client.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [bookingId]);
      if (!refreshedResult.rows.length) throw new Error(`Booking ${bookingId} not found`);
      const refreshed = refreshedResult.rows[0];
      const booking = await bookingRepo.cancelBooking(client, bookingId, reason);
      const promoted = await this.promoteWaitlist(client, refreshed.event_date, correlationId);

      logger.info('Booking cancelled', { bookingId, reason, correlationId, promotedCount: promoted.length });
      return {
        success: true,
        booking,
        promoted,
        message: `Booking cancelled successfully. Resources have been released.${promoted.length ? ` ${promoted.length} waitlisted request(s) promoted.` : ''}`
      };
    }), { maxRetries: 3 });
  }

  /**
   * Reschedule a booking (atomic operation)
   * @param {number} bookingId
   * @param {object} newRequest
   * @param {string} correlationId
   * @returns {Promise<object>}
   */
  async rescheduleBooking(bookingId, newRequest, correlationId = null, actor = null) {
    const validated = bookingRequestSchema.parse(newRequest);
    if (usesSupabaseRpc()) {
      const rpc = await callSupabaseRpc('reschedule_booking', [bookingId, validated], actor);
      return rpc.result;
    }
    const validationErrors = await this.validateBookingRequest(validated);
    if (validationErrors.length) {
      // Record a failed reschedule attempt while leaving the confirmed booking untouched.
      return transaction(async client => {
        await bookingRepo.acquireBookingLock(client, bookingId);
        const current = await client.query("SELECT * FROM bookings WHERE id = $1 AND status = 'confirmed'", [bookingId]);
        if (!current.rows.length) throw new Error('Booking not found or not in confirmed status');
        await bookingRepo.createAuditEvent(client, {
          event_type: 'booking_reschedule_failed', booking_id: bookingId, correlation_id: correlationId,
          event_data: { reason: validationErrors.join('; '), rejection_code: 'OUTSIDE_OPERATING_HOURS' }
        });
        return { success: false, booking: current.rows[0], message: `Cannot reschedule: ${validationErrors.join('; ')}` };
      });
    }

    return await withRetry(async () => {
      return await transaction(async (client) => {
        await bookingRepo.acquireBookingLock(client, bookingId);
        // Get original booking
        const originalResult = await client.query(
          'SELECT * FROM bookings WHERE id = $1 AND status = $2',
          [bookingId, 'confirmed']
        );

        if (originalResult.rows.length === 0) {
          throw new Error('Booking not found or not in confirmed status');
        }

        const original = originalResult.rows[0];

        // Protect both the released date and the target date; lock order is stable.
        await bookingRepo.acquireAllocationLocks(client, [original.event_date, validated.event_date]);
        const refreshedResult = await client.query(
          'SELECT * FROM bookings WHERE id = $1 AND status = $2 FOR UPDATE',
          [bookingId, 'confirmed']
        );
        if (!refreshedResult.rows.length) throw new Error('Booking not found or not in confirmed status');
        const refreshedOriginal = refreshedResult.rows[0];
        const previousAllocationsResult = await client.query(`
          SELECT rt.name AS resource_type, bra.quantity_allocated
          FROM booking_resource_allocations bra
          JOIN resource_types rt ON rt.id = bra.resource_type_id
          WHERE bra.booking_id = $1
          ORDER BY rt.name
        `, [bookingId]);
        if (Number(validated.client_id) !== Number(refreshedOriginal.client_id)) {
          const error = new Error('A booking cannot be reassigned to a different client during rescheduling');
          error.status = 400;
          throw error;
        }
        const venueCheck = await client.query('SELECT id FROM venues WHERE id = $1', [validated.preferred_venue_id]);
        if (!venueCheck.rows.length) {
          const error = new Error('Preferred venue does not exist');
          error.status = 400;
          throw error;
        }

        // Calculate new reserved interval
        const { reservedStart, reservedEnd } = calculateReservedInterval(
          validated.event_date,
          validated.event_start,
          validated.event_end
        );

        // Find available hall (excluding current booking)
        const allocation = await this.findAvailableHall(client, {
          ...validated,
          reservedStart,
          reservedEnd,
          exclude_booking_id: bookingId
        });

        if (!allocation) {
          const rejectionReason = await this.generateRejectionReason(client, validated);

          await bookingRepo.createAuditEvent(client, {
            event_type: 'booking_reschedule_failed',
            booking_id: bookingId,
            correlation_id: correlationId,
            event_data: { reason: rejectionReason }
          });

          return {
            success: false,
            booking: refreshedOriginal,
            message: `Cannot reschedule: ${rejectionReason}`
          };
        }

        // Update booking
        const resourceAllocations = await this.buildResourceAllocations(client, {
          projectors_requested: validated.projectors_requested,
          audio_systems_requested: validated.audio_systems_requested,
          staff_requested: validated.staff_requested
        });

        const updatedBooking = await bookingRepo.updateBooking(
          client,
          bookingId,
          {
            hall_id: allocation.hallId,
            venue_id: allocation.venueId,
            event_name: validated.event_name,
            event_date: validated.event_date,
            event_start: validated.event_start,
            event_end: validated.event_end,
            reserved_start: reservedStart,
            reserved_end: reservedEnd,
            attendees: validated.attendees,
            preferred_venue_id: validated.preferred_venue_id,
            projectors_requested: validated.projectors_requested,
            audio_systems_requested: validated.audio_systems_requested,
            staff_requested: validated.staff_requested
          },
          resourceAllocations
        );

        const currentAllocationsResult = await client.query(`
          SELECT rt.name AS resource_type, bra.quantity_allocated
          FROM booking_resource_allocations bra
          JOIN resource_types rt ON rt.id = bra.resource_type_id
          WHERE bra.booking_id = $1
          ORDER BY rt.name
        `, [bookingId]);
        await bookingRepo.createAuditEvent(client, {
          event_type: 'booking_reschedule_succeeded',
          booking_id: bookingId,
          client_id: refreshedOriginal.client_id,
          correlation_id: correlationId,
          event_data: {
            previous: {
              venue_id: refreshedOriginal.venue_id,
              hall_id: refreshedOriginal.hall_id,
              event_date: normalizeDateString(refreshedOriginal.event_date),
              event_start: String(refreshedOriginal.event_start).slice(0, 5),
              event_end: String(refreshedOriginal.event_end).slice(0, 5),
              reserved_start: String(refreshedOriginal.reserved_start).slice(0, 5),
              reserved_end: String(refreshedOriginal.reserved_end).slice(0, 5),
              attendees: refreshedOriginal.attendees,
              resource_allocations: previousAllocationsResult.rows
            },
            current: {
              venue_id: allocation.venueId,
              venue_name: allocation.venueName,
              hall_id: allocation.hallId,
              hall_name: allocation.hallName,
              event_date: validated.event_date,
              event_start: validated.event_start,
              event_end: validated.event_end,
              reserved_start: reservedStart,
              reserved_end: reservedEnd,
              attendees: validated.attendees,
              resource_allocations: currentAllocationsResult.rows
            }
          }
        });
        const promoted = await this.promoteWaitlist(client, refreshedOriginal.event_date, correlationId);

        logger.info('Booking rescheduled', {
          bookingId,
          newVenueId: allocation.venueId,
          newHallId: allocation.hallId,
          correlationId
        });

        return {
          success: true,
          booking: { ...updatedBooking, venue_name: allocation.venueName, hall_name: allocation.hallName },
          promoted,
          message: `Booking rescheduled to ${allocation.venueName} - ${allocation.hallName}${promoted.length ? `. ${promoted.length} waitlisted request(s) promoted from the released date.` : ''}`
        };
      });
    }, { maxRetries: 3 });
  }

  /**
   * Get alternative time slots
   * @param {object} request
   * @returns {Promise<Array>}
   */
  async getAlternativeSlots(request) {
    const validated = bookingRequestSchema.parse(request);
    const start = validated.event_start.split(':').map(Number).reduce((h, n, i) => i === 0 ? n * 60 : h + n, 0);
    const end = validated.event_end.split(':').map(Number).reduce((h, n, i) => i === 0 ? n * 60 : h + n, 0);
    const duration = end - start;
    const offsets = [60, -60, 120, -120, 180, -180, 240, -240];
    const alternatives = [];

    for (const offset of offsets) {
      const newStart = start + offset;
      const newEnd = newStart + duration;
      if (newStart < 0 || newEnd >= 24 * 60) continue;
      const toTime = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
      const testRequest = { ...validated, event_start: toTime(newStart), event_end: toTime(newEnd) };
      const { reservedStart, reservedEnd } = calculateReservedInterval(testRequest.event_date, testRequest.event_start, testRequest.event_end);
      if (!isWithinOperatingHours(reservedStart, reservedEnd)) continue;

      // Suggestions are read-only: never create/cancel temporary bookings just
      // to test availability, since those operations pollute history and race.
      const allocation = await transaction(async client => this.findAvailableHall(client, {
        ...testRequest, reservedStart, reservedEnd
      }));
      if (!allocation) continue;

      alternatives.push({
        event_date: testRequest.event_date,
        event_start: testRequest.event_start,
        event_end: testRequest.event_end,
        venue_id: allocation.venueId,
        venue_name: allocation.venueName,
        hall_id: allocation.hallId,
        hall_name: allocation.hallName,
        hall_capacity: allocation.hallCapacity,
        offset_minutes: offset,
        reason: `Available ${offset > 0 ? `${offset} minutes later` : `${Math.abs(offset)} minutes earlier`} at ${allocation.venueName}, ${allocation.hallName}`
      });
      if (alternatives.length >= 5) break;
    }
    return alternatives;
  }

  async addToWaitlist(bookingId, reason = null, correlationId = null) {
    return transaction(async client => {
      const row = await client.query('SELECT event_date FROM bookings WHERE id = $1', [bookingId]);
      if (!row.rows.length) throw new Error(`Booking ${bookingId} not found`);
      await bookingRepo.acquireAllocationLocks(client, [row.rows[0].event_date]);
      const booking = await bookingRepo.addToWaitlist(client, bookingId, reason, correlationId);
      const promoted = await this.promoteWaitlist(client, booking.event_date, correlationId);
      const promotedSelf = promoted.find(item => Number(item.id) === Number(bookingId));
      return {
        success: true,
        booking: promotedSelf || booking,
        promoted,
        waitlisted: !promotedSelf,
        message: promotedSelf
          ? 'A compatible allocation became available immediately; the request has been confirmed.'
          : 'Request added to the waitlist and will be rechecked when capacity is released.'
      };
    });
  }

  async promoteWaitlist(client, eventDate, correlationId = null) {
    const queue = await client.query(`
      SELECT * FROM bookings
      WHERE status = 'waitlisted' AND event_date = $1
      ORDER BY created_at ASC, id ASC
    `, [eventDate]);
    const promoted = [];
    for (const booking of queue.rows) {
      const eventDate = normalizeDateString(booking.event_date);
      const eventStart = String(booking.event_start).slice(0, 5);
      const eventEnd = String(booking.event_end).slice(0, 5);
      const demand = {
        client_id: booking.client_id,
        event_date: eventDate,
        event_start: eventStart,
        event_end: eventEnd,
        attendees: booking.attendees,
        projectors_requested: booking.projectors_requested,
        audio_systems_requested: booking.audio_systems_requested,
        staff_requested: booking.staff_requested,
      };
      // A manually waitlisted request is revalidated; never promote a request
      // whose event or buffer interval violates operating-hours rules.
      const validationErrors = await this.validateBookingRequest(demand);
      if (validationErrors.length) continue;

      const { reservedStart, reservedEnd } = calculateReservedInterval(eventDate, eventStart, eventEnd);
      const allocation = await this.findAvailableHall(client, {
        preferred_venue_id: booking.preferred_venue_id,
        event_date: eventDate,
        event_start: eventStart,
        event_end: eventEnd,
        attendees: booking.attendees,
        projectors_requested: booking.projectors_requested,
        audio_systems_requested: booking.audio_systems_requested,
        staff_requested: booking.staff_requested,
        reservedStart,
        reservedEnd
      });
      if (!allocation) continue;
      const resourceAllocations = await this.buildResourceAllocations(client, booking);
      const moved = await bookingRepo.promoteWaitlistedBooking(client, booking, allocation, resourceAllocations, correlationId);
      if (moved) promoted.push(moved);
    }
    return promoted;
  }

  async createBookingSeries(request, options = {}, correlationId = null, idempotencyKey = null, actor = null) {
    const validated = bookingRequestSchema.parse({ ...request, waitlist_if_full: false });
    const occurrences = Number(options.occurrences ?? 4);
    const everyDays = Number(options.every_days ?? 7);
    const allOrNothing = options.all_or_nothing !== false;
    if (!Number.isInteger(occurrences) || occurrences < 2 || occurrences > 52) {
      const error = new Error('occurrences must be an integer between 2 and 52'); error.status = 400; throw error;
    }
    if (!Number.isInteger(everyDays) || everyDays < 1 || everyDays > 365) {
      const error = new Error('every_days must be an integer between 1 and 365'); error.status = 400; throw error;
    }

    const dates = Array.from({ length: occurrences }, (_, i) => {
      const date = new Date(`${validated.event_date}T00:00:00.000Z`);
      date.setUTCDate(date.getUTCDate() + i * everyDays);
      return date.toISOString().slice(0, 10);
    });
    if (usesSupabaseRpc()) {
      const rpc = await callSupabaseRpc('create_recurring_series', [validated, occurrences, everyDays, allOrNothing, idempotencyKey || null], actor);
      return rpc.result;
    }
    return withRetry(() => transaction(async client => {
      if (idempotencyKey) {
        await idempotencyService.acquireKeyLock(client, idempotencyKey);
        const cached = await idempotencyService.checkIdempotencyKey(idempotencyKey, { ...request, occurrences, every_days: everyDays, all_or_nothing: allOrNothing }, client);
        if (cached.isDuplicate) return cached.cachedResponse;
      }

      // These arrays belong to a single transaction attempt. If PostgreSQL asks
      // for a retry, no staged records or failures should leak into the next one.
      const plans = [];
      const failures = [];
      const clientCheck = await client.query('SELECT id FROM clients WHERE id = $1 AND is_active = true', [validated.client_id]);
      if (!clientCheck.rows.length) { const error = new Error('Client does not exist or is inactive'); error.status = 400; throw error; }
      const venueCheck = await client.query('SELECT id FROM venues WHERE id = $1', [validated.preferred_venue_id]);
      if (!venueCheck.rows.length) { const error = new Error('Preferred venue does not exist'); error.status = 400; throw error; }
      await bookingRepo.acquireAllocationLocks(client, dates);
      for (let i = 0; i < dates.length; i++) {
        const demand = { ...validated, event_date: dates[i] };
        const errors = await this.validateBookingRequest(demand);
        if (errors.length) {
          failures.push({ occurrence: i + 1, event_date: dates[i], reason: errors.join('; ') });
          plans.push({ demand, allocation: null, reason: errors.join('; ') });
          continue;
        }
        const { reservedStart, reservedEnd } = calculateReservedInterval(demand.event_date, demand.event_start, demand.event_end);
        const allocation = await this.findAvailableHall(client, { ...demand, reservedStart, reservedEnd });
        const reason = allocation ? null : await this.generateRejectionReason(client, demand);
        if (!allocation) failures.push({ occurrence: i + 1, event_date: dates[i], reason });
        plans.push({ demand, reservedStart, reservedEnd, allocation, reason });
      }

      if (allOrNothing && failures.length) {
        await bookingRepo.createAuditEvent(client, {
          event_type: 'booking_series_failed', client_id: validated.client_id, correlation_id: correlationId,
          event_data: { dates, failures, all_or_nothing: true }
        });
        const response = { success: false, series_id: null, bookings: [], failures, message: 'The series was not created because one or more occurrences could not be allocated. No bookings were written.' };
        if (idempotencyKey) await idempotencyService.storeResult(idempotencyKey, { ...request, occurrences, every_days: everyDays, all_or_nothing: allOrNothing }, null, response, client);
        return response;
      }

      const seriesId = uuidv4();
      const resourceAllocations = await this.buildResourceAllocations(client, validated);
      const bookings = [];
      for (let i = 0; i < plans.length; i++) {
        const plan = plans[i];
        const allocation = plan.allocation;
        const booking = await bookingRepo.createBookingWithAllocations(client, {
          client_id: plan.demand.client_id,
          hall_id: allocation?.hallId ?? null,
          venue_id: allocation?.venueId ?? plan.demand.preferred_venue_id,
          preferred_venue_id: plan.demand.preferred_venue_id,
          projectors_requested: plan.demand.projectors_requested,
          audio_systems_requested: plan.demand.audio_systems_requested,
          staff_requested: plan.demand.staff_requested,
          event_name: `${plan.demand.event_name} (${i + 1}/${occurrences})`,
          event_date: plan.demand.event_date,
          event_start: plan.demand.event_start,
          event_end: plan.demand.event_end,
          reserved_start: plan.reservedStart ?? calculateReservedInterval(plan.demand.event_date, plan.demand.event_start, plan.demand.event_end).reservedStart,
          reserved_end: plan.reservedEnd ?? calculateReservedInterval(plan.demand.event_date, plan.demand.event_start, plan.demand.event_end).reservedEnd,
          attendees: plan.demand.attendees,
          status: allocation ? 'confirmed' : 'rejected',
          rejection_reason: plan.reason,
          rejection_code: allocation ? null : 'NO_AVAILABILITY',
          correlation_id: correlationId,
          series_id: seriesId,
          series_occurrence: i + 1,
          series_total: occurrences
        }, allocation ? resourceAllocations : []);
        bookings.push({ ...booking, ...(allocation ? { venue_name: allocation.venueName, hall_name: allocation.hallName } : {}) });
      }
      await bookingRepo.createAuditEvent(client, {
        event_type: 'booking_series_created', client_id: validated.client_id, correlation_id: correlationId,
        event_data: { series_id: seriesId, occurrences, every_days: everyDays, all_or_nothing: allOrNothing, confirmed: bookings.filter(b => b.status === 'confirmed').length, rejected: failures.length }
      });
      const response = {
        success: failures.length === 0 || !allOrNothing,
        series_id: seriesId,
        bookings,
        failures,
        message: `${bookings.filter(b => b.status === 'confirmed').length} of ${occurrences} occurrence(s) allocated${failures.length ? `; ${failures.length} could not be allocated` : ''}.`
      };
      if (idempotencyKey) {
        await idempotencyService.storeResult(
          idempotencyKey,
          { ...request, occurrences, every_days: everyDays, all_or_nothing: allOrNothing },
          bookings[0]?.id ?? null,
          response,
          client
        );
      }
      return response;
    }), { maxRetries: 3 });
  }

}

export default new SchedulingService();
