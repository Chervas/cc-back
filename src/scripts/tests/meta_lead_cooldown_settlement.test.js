'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
require('./fixtures/scheduled_jobs.fixture.cjs');
process.env.JOBS_AUTO_START = 'false';
process.env.RUNTIME_ROLE = 'api';
const db = require('../../../models');
const requests = require('../../services/jobRequests.service');
const scheduler = require('../../services/jobScheduler.service');
const { createBrokerCooldownWait, createCredentialRenewalWait, CREDENTIAL_WAIT_MS } = require('../../lib/metaLeadBrokerCooldown');
const clone = value => JSON.parse(JSON.stringify(value));
test('broker WAIT preserves retry budget in the claim CAS and keeps claim attempts monotonic', async () => {
  const original = { update: db.JobRequest.update, findByPk: db.JobRequest.findByPk };
  const now = Date.now(), job = { id: 99, type: 'campaign_meta_lead_receive', status: 'running', attempts: 8, max_attempts: 8 };
  let row = { ...job }, calls = [];
  db.JobRequest.findByPk = async () => ({ ...row });
  db.JobRequest.update = async (patch, options) => {
    calls.push({ patch, options });
    if (!Object.keys(options.where).every(key => row[key] === options.where[key])) return [0];
    const { max_attempts, ...plain } = patch; Object.assign(row, plain);
    if (max_attempts) { assert.equal(max_attempts.val, 'max_attempts + 1'); row.max_attempts++; }
    return [1];
  };
  try {
    const wait = createBrokerCooldownWait(job.type, 7200000, now);
    const execution = { status: 'waiting', nextRunAt: wait.nextAllowedAt, result: wait };
    await scheduler._settleJobResult(job, execution, { now: new Date(now) });
    assert.equal(row.attempts, 8); assert.equal(row.max_attempts, 9); assert.equal(row.status, 'waiting');
    assert.deepEqual(calls[0].options.where, { id: 99, status: 'running', attempts: 8, type: job.type, max_attempts: 8 });
    // An old settlement cannot apply after a new claim, even at the old limit.
    row.status = 'running'; row.attempts = 9;
    await scheduler._settleJobResult(job, execution, { now: new Date(now) });
    assert.equal(row.status, 'running'); assert.equal(row.max_attempts, 9);
    const next = { ...job, attempts: 9, max_attempts: 9 };
    assert.equal(scheduler._hasRetryAttemptRemaining(next), false);
    // Failed ordinary work does not acquire a new attempt budget.
    calls = [];
    await scheduler._settleJobResult(next, { status: 'failed', retryable: true, error: Error('ordinary failure') });
    assert.equal(row.status, 'failed'); assert.equal(row.max_attempts, 9);
    assert(!Object.hasOwn(calls[0].patch, 'max_attempts'));
  } finally { Object.assign(db.JobRequest, original); }
});
test('serialized or forged WAIT cannot increase a job budget; recovery keeps the same bound CAS', async () => {
  const now = Date.now(), job = { id: 100, type: 'campaign_meta_lead_receive', status: 'running', attempts: 2, max_attempts: 8 };
  const wait = createBrokerCooldownWait(job.type, 20000, now), execution = { status: 'waiting', nextRunAt: wait.nextAllowedAt, result: wait };
  const captured = [], original = requests.markWaiting;
  requests.markWaiting = async (_id, value) => captured.push(value);
  try {
    await scheduler._settleJobResult(job, { ...execution, result: clone(wait) }, { now: new Date(now) });
    assert(!Object.hasOwn(captured[0], 'metaLeadCooldownProof'));
    await assert.rejects(requests.markWaiting === original ? Promise.resolve() : original(job.id, {
      expectedAttempt: 2, nextRunAt: wait.nextAllowedAt, metaLeadCooldownProof: {},
    }), /meta_lead_cooldown_invalid/);
    const recovery = scheduler._buildSettlementRecovery(job, execution, new Date(now));
    assert(recovery.metaLeadCooldownProof);
    assert.throws(() => scheduler._buildSettlementRecovery({ ...job, max_attempts: 1000000 }, execution, new Date(now)), /invalid/);
    assert.throws(() => scheduler._buildSettlementRecovery(job, { ...execution, nextRunAt: new Date(now - 1) }, new Date(now)), /invalid/);
  } finally { requests.markWaiting = original; }
});

test('local authorization WAIT preserves provider attempts with a private claim-bound proof, including settlement recovery', async () => {
  const now = Date.now(), job = { id: 101, type: 'campaign_meta_lead_receive', status: 'running', attempts: 8, max_attempts: 8 };
  const wait = createCredentialRenewalWait(job.type, now);
  assert.equal(+wait.nextAllowedAt, now + CREDENTIAL_WAIT_MS);
  const execution = { status: 'waiting', nextRunAt: wait.nextAllowedAt, error: wait.error, result: wait };
  const original = requests.markWaiting, captured = [];
  requests.markWaiting = async (_id, value) => captured.push(value);
  try {
    await scheduler._settleJobResult(job, execution, { now: new Date(now) });
    assert(captured[0].metaLeadCooldownProof); assert.equal(captured[0].errorMessage, 'meta_credential_renewal_required');
    const budget = require('../../lib/metaLeadBrokerCooldown').inspectRetryBudgetProof(captured[0].metaLeadCooldownProof, 101, 8, wait.nextAllowedAt, now);
    assert.equal(budget.maxAttempts, 8); assert.equal(budget.type, job.type);
    const recovery = scheduler._buildSettlementRecovery(job, execution, new Date(now));
    assert(recovery.metaLeadCooldownProof); assert.equal(recovery.errorMessage, 'meta_credential_renewal_required');
    await scheduler._settleJobResult(job, { ...execution, result: clone(wait) }, { now: new Date(now) });
    assert.equal(captured[1].metaLeadCooldownProof, undefined);
    assert.throws(() => require('../../lib/metaLeadBrokerCooldown').inspectRetryBudgetProof(captured[0].metaLeadCooldownProof, 101, 9, wait.nextAllowedAt, now));
    assert.throws(() => createCredentialRenewalWait('campaign_meta_page_reception', now));
  } finally { requests.markWaiting = original; }
});
