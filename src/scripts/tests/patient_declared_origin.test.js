'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), S = require('sequelize');
const { CODES, validatePatientDeclaredOrigin } = require('../../lib/patient-declared-origin');
const migration = require('../../../migrations/20261017190000-add-patient-declared-origin-code');
test('seven explicit acquisition codes preserve legacy ambiguity; omission never creates an answer', () => {
  assert.deepEqual(CODES, ['social_media', 'search_engines', 'press_radio_tv', 'family_friend', 'professional_referral', 'clinic_signage', 'none']);
  for (const code of CODES) assert.deepEqual(validatePatientDeclaredOrigin({ como_nos_conocio_codigo: code }), { como_nos_conocio_codigo: code });
  assert.deepEqual(validatePatientDeclaredOrigin({ como_nos_conocio: 'otros', procedencia: 7 }), {});
  assert.deepEqual(validatePatientDeclaredOrigin({ como_nos_conocio_codigo: null }), { como_nos_conocio_codigo: null });
  for (const value of [false, 1, {}, [], 'recomendación', 'none ', 'UNKNOWN']) assert.throws(() => validatePatientDeclaredOrigin({ como_nos_conocio_codigo: value }), error => error.status === 400 && error.code === 'invalid_patient_declared_origin');
});
test('the new origin migration is nullable/additive/idempotent and refuses incompatible or destructive changes', async () => {
  const columns = { id_paciente: { type: 'INTEGER', allowNull: false } }, calls = [];
  const q = { describeTable: async table => { assert.equal(table, 'Pacientes'); return columns; }, addColumn: async (table, name, spec) => {
    calls.push({ table, name, spec }); columns[name] = { type: 'VARCHAR(64)', allowNull: spec.allowNull };
  } };
  await migration.up(q, S); await migration.up(q, S); assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'como_nos_conocio_codigo'); assert.equal(calls[0].spec.defaultValue, null);
  columns.como_nos_conocio_codigo = { type: 'VARCHAR(20)', allowNull: false };
  await assert.rejects(migration.up(q, S), /schema_conflict/); assert.equal(calls.length, 1);
  await assert.rejects(migration.down(), /preserve recorded answers/);
});
