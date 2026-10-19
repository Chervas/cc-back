'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { customSubmissionName, runCustomSubmission } = require('../../lib/whatsapp-custom-submission');
const input = { clinicId: 1, wabaId: 'waba-one', targetWabaIds: ['waba-one', 'waba-two'],
  createdByUserId: 2, requestId: 'synthetic-request-001', displayName: 'Relocation', bodyText: 'Hello {{name}}, new address.',
  category: 'UTILITY', language: 'es', variables: [{ name: 'name', index: 1 }], replaceTemplateId: 10 };

function fixture({ crash = false, unknown = false, notStarted = false } = {}) {
  const rows = new Map(), calls = { provider: 0, create: 0, reconcile: 0, enqueue: 0, released: 0 };
  let busy = false;
  const deps = { acquire: async () => {
    if (busy) return { acquired: false };
    busy = true; return { acquired: true, release: async () => { busy = false; calls.released++; } };
  }, find: async where => rows.get(`${where.waba_id}:${where.name}`),
  create: async value => {
    calls.create++;
    const row = value.existingRow || { id: calls.create, created_by_user_id: value.createdByUserId, clinic_id: value.clinicId };
    rows.set(`${value.wabaId}:${value.technicalName}`, row);
    if (notStarted) { row.rejection_reason = 'custom_submission_not_started'; throw Error('job_persistence_failed'); }
    row.rejection_reason = 'custom_submission_outcome_unknown'; calls.provider++;
    if (crash) throw Error('process_died_after_acceptance');
    if (!unknown) row.meta_template_id = 'synthetic-provider-id';
    return { row, submitted: !unknown };
  }, reconcile: async () => { calls.reconcile++; }, enqueue: async () => { calls.enqueue++; } };
  return { rows, calls, deps };
}
test('technical retry identity includes content, owner, language, targets and predecessor but not target ordering', () => {
  const name = customSubmissionName(input);
  assert.match(name, /^cc_custom_[a-f0-9]{40}$/);
  assert.equal(name, customSubmissionName({ ...input, targetWabaIds: [...input.targetWabaIds].reverse() }));
  assert.equal(name, customSubmissionName({ ...input, requestId: 'another-tab-retry-001' }));
  for (const changes of [{ bodyText: 'changed' }, { language: 'ca' }, { createdByUserId: 3 }, { replaceTemplateId: 11 }, { targetWabaIds: ['different'] }]) {
    assert.notEqual(name, customSubmissionName({ ...input, ...changes }));
  }
  assert.throws(() => customSubmissionName({ ...input, requestId: 'invalid' }), /invalid/);
});
test('100 concurrent submissions and their retries produce one provider create', async () => {
  const f = fixture();
  const results = await Promise.allSettled(Array.from({ length: 100 }, () => runCustomSubmission(input, f.deps)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  for (const result of results.filter(result => result.status === 'rejected')) assert.equal(result.reason.statusCode, 409);
  for (let i = 0; i < 100; i++) assert.equal((await runCustomSubmission(input, f.deps)).row.meta_template_id, 'synthetic-provider-id');
  assert.equal(f.calls.provider, 1); assert.equal(f.calls.create, 1); assert.equal(f.calls.released, 101);
});
test('timeout and process death preserve one durable identity and reconcile without resubmitting', async () => {
  for (const options of [{ unknown: true }, { crash: true }]) {
    const f = fixture(options);
    if (options.crash) await assert.rejects(runCustomSubmission(input, f.deps), /process_died/);
    else await runCustomSubmission(input, f.deps);
    for (let i = 0; i < 5; i++) assert.equal((await runCustomSubmission(input, f.deps)).outcome_unknown, true);
    assert.equal(f.calls.provider, 1); assert.equal(f.calls.enqueue, 5);
    assert.equal(f.calls.create, 1); assert.equal(f.calls.released, 6);
  }
});
test('failure before contacting Meta may resume only that not-started identity', async () => {
  const f = fixture({ notStarted: true });
  await assert.rejects(runCustomSubmission(input, f.deps), /job_persistence_failed/);
  await assert.rejects(runCustomSubmission(input, f.deps), /job_persistence_failed/);
  assert.equal(f.calls.provider, 0); assert.equal(f.rows.size, 1); assert.equal(f.calls.released, 2);
});
test('existing identities owned by another user or clinic cannot be reused', async () => {
  const f = fixture();
  f.rows.set(`${input.wabaId}:${customSubmissionName(input)}`, { clinic_id: 3, created_by_user_id: input.createdByUserId });
  await assert.rejects(runCustomSubmission(input, f.deps), { code: 'template_owner_forbidden' });
  assert.equal(f.calls.provider, 0); assert.equal(f.calls.released, 1);
});
