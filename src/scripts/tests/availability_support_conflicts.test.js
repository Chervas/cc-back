'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { supportConflictsForSlot, installationStaffConflicts } = require('../../lib/availability-support-conflicts');
const { explainUnavailableStart } = require('../../lib/booking-grid-diagnostics');
const start = new Date('2026-10-14T09:00:00Z'), end = new Date('2026-10-14T09:15:00Z');
const person = (busy = []) => ({ name: 'Celia', windows: [{ start: new Date('2026-10-14T07:30:00Z'), end: new Date('2026-10-14T15:30:00Z') }], busy });
const args = busy => ({ additionalStaffIds: [53], supportContext: { doctors: new Map([[53, person(busy)]]) },
  start, end, clinicaId: 66, timeZone: 'Europe/Madrid' });

test('support occupation is local-time, privacy-redacted and not forceable', () => {
  const conflicts = supportConflictsForSlot(args([{ start, end: new Date('2026-10-14T09:45:00Z'),
    appointment_id: 77811, diagnostic: { kind: 'other_clinic', treatment_name: 'PRIVATE', patient_name: 'PRIVATE' } }]));
  assert.equal(conflicts[0].code, 'STAFF_OVERLAP');
  assert.equal(conflicts[0].can_force, false);
  assert.equal(conflicts[0].clinica_id, 66);
  assert.match(conflicts[0].details.message, /Celia.*otra clínica.*11:00.*11:45/);
  assert.doesNotMatch(JSON.stringify(conflicts), /PRIVATE|77811|appointment_id|patient_name|treatment_name/);
});

test('end/start boundary is free; missing or out-of-hours support remains unavailable', () => {
  assert.deepEqual(supportConflictsForSlot(args([{ start: new Date('2026-10-14T08:45:00Z'), end: start }])), []);
  assert.deepEqual(supportConflictsForSlot(args([{ start: end, end: new Date('2026-10-14T10:00:00Z') }])), []);
  assert.equal(supportConflictsForSlot({ ...args([]), supportContext: { doctors: new Map() } })[0].code, 'STAFF_OUT_OF_HOURS');
  assert.equal(supportConflictsForSlot({ ...args([]), end: new Date('2026-10-14T16:00:00Z') })[0].code, 'STAFF_OUT_OF_HOURS');
});

test('room allowed professionals remain enforced, not bypassed for support', () => {
  const context = args([]);
  assert.equal(installationStaffConflicts({ ...context, doctorId: 50,
    inst: { id: 75, nombre: 'C2', profesionales_permitidos: [50] } })[0].code, 'INSTALLATION_PROFESSIONAL_NOT_ALLOWED');
  assert.deepEqual(installationStaffConflicts({ ...context, doctorId: 50,
    inst: { id: 75, nombre: 'C2', profesionales_permitidos: [50, 53] } }), []);
});

test('canonical treatment explains support room eligibility instead of interpreting empty windows as closure', () => {
  const profile = { phases: [{ key: 'visit', duration_minutes: 15, installation_ids: [75], professionals: { ids: [50] } }] };
  const context = { doctors: new Map([[50, person()], [53, person()]]),
    installations: new Map([[75, { name: 'C2', profesionales_permitidos: [50], windows: [], busy: [] }]]) };
  const conflict = explainUnavailableStart({ profile, context, start, additionalStaffIds: [53] });
  assert.equal(conflict.details.reason_key, 'room_staff_incompatible');
  assert.doesNotMatch(conflict.details.message, /cerrada|fuera de.*horario/);
});
