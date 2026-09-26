'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { STATES, instant, projectAppointment, reviewPatientResponse } = require('../../lib/interoperability/appointment-fhir-r4');

// Exclusively fictitious fixtures, no application boot or environment credentials.
const appointment = Object.freeze({ id_cita: 101, clinica_id: 51, paciente_id: 71, doctor_id: 31, instalacion_id: 41,
  estado: 'pendiente', inicio: '2026-09-28T10:00:00+02:00', fin: '2026-09-28T11:00:00+02:00',
  created_at: '2026-09-20T09:00:00Z', updated_at: '2026-09-26T11:00:00Z' });
const occupancy = (kind, key, fields = {}) => ({ appointment_id: 101, resource_kind: kind, resource_key: kind + ':' + key,
  start_at: appointment.inicio, end_at: appointment.fin, ...fields });
const options = Object.freeze({ clinicId: 51, identifierNamespace: 'https://interop.example.test/instance-a', occupancies: [
  occupancy('doctor', 31, { doctor_id: 31 }), occupancy('installation', 40, { installation_id: 41 }), occupancy('equipment', 61),
] });
const projection = state => projectAppointment({ ...appointment, estado: state }, options);
const response = () => ({ resourceType: 'AppointmentResponse', appointment: { identifier: projection('pendiente').resource.identifier[0] },
  actor: projection('pendiente').resource.participant[0].actor, participantStatus: 'accepted', start: appointment.inicio, end: appointment.fin });
const review = (r, a = appointment, o = {}) => reviewPatientResponse(r, a, { ...options, expectedVersion: appointment.updated_at, ...o });
const throws = (fn, code) => assert.throws(fn, { code });

