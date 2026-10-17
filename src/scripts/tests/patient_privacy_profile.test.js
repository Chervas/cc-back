'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { patientVersion } = require('../../services/patientPrivacyProfile.service');

test('legacy invalid/zero imported DOB stays unknown instead of throwing or inventing a birthday in the review receipt', () => {
  const empty = patientVersion({ id_paciente: 30, fecha_nacimiento: null });
  for (const date of ['', '0000-00-00', '0000-01-01', 'not-a-date', new Date(NaN)]) {
    assert.equal(patientVersion({ id_paciente: 30, fecha_nacimiento: date }), empty, String(date));
  }
  assert.notEqual(patientVersion({ id_paciente: 30, fecha_nacimiento: '1980-01-02' }), empty);
  assert.equal(patientVersion({ id_paciente: 30, fecha_nacimiento: '1980-01-02' }),
    patientVersion({ id_paciente: 30, fecha_nacimiento: new Date('1980-01-02T00:00:00Z') }));
});
