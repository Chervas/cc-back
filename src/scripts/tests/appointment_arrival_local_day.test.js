'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { careState, assertCareAction, careActionPatch, assertCareStatusChange } = require('../../lib/appointment-care');
const base = { id_cita: 11, clinica_id: 3, paciente_id: 7, estado: 'recordatorio_confirmado', es_provisional: false };

for (const [label, timeZone, inicio, midnight] of [
  ['Madrid summer', 'Europe/Madrid', '2026-10-15T16:00:00Z', '2026-10-14T22:00:00Z'],
  ['Madrid winter', 'Europe/Madrid', '2026-11-15T17:00:00Z', '2026-11-14T23:00:00Z'],
  ['DST forward day', 'Europe/Madrid', '2026-03-29T16:00:00Z', '2026-03-28T23:00:00Z'],
  ['DST backward day', 'Europe/Madrid', '2026-10-25T17:00:00Z', '2026-10-24T22:00:00Z'],
  ['America clinic', 'America/New_York', '2026-10-15T20:00:00Z', '2026-10-15T04:00:00Z'],
  ['UTC clinic', 'UTC', '2026-10-15T18:00:00Z', '2026-10-15T00:00:00Z'],
]) test(`${label}: reception starts exactly at clinic midnight, not the appointment hour`, () => {
  const row = { ...base, inicio }, options = { timeZone };
  const now = new Date(midnight), before = new Date(+now - 1);
  assert.equal(careState(row, before, options).can_arrive, false);
  assert.throws(() => assertCareAction(row, 'arrive', before, options), { code: 'care_too_early' });
  assert.equal(careState(row, now, options).can_arrive, true);
  assert.equal(careState(row, now, options).can_no_show, false);
  assert.throws(() => assertCareStatusChange(row, { estado: 'no_asistio' }, now), { code: 'care_no_show_too_early' });
  const patch = careActionPatch(row, 'arrive', { now, actorId: 9, timeZone });
  assert.equal(patch.arrived_at, now);
  assert.equal(patch.care_started_at, null);
  const arrived = { ...row, ...patch };
  assert.equal(careState(arrived, now, options).can_start, false);
  assert.throws(() => assertCareAction(arrived, 'start', now, options), { code: 'care_too_early' });
  assert.equal(careState(arrived, new Date(inicio), options).can_start, true);
  assert.doesNotThrow(() => assertCareAction(arrived, 'start', new Date(inicio), options));
});

test('default and included clinic configuration use the existing authoritative timezone resolver', () => {
  const row = { ...base, inicio: '2026-10-15T20:00:00Z' }, now = new Date('2026-10-15T01:00:00Z');
  assert.equal(careState(row, now).can_arrive, true, 'default Madrid');
  assert.equal(careState({ ...row, clinica: { configuracion: { timezone: 'America/New_York' } } }, now).can_arrive, false);
  assert.equal(careState({ ...row, clinica: { configuracion: '{"timezone":"America/New_York"}' } }, now).can_arrive, false);
});

test('existing past, terminal, provisional and historical boundaries remain unchanged', () => {
  const row = { ...base, inicio: '2026-10-14T11:00:00Z' }, now = new Date('2026-10-15T11:00:00Z');
  assert.equal(careState(row, now).can_arrive, true, 'past reservations retain existing reception correction behavior');
  for (const change of [{ estado: 'cancelada' }, { estado: 'no_asistio' }, { estado: 'completada' },
    { es_provisional: true }, { paciente_id: null }, { care_legacy_attendance: true }, { inicio: null }, { inicio: 'invalid' }]) {
    assert.equal(careState({ ...row, ...change }, now).can_arrive, false);
  }
  assert.equal(careState(row, new Date('invalid')).can_arrive, false);
});

function receptionService(timeZone) {
  const fs = require('node:fs'), vm = require('node:vm'), { createRequire } = require('node:module');
  const filename = require.resolve('../../services/appointmentCare.service'), nativeRequire = createRequire(filename);
  const clock = { now: '2026-10-15T01:00:00Z' }, writes = [], reads = [], careEvents = [];
  const transaction = { LOCK: { UPDATE: 'UPDATE' }, options: { isolationLevel: 'READ COMMITTED' } };
  const appointment = { ...base, inicio: '2026-10-15T20:00:00Z', toJSON() { return { ...this }; }, async update(patch, options) {
    assert.equal(options.transaction, transaction); writes.push(patch); Object.assign(this, patch);
  } };
  const db = { sequelize: { transaction: (options, fn) => { assert.equal(options.isolationLevel, 'READ COMMITTED'); return fn(transaction); } },
    CitaPaciente: { findByPk: async (id, options) => { assert.equal(options.lock, 'UPDATE'); return appointment; } },
    Clinica: { findByPk: async (id, options) => { reads.push(id); assert.equal(options.transaction, transaction);
      return { id_clinica: id, configuracion: { timezone: timeZone } }; } },
    AppointmentCareEvent: { create: async values => { const event = { id: careEvents.length + 1, ...values }; careEvents.push(event); return event; } },
    PatientOperationalEvent: { create: async () => {} } };
  const module = { exports: {} };
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [clock.now])); } }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, Date: ClockDate,
    require: name => name === '../../models' ? db
      : name === './appointmentPatientLinks.service' ? { load: async () => null }
        : name === './appointmentConfirmationUndo.service' ? { createAppointmentConfirmationUndoService: () => ({ record: async () => null }) }
          : name === './appointmentActivity.service' ? { recordAppointmentStatusChange: async () => {} }
        : name === './appointmentConsentEligibility.service' ? { assessAppointmentClinicalConsent: async () => assert.fail('Early care cannot consult or bypass consent') }
          : name === './treatmentDocumentation.service' ? { createTreatmentDocumentationService: () => assert.fail('Arrival cannot start clinical work') }
            : nativeRequire(name) });
  return { service: module.exports, appointment, writes, reads, careEvents, clock,
    record: action => module.exports.record({ appointmentId: 11, clinicId: 3, actorId: 9, action }) };
}

test('audited service resolves clinic timezone under the appointment transaction and keeps early arrival idempotent', async () => {
  const f = receptionService('Europe/Madrid');
  const result = await f.record('arrive');
  assert.equal(result.appointment.estado, 'ha_acudido');
  assert.equal(result.care.can_start, false);
  assert.equal(f.writes.length, 1); assert.equal(f.careEvents.length, 1);
  assert.equal(f.careEvents[0].actor_id, 9);
  assert.equal((await f.record('arrive')).replayed, true);
  assert.equal(f.writes.length, 1); assert.equal(f.careEvents.length, 1);
  await assert.rejects(f.record('start'), { code: 'care_too_early' });
  assert.equal(f.writes.length, 1); assert.equal(f.careEvents.length, 1);
});

test('audited service denies a clinic-local future day and a different clinic without writing evidence', async () => {
  const f = receptionService('America/New_York');
  await assert.rejects(f.record('arrive'), { code: 'care_too_early' });
  assert.equal(f.writes.length, 0); assert.equal(f.careEvents.length, 0);
  await assert.rejects(f.service.record({ appointmentId: 11, clinicId: 4, actorId: 9, action: 'arrive' }), { code: 'appointment_clinic_changed' });
  assert.equal(f.reads.length, 1, 'foreign clinic is denied before querying its configuration');
});
