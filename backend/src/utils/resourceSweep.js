/**
 * Pure sweep-line evaluation for shared-resource demand over half-open intervals.
 * Times must be HH:MM; intervals use [start, end), so a reservation ending at
 * 10:00 does not overlap one beginning at 10:00.
 */
const RESOURCE_FIELDS = [
  { key: 'projectors', requested: 'projectorsRequested', type: 'projector' },
  { key: 'audio', requested: 'audioSystemsRequested', type: 'audio_system' },
  { key: 'staff', requested: 'staffRequested', type: 'support_staff' },
];

const timeKey = (value) => String(value ?? '').slice(0, 5);

export function evaluateResourceCapacity({
  reservedStart,
  reservedEnd,
  requested = {},
  overlappingBookings = [],
  capacities = {},
}) {
  const events = [];
  const demand = {
    projectors: Number(requested.projectorsRequested ?? 0),
    audio: Number(requested.audioSystemsRequested ?? 0),
    staff: Number(requested.staffRequested ?? 0),
  };
  const limits = {
    projectors: Number(capacities.projector?.capacity ?? 0),
    audio: Number(capacities.audio_system?.capacity ?? 0),
    staff: Number(capacities.support_staff?.capacity ?? 0),
  };

  events.push({ time: timeKey(reservedStart), type: 'start', quantities: demand });
  events.push({ time: timeKey(reservedEnd), type: 'end', quantities: demand });

  for (const booking of overlappingBookings) {
    const resources = Array.isArray(booking.resources) ? booking.resources : [];
    const quantities = {
      projectors: Number(resources.find(item => item.resource_type === 'projector')?.quantity ?? 0),
      audio: Number(resources.find(item => item.resource_type === 'audio_system')?.quantity ?? 0),
      staff: Number(resources.find(item => item.resource_type === 'support_staff')?.quantity ?? 0),
    };
    events.push({ time: timeKey(booking.reserved_start), type: 'start', quantities });
    events.push({ time: timeKey(booking.reserved_end), type: 'end', quantities });
  }

  events.sort((a, b) => {
    const byTime = a.time.localeCompare(b.time);
    if (byTime !== 0) return byTime;
    if (a.type === b.type) return 0;
    return a.type === 'end' ? -1 : 1;
  });

  const active = { projectors: 0, audio: 0, staff: 0 };
  const peak = { projectors: 0, audio: 0, staff: 0 };
  const firstShortage = new Map();

  for (const event of events) {
    const sign = event.type === 'start' ? 1 : -1;
    for (const { key } of RESOURCE_FIELDS) {
      active[key] += sign * event.quantities[key];
      peak[key] = Math.max(peak[key], active[key]);
      if (event.type === 'start' && active[key] > limits[key] && !firstShortage.has(key)) {
        firstShortage.set(key, {
          resource: key,
          requiredAtPeak: active[key],
          capacity: limits[key],
          time: event.time,
        });
      }
    }
  }

  return {
    available: firstShortage.size === 0,
    capacities: limits,
    peakUsage: peak,
    shortages: [...firstShortage.values()],
  };
}
