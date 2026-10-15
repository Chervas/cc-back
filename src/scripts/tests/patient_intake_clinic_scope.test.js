'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const { patientForIntakeClinic } = require('../../lib/patient-intake-clinic-scope');
const q = require('../../lib/patient-intake-questionnaire');

function fixture({ primary = 66, clinic = 72, linked = true, primaryGroup = 29, targetGroup = 29,
  missingPatient = false, missingClinic = false, forgedMembership = false } = {}) {
  const calls = [], transaction = { LOCK: { UPDATE: 'UPDATE', SHARE: 'SHARE' } };
  const patient = { id_paciente: 17, public_id: 'pac_ficticio', clinica_id: primary };
  const db = {
    Paciente: {
      findByPk: async (id, options) => { calls.push(['patient', id, options]); return missingPatient ? null : patient; },
      findOne: async options => { calls.push(['patient-public', options]); return missingPatient ? null : patient; },
    },
    PacienteClinica: { findOne: async options => { calls.push(['membership', options]); return !linked ? null
      : { id: 2, paciente_id: forgedMembership ? 99 : 17, clinica_id: clinic }; } },
    Clinica: { findByPk: async (id, options) => { calls.push(['clinic', id, options]); return missingClinic ? null
      : { id_clinica: id, grupoClinicaId: id === primary ? primaryGroup : targetGroup }; } },
  };
  return { db, patient, calls, transaction, clinic,
    run: (extra = {}) => patientForIntakeClinic({ db, identifier: 17, clinicId: clinic, transaction, ...extra }) };
}
test('primary clinic access is preserved and locks the actual patient for transactional operations', async () => {
  const f = fixture({ primary: 72 }); assert.equal(await f.run(), f.patient);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][1], 17);
  assert.equal(f.calls[0][2].transaction, f.transaction); assert.equal(f.calls[0][2].lock, 'UPDATE');
});
test('linked same-group access is derived from the actual membership and both locked clinic anchors', async () => {
  for (const primary of [66, 72]) {
    const f = fixture({ primary, clinic: primary === 66 ? 72 : 66 }); assert.equal(await f.run(), f.patient);
    const membership = f.calls.find(([name]) => name === 'membership')[1];
    assert.deepEqual(membership.where, { paciente_id: 17, clinica_id: f.clinic });
    assert.equal(membership.transaction, f.transaction); assert.equal(membership.lock, 'SHARE');
    const clinics = f.calls.filter(([name]) => name === 'clinic'); assert.deepEqual(clinics.map(row => row[1]), [66, 72]);
    for (const row of clinics) { assert.equal(row[2].transaction, f.transaction); assert.equal(row[2].lock, 'SHARE'); }
  }
});
test('missing membership, different/missing groups, forged rows or deleted anchors always fail closed', async () => {
  for (const options of [{ linked: false }, { primaryGroup: 30 }, { primaryGroup: null, targetGroup: null },
    { targetGroup: 0 }, { missingPatient: true }, { missingClinic: true }, { forgedMembership: true }]) {
    const f = fixture(options); await assert.rejects(f.run({ allowLinkedClinic: true }), { code: 'intake_patient_scope', statusCode: 403 });
  }
});
test('public ids are resolved server-side; invalid scopes and missing identifiers cannot fall through', async () => {
  const f = fixture(); assert.equal(await f.run({ identifier: 'pac_ficticio', transaction: null }), f.patient);
  assert.equal(f.calls[0][0], 'patient-public'); assert.deepEqual(f.calls[0][1].where, { public_id: 'pac_ficticio' });
  for (const clinicId of [0, -1, 'forged', 1.5]) await assert.rejects(f.run({ clinicId }), { code: 'clinic_scope_required' });
  for (const identifier of ['', 0, '0', 'a'.repeat(129)]) await assert.rejects(f.run({ identifier }), { code: 'intake_patient_scope' });
});

const source = fs.readFileSync(require.resolve('../../controllers/patientIntake.controller'), 'utf8');
function controllerFixture(options = {}) {
  const f = fixture(options), calls = [], module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, require(name) {
    if (name === '../../models') return f.db;
    if (name.includes('patient-intake-questionnaire')) return q;
    if (name.includes('patient-intake-clinic-scope')) return { patientForIntakeClinic };
    if (name.includes('access-policy')) return { canUserAccessFeature: async scope => { calls.push(['acl', scope]); return options.allowed !== false; } };
    if (name.includes('patientIntake.service')) return Object.fromEntries(['prepare', 'reviewView', 'confirm'].map(action => [action,
      async scope => { calls.push(['service', action, scope]); return { ok: true }; }]));
    throw Error(name);
  } });
  return { ...f, calls, async run(action) {
    const req = { params: { id: 'pac_ficticio' }, userData: { userId: 7 }, query: {},
      body: { clinic_id: f.clinic, allowLinkedClinic: true, patientId: 999, primary_clinic_id: f.clinic } };
    const res = { code: 200, status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
    await module.exports[action](req, res, error => { throw error; }); return res;
  } };
}
test('prepare, review and confirm retain selected-clinic ACL and accept only verified same-group membership', async () => {
  for (const [action, feature] of [['prepare', 'consents.manage'], ['review', 'clinical.reports.view'], ['confirm', 'clinical.reports.manage']]) {
    const f = controllerFixture(); assert.equal((await f.run(action)).code, 200);
    assert.equal(f.calls[0][1].featureKey, feature); assert.equal(f.calls[0][1].clinicId, 72);
    const scope = f.calls[1][2]; assert.equal(scope.patientId, 17); assert.equal(scope.clinicId, 72); assert.equal(scope.actorId, 7);
    const noAcl = controllerFixture({ allowed: false }); assert.equal((await noAcl.run(action)).code, 403);
    assert.equal(noAcl.calls.length, 1); assert.equal(noAcl.patient.public_id, 'pac_ficticio');
    for (const denied of [{ linked: false }, { targetGroup: 30 }]) {
      const rejected = controllerFixture(denied); assert.equal((await rejected.run(action)).code, 404);
      assert.equal(rejected.calls.length, 1, 'Body flags never authorize an unrelated patient/clinic');
    }
  }
});
