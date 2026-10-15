'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

for (const [label, privacy] of [['paper', { privacy_satisfied: true, privacy_signed: false, privacy_on_paper: true }],
  ['digital', { privacy_signed: true }]]) test(`health-only questionnaire remains reusable with ${label} privacy evidence`, async () => {
  const transaction = { LOCK: { UPDATE: 'UPDATE' } }, writes = [], previous = { id: 4, package_id: 99, status: 'pending' };
  const db = { Sequelize: { Op: {} }, sequelize: { transaction: callback => callback(transaction) },
    Paciente: { findByPk: async () => ({ id_paciente: 2, clinica_id: 72 }) },
    PatientIntakeRequest: { findOne: async () => previous, create: async () => { writes.push('intake'); throw Error('duplicate intake'); } },
    ConsentSignaturePackage: { findByPk: async () => ({ id: 99, status: 'pending', expires_at: new Date('2099-01-01') }),
      create: async () => { writes.push('package'); throw Error('duplicate package'); } },
    PatientConsentDocument: { count: async query => { assert.equal(query.where.package_id, 99); return 0; } } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../services/patientIntake.service'), 'utf8'), {
    module, exports: module.exports, Buffer, console, Date,
    require(name) {
      if (name === '../../models') return db;
      if (name === './consentimientos.service') return { createPatientIntakePackage: async () => ({ ...privacy, current_package_ids: [] }) };
      if (name === '../lib/patient-intake-questionnaire') return { error: (code, message) => Object.assign(new Error(message), { code }) };
      if (name.startsWith('node:')) return require(name);
      throw Error('Unexpected dependency ' + name);
    },
  });
  const result = await module.exports.prepare({ patientId: 2, clinicId: 72, actorId: 7 });
  assert.equal(result.package_id, 99); assert.equal(result.intake_id, 4); assert.equal(result.reused, true); assert.equal(writes.length, 0);
});
