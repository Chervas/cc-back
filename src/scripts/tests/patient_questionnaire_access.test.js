'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../../controllers/patientIntake.controller'), 'utf8');
function harness({ allowed = true, patientClinic = 121 } = {}) {
  const calls = [], module = { exports: {} };
  const service = Object.fromEntries(['prepare', 'reviewView', 'confirm'].map(name => [name, async args => { calls.push({ name, args }); return { ok: true }; }]));
  vm.runInNewContext(source, { module, exports: module.exports, require: name => {
    if (name === '../../models') return { Paciente: { findOne: async () => ({ id_paciente: 12, clinica_id: patientClinic }) } };
    if (name.includes('access-policy')) return { canUserAccessFeature: async args => { calls.push({ name: 'access', args }); return allowed; } };
    if (name.includes('patient-intake-questionnaire')) return require('../../lib/patient-intake-questionnaire');
    if (name.includes('patientIntake.service')) return service;
    throw Error(name);
  } });
  return { calls, async run(action, clinicId = 121) { let status = 200, body; const res = { status(n) { status = n; return this; }, json(value) { body = value; } };
    await module.exports[action]({ params: { id: 'pac_ficticio' }, body: { clinic_id: clinicId }, query: {}, userData: { userId: 1 } }, res, e => { throw e; }); return { status, body }; } };
}
test('questionnaire preparation, read and professional confirmation use distinct clinic permissions', async () => {
  for (const [action, feature] of Object.entries({ prepare: 'consents.manage', review: 'clinical.reports.view', confirm: 'clinical.reports.manage' })) {
    const h = harness(); assert.equal((await h.run(action)).status, 200); assert.equal(h.calls[0].args.featureKey, feature); assert.equal(h.calls[0].args.clinicId, 121); assert.equal(h.calls[1].args.patientId, 12);
    const denied = harness({ allowed: false }); assert.equal((await denied.run(action)).status, 403); assert.equal(denied.calls.length, 1);
    const wrong = harness({ patientClinic: 122 }); assert.equal((await wrong.run(action)).status, 404); assert.equal(wrong.calls.length, 1);
  }
});
test('invalid clinic scopes never query permissions or write patient intake', async () => {
  for (const id of [-1, 'not-clinic', 0, 1.5]) { const h = harness(); assert.equal((await h.run('prepare', id)).status, 400); assert.equal(h.calls.length, 0); }
});