test('canonical model states are all covered; unknown aliases fail closed', () => {
  const model = fs.readFileSync(path.join(__dirname, '../../../models/citapaciente.js'), 'utf8');
  const enumBlock = model.match(/estado:\s*\{[\s\S]*?DataTypes.ENUM\(([\s\S]*?)\)/)[1];
  assert.deepEqual([...enumBlock.matchAll(/'([^']+)'/g)].map(m => m[1]), STATES);
  const expected = { recordatorio_confirmado: 'booked', completada: 'fulfilled', no_asistio: 'noshow', cancelada: 'cancelled' };
  for (const state of STATES) assert.equal(projection(state).resource.status, expected[state] || 'pending');
  throws(() => projection('confirmada'), 'unmapped_appointment_state');
});
test('information received/read never means attendance or a participant response', () => {
  for (const state of ['pendiente', 'info_enviada', 'info_confirmada', 'recordatorio_enviado']) {
    const p = projection(state);
    assert.equal(p.resource.participant[0].status, 'needs-action');
    assert.equal(p.resource.status, 'pending');
  }
  assert.equal(projection('recordatorio_confirmado').resource.participant[0].status, 'accepted');
  assert.equal(projection('completada').resource.resourceType, 'Appointment'); // not an invented Encounter
});
test('rescheduling keeps stable identity and requesting a change does not cancel the reservation', () => {
  const initial = projection('pendiente');
  assert.deepEqual(projection('reprogramada').resource.identifier, initial.resource.identifier);
  const request = projection('cambio_solicitado');
  assert.equal(request.resource.status, 'pending');
  assert.equal(request.resource.start, initial.resource.start);
  assert.equal(request.provenance.reschedule_requested, true);
});
test('explicit instants handle DST and reject ambiguous, impossible or unknown-offset dates', () => {
  assert.equal(instant('2026-10-25T02:30:00+02:00'), '2026-10-25T00:30:00.000Z');
  assert.equal(instant('2026-10-25T02:30:00+01:00'), '2026-10-25T01:30:00.000Z');
  assert.equal(instant(new Date(appointment.inicio)), '2026-09-28T08:00:00.000Z');
  for (const bad of ['2026-09-28 10:00:00', '2026-09-28T10:00:00', '2026-02-30T10:00:00Z',
    '2026-09-28T24:00:00Z', '2026-09-28T10:00:00+14:30', '2026-09-28T10:00:00-00:00']) assert.throws(() => instant(bad));
  throws(() => projectAppointment({ ...appointment, fin: appointment.inicio }, options), 'invalid_period');
});
test('multi-phase resource identity and periods survive without exporting clinical notes or double reserving', () => {
  const half = '2026-09-28T10:30:00+02:00';
  const rows = [occupancy('doctor', 31), occupancy('installation', 40, { installation_id: 41, end_at: half }),
    occupancy('installation', 42, { installation_id: 42, start_at: half }),
    occupancy('equipment', 61, { end_at: half }), occupancy('equipment', 62, { start_at: half })];
  const a = { ...appointment, nota: 'CLINICAL_SECRET', telefono: 'PRIVATE_CONTACT', import_metadata: { secret: 'DO_NOT_EXPORT' } };
  const before = JSON.stringify({ a, rows });
  const p = projectAppointment(a, { ...options, occupancies: [...rows, rows[0]] });
  assert.equal(p.resource.participant.length, 6);
  const rooms = p.resource.participant.filter(p => p.actor.type === 'Location');
  assert.equal(rooms[0].actor.identifier.value, 'installation:40'); // physical, not clinic alias 41
  assert.equal(rooms[0].period.end, rooms[1].period.start);
  assert.equal(JSON.stringify({ a, rows }), before);
  assert(!/CLINICAL_SECRET|PRIVATE_CONTACT|DO_NOT_EXPORT/.test(JSON.stringify(p)));
  const group = projectAppointment({ ...a, clinica_id: 52 }, { ...options, clinicId: 52, occupancies: rows });
  assert.deepEqual(group.resource.participant[2].actor.identifier, rooms[0].actor.identifier);
});
test('missing native resources are not invented and legacy assignments are not presumed accepted', () => {
  const p = projectAppointment({ ...appointment, estado: 'recordatorio_confirmado' }, { ...options, occupancies: [] });
  assert.equal(p.resource.status, 'pending');
  assert.deepEqual(p.warnings, ['legacy_resource_allocation_unverified']);
  const simple = projectAppointment({ ...appointment, doctor_id: null, instalacion_id: null }, { ...options, occupancies: [] });
  assert.equal(simple.resource.participant.length, 1);
});
test('scope, provisional holds and foreign occupancy are rejected; periods are not silently shortened', () => {
  throws(() => projectAppointment(appointment, { ...options, clinicId: 99 }), 'clinic_scope_mismatch');
  throws(() => projectAppointment({ ...appointment, es_provisional: true }, options), 'provisional_hold_not_exportable');
  throws(() => projectAppointment(appointment, { ...options, occupancies: [occupancy('doctor', 31, { appointment_id: 102 })] }), 'occupancy_appointment_mismatch');
  throws(() => projectAppointment(appointment, { ...options, occupancies: [occupancy('patient', 72)] }), 'occupancy_patient_mismatch');
  const p = projectAppointment(appointment, { ...options, occupancies: [...options.occupancies,
    occupancy('equipment', 62, { end_at: '2026-09-28T11:10:00+02:00' })] });
  assert(p.warnings.includes('resource_period_includes_preparation'));
  assert.equal(p.resource.participant.at(-1).period.end, '2026-09-28T09:10:00.000Z');
});
test('identifiers require an issuer; import names are not assumed globally unique', () => {
  throws(() => projectAppointment(appointment, { ...options, identifierNamespace: undefined }), 'identifier_namespace_required');
  throws(() => projectAppointment(appointment, { ...options, identifierNamespace: 'https://user:pass@example.test' }), 'identifier_namespace_invalid');
  const a = { ...appointment, source_system: 'cliniccloud', source_reference: 'fictitious-export-row-101' };
  const p = projectAppointment(a, options);
  assert.equal(p.resource.identifier.length, 1);
  assert(p.warnings.includes('external_identifier_not_exported_without_issuer'));
  assert.equal(projectAppointment(a, { ...options, sourceIdentifierSystems: { cliniccloud: 'urn:example:cliniccloud:tenant-fictitious' } }).resource.identifier.length, 2);
});
test('six program sessions remain six appointments, never one Appointment or a second booking', () => {
  const items = Array.from({ length: 6 }, (_, n) => projectAppointment({ ...appointment, id_cita: 201 + n }, { ...options, occupancies: [] }));
  assert.equal(new Set(items.map(i => i.resource.identifier[0].value)).size, 6);
});
test('a structured answer is only a review proposal; declines or new times do not cancel or move appointments', () => {
  assert.equal(review(response()).action, 'confirm_attendance');
  assert.equal(review({ ...response(), participantStatus: 'declined' }).action, 'review_decline');
  assert.equal(review({ ...response(), start: '2026-09-29T10:00:00+02:00', end: '2026-09-29T11:00:00+02:00' }).action, 'review_reschedule');
  assert.equal(review({ ...response(), comment: '¿Necesito acudir en ayunas?' }).action, 'review_response');
  const result = review(response());
  assert.equal(result.applies, false);
  assert.equal(result.requires_human_review, true);
});
test('stale dates/version, wrong patient/clinic and terminal responses cannot confirm the wrong appointment', () => {
  throws(() => review(response(), appointment, { expectedVersion: '2026-09-25T11:00:00Z' }), 'stale_appointment_response');
  throws(() => review(response(), appointment, { clinicId: 52 }), 'clinic_scope_mismatch');
  throws(() => review({ ...response(), actor: { ...response().actor, identifier: { system: 'wrong', value: 'patient:71' } } }), 'response_patient_mismatch');
  throws(() => review({ ...response(), appointment: { identifier: { ...response().appointment.identifier, value: '51:102' } } }), 'response_appointment_mismatch');
  throws(() => review({ ...response(), start: undefined, end: undefined }), 'explicit_timezone_required');
  throws(() => review(response(), { ...appointment, estado: 'cancelada' }), 'terminal_appointment_response');
});
