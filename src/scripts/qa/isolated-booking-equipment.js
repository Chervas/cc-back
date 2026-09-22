#!/usr/bin/env node
'use strict';
// Real SQL acceptance on fictitious DEV only. One transaction; always rollback.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
async function main() {
  assert.equal(process.env.QA_EQUIPMENT_SQL, 'isolated-dev-rollback');
  require('dotenv').config({ path: require('node:path').resolve(__dirname, '../../../.env'), quiet: true });
  assert.equal(process.env.DB_NAME, 'clinicaclick_dev_isolated');
  assert.equal(process.env.DB_USERNAME, 'cc_dev_api');
  Object.assign(process.env, { BOOKING_EQUIPMENT_ENABLED: 'true', BOOKING_PROFILES_ENABLED: 'true', BOOKING_MULTI_RESOURCE_ENABLED: 'true' });
  const log = console.log;
  let db;
  try { console.log = () => {}; db = require('../../../models'); } finally { console.log = log; }
  const { mutateAppointmentBooking } = require('../../services/appointmentBookingCommand.service');
  const { loadBookingContext } = require('../../services/appointmentBookingAvailability.service');
  const { withCalendarMutation } = require('../../services/appointmentCalendarMutation.service');
  const { bookingSegments } = require('../../lib/appointment-booking-segments');
  const { validateCatalogResources } = require('../../lib/treatment-catalog-resources');
  const marker = `qa-equipment-${randomUUID()}`, checks = [];
  let tx;
  try {
    assert.equal(db.sequelize.config.database, 'clinicaclick_dev_isolated');
    const owner = await db.Clinica.findByPk(1);
    assert.equal(owner.nombre_clinica, 'Clinica ficticia DEV');
    const originalFeature = owner.equipment_booking_enabled, originalGroup = owner.grupoClinicaId;
    const staff = await db.Usuario.findAll({ where: { notas_usuario: 'bs-startup-isolated-20260920' }, order: [['id_usuario', 'ASC']] });
    assert.equal(staff.length, 2);
    const patient = await db.Paciente.findOne({ where: { public_id: 'pac_09202026000000000001', clinica_id: 1 } });
    assert(patient);
    tx = await db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' });
    const group = await db.GrupoClinica.create({ nombre_grupo: marker }, { transaction: tx });
    await owner.update({ equipment_booking_enabled: true, grupoClinicaId: group.id_grupo }, { transaction: tx });
    const peer = await db.Clinica.create({ nombre_clinica: marker, equipment_booking_enabled: true,
      grupoClinicaId: group.id_grupo, configuracion: { timezone: 'Europe/Madrid' } }, { transaction: tx });
    const patient2 = await db.Paciente.create({ public_id: `pac_${randomUUID()}`, nombre: 'QA equipos', apellidos: 'Ficticio', clinica_id: peer.id_clinica }, { transaction: tx });
    const link = await db.DoctorClinica.create({ doctor_id: staff[1].id_usuario, clinica_id: peer.id_clinica, activo: true, recibe_citas: true }, { transaction: tx });
    const rooms = [];
    for (const c of [owner, peer]) {
      const room = await db.Instalacion.create({ clinica_id: c.id_clinica, nombre: marker, activo: true, capacidad: 1 }, { transaction: tx });
      rooms.push(room);
      for (let day = 1; day <= 5; day++) {
        await db.InstalacionHorario.create({ instalacion_id: room.id, dia_semana: day, activo: true, hora_inicio: '09:00', hora_fin: '20:00' }, { transaction: tx });
        if (c === peer) {
          await db.ClinicaHorario.create({ clinica_id: c.id_clinica, dia_semana: day, activo: true, hora_inicio: '09:00', hora_fin: '20:00' }, { transaction: tx });
          await db.DoctorHorario.create({ doctor_clinica_id: link.id, dia_semana: day, activo: true, hora_inicio: '09:00', hora_fin: '20:00' }, { transaction: tx });
        }
      }
      await db.BookingEquipmentRoomPolicy.create({ installation_id: room.id, mode: 'all' }, { transaction: tx });
    }
    const machine = await db.BookingEquipment.create({ owner_clinic_id: 1, group_id: group.id_grupo, name: marker, family_key: 'exion',
      mobility: 'mobile', status: 'available', turnaround_minutes: 5 }, { transaction: tx });
    await db.BookingEquipmentClinic.bulkCreate([1, peer.id_clinica].map(clinic_id => ({ equipment_id: machine.id, clinic_id })), { transaction: tx });
    const treatments = [];
    for (let i = 0; i < 2; i++) treatments.push(await db.Tratamiento.create({ nombre: marker, disciplina: 'estetica', origen: 'clinica',
      clinica_id: rooms[i].clinica_id, activo: true, duracion_min: 30, clinical_config: { catalog_status: 'active', booking_profile: { version: 2, phases: [{
        key: 'care', duration_minutes: 30, installation_ids: [rooms[i].id], professionals: { mode: 'any', ids: [staff[i].id_usuario], preferred_id: staff[i].id_usuario },
        equipment_requirements: [{ equipment_ids: [machine.id] }],
      }] } } }, { transaction: tx }));
    const values = i => ({ clinica_id: rooms[i].clinica_id, paciente_id: i ? patient2.id_paciente : patient.id_paciente,
      tratamiento_id: treatments[i].id_tratamiento, doctor_id: staff[i].id_usuario, instalacion_id: rooms[i].id,
      inicio: '2031-01-06T10:00:00Z', fin: '2031-01-06T10:30:00Z', estado: 'pendiente', source_system: 'qa_rollback', source_reference: marker,
      import_metadata: { notification_suppression: { appointment_details: true, day_before: true, same_day: true } } });
    const persist = ({ values: v, existing, transaction }) => existing ? existing.update(v, { transaction })
      : db.CitaPaciente.create({ ...v, source_reference: `${marker}-${randomUUID()}` }, { transaction });
    const reserve = (i, options = {}) => mutateAppointmentBooking({ db, appointmentValues: values(i), persist, transaction: tx, ...options });
    await validateCatalogResources(treatments[0], db, { transaction: tx });
    checks.push('active-catalog-machine-compatibility');
    const first = await reserve(0);
    const rows = await db.AppointmentBookingOccupancy.findAll({ where: { appointment_id: first.id_cita }, transaction: tx });
    assert.equal(rows.length, 3);
    assert.equal(rows.find(r => r.resource_kind === 'equipment').end_at.toISOString(), '2031-01-06T10:35:00.000Z');
    assert.deepEqual(bookingSegments(first.toJSON())[0].equipment, [{ id: machine.id, name: marker }]);
    checks.push('sql-equipment-occupancy-buffer-and-dto');
    await assert.rejects(reserve(1, { force: true }), e => e.code === 'booking_unavailable' && !e.details.can_force);
    checks.push('shared-machine-conflict-between-clinics');
    await reserve(0, { existingAppointmentId: first.id_cita, appointmentValues: { estado: 'cancelada' }, stateOnly: true });
    const second = await reserve(1);
    checks.push('cancellation-releases-shared-machine');
    await assert.rejects(reserve(0, { existingAppointmentId: first.id_cita, appointmentValues: { estado: 'pendiente' }, stateOnly: true }), { code: 'booking_unavailable' });
    checks.push('reopening-revalidates-machine');
    await reserve(1, { existingAppointmentId: second.id_cita, appointmentValues: { ...values(1), inicio: '2031-01-06T11:00:00Z', fin: '2031-01-06T11:30:00Z' } });
    await reserve(0, { existingAppointmentId: first.id_cita, appointmentValues: { ...values(0), estado: 'pendiente' } });
    checks.push('rescheduling-releases-previous-slot');
    const policy = await db.BookingEquipmentRoomPolicy.findByPk(rooms[0].id, { transaction: tx });
    await policy.update({ mode: 'none' }, { transaction: tx });
    await assert.rejects(reserve(0, { appointmentValues: { ...values(0), inicio: '2031-01-06T12:00:00Z', fin: '2031-01-06T12:30:00Z' } }), { code: 'booking_unavailable' });
    checks.push('room-rejects-mobile-equipment');
    await machine.update({ mobility: 'fixed', home_installation_id: rooms[0].id }, { transaction: tx });
    assert(await reserve(0, { appointmentValues: { ...values(0), inicio: '2031-01-06T12:00:00Z', fin: '2031-01-06T12:30:00Z' } }));
    checks.push('fixed-equipment-not-blocked-by-mobile-rule');
    await machine.update({ status: 'maintenance' }, { transaction: tx });
    await assert.rejects(reserve(0, { appointmentValues: { ...values(0), inicio: '2031-01-06T13:00:00Z', fin: '2031-01-06T13:30:00Z' } }), { code: 'booking_unavailable' });
    checks.push('maintenance-blocks-new-reservations');
    await withCalendarMutation({ db, clinicId: 1, transaction: tx, mutate: async () => true });
    checks.push('calendar-mutation-compatible-with-equipment-buffer');
    const noEquipmentProfile = structuredClone(treatments[0].clinical_config.booking_profile);
    noEquipmentProfile.version = 1; delete noEquipmentProfile.phases[0].equipment_requirements;
    const priorRead = db.BookingEquipment.findAll;
    try {
      db.BookingEquipment.findAll = () => { throw new Error('UNEXPECTED_MACHINE_READ'); };
      await loadBookingContext({ db, clinic: owner, profile: noEquipmentProfile, start: new Date('2031-01-07T10:00:00Z'), end: new Date('2031-01-07T11:00:00Z'), transaction: tx, occupancyEnabled: true });
    } finally { db.BookingEquipment.findAll = priorRead; }
    checks.push('no-machine-query-for-ordinary-treatment');
    await tx.rollback(); tx = null;
    await owner.reload();
    assert.equal(owner.equipment_booking_enabled, originalFeature); assert.equal(owner.grupoClinicaId, originalGroup);
    assert.equal(await db.BookingEquipment.count({ where: { name: marker } }), 0);
    assert.equal(await db.CitaPaciente.count({ where: { source_reference: { [db.Sequelize.Op.like]: `${marker}%` } } }), 0);
    assert.equal(await db.Clinica.count({ where: { nombre_clinica: marker } }), 0);
    checks.push('all-fixtures-and-enablement-rolled-back');
    log(JSON.stringify({ status: 'passed', database: 'isolated-dev-only', checks, persistedAppointments: 0, productionChanges: false }));
  } finally { if (tx && !tx.finished) await tx.rollback(); await db.sequelize.close(); }
}
main().catch(e => { console.error({ code: e.code || e.name, message: e.message, detail: e.parent?.sqlMessage }); process.exitCode = 1; });
