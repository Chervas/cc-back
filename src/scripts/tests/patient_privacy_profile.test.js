'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { patientVersion, emptyCandidates, lockAutofillAnchors } = require('../../services/patientPrivacyProfile.service');

test('legacy invalid/zero imported DOB stays unknown instead of throwing or inventing a birthday in the review receipt', () => {
  const empty = patientVersion({ id_paciente: 30, fecha_nacimiento: null });
  for (const date of ['', '0000-00-00', '0000-01-01', 'not-a-date', new Date(NaN)]) {
    assert.equal(patientVersion({ id_paciente: 30, fecha_nacimiento: date }), empty, String(date));
  }
  assert.notEqual(patientVersion({ id_paciente: 30, fecha_nacimiento: '1980-01-02' }), empty);
  assert.equal(patientVersion({ id_paciente: 30, fecha_nacimiento: '1980-01-02' }),
    patientVersion({ id_paciente: 30, fecha_nacimiento: new Date('1980-01-02T00:00:00Z') }));
});

test('autofill only considers still-empty fields, including contacts; existing discrepancies remain explicit', () => {
  assert.deepEqual(emptyCandidates({ available: false, fields: [{ key: 'dni', current: '', proposed: 'QA' }] }), []);
  const fields = [
    { key: 'dni', current: null, proposed: 'QA-DOC' },
    { key: 'email', current: ' ', proposed: 'qa@example.invalid', contact: true },
    { key: 'telefono_movil', current: '34600000000', proposed: '34600000001', contact: true },
    { key: 'direccion', current: 'Conservada', proposed: 'Otra' },
    { key: 'provincia', current: '', proposed: ' ' },
  ];
  assert.deepEqual(emptyCandidates({ available: true, fields }).map(field => field.key), ['dni', 'email']);
});

test('a non-identity document never acquires master profile locks', async () => {
  let called = false;
  await lockAutofillAnchors({ db: { Clinica: { findByPk: () => { called = true; } } },
    documents: [{ purpose: 'clinical' }], transaction: { LOCK: { UPDATE: 'update' } } });
  assert.equal(called, false);
});
