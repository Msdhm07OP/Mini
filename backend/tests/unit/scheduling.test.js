import {
  calculateReservedInterval,
  isWithinOperatingHours,
  checkIntervalOverlap,
} from '../../src/utils/timeHelpers.js';

describe('EventSync scheduling time rules', () => {
  test('reserves 30 minutes before and after the event', () => {
    expect(calculateReservedInterval('2026-12-15', '10:00', '12:00')).toEqual({
      reservedStart: '09:30',
      reservedEnd: '12:30',
    });
  });

  test('allows a reservation exactly within operating hours', () => {
    expect(isWithinOperatingHours('08:00', '22:00')).toBe(true);
  });

  test('rejects buffers that extend outside operating hours', () => {
    expect(isWithinOperatingHours('07:30', '10:30')).toBe(false);
    expect(isWithinOperatingHours('20:00', '22:30')).toBe(false);
  });

  test('treats intervals as half-open so adjacent reservations do not overlap', () => {
    expect(checkIntervalOverlap('2026-12-15', '09:00', '10:00', '10:00', '11:00')).toBe(false);
    expect(checkIntervalOverlap('2026-12-15', '09:00', '10:01', '10:00', '11:00')).toBe(true);
  });
});
