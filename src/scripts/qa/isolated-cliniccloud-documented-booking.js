#!/usr/bin/env node
'use strict';
// Real canonical booking command against verified fictional DEV only. Every
// test transaction rolls back; no events, signatures, reminders or API login.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { MARKER, PATIENT_ID } = require('./prepare-isolated-clinical-fixture');
const { bookReviewedAppointment } = require('../../lib/cliniccloud-import/book-reviewed-appointment');
async function main() {
  assert.equal(process.env.QA_ISOLATED_CLINICAL_WRITES, MARKER);
  require('dotenv').config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });
  assert.equal(process.env.DB_NAME, 'clinicaclick_dev_isolated');
  assert.equal(process.env.DB_USERNAME, 'cc_dev_api');
  let db; const log = console.log;
  try { console.log = () => {}; db = require('../../../models'); } finally { console.log = log; }
  const checks = [], ids = [], marker = 'qa-reviewed-import-' + randomUUID();
  const run = async callback => {
    const transaction = await db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' });
    try { await callback(transaction); } finally { if (!transaction.finished) await transaction.rollback(); }
  };
  try {
    assert.equal(db.sequelize.config.database, 'clinicaclick_dev_isolated');
    assert.equal(db.sequelize.config.username, 'cc_dev_api');
    assert.equal((await db.Clinica.findByPk(1)).nombre_clinica, 'Clinica ficticia DEV');
    const patient = await db.Paciente.findOne({ where: { public_id: PATIENT_ID, clinica_id: 1 } });
    const staff = await db.Usuario.findAll({ where: { notas_usuario: MARKER }, order: [['id_usuario','ASC']] });
    const rooms = await db.Instalacion.findAll({ where: { clinica_id: 1, descripcion: MARKER }, order: [['id','ASC']] });
    assert(patient && staff.length >= 2 && rooms.length >= 2);
    const make = suffix => ({ clinica_id: 1, paciente_id: patient.id_paciente, doctor_id: staff[0].id_usuario,
      instalacion_id: rooms[0].id, tratamiento_id: null, titulo: marker, nota: 'Synthetic only', motivo: 'Synthetic import',
      tipo_cita: 'primera_sin_trat', estado: 'pendiente', inicio: '2030-01-07T10:00:00.000Z', fin: '2030-01-07T10:30:00.000Z',
      source_system: 'cliniccloud', source_reference: marker + suffix, es_provisional: 0,
      created_at: '2026-09-27T00:00:00.000Z', updated_at: '2026-09-27T00:00:00.000Z',
      import_metadata: { source_account: 'cliniccloud-5880', source_contact_id: '999999',
        notification_suppression: { appointment_details: true, day_before: true, same_day: true },
        cliniccloud_delta: { pending_assignment: ['treatment_id'], source: { service_key: 'Synthetic' } },
        cliniccloud_reconciliation: { automation_policy: 'hold' } } });
    const reserve = (transaction, payload, more = {}) => bookReviewedAppointment({ db, payload, transaction,
      sourceSha256: 'f'.repeat(64), beforeInsert: async () => {
        assert(await db.Paciente.findByPk(payload.paciente_id, { transaction, lock: transaction.LOCK.UPDATE }));
      }, ...more });
    await run(async transaction => {
      const payload = make('basic'), row = await reserve(transaction, payload); ids.push(row.id_cita);
      await row.reload({ transaction });
      assert.deepEqual(row.import_metadata, payload.import_metadata);
      assert.equal(row.tratamiento_id, null);
      const occupancy = await db.AppointmentBookingOccupancy.findAll({ where: { appointment_id: row.id_cita }, transaction });
      assert.equal(occupancy.length, 2);
      assert.equal(new Date(row.inicio).toISOString(), payload.inicio);
      assert.equal(new Date(row.fin).toISOString(), payload.fin);
      assert.equal(new Date(row.created_at).toISOString(), payload.created_at);
      assert.equal(new Date(row.updated_at).toISOString(), payload.updated_at);
      await assert.rejects(reserve(transaction, make('overlap')), { code: 'booking_unavailable' });
      checks.push('Source interval/HOLD preserved and canonical room/staff occupancies created; overlapping import rejected without force');
    });
    await run(async transaction => {
      const treatment = await db.Tratamiento.create({ nombre: marker, disciplina: 'estetica', activo: true,
        clinica_id: 1, origen: 'clinica', clinical_config: { booking_profile: { version: 1, phases: [] } } }, { transaction, hooks: false });
      await assert.rejects(reserve(transaction, { ...make('configured'), tratamiento_id: treatment.id_tratamiento }), /CONFIGURED_TREATMENT_REQUIRES_PROFILE/);
      assert.equal(await db.CitaPaciente.count({ where: { source_reference: marker + 'configured' }, transaction }), 0);
      checks.push('Configured catalog profiles cannot be replaced by operator-selected resources');
    });
    await run(async transaction => {
      await db.Clinica.update({ equipment_booking_enabled: true }, { where: { id_clinica: 1 }, transaction, hooks: false });
      const equipment = await db.BookingEquipment.create({ owner_clinic_id: 1, name: marker, family_key: 'qa_mobile',
        mobility: 'mobile', status: 'available', turnaround_minutes: 0 }, { transaction });
      await db.BookingEquipmentClinic.create({ equipment_id: equipment.id, clinic_id: 1 }, { transaction });
      for (const room of rooms.slice(0,2)) await db.BookingEquipmentRoomPolicy.upsert({ installation_id: room.id, mode: 'all', equipment_ids: [] }, { transaction });
      const payload = make('equipment'), row = await reserve(transaction, payload, { equipmentIds: [equipment.id] }); ids.push(row.id_cita);
      await row.reload({ transaction });
      assert.equal(row.import_metadata.booking.profile.version, 2);
      assert.deepEqual(row.import_metadata.notification_suppression, payload.import_metadata.notification_suppression);
      assert.equal(row.tratamiento_id, null);
      const metadata = { ...row.import_metadata }; delete metadata.booking; assert.deepEqual(metadata, payload.import_metadata);
      const occupancy = await db.AppointmentBookingOccupancy.findAll({ where: { appointment_id: row.id_cita }, transaction });
      assert.equal(occupancy.length, 3); assert(occupancy.some(r => r.resource_key === 'equipment:' + equipment.id));
      // Another patient, professional and cabin still cannot use the single unit.
      const second = await db.Paciente.create({ clinica_id: 1, public_id: 'pac_' + randomUUID().replaceAll('-','').slice(0,20),
        nombre: 'Ficticio', apellidos: marker }, { transaction, hooks: false });
      await assert.rejects(reserve(transaction, { ...make('equipment-overlap'), paciente_id: second.id_paciente,
        doctor_id: staff[1].id_usuario, instalacion_id: rooms[1].id }, { equipmentIds: [equipment.id] }), { code: 'booking_unavailable' });
      checks.push('One physical equipment unit is reserved canonically and cannot overlap in another room with another patient/staff');
    });
    await run(async transaction => {
      await assert.rejects(reserve(transaction, make('identity'), { beforeInsert: async () => { throw Error('SOURCE_IDENTITY_CHANGED'); } }), /SOURCE_IDENTITY_CHANGED/);
      assert.equal(await db.CitaPaciente.count({ where: { source_reference: marker + 'identity' }, transaction }), 0);
      checks.push('Identity drift stops before inserting the source appointment');
    });
    assert.equal(await db.CitaPaciente.count({ where: { titulo: marker } }), 0);
    assert.equal(await db.AppointmentBookingOccupancy.count({ where: { appointment_id: ids } }), 0);
    console.log(JSON.stringify({ success: true, checks, rolled_back: true, public_database_access: false, messages_sent: 0 }));
  } finally { await db.sequelize.close(); }
}
main().catch(error => { console.error(JSON.stringify({ success: false, code: error.code || error.message })); process.exitCode = 1; });
