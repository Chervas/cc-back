'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const Sequelize = require('sequelize');
require('./fixtures/campaign_offline_runtime.cjs');
const sourceRoot = path.resolve(process.env.GATEWAY_BOUNDARY_SOURCE_ROOT || path.resolve(__dirname, '../../..'));
const { resolveEnqueueRuntimeNamespace } = require(path.join(sourceRoot, 'src/lib/gatewayJobOwnership'));

// Run the actual service source with owned in-memory ports, not live SQL,
// queues, providers or the process environment of another test.
function loadService(name, env, stubs) {
  const file = path.join(sourceRoot, 'src/services', name + '.service.js');
  const localRequire = createRequire(file);
  const requireOwned = id => Object.hasOwn(stubs, id) ? stubs[id] : localRequire(id);
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'process', fs.readFileSync(file, 'utf8'))(
    requireOwned, module, module.exports, { env, cwd: () => '/owned-test' }
  );
  return module.exports;
}

function scheduler(role) {
  const calls = [];
  const job = { id: 501, type: 'automations_v2_execute', attempts: 1 };
  const record = (name, result) => async () => { calls.push(name); return result; };
  const service = loadService('jobScheduler', { RUNTIME_ROLE: role, JOB_RUNTIME_NAMESPACE: role === 'gateway' ? 'gateway' : 'staging' }, {
    '../../models': {},
    './jobRequests.service': {
      getCurrentRuntimeNamespace: () => role === 'gateway' ? 'gateway' : 'staging',
      getRuntimeNamespaceAliases: () => [], shouldClaimUnscopedJobs: () => false,
      findJobById: record('find', job), claimJobById: record('claim', job),
      claimNextJob: record('claimNext', null), resetRunningJobs: record('reset', {}),
      acquireBackgroundIntegrationLease: record('lease', { acquired: false }),
      markCompleted: record('complete', {}),
    },
    './jobExecutor.service': { JOB_HANDLERS: { automations_v2_execute: () => {} }, runJob: record('execute', { status: 'completed' }) },
    './aiRuntimeMonitoring.service': {},
    './appointmentVisitManaged.service': { current: () => ({ reconcilePendingBirthIntents: record('visitDiscovery', {}) }) },
  });
  return { calls, service, job };
}

test('Gateway cannot execute or claim business jobs, even with a dispatcher or workers accidentally enabled', async () => {
  const f = scheduler('gateway');
  f.service.setExternalDispatcher(async () => { f.calls.push('externalDispatcher'); });
  assert.deepEqual(await f.service.start(), { status: 'disabled', reason: 'gateway_runtime' });
  assert.equal(await f.service.triggerImmediate(501), false);
  assert.equal(await f.service._handleCriticalTick(), 0);
  assert.equal(await f.service._handleStandardTick(), 0);
  assert.equal(await f.service._handleBackgroundTick(), 0);
  assert.equal(await f.service._drainQueue(['critical'], 'critical'), 0);
  assert.equal(await f.service._processJob(f.job), false);
  assert.deepEqual(f.calls, []);
  assert.equal(f.service._getWorkerState().running, false);
});

test('Canonical API keeps immediate execution, settlement and critical discovery unchanged', async () => {
  const f = scheduler('api');
  assert.equal(await f.service.triggerImmediate(501), true);
  assert.deepEqual(f.calls, ['find', 'claim', 'execute', 'complete']);
  f.calls.length = 0;
  await f.service._handleCriticalTick();
  assert.deepEqual(f.calls, process.env.GATEWAY_BOUNDARY_SOURCE_ROOT ? ['claimNext'] : ['visitDiscovery', 'claimNext']);
});

test('Gateway only enqueues to its configured owner; missing, self, DEV or caller-selected targets fail closed', () => {
  const env = { RUNTIME_ROLE: 'gateway', AUTOMATIONS_V2_FALLBACK_RUNTIME_NAMESPACE: 'staging' };
  assert.equal(resolveEnqueueRuntimeNamespace('gateway', null, env), 'staging');
  assert.equal(resolveEnqueueRuntimeNamespace('gateway', 'staging', env), 'staging');
  for (const namespace of ['gateway', 'dev', 'prod', 'other']) assert.throws(
    () => resolveEnqueueRuntimeNamespace('gateway', namespace, env), { code: 'gateway_job_owner_unavailable' }
  );
  for (const owner of ['', 'gateway', 'dev', 'runtime:unknown']) assert.throws(
    () => resolveEnqueueRuntimeNamespace('gateway', null, { ...env, AUTOMATIONS_V2_FALLBACK_RUNTIME_NAMESPACE: owner }),
    { code: 'gateway_job_owner_unavailable' }
  );
  assert.equal(resolveEnqueueRuntimeNamespace('dev', null, { RUNTIME_ROLE: 'api' }), 'dev');
  assert.equal(resolveEnqueueRuntimeNamespace('staging', 'trusted-owner', { RUNTIME_ROLE: 'api' }), 'trusted-owner');
});

test('Actual JobRequest persistence keeps handoff scope/idempotency and does not modify its input', async () => {
  const calls = [];
  const sequelize = { literal: Sequelize.literal, where: Sequelize.where,
    transaction: async (_options, run) => run({ LOCK: { UPDATE: 'UPDATE' } }) };
  const model = {
    create: async input => { calls.push(input); return { id: calls.length, ...input }; },
    findOne: async () => null,
  };
  const env = { RUNTIME_ROLE: 'gateway', JOB_RUNTIME_NAMESPACE: 'gateway', AUTOMATIONS_V2_FALLBACK_RUNTIME_NAMESPACE: 'staging' };
  const service = loadService('jobRequests', env, { '../../models': { JobRequest: model, sequelize, Sequelize } });
  const payload = { execution_id: 501 };
  const job = await service.enqueueJobRequest({ type: 'automations_v2_execute', payload });
  assert.equal(job.payload.__runtime_namespace, 'staging'); assert.deepEqual(payload, { execution_id: 501 });
  const unique = await service.enqueueUniqueJobRequest({ type: 'automations_v2_execute', payload, dedupeScope: 'flow_execution:501' });
  assert.equal(unique.job.payload.__runtime_namespace, 'staging');
  assert.equal(unique.job.payload.__dedupe_scope, 'flow_execution:501');
  await assert.rejects(() => service.enqueueJobRequest({ type: 'automations_v2_execute', payload: { __runtime_namespace: 'dev' } }),
    { code: 'gateway_job_owner_unavailable' });
  assert.equal(calls.length, 2);
});
