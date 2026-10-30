import { evaluateResourceCapacity } from '../../src/utils/resourceSweep.js';

const capacities = {
  projector: { capacity: 2 },
  audio_system: { capacity: 2 },
  support_staff: { capacity: 5 },
};

describe('shared-resource sweep-line allocation', () => {
  test('accepts overlapping reservations within all resource capacities', () => {
    const result = evaluateResourceCapacity({
      reservedStart: '10:00', reservedEnd: '12:00',
      requested: { projectorsRequested: 1, audioSystemsRequested: 1, staffRequested: 2 },
      overlappingBookings: [{
        reserved_start: '09:00', reserved_end: '10:30',
        resources: [
          { resource_type: 'projector', quantity: 1 },
          { resource_type: 'audio_system', quantity: 1 },
          { resource_type: 'support_staff', quantity: 2 },
        ],
      }],
      capacities,
    });
    expect(result.available).toBe(true);
    expect(result.peakUsage).toEqual({ projectors: 2, audio: 2, staff: 4 });
    expect(result.shortages).toHaveLength(0);
  });

  test('rejects the candidate when an overlapping interval exceeds a resource limit', () => {
    const result = evaluateResourceCapacity({
      reservedStart: '10:00', reservedEnd: '12:00',
      requested: { projectorsRequested: 0, audioSystemsRequested: 0, staffRequested: 4 },
      overlappingBookings: [{
        reserved_start: '09:30', reserved_end: '10:30',
        resources: [{ resource_type: 'support_staff', quantity: 2 }],
      }],
      capacities,
    });
    expect(result.available).toBe(false);
    expect(result.shortages).toContainEqual({ resource: 'staff', requiredAtPeak: 6, capacity: 5, time: '10:00' });
  });

  test('does not count end-time usage against a reservation starting at the same time', () => {
    const result = evaluateResourceCapacity({
      reservedStart: '10:00', reservedEnd: '11:00',
      requested: { projectorsRequested: 1 },
      overlappingBookings: [{
        reserved_start: '09:00', reserved_end: '10:00',
        resources: [{ resource_type: 'projector', quantity: 1 }],
      }],
      capacities: { projector: { capacity: 1 }, audio_system: { capacity: 2 }, support_staff: { capacity: 5 } },
    });
    expect(result.available).toBe(true);
    expect(result.peakUsage.projectors).toBe(1);
  });
});
