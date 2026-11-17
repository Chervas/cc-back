'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const api = require('../../lib/patient-group-link');
const { pack, unpack } = require('../../../services/platform-audit/src/event');
const { FEATURE_KEYS } = require('../../../services/platform-audit/src/access-policy-contract');
const source = { id_clinica: 100, grupoClinicaId: 50, nombre_clinica: 'Origen ficticio' };
const target = { id_clinica: 200, grupoClinicaId: '50', nombre_clinica: 'Destino ficticio' };
const patient = { id_paciente: 901, public_id: 'pac_ficticio', numero_historia: 'NHC-901',
  nombre: 'Paciente ficticio', apellidos: 'Prueba', clinica_id: 100,
  telefono_movil: '34600000901', email: 'ficticio@example.invalid',
  telefono_secundario: 'PHI_SECONDARY_CANARY', dni: 'PHI_DNI_CANARY', alergias: 'PHI_CLINICAL_CANARY',
  fecha_nacimiento: '1980-01-01', notas_paciente: 'PHI_NOTES_CANARY',
  clinicasVinculadas: [{ clinica_id: 999, clinica: { nombre_clinica: 'PHI_UNSEEN_CANARY' } }] };
const input = patch => ({ patient, sourceClinic: source, targetClinic: target,
  contact: { telefono: '+34 600 000 901' }, permitted: true, ...patch });
test('candidate and linked DTOs are separate minimal projections and never disclose hidden contacts or clinical data', () => {
  const candidate = api.groupLinkCandidate(input());
  assert.deepEqual(candidate, { id_paciente: 901, public_id: 'pac_ficticio', numero_historia: 'NHC-901',
    nombre: patient.nombre, apellidos: patient.apellidos, clinica_id: 100, clinicaNombre: source.nombre_clinica });
  const basic = api.basicLinkedPatient(patient, '200', { telefono: '+34 600 000 901' });
  assert.deepEqual(basic, { id_paciente: 901, public_id: 'pac_ficticio', numero_historia: 'NHC-901',
    nombre: patient.nombre, apellidos: patient.apellidos, clinica_id: 200, telefono_movil: '34600000901' });
  assert(!JSON.stringify([candidate, basic]).includes('PHI_'));
  assert(!JSON.stringify([candidate, basic]).includes(patient.email));
  assert.equal(patient.clinica_id, 100); assert.equal(patient.numero_historia, 'NHC-901');
});
for (const value of [null, undefined, 0, -1, '', true, false, 'abc', '0']) {
  test('a missing/non-positive group never authorizes linking: ' + String(value), () => {
    assert.equal(api.groupLinkCandidate(input({ sourceClinic: { ...source, grupoClinicaId: value },
      targetClinic: { ...target, grupoClinicaId: value } })), null);
  });
}
for (const [label, patch] of [
  ['different groups', { targetClinic: { ...target, grupoClinicaId: 51 } }],
  ['same clinic', { targetClinic: source }], ['inconsistent source', { sourceClinic: { ...source, id_clinica: 101 } }],
  ['explicit permission missing', { permitted: undefined }], ['truthy permission is insufficient', { permitted: 'true' }],
  ['already linked', { alreadyLinked: true }], ['no contact', { contact: {} }],
  ['name alone', { contact: { nombre: patient.nombre, apellidos: patient.apellidos } }],
  ['fuzzy phone', { contact: { telefono: '60000090' } }], ['different email', { contact: { email: 'other@example.invalid' } }],
]) test('candidate is denied for ' + label, () => assert.equal(api.groupLinkCandidate(input(patch)), null));
test('contact matching supports international phone formatting and case-insensitive trimmed email without leaking non-matching input', () => {
  for (const telefono of ['+34 600 000 901', '0034 600000901', '600000901', '34600000901']) {
    assert(api.groupLinkCandidate(input({ contact: { telefono } })), telefono);
  }
  const contact = { email: '  FICTICIO@EXAMPLE.INVALID ', telefono: '34699999999' };
  assert(api.groupLinkCandidate(input({ contact })));
  assert.deepEqual(api.matchingPatientGroupContact(patient, contact), { phone: null, email: patient.email });
  assert.equal(api.basicLinkedPatient(patient, 200, contact).email, patient.email);
  assert(!Object.hasOwn(api.basicLinkedPatient(patient, 200, contact), 'telefono_movil'));
});
test('permission codec includes group linking and preserves audited allow/deny/inherit transitions', () => {
  assert(FEATURE_KEYS.includes('patients.group.link'));
  for (const requestedEffect of ['allow', 'deny', 'inherit']) for (const roleCode of ['reception', 'admin_staff', 'propietario', 'patient_director']) {
    const event = { version: 4, eventId: randomUUID(), correlationId: randomUUID(), occurredAt: '2026-11-17T10:00:00.000Z',
      action: 'permission.override.change', stage: 'completed', outcome: 'success', reason: 'override_changed', actor: { type: 'user', id: '9001' },
      sessionRef: randomUUID(), scope: { type: 'clinic', id: '200' }, featureKey: 'patients.group.link', roleCode,
      requestedEffect, previousEffect: requestedEffect === 'deny' ? 'allow' : 'deny', resultCount: 1, scopeClinicCount: 1,
      authorizationBasis: 'scope_owner', authorizationPolicyVersion: 'a'.repeat(64), capturePolicy: 'permissions-durable-v1' };
    assert.deepEqual(unpack(pack(event)).event, event);
    assert.throws(() => pack({ ...event, patientName: 'PHI_NAME_CANARY' }));
    assert.throws(() => pack({ ...event, featureKey: 'patients.group.link.unrecognized' }));
  }
});
