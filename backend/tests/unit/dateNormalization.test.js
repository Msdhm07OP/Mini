import { normalizeDateString } from '../../src/utils/timeHelpers.js';

describe('PostgreSQL DATE normalization', () => {
  test('preserves a calendar date returned as an ISO string', () => {
    expect(normalizeDateString('2026-10-30')).toBe('2026-10-30');
  });

  test('preserves a calendar date returned as a JavaScript Date object', () => {
    expect(normalizeDateString(new Date('2026-10-30T00:00:00.000Z'))).toBe('2026-10-30');
  });

  test('rejects invalid ISO-shaped calendar dates', () => {
    expect(() => normalizeDateString('2026-02-31')).toThrow('Invalid date value');
  });
});
