'use strict';

require('./fixtures/scheduled_jobs.fixture.cjs');
const assert = require('node:assert/strict');
const test = require('node:test');
const db = require('../../../models');
const service = require('../../services/marketingBulkSends.service');
const policy = require('../../lib/marketing-whatsapp-cadence');

process.env.JOB_RUNTIME_NAMESPACE = 'cadence-fixture';
const revision = '2026-11-20T09:00:01.000Z';
const nextAllowed = '2026-11-20T09:05:00.000Z';
const scope = { scope: 'group', clinicIds: [8001, 8002], groupId: 9001 };
const after = { batch_size: 70, delay_ms: 10 * 60_000 };
let list, job, actions;
const transaction = { LOCK: { UPDATE: 'lock' } };

db.sequelize.transaction = async callback => callback(transaction);
db.MarketingPatientList.findByPk = async (id, options) => {
  if (options) {
    assert.equal(options.transaction, transaction);
    actions.push('lock-campaign');
  }
  return Number(id) === list.id ? list : null;
};
db.JobRequest.findByPk = async (id, options) => {
  assert.equal(options.transaction, transaction);
  actions.push('lock-job');
  return Number(id) === job.id ? job : null;
};
db.MarketingPatientContactEvent.create = async (event, options) => {
  assert.equal(options.transaction, transaction);
  actions.push(event.event_type);
};

function fixture() {
  actions = [];
  list = {
    id: 8050,
    objective_id: 'mass_sends',
    scope_type: 'group',
    grupo_clinica_id: scope.groupId,
    clinic_ids: scope.clinicIds,
    channel: 'whatsapp',
    status: 'sending',
    counters: { sent: 1, ready: 100 },
    updated_at: new Date(revision),
    criteria: {
      record_kind: 'campaign',
      channels: ['whatsapp', 'email'],
      channel_schedules: { channels: { email: { mode: 'scheduled', scheduled_at: nextAllowed } } },
      dispatch: {
        status: 'waiting_next_batch', job_id: 8100, batch_size: 100, delay_ms: 5 * 60_000,
        last_batch_completed_at: '2026-11-20T09:00:00.000Z', next_allowed_at: nextAllowed,
        business_hours: { start_time: '08:00', end_time: '20:00', timezone: 'Europe/Madrid' },
        delivery_governance: { allowed: true, effective_batch_size: 5 },
      },
    },
    async update(patch, options) {
      assert.equal(options.transaction, transaction);
      actions.push('update-campaign');
      Object.assign(this, patch);
    },
  };
  job = {
    id: 8100,
    type: 'marketing_bulk_send_dispatch',
    status: 'waiting',
    payload: { list_id: list.id, __runtime_namespace: 'cadence-fixture' },
    result_summary: { reason: 'batch_delay' },
    next_run_at: new Date(nextAllowed),
    async update(patch, options) {
      assert.equal(options.transaction, transaction);
      actions.push('update-job');
      Object.assign(this, patch);
    },
  };
}

test('validates cadence without accepting a client-supplied sender, gate or job', () => {
  assert.deepEqual(policy.normalizeCadence({ ...after, job_id: 123, max_opt_out_rate: 1 }), after);
  for (const invalid of [null, { ...after, batch_size: 0 }, { ...after, batch_size: 1001 },
    { ...after, delay_ms: 119_999 }, { ...after, delay_ms: 31 * 86_400_000 }]) {
    assert.throws(() => policy.normalizeCadence(invalid), { status: 400 });
  }
  assert.equal(policy.draftCadence({ whatsapp_cadence: null }, { whatsapp_cadence: after }), null);
  assert.deepEqual(policy.draftCadence({}, { whatsapp_cadence: after }), after);
});

test('lengthens a regular batch wait under job then campaign locks and preserves email, quality and recipients', async () => {
  fixture();
  const email = list.criteria.channel_schedules;
  const result = await service.updateBulkWhatsappCadence(scope, list.id, { revision, whatsapp_cadence: after });
  assert.equal(result.dispatch.batch_size, 70);
  assert.equal(result.dispatch.delay_ms, after.delay_ms);
  assert.equal(result.dispatch.status, 'waiting_next_batch');
  assert.equal(list.criteria.channel_schedules, email);
  assert.equal(result.dispatch.delivery_governance.effective_batch_size, 5);
  assert.equal(job.next_run_at.toISOString(), '2026-11-20T09:10:00.000Z');
  assert.equal(result.dispatch.next_allowed_at, job.next_run_at.toISOString());
  assert.deepEqual(actions, ['lock-job', 'lock-campaign', 'update-job', 'update-campaign', 'mass_campaign_whatsapp_cadence_updated']);
});

test('reduces subsequent intervals and edits scheduled batches without advancing the existing job', async () => {
  fixture();
  const reduced = { batch_size: 200, delay_ms: 2 * 60_000 };
  const result = await service.updateBulkWhatsappCadence(scope, list.id, { revision, whatsapp_cadence: reduced });
  assert.equal(result.dispatch.next_allowed_at, nextAllowed);
  assert.equal(result.dispatch.delay_ms, reduced.delay_ms);
  assert.equal(job.next_run_at.toISOString(), nextAllowed);
  assert(!actions.includes('update-job'));

  fixture();
  list.criteria.dispatch.status = 'scheduled';
  job.result_summary = { reason: 'outside_business_hours' };
  await service.updateBulkWhatsappCadence(scope, list.id, { revision, whatsapp_cadence: after });
  assert.equal(job.next_run_at.toISOString(), nextAllowed);
  assert(!actions.includes('update-job'));
});

test('rejects a stale revision, a claimed batch, a foreign runtime or a mixed clinic scope before any update', async () => {
  for (const [patch, status] of [
    [() => ({ revision: 'old' }), 409],
    [() => { job.status = 'running'; }, 409],
    [() => { job.payload.__runtime_namespace = 'different'; }, 409],
    [() => { list.criteria.dispatch.status = 'paused_quality'; }, 409],
    [() => { list.criteria.review_request = true; }, 409],
  ]) {
    fixture();
    await assert.rejects(service.updateBulkWhatsappCadence(scope, list.id, { revision, whatsapp_cadence: after, ...patch() }), { status });
    assert(actions.every(action => action.startsWith('lock')));
  }
  fixture();
  await assert.rejects(service.updateBulkWhatsappCadence({ ...scope, clinicIds: [8001] }, list.id, {
    revision, whatsapp_cadence: after,
  }), { status: 403 });
  assert.deepEqual(actions, []);
});
