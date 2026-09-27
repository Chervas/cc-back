#!/usr/bin/env node
'use strict';
// Transactional fictional clinic 66 is created only after asserting it does
// not exist in isolated DEV. All fixture data, reservations and tests roll back.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { MARKER } = require('./prepare-isolated-clinical-fixture');
const { hash, localToUtc } = require('../../lib/cliniccloud-import/adapter');
const { prepareSourceRefresh, storedSourceRefresh } = require('../../lib/cliniccloud-import/source-refresh');
const { refreshReviewedAppointment } = require('../../lib/cliniccloud-import/refresh-reviewed-appointment');
const plain = row => {
  const result = JSON.parse(JSON.stringify(row.toJSON()));
  if ('es_provisional' in result) result.es_provisional = Number(result.es_provisional);
  return result;
};
async function main() {
  assert.equal(process.env.QA_ISOLATED_CLINICAL_WRITES, MARKER);
  require('dotenv').config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });
  assert.equal(process.env.DB_NAME, 'clinicaclick_dev_isolated');
  assert.equal(process.env.DB_USERNAME, 'cc_dev_api');
  let db; const log = console.log;
  try { console.log = () => {}; db = require('../../../models'); } finally { console.log = log; }
  const marker = 'qa-source-refresh-' + randomUUID(), checks = [], ids = [];
  const run = async fn => {
    const transaction = await db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' });
    try { await fn(transaction); } finally { if (!transaction.finished) await transaction.rollback(); }
  };
  try {
    assert.equal(db.sequelize.config.database, 'clinicaclick_dev_isolated');
    assert.equal(db.sequelize.config.username, 'cc_dev_api');
    assert.equal((await db.Clinica.findByPk(1)).nombre_clinica, 'Clinica ficticia DEV');
    assert.equal(await db.Clinica.findByPk(66), null);
    const doctor = await db.Usuario.findOne({ where: { notas_usuario: MARKER } }); assert(doctor);
    const seed = async transaction => {
      await db.Clinica.create({ id_clinica: 66, nombre_clinica: marker, equipment_booking_enabled: true }, { transaction, hooks: false });
      const patient = await db.Paciente.create({ clinica_id: 66, nombre: 'Ficticio', apellidos: marker,
        public_id: 'pac_' + randomUUID().replaceAll('-','').slice(0,20) }, { transaction, hooks: false });
      const link = await db.DoctorClinica.create({ clinica_id: 66, doctor_id: doctor.id_usuario, recibe_citas: true, activo: true }, { transaction });
      await db.DoctorHorario.create({ doctor_clinica_id: link.id, dia_semana: 1, hora_inicio: '09:00', hora_fin: '20:00', activo: true }, { transaction });
      const rooms = [];
      for (const suffix of ['old', 'new']) {
        const room = await db.Instalacion.create({ clinica_id: 66, nombre: marker + suffix, tipo: 'consulta', capacidad: 1, activo: true }, { transaction });
        await db.InstalacionHorario.create({ instalacion_id: room.id, dia_semana: 1, hora_inicio: '09:00', hora_fin: '20:00', activo: true }, { transaction });
        await db.BookingEquipmentRoomPolicy.create({ installation_id: room.id, mode: 'all', equipment_ids: [] }, { transaction });
        rooms.push(room);
      }
      const equipment = await db.BookingEquipment.create({ owner_clinic_id: 66, name: marker, family_key: 'qa_mobile', mobility: 'mobile', status: 'available', turnaround_minutes: 0 }, { transaction });
      await db.BookingEquipmentClinic.create({ equipment_id: equipment.id, clinic_id: 66 }, { transaction });
      const row = await db.CitaPaciente.create({ clinica_id: 66, paciente_id: patient.id_paciente, doctor_id: doctor.id_usuario,
        instalacion_id: rooms[0].id, tratamiento_id: null, titulo: marker, nota: 'Preserve this historical note',
        tipo_cita: 'primera_sin_trat', estado: 'pendiente', inicio: '2030-01-07T09:00:00.000Z', fin: '2030-01-07T09:30:00.000Z',
        es_provisional: 0, source_system: 'cliniccloud', source_reference: marker,
        created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
        import_metadata: { source_account: 'cliniccloud-5880', source_contact_id: '999999', source_appointment_id: '999998', source_service_id: '999997',
          cliniccloud_delta: { pending_assignment: ['treatment_id'] },
          raw: { idCita: '999998', idContacto: '999999', idAgenda: '999996', fechaIni: '2030-01-07', fechaFin: '2030-01-07', horaIni: '10:00:00', horaFin: '10:30:00', estado: '0', detalles: '' } },
      }, { transaction, hooks: false });
      ids.push(row.id_cita);
      await db.sequelize.query('UPDATE CitasPacientes SET created_at=?, updated_at=? WHERE id_cita=?', {
        replacements: ['2026-09-01 00:00:00', '2026-09-01 00:00:00', row.id_cita], transaction,
      });
      await row.reload({ transaction });
      const before = plain(row), now = Date.now();
      assert.equal(before.updated_at, '2026-09-01T00:00:00.000Z');
      const source = { kind: 'appointment', source_contact_id: '999999', start_local: '2030-01-07T11:00:00', end_local: '2030-01-07T11:30:00',
        start_utc: localToUtc('2030-01-07T11:00:00'), end_utc: localToUtc('2030-01-07T11:30:00'), agenda_key: 'SYNTHETIC', service_key: 'SYNTHETIC', status: 'pendiente', details: '',
        provenance: { source_row: 2, file_sha256: hash(marker), row_sha256: hash('synthetic') } };
      const detail = { idEmpresa: 5880, idCita: 999998, idContacto: 999999, idAgenda: 999996, fechaIni: '2030-01-07', fechaFin: '2030-01-07', horaIni: '11:00:00', horaFin: '11:30:00', estado: 0,
        agenda: { nombre: 'Synthetic' }, cita_conceptos: [{ idServicio: 999997, asunto: 'Synthetic' }], detalles: '' };
      const receipt = prepareSourceRefresh({ before, source, detail, now, liveCapturedAt: new Date(now-1000).toISOString(), sourcePlanSha256: hash('fictional plan'),
        coverage: { start: '2030-01-07', end: '2030-01-07' }, resources: { doctor_id: doctor.id_usuario, installation_id: rooms[1].id, equipment_ids: [equipment.id], evidence_sha256: hash('fictional review') },
        reviewedBy: 'Fictional QA', reason: 'Synthetic source reschedule reviewed for isolated SQL rollback test' });
      return { row, before, receipt, now, rooms };
    };
    await run(async transaction => {
      const f = await seed(transaction);
      const saved = await refreshReviewedAppointment({ db, receipt: f.receipt, transaction, now: f.now, beforeUpdate: async ({ before }) => assert.deepEqual(before, f.before) });
      const after = plain(saved), occupancy = await db.AppointmentBookingOccupancy.findAll({ where: { appointment_id: saved.id_cita }, transaction });
      assert.equal(after.id_cita, f.before.id_cita); assert.equal(after.nota, f.before.nota);
      assert.deepEqual(after.import_metadata.raw, f.before.import_metadata.raw);
      assert.equal(after.inicio, '2030-01-07T10:00:00.000Z'); assert.equal(after.instalacion_id, f.rooms[1].id);
      assert.equal(after.updated_at, new Date(Math.floor(f.now/1000)*1000).toISOString());
      assert.equal(occupancy.length, 3); assert(occupancy.some(item => item.resource_kind === 'equipment'));
      assert.equal(storedSourceRefresh(after, after.import_metadata).receipt_sha256, f.receipt.receipt_sha256);
      assert.deepEqual(after.import_metadata.notification_suppression, { appointment_details: true, day_before: true, same_day: true });
      await assert.rejects(refreshReviewedAppointment({ db, receipt: f.receipt, transaction, now: f.now, beforeUpdate: async () => {} }), /SOURCE_REFRESH_REVIEW_REQUIRED/);
      checks.push('Identity/history/HOLD preserved; date, physical room, doctor and equipment occupancies updated atomically; stale replay rejected');
    });
    await run(async transaction => {
      const f = await seed(transaction);
      await db.CitaPaciente.create({ clinica_id: 66, paciente_id: f.before.paciente_id, doctor_id: doctor.id_usuario,
        instalacion_id: f.rooms[1].id, titulo: marker, tipo_cita: 'primera_sin_trat', estado: 'pendiente',
        inicio: '2030-01-07T10:00:00.000Z', fin: '2030-01-07T10:30:00.000Z' }, { transaction, hooks: false });
      await assert.rejects(refreshReviewedAppointment({ db, receipt: f.receipt, transaction, now: f.now, beforeUpdate: async () => {} }), { code: 'booking_unavailable' });
      checks.push('Canonical availability rejects overlapping reschedule without force; caller rolls back complete transaction');
    });
    await run(async transaction => {
      const f = await seed(transaction);
      await assert.rejects(refreshReviewedAppointment({ db, receipt: f.receipt, transaction, now: f.now,
        beforeUpdate: async () => { throw Error('DEPENDENT_HISTORY_FOUND'); } }), /DEPENDENT_HISTORY_FOUND/);
      await f.row.reload({ transaction }); assert.deepEqual(plain(f.row), f.before);
      checks.push('Dependency/identity guard aborts before mutation');
    });
    assert.equal(await db.Clinica.findByPk(66), null);
    assert.equal(await db.CitaPaciente.count({ where: { titulo: marker } }), 0);
    assert.equal(await db.AppointmentBookingOccupancy.count({ where: { appointment_id: ids } }), 0);
    console.log(JSON.stringify({ success: true, checks, rolled_back: true, messages_sent: 0, real_data_writes: 0 }));
  } finally { await db.sequelize.close(); }
}
main().catch(error => { console.error(JSON.stringify({ success: false, code: error.code || error.message,
  location: error.stack?.split('\n').filter(line => line.trim().startsWith('at ')).slice(0,3) })); process.exitCode = 1; });
