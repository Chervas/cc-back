'use strict';

const { resolveLocalInstant } = require('./voucher-schedule-calendar');

/** Pure clock conversions only, owned by one availability request/batch.
 * Never retain resource schedules, occupancy, patients, solutions or receipts.
 * Successful instants are numbers so callers cannot mutate the cached Date.
 * Errors (including ambiguous/nonexistent DST times) remain native errors and
 * are deliberately not cached. The bound also covers disjoint date batches.
 */
function createAvailabilityLocalInstantResolver(resolve = resolveLocalInstant) {
  const instants = new Map();
  return (date, time, timeZone) => {
    // Only the internal string contract is memoized. Other inputs still pass
    // through the native resolver and retain its validation/error behavior.
    if ([date, time, timeZone].some(value => typeof value !== 'string')) return resolve(date, time, timeZone);
    const key = JSON.stringify([date, time, timeZone]);
    if (!instants.has(key)) {
      const instant = +resolve(date, time, timeZone);
      if (instants.size >= 16384) instants.delete(instants.keys().next().value);
      instants.set(key, instant);
    }
    return new Date(instants.get(key));
  };
}

module.exports = { createAvailabilityLocalInstantResolver };
