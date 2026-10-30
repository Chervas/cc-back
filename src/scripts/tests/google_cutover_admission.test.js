'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createAdmission } = require('../../lib/googleCutoverAdmission');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  let control = { present: false, state: 'OPEN', nonce: null, sha256: null };
  const admission = createAdmission({
    read: () => control,
    resolveRuntime: () => ({ bypass: false, kind: 'api', uid: 1000 }),
  });
  return {
    admission,
    close() {
      control = { present: true, state: 'CLOSED', nonce: randomUUID(), sha256: '0'.repeat(64) };
    },
    installOpen() {
      control = { present: true, state: 'OPEN', nonce: randomUUID(), sha256: '0'.repeat(64) };
    },
  };
}

test('without installed control the original return value and error are preserved', async () => {
  const { admission } = fixture();
  assert.equal(await admission.run('legacy_request', async () => 42), 42);
  const original = new Error('fictitious failure');
  await assert.rejects(admission.run('ads_http', async () => { throw original; }), e => e === original);
  assert.equal(admission.observation().totalActive, 0);
  assert.equal(admission.observation().completionRejectedCounts.ads_http, 1);
});

test('closed admission rejects before persistence and distinguishes refusal from a failed operation', async () => {
  const { admission, close } = fixture();
  close();
  let writes = 0;
  await assert.rejects(admission.run('intake_leads', () => writes++), { code: 'google_cutover_paused' });
  assert.equal(writes, 0);
  assert.equal(admission.observation().admissionRejectedCounts.intake_leads, 1);
  assert.equal(admission.observation().completionRejectedCounts.intake_leads, 0);
});

test('an invalid control cannot authorize work or report a verified zero', async () => {
  const admission = createAdmission({
    read: () => { throw new Error('invalid fictitious control'); },
    resolveRuntime: () => ({ bypass: false, kind: 'api' }),
  });
  let sends = 0;
  await assert.rejects(admission.run('legacy_request', () => sends++));
  assert.equal(sends, 0);
  assert.equal(admission.observation().valid, false);
  assert.equal(admission.observation().totalActive, null);
});

test('an installed control requires a ready observer even when open', async () => {
  const { admission, installOpen } = fixture();
  installOpen();
  await assert.rejects(admission.run('ads_http', () => 1), { code: 'google_cutover_observer_unavailable' });
});

test('closing admission retains accepted work until its promise finishes', async () => {
  const { admission, close } = fixture();
  const pending = deferred();
  const work = admission.run('intake_events', () => pending.promise);
  close();
  assert.equal(admission.observation().activeCounts.intake_events, 1);
  pending.resolve('finished');
  assert.equal(await work, 'finished');
  assert.equal(admission.observation().totalActive, 0);
});

test('accepted work can finish nested calls after closure while an expired detached ticket cannot', async () => {
  const { admission, close } = fixture();
  const child = deferred();
  const late = deferred();
  let detached;
  const work = admission.run('intake_leads', async () => {
    close();
    detached = late.promise.then(() => admission.run('ads_http', () => 1));
    detached.catch(() => {});
    await admission.run('legacy_request', () => child.promise);
    return 'finished';
  });
  assert.equal(admission.observation().totalActive, 2);
  child.resolve();
  assert.equal(await work, 'finished');
  late.resolve();
  await assert.rejects(detached, { code: 'google_cutover_paused' });
  assert.equal(admission.observation().totalActive, 0);
});

test('a pending rejection stays counted and preserves the provider error', async () => {
  const { admission } = fixture();
  const pending = deferred();
  const failure = new Error('fictitious transport failure');
  const work = admission.run('legacy_request', () => pending.promise);
  assert.equal(admission.observation().activeCounts.legacy_request, 1);
  pending.reject(failure);
  await assert.rejects(work, e => e === failure);
  assert.equal(admission.observation().totalActive, 0);
  assert.equal(admission.observation().completionRejectedCounts.legacy_request, 1);
});

test('isolated development bypasses production control and observer', async () => {
  let reads = 0;
  const admission = createAdmission({
    read: () => { reads++; throw new Error('production control must not be read'); },
    resolveRuntime: () => ({ bypass: true, kind: 'isolated_dev' }),
  });
  assert.equal(await admission.run('legacy_request', () => 7), 7);
  assert.equal((await admission.startObserver()).status, 'BYPASS');
  assert.equal(reads, 0);
});
