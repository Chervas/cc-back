'use strict';

const { performance } = require('node:perf_hooks');
const MAX_REQUEST_BYTES = 1024 * 1024;
const failure = code => Object.assign(new Error(code), { code });

// One admission queue per application process, shared by conversation work and
// model health checks. Deployment must retain a single Bedrock caller process;
// this is not a distributed rate limiter or a durable job queue.
function createBedrockAdmission({ maxConcurrent = 3, maxWaiting = 32,
  maxWaitingBytes = 4 * MAX_REQUEST_BYTES, waitTimeoutMs = 30000, spacingMs = 300 } = {}) {
  if (![maxConcurrent, maxWaiting, maxWaitingBytes, waitTimeoutMs, spacingMs].every(Number.isSafeInteger)
    || maxConcurrent < 1 || maxConcurrent > 3 || maxWaiting < 1 || maxWaiting > 32
    || maxWaitingBytes < 1 || maxWaitingBytes > 4 * MAX_REQUEST_BYTES
    || waitTimeoutMs < 1 || waitTimeoutMs > 30000 || spacingMs < 0 || spacingMs > 1000) throw failure('broker_configuration_invalid');
  const queue = [];
  let active = 0, activeBytes = 0, waitingBytes = 0, nextStart = 0, timer;
  function pump() {
    clearTimeout(timer); timer = undefined;
    if (!queue.length || active >= maxConcurrent || activeBytes + queue[0].bytes > MAX_REQUEST_BYTES) return;
    const delay = nextStart - performance.now();
    if (delay > 0) { timer = setTimeout(pump, delay); return; }
    const item = queue.shift(); clearTimeout(item.deadline);
    waitingBytes -= item.bytes; active++; activeBytes += item.bytes;
    nextStart = performance.now() + spacingMs;
    Promise.resolve().then(item.work).then(item.resolve, item.reject).finally(() => {
      active--; activeBytes -= item.bytes; pump();
    });
    pump();
  }
  return {
    run(work, bytes) {
      if (typeof work !== 'function' || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_REQUEST_BYTES) return Promise.reject(failure('invalid_request'));
      if (queue.length >= maxWaiting || waitingBytes + bytes > maxWaitingBytes) return Promise.reject(failure('broker_queue_full'));
      return new Promise((resolve, reject) => {
        const item = { work, bytes, resolve, reject };
        item.deadline = setTimeout(() => {
          const index = queue.indexOf(item); if (index < 0) return;
          queue.splice(index, 1); waitingBytes -= bytes;
          reject(failure('broker_queue_timeout')); pump();
        }, waitTimeoutMs);
        queue.push(item); waitingBytes += bytes; pump();
      });
    },
  };
}
module.exports = { createBedrockAdmission };
