import { jest } from '@jest/globals';
import simulationService from '../../src/services/simulationService.js';
import { toCsv } from '../../src/services/analyticsService.js';

/**
 * evaluateRequest is pure: it takes a snapshot object and returns a verdict.
 * That is what makes the simulator testable without a database.
 */
const snapshot = () => ({
  venues: [
    { id: 4, name: 'Venue A', halls: [{ id: 1, name: 'A1', capacity: 60 }, { id: 2, name: 'A2', capacity: 150 }] },
    { id: 5, name: 'Venue B', halls: [{ id: 3, name: 'B1', capacity: 100 }, { id: 4, name: 'B2', capacity: 200 }] },
  ],
  capacities: {
    4: { projector: { capacity: 2 }, audio_system: { capacity: 2 }, support_staff: { capacity: 5 } },
    5: { projector: { capacity: 2 }, audio_system: { capacity: 1 }, support_staff: { capacity: 4 } },
  },
  bookings: [],
});

const req = (over = {}) => ({
  event_date: '2026-11-08', event_start: '10:00', event_end: '13:00',
  attendees: 120, preferred_venue_id: 4,
  projectors_requested: 0, audio_systems_requested: 0, staff_requested: 0, ...over,
});

describe('what-if simulator', () => {
  test('picks the smallest sufficient hall at the preferred venue', () => {
    const result = simulationService.evaluateRequest(snapshot(), req({ attendees: 50 }), 0);
    expect(result.accepted).toBe(true);
    expect(result.hall_name).toBe('A1');
  });

  test('applies the 30-minute buffers to the operating-hours check', () => {
    const result = simulationService.evaluateRequest(
      snapshot(), req({ event_start: '21:00', event_end: '22:00', attendees: 50 }), 0
    );
    expect(result.accepted).toBe(false);
    expect(result.blocking_rule).toBe('operating_hours');
    expect(result.reserved_start).toBe('20:30');
  });

  test('falls through to another venue when the preferred one cannot fit', () => {
    const result = simulationService.evaluateRequest(snapshot(), req({ attendees: 180 }), 0);
    expect(result.accepted).toBe(true);
    expect(result.venue_name).toBe('Venue B');
    expect(result.moved_from_preferred).toBe(true);
  });

  test('back-to-back holds do not conflict (half-open intervals)', () => {
    const snap = snapshot();
    snap.bookings.push({
      id: 1, venue_id: 4, hall_id: 2, event_date: '2026-11-08',
      reserved_start: '09:30', reserved_end: '13:30', title: 'Earlier', resources: [],
    });
    // 14:00 event reserves from 13:30, exactly when the other hold ends
    const result = simulationService.evaluateRequest(
      snap, req({ event_start: '14:00', event_end: '16:00', attendees: 120 }), 0
    );
    expect(result.accepted).toBe(true);
    expect(result.hall_name).toBe('A2');
  });

  test('reports a busy hall differently from no hall being large enough', () => {
    const snap = snapshot();
    snap.bookings.push({
      id: 1, venue_id: 4, hall_id: 2, event_date: '2026-11-08',
      reserved_start: '09:30', reserved_end: '13:30', title: 'Holder', resources: [],
    });
    const result = simulationService.evaluateRequest(snap, req({ attendees: 120 }), 0);
    const venueA = result.candidates.find(c => c.venue_id === 4);
    expect(venueA.blocking_rule).toBe('hall_conflict');
  });

  test('shared resources are pooled across halls at one venue', () => {
    const snap = snapshot();
    snap.bookings.push({
      id: 1, venue_id: 4, hall_id: 2, event_date: '2026-11-08',
      reserved_start: '09:30', reserved_end: '13:30', title: 'Conference',
      resources: [{ resource_type: 'support_staff', quantity: 4 }],
    });
    // venue A has 5 staff; 4 are committed, so a request for 2 cannot fit there
    const result = simulationService.evaluateRequest(
      snap, req({ attendees: 50, staff_requested: 2 }), 0
    );
    const venueA = result.candidates.find(c => c.venue_id === 4);
    expect(venueA.blocking_rule).toBe('shared_resources');
    expect(result.venue_name).toBe('Venue B');
  });
});

describe('simulation scenario composition', () => {
  test('hypothetical requests compete with each other, not only with real bookings', async () => {
    const snap = snapshot();
    jest.spyOn(simulationService, 'loadSnapshot').mockResolvedValue(snap);

    const result = await simulationService.simulate({
      requests: [
        { label: 'First', ...req({ attendees: 50, projectors_requested: 2 }) },
        { label: 'Second', ...req({ attendees: 50, projectors_requested: 1 }) },
      ],
    });

    // Venue A owns 2 projectors; the first hypothetical takes both, so the
    // second must not also be granted them at the same venue.
    expect(result.results[0].accepted).toBe(true);
    expect(result.results[0].venue_name).toBe('Venue A');
    expect(result.results[1].venue_name).toBe('Venue B');
    simulationService.loadSnapshot.mockRestore();
  });
});

describe('CSV export', () => {
  test('neutralises formula injection and escapes delimiters', () => {
    const csv = toCsv([{ a: '=cmd|calc', b: 'has "quotes", and a comma', c: '+1', d: null }]);
    expect(csv).toContain('"\'=cmd|calc"');
    expect(csv).toContain('"\'+1"');
    expect(csv).toContain('"has ""quotes"", and a comma"');
    expect(csv).toContain('""');
  });

  test('returns an empty string rather than a bare header for no rows', () => {
    expect(toCsv([])).toBe('');
  });
});
