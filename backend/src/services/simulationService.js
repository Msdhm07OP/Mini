import { transaction } from '../database/config.js';
import { calculateReservedInterval, isWithinOperatingHours, normalizeDateString, OPERATING_HOURS } from '../utils/timeHelpers.js';
import { evaluateResourceCapacity } from '../utils/resourceSweep.js';
import { simulationRequestSchema } from './validation/schemas.js';
import logger from '../utils/logger/index.js';

/**
 * What-if scheduling simulator.
 *
 * Answers "what would happen if we accepted these requests?" without touching
 * the schedule. Three properties make it trustworthy:
 *
 * 1. It never writes. No temporary bookings, no reserved resources, no audit
 *    events. Everything happens against an in-memory snapshot.
 * 2. The snapshot is read inside a single REPEATABLE READ transaction, so every
 *    hypothetical request is judged against one consistent view of the schedule
 *    rather than a moving target.
 * 3. Hypothetical requests compete with each other, not just with existing
 *    bookings. An accepted hypothetical is added to the working snapshot before
 *    the next one is evaluated, so two simulated events that would together
 *    exhaust a venue's projectors are correctly reported as one accepted and
 *    one rejected.
 *
 * The allocation policy is identical to the production one: preferred venue
 * first then venues by id, smallest sufficient hall, hall id as tie-breaker,
 * half-open intervals, 30-minute buffers, and the same sweep-line resource
 * evaluation imported from the production module — not a reimplementation.
 */
