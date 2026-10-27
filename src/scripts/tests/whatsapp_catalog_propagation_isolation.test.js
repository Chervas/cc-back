'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createPropagation, catalogDigest } = require('../../lib/whatsapp-catalog-propagation');
function fixture(options = {}) {
  const catalog = { id: 20, body_text: 'TESTONLY {{1}}', is_active: true, is_generic: true, disciplinas: [] };
  const rows = new Map(), calls = [], settlements = [];
  let nextId = 2, busy = false, failEnqueue = false;
  const model = data => ({ ...data, update: async function(values) { Object.assign(this, structuredClone(values)); } });
  const parent = model({ id: 1, status: 'running', attempts: 1,
    payload: { mode: 'propagate_catalog_item', templateCatalogId: 20, __runtime_namespace: 'TESTONLY' } });
  rows.set(1, parent);
  const configs = new Map([[1, { wabaId: '101' }], [2, { wabaId: '101' }], [3, { wabaId: '102' }], [4, null]]);
  const coordinator = createPropagation({
    JobRequest: { findByPk: async id => rows.get(Number(id)), findAll: async ({ where }) => where.id.map(id => rows.get(id)).filter(Boolean) },
    sequelize: { transaction: async fn => {
      const snapshot = [...rows].map(([id, row]) => [id, structuredClone({ ...row, update: undefined })]);
      try { return await fn({ LOCK: { UPDATE: true } }); }
      catch (error) { rows.clear(); for (const [id, data] of snapshot) rows.set(id, model(data)); throw error; }
    } },
    loadCatalog: async () => catalog,
    listClinics: async () => [1, 2, 3, 4].map(id_clinica => ({ id_clinica })),
    resolveConfig: async id => configs.get(id), applies: () => true,
    enqueue: async (input, options) => {
      assert(options.transaction);
      if (failEnqueue && input.payload.target.key === 'waba:102') throw Error('TESTONLY enqueue failure');
      const previous = [...rows.values()].find(row => row.payload.__dedupe_scope === input.dedupeScope);
      if (previous) return { job: previous };
      const row = model({ id: nextId++, status: 'pending', attempts: 0, payload: { ...input.payload, __dedupe_scope: input.dedupeScope } });
      rows.set(row.id, row); return { job: row };
    },
    acquireLease: async waba => ({ acquired: !busy, release: async () => calls.push(['release', waba]) }),
    propagate: async input => {
      calls.push(input);
      if (input.wabaIds?.[0] === '101') throw Object.assign(Error('TESTONLY timeout'), { code: 'provider_timeout' });
      return { errors: [], clinics_targeted: input.clinicIds.length };
    },
    settleCatalog: async value => settlements.push(value),
    ...options,
  });
  const children = () => [...rows.values()].filter(row => row.id !== 1);
  const run = async child => { child.status = 'running'; child.attempts++;
    try { const result = await coordinator.target(child.payload, child); child.status = result.status; return result; }
    catch (error) { child.status = 'failed'; child.error_message = error.code; throw error; } };
  return { catalog, parent, rows, children, coordinator, calls, settlements, configs, run,
    busy: () => { busy = true; }, failEnqueue: () => { failEnqueue = true; } };
}
test('one shared account gets one child, disconnected clinics remain local, and planning never performs provider work', async () => {
  const f = fixture(), result = await f.coordinator.parent(f.parent.payload, f.parent);
  assert.equal(result.status, 'waiting'); assert.equal(f.children().length, 3);
  assert.deepEqual(f.children()[0].payload.target.clinicIds, [1, 2]); assert.equal(f.calls.length, 0);
  assert.equal(f.children()[2].payload.target.wabaId, null);
  await f.coordinator.parent(f.parent.payload, f.parent); assert.equal(f.children().length, 3);
});
test('account timeout does not prevent another account or local clinic from finishing; aggregate waits then reports partial failure', async () => {
  const f = fixture(); await f.coordinator.parent(f.parent.payload, f.parent);
  const [broken, healthy, local] = f.children(); await assert.rejects(f.run(broken), /timeout/);
  assert.equal((await f.run(healthy)).status, 'completed');
  const waiting = await f.coordinator.parent(f.parent.payload, f.parent);
  assert.equal(waiting.status, 'waiting'); assert.equal(waiting.result.targets_failed, 1); assert.equal(waiting.result.targets_pending, 1);
  assert.equal(f.settlements.length, 0);
  assert.equal((await f.run(local)).status, 'completed');
  const final = await f.coordinator.parent(f.parent.payload, f.parent);
  assert.equal(final.status, 'failed'); assert.equal(final.retryable, false); assert.equal(final.result.targets_completed, 2);
  assert.equal(f.settlements[0].state, 'failed');
  await f.coordinator.parent(f.parent.payload, f.parent); assert.equal(f.children().length, 3);
});
test('plan and children roll back together on enqueue failure', async () => {
  const f = fixture(); f.failEnqueue();
  await assert.rejects(f.coordinator.parent(f.parent.payload, f.parent), /enqueue failure/);
  assert.equal(f.children().length, 0); assert.equal(f.rows.get(1).payload.catalog_propagation_v1, undefined);
});
test('catalog edit supersedes queued children without a provider call or a misleading completion marker', async () => {
  const f = fixture(); await f.coordinator.parent(f.parent.payload, f.parent); f.catalog.body_text = 'TESTONLY new';
  assert.equal((await f.run(f.children()[0])).result.state, 'superseded');
  assert.equal((await f.coordinator.parent(f.parent.payload, f.parent)).result.state, 'superseded');
  assert.equal(f.calls.length, 0); assert.equal(f.settlements.length, 0);
});
test('an edited catalog is not silently adopted by an older queued request', async () => {
  const f = fixture(); f.parent.payload.catalogGeneration = catalogDigest(f.catalog); f.catalog.body_text = 'TESTONLY changed';
  assert.equal((await f.coordinator.parent(f.parent.payload, f.parent)).result.state, 'superseded'); assert.equal(f.children().length, 0);
});
test('a legacy queued request whose source changed is held without replaying current catalog edits', async () => {
  const f = fixture(); f.parent.payload.sourceUpdatedAt = '2030-01-01T00:00:00Z'; f.catalog.updated_at = '2030-01-02T00:00:00Z';
  assert.equal((await f.coordinator.parent(f.parent.payload, f.parent)).result.reason, 'legacy_source_changed');
  assert.equal(f.children().length, 0);
});
test('cancelling the parent prevents its queued account jobs from contacting the provider', async () => {
  const f = fixture(); await f.coordinator.parent(f.parent.payload, f.parent); f.parent.status = 'cancelled';
  assert.equal((await f.run(f.children()[0])).result.state, 'cancelled'); assert.equal(f.calls.length, 0);
});
test('a moved clinic is excluded without preventing the remaining clinic in its shared account', async () => {
  const f = fixture(); await f.coordinator.parent(f.parent.payload, f.parent);
  // Use the healthy account branch for this test, sharing it between clinics.
  const child = f.children()[1];
  child.payload.target = { ...child.payload.target, clinicIds: [3, 4] };
  f.parent.payload.catalog_propagation_v1.targets.find(t => t.jobId === child.id).clinicIds = [3, 4];
  f.configs.set(4, { wabaId: '103' });
  const result = await f.run(child); assert.equal(result.status, 'failed');
  const sent = f.calls.find(value => value.wabaIds); assert.deepEqual(sent.clinicIds, [3]);
  assert.deepEqual(result.result.routing_changed_clinics, [4]);
});
test('account lease contention yields without provider work and does not block another account', async () => {
  const f = fixture(); await f.coordinator.parent(f.parent.payload, f.parent); f.busy();
  assert.equal((await f.run(f.children()[0])).status, 'waiting'); assert.equal(f.calls.length, 0);
});
test('foreign namespace or altered target/catalog cannot execute another account', async () => {
  for (const mutate of [child => child.payload.__runtime_namespace = 'foreign', child => child.payload.target.wabaId = 'foreign',
    child => child.payload.templateCatalogId = 99]) {
    const f = fixture(); await f.coordinator.parent(f.parent.payload, f.parent);
    const child = structuredClone({ ...f.children()[0], update: undefined }); mutate(child);
    await assert.rejects(f.coordinator.target(child.payload, child), /target_changed/); assert.equal(f.calls.length, 0);
  }
});
test('only the current claimed parent may persist the outbox', async () => {
  const f = fixture();
  await assert.rejects(f.coordinator.parent(f.parent.payload, { ...f.parent, attempts: 99 }), /claim_changed/);
  assert.equal(f.children().length, 0);
});
test('catalog identity ignores association storage metadata and propagation timestamps', () => {
  const a = { id: 1, body_text: 'TESTONLY', disciplinas: [{ id: 1, disciplina_code: 'dental' }] };
  assert.equal(catalogDigest(a), catalogDigest({ ...a, propagation_state: 'completed', updated_at: '2030',
    disciplinas: [{ id: 9, template_id: 1, disciplina_code: 'dental', created_at: '2030' }] }));
});
test('review secondary accounts have independent tracked children and keep their native provisioner', async () => {
  let prepared = 0;
  const extra = { key: 'waba:103', wabaId: '103', clinicIds: [1], provisioning: { groupId: 9, assignmentScope: 'group' } };
  const f = fixture({ extraTargets: async () => [extra], provisionSecondary: async ({ target, catalogId }) => {
    assert.equal(target.wabaId, '103'); assert.equal(catalogId, 20); prepared++; return { submitted: 1, localPending: 0 };
  } });
  await f.coordinator.parent(f.parent.payload, f.parent); assert.equal(f.children().length, 4);
  assert.equal((await f.run(f.children()[3])).status, 'completed'); assert.equal(prepared, 1);
  assert.equal(f.calls.length, 0);
});
test('a secondary with an uncertain result is visible as failed, while an account already targeted as primary is not duplicated', async () => {
  const f = fixture({ extraTargets: async () => [
    { key: 'waba:101', wabaId: '101', clinicIds: [1], provisioning: {} },
    { key: 'waba:103', wabaId: '103', clinicIds: [1], provisioning: {} },
  ], provisionSecondary: async () => ({ localPending: 1 }) });
  await f.coordinator.parent(f.parent.payload, f.parent); assert.equal(f.children().length, 4);
  assert.equal(f.children()[0].payload.target.provisioning, undefined);
  assert.equal((await f.run(f.children()[3])).status, 'failed');
});
