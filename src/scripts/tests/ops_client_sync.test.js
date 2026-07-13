'use strict';

const assert = require('assert/strict');
const {
  comparableClientName,
  isDuplicateEntryError,
  planOpsClientSync,
  syncOpsClients,
} = require('../../services/opsClientSync.service');

function clinicPayload(overrides = {}) {
  return {
    name: 'Clinic current name',
    brand: 'Clinic current name',
    business_unit: 'clinicaclick',
    status: 'active',
    source_platform: 'clinicaclick',
    external_id: '56',
    email: null,
    phone: null,
    notes: 'Web: https://example.test',
    ...overrides,
  };
}

async function testExistingExternalIdentityWinsOverStaleName() {
  const payload = clinicPayload({
    name: 'Propdental Sant Martí',
    brand: 'Propdental Sant Martí',
  });
  const existing = [
    {
      id: 448,
      name: 'Propdental Sant Marti',
      source_platform: 'clinicaclick',
      external_id: '55',
    },
    {
      id: 449,
      name: 'Propdental Glories',
      source_platform: 'clinicaclick',
      external_id: '56',
    },
  ];
  const calls = { patches: [], creates: [] };

  const result = await syncOpsClients({
    payloads: [payload],
    existingClients: existing,
    patchClient: async (id, body) => calls.patches.push({ id, body }),
    createClients: async (items) => calls.creates.push(items),
  });

  assert.deepEqual(result, {
    total: 1,
    updated: 1,
    created: 0,
    name_conflicts: 1,
  });
  assert.equal(calls.creates.length, 0, 'an existing external key must never be inserted again');
  assert.equal(calls.patches.length, 1);
  assert.equal(calls.patches[0].id, 449, 'the canonical external 56 row must be updated');
  assert.equal(Object.hasOwn(calls.patches[0].body, 'name'), false);
  assert.equal(calls.patches[0].body.brand, payload.brand);
  assert.equal(calls.patches[0].body.source_platform, payload.source_platform);
  assert.equal(calls.patches[0].body.external_id, payload.external_id);
  assert.equal(calls.patches[0].body.notes, payload.notes);
}

async function testUniqueRenameKeepsCompleteProviderPayload() {
  const payload = clinicPayload({ name: 'Unique renamed clinic', brand: 'Unique renamed clinic' });
  const existing = [{
    id: 449,
    name: 'Old clinic name',
    source_platform: 'clinicaclick',
    external_id: '56',
  }];
  const plan = planOpsClientSync([payload], existing);

  assert.equal(plan.creates.length, 0);
  assert.equal(plan.updates.length, 1);
  assert.deepEqual(plan.updates[0].payload, payload);
  assert.equal(plan.updates[0].name_conflict, false);
}

async function testNewExternalClientStillUsesUnchangedBatchPayload() {
  const payload = clinicPayload({ external_id: '999' });
  const created = [];
  const result = await syncOpsClients({
    payloads: [payload],
    existingClients: [],
    patchClient: async () => assert.fail('new clients must not be patched'),
    createClients: async (items) => created.push(items),
  });

  assert.deepEqual(created, [[payload]]);
  assert.equal(result.created, 1);
  assert.equal(result.updated, 0);
}

async function testUnexpectedArchivedNameCollisionRetriesWithoutName() {
  const payload = clinicPayload({ name: 'Renamed clinic' });
  const patches = [];
  const result = await syncOpsClients({
    payloads: [payload],
    existingClients: [{
      id: 449,
      name: 'Old clinic name',
      source_platform: 'clinicaclick',
      external_id: '56',
    }],
    patchClient: async (id, body) => {
      patches.push({ id, body });
      if (patches.length === 1) {
        const error = new Error('provider conflict');
        error.response = { data: { code: 'ER_DUP_ENTRY' } };
        throw error;
      }
    },
    createClients: async () => assert.fail('existing clients must not be created'),
  });

  assert.equal(patches.length, 2);
  assert.equal(patches[0].body.name, payload.name);
  assert.equal(Object.hasOwn(patches[1].body, 'name'), false);
  assert.equal(patches[1].body.brand, payload.brand);
  assert.equal(result.name_conflicts, 1);
}

async function run() {
  assert.equal(comparableClientName(' Propdental Sant Martí '), 'propdental sant marti');
  assert.equal(isDuplicateEntryError({ response: { data: { code: 'ER_DUP_ENTRY' } } }), true);
  await testExistingExternalIdentityWinsOverStaleName();
  await testUniqueRenameKeepsCompleteProviderPayload();
  await testNewExternalClientStillUsesUnchangedBatchPayload();
  await testUnexpectedArchivedNameCollisionRetriesWithoutName();
  console.log('ops_client_sync.test.js: OK');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
