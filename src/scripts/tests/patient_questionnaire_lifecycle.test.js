'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const path = require('node:path'), { createRequire } = require('node:module');
const file = path.resolve(__dirname, '../../services/patientIntake.service.js');
function service(db) {
  const module = { exports: {} }, normal = createRequire(file);
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports, Date, require: name => {
    if (name === '../../models') return db;
    if (name === './consentimientos.service') throw Error('Must not prepare documents before reviewing submitted answers');
    return normal(name);
  } }); return module.exports;
}
test('repeating preparation cannot hide submitted answers behind a new empty questionnaire', async () => {
  const db = { Sequelize: { Op: {} }, Paciente: { findByPk: async () => ({ clinica_id: 121 }) }, PatientIntakeRequest: { findOne: async () => ({ status: 'submitted' }) } };
  await assert.rejects(service(db).prepare({ patientId: 1, clinicId: 121, actorId: 1 }), { code: 'intake_review_pending', statusCode: 409 });
});
test('returning patient receives their earlier answers but not clinician edits or private history', async () => {
  let i = 0;
  const db = { Sequelize: { Op: { lt: Symbol('lt'), ne: Symbol('ne') } }, PatientIntakeRequest: { findOne: async () => ++i === 1
    ? { id: 2, patient_id: 1, clinic_id: 121, status: 'pending', answers: null, personal_snapshot: { nombre: 'Ficticio' }, confirmed_summary: { private: 'not patient data' } }
    : { answers: { allergies: 'Respuesta original' }, confirmed_summary: { alergias: 'Edición profesional' } } } };
  const view = await service(db).publicView({ id: 22, paciente_id: 1, clinica_id: 121 });
  assert.equal(view.answers.allergies, 'Respuesta original'); assert.equal(view.confirmed_summary, undefined);
});
