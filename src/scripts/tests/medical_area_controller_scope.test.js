'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const file = path.resolve(__dirname, '../../controllers/especialidades.controller.js');

function fixture() {
  const calls = [], out = {}, module = { exports: {} };
  const service = {
    getMedicalAreaContracts: async options => { calls.push(['read', options]); return { contracts: {} }; },
    upsertMedicalAreaContract: async (...args) => { calls.push(['publish', ...args]); return { code: args[0] }; },
    adoptClinicRevision: async (...args) => { calls.push(['adopt', ...args]); return { code: args[1] }; },
    listClinicVersions: async (...args) => { calls.push(['list', ...args]); return { items: [] }; },
    reviewClinicRevision: async (...args) => { calls.push(['review', ...args]); return {}; },
    getClinicRevisionHistory: async (...args) => { calls.push(['history', ...args]); return { items: [] }; },
  };
  new Function('require', 'module', 'exports', fs.readFileSync(file, 'utf8'))(name => {
    if (name === 'express-async-handler') return fn => fn;
    if (name === '../../models') return {};
    if (name === '../services/medicalAreaContracts.service') return service;
    if (name === '../lib/access-policy') return { canUserAccessFeature: async ({ clinicId }) => clinicId === 10 };
    if (name === '../lib/role-helpers') return { isGlobalAdmin: id => id === 1 };
    if (name === '../lib/clinic-configuration') return {};
    throw Error(name);
  }, module, module.exports);
  const res = { status: code => { out.status = code; return res; }, json: data => { out.data = data; return res; } };
  const request = { userData: { userId: 7 }, query: {}, params: { clinicId: '10', code: 'nutricion' }, body: {} };
  return { calls, out, handlers: module.exports, res, request, service };
}

test('scoped configuration reads require a valid authorized clinic before loading revisions', async () => {
  for (const [id, status] of [['20', 403], ['10abc', 400], ['-1', 400]]) {
    const f = fixture(); f.request.query.clinica_id = id;
    await f.handlers.getMedicalAreaContracts(f.request, f.res);
    assert.equal(f.out.status, status); assert.equal(f.calls.length, 0);
  }
  const f = fixture(); f.request.query.clinica_id = '10';
  await f.handlers.getMedicalAreaContracts(f.request, f.res);
  assert.deepEqual(f.calls, [['read', { clinicId: '10' }]]);
});

test('only global admins can publish or adopt a version; caller-supplied actor is ignored', async () => {
  for (const action of ['updateMedicalAreaContract', 'adoptMedicalAreaRevision', 'listClinicAreaVersions', 'reviewClinicAreaRevision', 'getClinicAreaRevisionHistory']) {
    const f = fixture(); f.request.body = { updated_by: 1, actorId: 1 };
    await f.handlers[action](f.request, f.res);
    assert.equal(f.out.status, 403); assert.equal(f.calls.length, 0);
  }
  const f = fixture(); f.request.userData.userId = 1;
  f.request.body = { contract: { code: 'nutricion' }, updated_by: 999, expected_revision_id: 8 };
  await f.handlers.updateMedicalAreaContract(f.request, f.res);
  assert.deepEqual(f.calls, [['publish', 'nutricion', { code: 'nutricion' }, 1, { expectedRevisionId: 8 }]]);
});

test('administrative adoption passes only explicit review and authenticated actor to backend', async () => {
  const f = fixture(); f.request.userData.userId = 1;
  f.request.body = { revision_id: 12, expected_revision_id: 8, review_hash: 'a'.repeat(64),
    acknowledge_impact: true, reason: 'Revisión de prueba', actorId: 999 };
  await f.handlers.adoptMedicalAreaRevision(f.request, f.res);
  assert.deepEqual(f.calls, [['adopt', '10', 'nutricion', { revisionId: 12, expectedRevisionId: 8, actorId: 1,
    reviewHash: 'a'.repeat(64), acknowledged: true, reason: 'Revisión de prueba' }]]);
});

test('version conflicts have an actionable JSON response, not a silent overwrite', async () => {
  const f = fixture(); f.request.userData.userId = 1;
  f.service.upsertMedicalAreaContract = async () => { throw Object.assign(Error('conflict'), { code: 'medical_area_revision_conflict', statusCode: 409 }); };
  await f.handlers.updateMedicalAreaContract(f.request, f.res);
  assert.equal(f.out.status, 409); assert.equal(f.out.data.code, 'medical_area_revision_conflict');
});