class SimulationService {
  /**
   * Load venues, halls, capacities and confirmed bookings for the dates in play.
   * Read-only and consistent: one REPEATABLE READ transaction for the lot.
   */
  async loadSnapshot(dates) {
    return transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');

      const venues = (await client.query(`
        SELECT v.id, v.name,
               COALESCE(json_agg(json_build_object('id', h.id, 'name', h.name, 'capacity', h.capacity)
                        ORDER BY h.capacity ASC, h.id ASC)
                        FILTER (WHERE h.id IS NOT NULL), '[]') AS halls
        FROM venues v
        LEFT JOIN halls h ON h.venue_id = v.id AND h.is_active = true
        GROUP BY v.id, v.name
        ORDER BY v.id ASC
      `)).rows;

      const capacityRows = (await client.query(`
        SELECT vrc.venue_id, rt.name AS resource_type, vrc.capacity
        FROM venue_resource_capacity vrc
        JOIN resource_types rt ON rt.id = vrc.resource_type_id
      `)).rows;

      const capacities = {};
      for (const row of capacityRows) {
        capacities[row.venue_id] = capacities[row.venue_id] || {};
        capacities[row.venue_id][row.resource_type] = { capacity: Number(row.capacity) };
      }

      const bookings = (await client.query(`
        SELECT b.id, b.venue_id, b.hall_id, b.event_date, b.reserved_start, b.reserved_end,
               b.event_name AS title,
               COALESCE(json_agg(json_build_object('resource_type', rt.name,
                                                   'quantity', bra.quantity_allocated))
                        FILTER (WHERE rt.id IS NOT NULL), '[]') AS resources
        FROM bookings b
        LEFT JOIN booking_resource_allocations bra ON bra.booking_id = b.id
        LEFT JOIN resource_types rt ON rt.id = bra.resource_type_id
        WHERE b.status = 'confirmed' AND b.event_date = ANY($1::date[])
        GROUP BY b.id
      `, [dates])).rows;

      return { venues, capacities, bookings: bookings.map(row => ({ ...row, hypothetical: false })) };
    });
  }

  /**
   * Evaluate one request against the working snapshot and explain every
   * candidate hall that was considered, in the order the algorithm considered
   * them. Returns the chosen allocation plus the full decision trail.
   */
  evaluateRequest(snapshot, request, index) {
    const eventDate = normalizeDateString(request.event_date);
    const { reservedStart, reservedEnd } = calculateReservedInterval(
      eventDate, request.event_start, request.event_end
    );

    const trail = [];
    const demand = {
      projectorsRequested: Number(request.projectors_requested ?? 0),
      audioSystemsRequested: Number(request.audio_systems_requested ?? 0),
      staffRequested: Number(request.staff_requested ?? 0),
    };

    if (!isWithinOperatingHours(reservedStart, reservedEnd)) {
      return {
        index,
        label: request.label || `Request ${index + 1}`,
        hypothetical: true,
        accepted: false,
        event_date: eventDate,
        event_start: request.event_start,
        event_end: request.event_end,
        reserved_start: reservedStart,
        reserved_end: reservedEnd,
        blocking_rule: 'operating_hours',
        explanation: `With 30-minute setup and cleanup buffers this request holds its hall ${reservedStart}–${reservedEnd}, which falls outside operating hours ${OPERATING_HOURS.START}–${OPERATING_HOURS.END}.`,
        candidates: trail,
      };
    }

    // Preferred venue first, then the remaining venues by id — production order.
    const ordered = [
      ...snapshot.venues.filter(v => v.id === request.preferred_venue_id),
      ...snapshot.venues.filter(v => v.id !== request.preferred_venue_id),
    ];

    let allocation = null;

    for (const venue of ordered) {
      const isPreferred = venue.id === request.preferred_venue_id;
      const overlapping = snapshot.bookings.filter(b =>
        b.venue_id === venue.id &&
        normalizeDateString(b.event_date) === eventDate &&
        this.overlaps(b.reserved_start, b.reserved_end, reservedStart, reservedEnd)
      );

      // Shared resources are a venue-level property: evaluate once per venue
      // using the same sweep-line module production uses.
      const resourceVerdict = evaluateResourceCapacity({
        reservedStart,
        reservedEnd,
        requested: demand,
        overlappingBookings: overlapping,
        capacities: snapshot.capacities[venue.id] || {},
      });

      const feasibleHalls = (venue.halls || []).filter(h => h.capacity >= request.attendees);

      if (feasibleHalls.length === 0) {
        const largest = Math.max(0, ...(venue.halls || []).map(h => h.capacity));
        trail.push({
          venue_id: venue.id, venue_name: venue.name, preferred: isPreferred,
          outcome: 'rejected', blocking_rule: 'hall_capacity',
          detail: `Largest hall at ${venue.name} seats ${largest}; ${request.attendees} guests expected.`,
        });
        continue;
      }

      if (!resourceVerdict.available) {
        trail.push({
          venue_id: venue.id, venue_name: venue.name, preferred: isPreferred,
          outcome: 'rejected', blocking_rule: 'shared_resources',
          detail: this.describeShortfall(venue, resourceVerdict, overlapping),
          shortages: resourceVerdict.shortages,
          peak_usage: resourceVerdict.peakUsage,
          capacities: resourceVerdict.capacities,
        });
        continue;
      }

      const occupied = new Set(overlapping.map(b => b.hall_id));
      const chosen = feasibleHalls.find(h => !occupied.has(h.id));

      if (!chosen) {
        trail.push({
          venue_id: venue.id, venue_name: venue.name, preferred: isPreferred,
          outcome: 'rejected', blocking_rule: 'hall_conflict',
          detail: `Every hall at ${venue.name} seating ${request.attendees} is already held during ${reservedStart}–${reservedEnd}: ${feasibleHalls.map(h => h.name).join(', ')}.`,
        });
        continue;
      }

      const runnersUp = feasibleHalls.filter(h => h.id !== chosen.id && !occupied.has(h.id));
      trail.push({
        venue_id: venue.id, venue_name: venue.name, preferred: isPreferred,
        outcome: 'selected', hall_id: chosen.id, hall_name: chosen.name,
        hall_capacity: chosen.capacity,
        capacity_waste: chosen.capacity - request.attendees,
        detail: runnersUp.length
          ? `${chosen.name} seats ${chosen.capacity}, the smallest free hall that fits ${request.attendees}. Also free but larger: ${runnersUp.map(h => `${h.name} (${h.capacity})`).join(', ')}.`
          : `${chosen.name} seats ${chosen.capacity} and was the only free hall fitting ${request.attendees}.`,
      });

      allocation = { venue, hall: chosen };
      break;
    }

    const base = {
      index,
      label: request.label || `Request ${index + 1}`,
      hypothetical: true,
      event_date: eventDate,
      event_start: request.event_start,
      event_end: request.event_end,
      reserved_start: reservedStart,
      reserved_end: reservedEnd,
      attendees: request.attendees,
      requested_resources: demand,
      candidates: trail,
    };

    if (!allocation) {
      const preferredTrail = trail.find(t => t.preferred);
      return {
        ...base,
        accepted: false,
        blocking_rule: preferredTrail?.blocking_rule || trail[0]?.blocking_rule || 'no_feasible_venue',
        explanation: trail.length
          ? `No venue could take this request. ${trail.map(t => `${t.venue_name}: ${t.detail}`).join(' ')}`
          : 'No venues are configured.',
      };
    }

    return {
      ...base,
      accepted: true,
      venue_id: allocation.venue.id,
      venue_name: allocation.venue.name,
      hall_id: allocation.hall.id,
      hall_name: allocation.hall.name,
      hall_capacity: allocation.hall.capacity,
      moved_from_preferred: allocation.venue.id !== request.preferred_venue_id,
      explanation: allocation.venue.id === request.preferred_venue_id
        ? `Would be confirmed in ${allocation.hall.name} at ${allocation.venue.name}, holding the hall ${reservedStart}–${reservedEnd}.`
        : `The preferred venue could not take it, so it would fall through to ${allocation.hall.name} at ${allocation.venue.name}.`,
    };
  }

  /** Half-open overlap on HH:MM strings: touching intervals do not conflict. */
  overlaps(aStart, aEnd, bStart, bEnd) {
    const k = v => String(v ?? '').slice(0, 5);
    return k(aStart) < k(bEnd) && k(bStart) < k(aEnd);
  }

  describeShortfall(venue, verdict, overlapping) {
    const LABELS = { projectors: 'projectors', audio: 'audio systems', staff: 'support staff' };
    const parts = (verdict.shortages || []).map(item =>
      `${LABELS[item.resource] || item.resource} (${item.requiredAtPeak} needed at ${item.time}, only ${item.capacity} available)`
    );
    const held = overlapping.map(b => b.title).filter(Boolean).slice(0, 3);
    const detail = parts.length
      ? `${venue.name} runs short on ${parts.join('; ')}.`
      : `${venue.name} does not have enough shared equipment or staff for this interval.`;
    return held.length ? `${detail} Concurrent holds: ${held.join(', ')}.` : detail;
  }

  /**
   * Run a scenario: a list of hypothetical requests evaluated in order against
   * a consistent snapshot, with accepted hypotheticals competing against those
   * that follow.
   */
  async simulate(payload, correlationId = null) {
    const validated = simulationRequestSchema.parse(payload);
    const dates = [...new Set(validated.requests.map(r => normalizeDateString(r.event_date)))];
    const snapshot = await this.loadSnapshot(dates);

    const working = {
      venues: snapshot.venues,
      capacities: snapshot.capacities,
      bookings: [...snapshot.bookings],
    };

    const results = [];
    for (let i = 0; i < validated.requests.length; i += 1) {
      const request = validated.requests[i];
      const result = this.evaluateRequest(working, request, i);
      results.push(result);

      if (result.accepted) {
        // The accepted hypothetical now occupies space and resources for the
        // requests that follow it in this scenario.
        working.bookings.push({
          id: `hypothetical-${i}`,
          venue_id: result.venue_id,
          hall_id: result.hall_id,
          event_date: result.event_date,
          reserved_start: result.reserved_start,
          reserved_end: result.reserved_end,
          title: result.label,
          hypothetical: true,
          resources: [
            { resource_type: 'projector', quantity: result.requested_resources.projectorsRequested },
            { resource_type: 'audio_system', quantity: result.requested_resources.audioSystemsRequested },
            { resource_type: 'support_staff', quantity: result.requested_resources.staffRequested },
          ],
        });
      }
    }

    const accepted = results.filter(r => r.accepted);
    logger.info?.('Simulation completed', {
      correlationId, requests: results.length, accepted: accepted.length,
    });

    return {
      simulation: true,
      disclaimer: 'Hypothetical only. Nothing was booked and no resources were reserved.',
      snapshot_dates: dates,
      existing_bookings_considered: snapshot.bookings.length,
      summary: {
        requested: results.length,
        accepted: accepted.length,
        rejected: results.length - accepted.length,
        moved_from_preferred: accepted.filter(r => r.moved_from_preferred).length,
        blocking_rules: results.filter(r => !r.accepted)
          .reduce((acc, r) => ({ ...acc, [r.blocking_rule]: (acc[r.blocking_rule] || 0) + 1 }), {}),
      },
      results,
    };
  }
}

export default new SimulationService();
