'use strict';

const { performance } = require('node:perf_hooks');
const { MAX_REQUEST_BYTES } = require('../../services/integrations-broker/src/email-limits');
const failure = code => Object.assign(new Error(code), { code, retryable: true });

// Shared by all email callers in one worker process, including manual jobs.
// The durable outbox still owns retries; only work not dispatched may expire.
function createEmailAdmission({ maxWaiting = 16, maxWaitingBytes = 1024 * 1024,
  waitMs = 10000, spacingMs = 300 } = {}) {
  if (![maxWaiting, maxWaitingBytes, waitMs, spacingMs].every(Number.isSafeInteger)
    || maxWaiting < 1 || maxWaiting > 16 || maxWaitingBytes < 1 || maxWaitingBytes > 1024 * 1024
    || waitMs < 1 || waitMs > 10000 || spacingMs < 0 || spacingMs > 1000) throw Error('email_admission_configuration_invalid');
  const queue = [];
  let active = false, waitingBytes = 0, nextStart = 0, timer;
  function pump() {
    clearTimeout(timer); timer = undefined;
    if (active) return;
    // Expiry timers can run late under event-loop load. Check the monotonic
    // deadline before admitting work, including from a promise continuation.
    while (queue.length && performance.now() >= queue[0].expiresAt) {
      const expired = queue.shift(); clearTimeout(expired.deadline);
      waitingBytes -= expired.bytes; expired.reject(failure('email_admission_expired'));
    }
    if (!queue.length) return;
    const delay = nextStart - performance.now();
    if (delay > 0) { timer = setTimeout(pump, delay); return; }
    const item = queue.shift(); clearTimeout(item.deadline);
    waitingBytes -= item.bytes; active = true;
    Promise.resolve().then(item.work).then(item.resolve, item.reject).finally(() => {
      // Include asynchronous authorization and transport time: a slow guard
      // must not consume the gap and let two HTTP sends start back to back.
      active = false; nextStart = performance.now() + spacingMs; pump();
    });
  }
  return { run(work, bytes) {
    if (typeof work !== 'function' || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_REQUEST_BYTES) {
      return Promise.reject(Object.assign(Error('email_broker_request_invalid'), { code: 'email_broker_request_invalid', retryable: false }));
    }
    if (queue.length >= maxWaiting || waitingBytes + bytes > maxWaitingBytes) return Promise.reject(failure('email_admission_full'));
    return new Promise((resolve, reject) => {
      const item = { work, bytes, resolve, reject, expiresAt: performance.now() + waitMs };
      item.deadline = setTimeout(() => {
        const index = queue.indexOf(item); if (index < 0) return;
        queue.splice(index, 1); waitingBytes -= bytes; reject(failure('email_admission_expired')); pump();
      }, waitMs);
      queue.push(item); waitingBytes += bytes; pump();
    });
  } };
}
module.exports = { createEmailAdmission };
