'use strict';

// Shared pure policy: the sender evaluates live signals; reports reuse its last
// observed signals with the currently saved cadence, without provider reads.
function computeEffectiveDispatchPolicy({
  requestedBatchSize = 1,
  requestedDelayMs = 0,
  templateQuality = null,
  pauseCount = 0,
  successfulMessages = 0,
  failedMessages = 0,
  availableCapacity = null,
} = {}) {
  const requestedBatch = Math.max(1, Number(requestedBatchSize || 1));
  const requestedDelay = Math.max(0, Number(requestedDelayMs || 0));
  const quality = templateQuality === undefined || templateQuality === null ? '' : String(templateQuality).trim().toUpperCase();
  const yellowDelayMs = 3 * 60 * 60 * 1000;
  const needsWarmup = !quality || ['UNKNOWN', 'YELLOW'].includes(quality) || Number(pauseCount || 0) > 0;
  const warmupBatch = quality === 'YELLOW'
    ? 5
    : Number(failedMessages || 0) > 0
      ? 5
      : Number(successfulMessages || 0) >= 100
        ? 50
        : Number(successfulMessages || 0) >= 25
          ? 20
          : Number(successfulMessages || 0) >= 5
            ? 10
            : 5;
  const capacityBatch = availableCapacity === null || availableCapacity === undefined
    ? requestedBatch
    : Math.max(0, Math.trunc(Number(availableCapacity || 0)));
  const effectiveBatchSize = Math.min(
    needsWarmup ? Math.min(requestedBatch, warmupBatch) : requestedBatch,
    capacityBatch,
  );
  return {
    needsWarmup,
    warmupBatch,
    requestedBatch,
    requestedDelay,
    effectiveBatchSize,
    effectiveDelayMs: quality === 'YELLOW'
      ? Math.max(requestedDelay, yellowDelayMs)
      : requestedDelay,
  };
}

module.exports = { computeEffectiveDispatchPolicy };
