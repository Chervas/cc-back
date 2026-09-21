'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resourceAppointments, resourceInstallationBlocks } = require('../../services/appointmentResourceCalendar.service');
const Op = { ne: Symbol('ne'), lt: Symbol('lt'), gt: Symbol('gt'), in: Symbol('in'), or: Symbol('or') };
const start = '2026-10-05T09:00:00Z', end = '2026-10-05T10:00:00Z';
test('SQL profile marker preserves JSON paths without opening a database connection', async () => {
  const Sequelize = require('sequelize');
  const sequelize = new Sequelize('offline', 'offline', 'offline', { dialect: 'mysql', logging: false });
  try {
    const attribute = require('../../services/appointmentBookingAvailability.service').protectedBookingAttribute({ Sequelize }, 'appointment');
    const sql = sequelize.getQueryInterface().queryGenerator.handleSequelizeMethod(attribute[0]);
    assert.match(sql, /'\$\.booking'/);
    assert.match(sql, /'\$\.program_session'/);
    assert.match(sql, /'\$\.additional_staff'/);
    assert.doesNotMatch(sql, /\$\$/);
  } finally { await sequelize.close(); }
});
function fixture() {
  return { Sequelize: { Op, fn: (name, ...args) => ({ name, args }), col: name => ({ col: name }), literal: value => ({ literal: value }) }, CitaPaciente: { findAll: async () => [
    { id_cita: 1, clinica_id: 72, doctor_id: 5, inicio: start, fin: end },
    { id_cita: 2, clinica_id: 72, doctor_id: 5, inicio: start, fin: end },
  ] }, AppointmentBookingOccupancy: { findAll: async () => [
    { appointment_id: 1, resource_key: 'doctor:5', doctor_id: 5, start_at: start, end_at: '2026-10-05T09:30:00Z', appointment: { clinica_id: 72 } },
    { appointment_id: 1, resource_key: 'doctor:6', doctor_id: 6, start_at: '2026-10-05T09:30:00Z', end_at: end, appointment: { clinica_id: 72 } },
    { appointment_id: 3, resource_key: 'doctor:5', doctor_id: 5, start_at: '2026-10-05T09:30:00Z', end_at: end, appointment: { clinica_id: 66 } },
  ] } };
}
test('legacy resource search includes secondary professionals and does not double-count primary phases', async () => {
  const rows = await resourceAppointments({ db: fixture(), doctorId: 5, start, end, enabled: true });
  assert.deepEqual(rows.map(r => r.id_cita).sort(), [1, 2, 3]);
  assert.equal(rows.find(r => r.id_cita === 1).fin, '2026-10-05T09:30:00Z');
  assert.equal(rows.find(r => r.id_cita === 3).clinica_id, 66);
  assert(rows.every(r => !Object.hasOwn(r, 'paciente_id')));
});
test('disabled gate never reads occupancy schema', async () => {
  const db = fixture(); db.AppointmentBookingOccupancy.findAll = () => { throw Error('must not read'); };
  assert.equal((await resourceAppointments({ db, doctorId: 5, start, end, enabled: false })).length, 2);
});
test('overlap policy distinguishes ordinary occupancy from protected profiles without leaking metadata', async () => {
  const db = fixture();
  db.CitaPaciente.findAll = async () => [{ id_cita: 2, clinica_id: 72, doctor_id: 5,
    inicio: start, fin: end, booking_protected: 0, source_system: null }];
  const original = db.AppointmentBookingOccupancy.findAll;
  db.AppointmentBookingOccupancy.findAll = async () => (await original()).map(row => ({ ...row,
    appointment: { ...row.appointment, booking_protected: row.appointment_id === 1 ? 1 : 0, source_system: null } }));
  const rows = await resourceAppointments({ db, doctorId: 5, start, end, enabled: true });
  assert.equal(rows.find(row => row.id_cita === 1).can_force_legacy, false);
  assert.equal(rows.find(row => row.id_cita === 2).can_force_legacy, true);
  assert.equal(rows.find(row => row.id_cita === 3).can_force_legacy, true);
  assert(rows.every(row => !Object.hasOwn(row, 'source_system') && !Object.hasOwn(row, 'booking_protected')));
});
test('ignores non-overlapping segments and deduplicates same appointment/team interval', async () => {
  const db = fixture(); const original = db.AppointmentBookingOccupancy.findAll;
  db.AppointmentBookingOccupancy.findAll = async () => { const rows = await original(); return [...rows, rows[0], { ...rows[0], start_at: end, end_at: '2026-10-05T11:00:00Z' }]; };
  assert.equal((await resourceAppointments({ db, doctorId: 5, start, end, enabled: true })).length, 3);
});
test('rejects missing scope and invalid intervals before SQL', async () => {
  for (const values of [{}, { doctorId: 5, end: start }, { installationId: 10 }, { doctorId: 5, end: '2028-10-05T10:00:00Z' }]) await assert.rejects(resourceAppointments({ db: fixture(), start, end, enabled: true, ...values }));
});
test('physical cabin alias projects legacy and phase occupancy to the requested cabin without patient fields', async () => {
  const db = fixture(); let aliasReads = 0;
  const alias = { installation_id: 20, canonical_installation_id: 10, group_id: 29 };
  db.InstallationPhysicalAlias = { findAll: async () => (++aliasReads, [alias]) };
  db.Instalacion = { findAll: async () => [10, 20].map(id => ({ id, clinica: { grupoClinicaId: 29 } })) };
  db.CitaPaciente.findAll = async () => [{ id_cita: 2, clinica_id: 66, instalacion_id: 10, inicio: start, fin: end }];
  db.AppointmentBookingOccupancy.findAll = async () => [{ appointment_id: 3, resource_key: 'installation:10',
    installation_id: 10, doctor_id: null, start_at: start, end_at: end, appointment: { clinica_id: 66 } }];
  const result = await resourceAppointments({ db, clinic: { grupoClinicaId: 29 }, installationId: 20, start, end, enabled: true });
  assert.equal(aliasReads, 2); assert.equal(result.length, 2); assert(result.every(row => row.instalacion_id === 20));
  db.InstalacionBloqueo = { findAll: async () => [{ id: 2, instalacion_id: 10, motivo: 'PRIVATE', fecha_inicio: start, fecha_fin: end }] };
  const blocks = await resourceInstallationBlocks({ db, clinic: { grupoClinicaId: 29 }, installationIds: [20], start, end, enabled: true });
  assert.equal(blocks[0].instalacion_id, 20); assert.equal(blocks[0].id, null); assert.doesNotMatch(JSON.stringify(blocks), /PRIVATE/);
});
test('bulk doctor availability stays one legacy read plus one occupancy read', async () => {
  const db = fixture(); let reads = 0;
  const legacy = db.CitaPaciente.findAll, phases = db.AppointmentBookingOccupancy.findAll;
  db.CitaPaciente.findAll = async q => { reads++; assert.deepEqual(q.where[Op.or][0].doctor_id[Op.in], [5, 6]); return legacy(q); };
  db.AppointmentBookingOccupancy.findAll = async q => { reads++; return phases(q); };
  const rows = await resourceAppointments({ db, doctorIds: [5, 6], start, end, enabled: true });
  assert.equal(reads, 2); assert(rows.some(row => row.doctor_id === 6));
});
