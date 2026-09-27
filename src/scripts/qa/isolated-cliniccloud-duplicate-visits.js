#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { MARKER } = require('./prepare-isolated-clinical-fixture');
const { hash, localToUtc } = require('../../lib/cliniccloud-import/adapter');
const { prepareDuplicateVisit, duplicateVisitLinks } = require('../../lib/cliniccloud-import/duplicate-visits');
const { normalizedSourceRefreshRow: normalize } = require('../../lib/cliniccloud-import/source-refresh');
const { consolidateReviewedDuplicate } = require('../../lib/cliniccloud-import/consolidate-reviewed-duplicate');
const plain = row => normalize(JSON.parse(JSON.stringify(row.toJSON())));

async function main() {
  assert.equal(process.env.QA_ISOLATED_CLINICAL_WRITES, MARKER);
  require('dotenv').config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });
  assert.equal(process.env.DB_NAME, 'clinicaclick_dev_isolated');
  assert.equal(process.env.DB_USERNAME, 'cc_dev_api');
  let db; const log = console.log;
  try { console.log = () => {}; db = require('../../../models'); } finally { console.log = log; }
  const marker = 'qa-duplicate-' + randomUUID(), ids = [], checks = [];
  const run = async fn => {
    const transaction = await db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' });
    try { await fn(transaction); } finally { if (!transaction.finished) await transaction.rollback(); }
  };
  try {
    assert.equal(db.sequelize.config.database, 'clinicaclick_dev_isolated');
    assert.equal((await db.Clinica.findByPk(1)).nombre_clinica, 'Clinica ficticia DEV');
    assert.equal(await db.Clinica.findByPk(66), null);
    assert.equal(await db.GrupoClinica.findByPk(29), null);
    const doctor = await db.Usuario.findOne({ where: { notas_usuario: MARKER } }); assert(doctor);
    const seed = async transaction => {
      await db.GrupoClinica.create({ id_grupo: 29, nombre_grupo: marker }, { transaction, hooks: false });
      await db.Clinica.create({ id_clinica: 66, nombre_clinica: marker, grupoClinicaId: 29, equipment_booking_enabled: true }, { transaction, hooks: false });
      const patient = await db.Paciente.create({ clinica_id: 66, nombre: 'Ficticio', apellidos: marker,
        public_id: 'pac_' + randomUUID().replaceAll('-', '').slice(0, 20) }, { transaction, hooks: false });
      const link = await db.DoctorClinica.create({ clinica_id: 66, doctor_id: doctor.id_usuario, recibe_citas: true, activo: true }, { transaction });
      await db.DoctorHorario.create({ doctor_clinica_id: link.id, dia_semana: 1, hora_inicio: '09:00', hora_fin: '20:00', activo: true }, { transaction });
      const rooms = [];
      for (const suffix of ['old-a', 'old-b', 'new']) {
        const room = await db.Instalacion.create({ clinica_id: 66, nombre: marker + suffix, tipo: 'consulta', capacidad: 1, activo: true }, { transaction });
        await db.InstalacionHorario.create({ instalacion_id: room.id, dia_semana: 1, hora_inicio: '09:00', hora_fin: '20:00', activo: true }, { transaction });
        await db.BookingEquipmentRoomPolicy.create({ installation_id: room.id, mode: 'all', equipment_ids: [] }, { transaction }); rooms.push(room);
      }
      const equipment = await db.BookingEquipment.create({ owner_clinic_id: 66, name: marker, family_key: 'qa_mobile', mobility: 'mobile', status: 'available', turnaround_minutes: 0 }, { transaction });
      await db.BookingEquipmentClinic.create({ equipment_id: equipment.id, clinic_id: 66 }, { transaction });
      const treatment = await db.Tratamiento.create({ nombre: marker, disciplina: 'estetica', clinica_id: 66,
        activo: true, clinical_config: {} }, { transaction, hooks: false });
      const details = [], models = [], actions = [];
      for (let i = 0; i < 2; i++) {
        const detail = { idCita: String(999991 + i), idContacto: '999990', idEmpresa: '5880', idAgenda: String(999993 + i),
          estado: 0, fechaIni: '2030-01-07', fechaFin: '2030-01-07', horaIni: '10:00:00', horaFin: '11:00:00',
          detalles: 'Synthetic machine', agenda: { nombre: 'SYNTHETIC ' + i }, cita_conceptos: [{ idServicio: '999999', asunto: 'SYNTHETIC' }],
          pagado: '0', idBono: '0', archivada: '0', createdOn: '2026-06-01 16:00:0' + i };
        details.push({ source_appointment_id: detail.idCita, data: detail });
        const row = await db.CitaPaciente.create({ clinica_id: 66, paciente_id: patient.id_paciente, doctor_id: doctor.id_usuario,
          instalacion_id: rooms[i].id, tratamiento_id: treatment.id_tratamiento, titulo: marker, nota: 'Preserve original legacy note',
          tipo_cita: 'continuacion', estado: 'pendiente', inicio: '2030-01-07T09:00:00.000Z', fin: '2030-01-07T10:00:00.000Z',
          es_provisional: 0, source_system: 'cliniccloud', source_reference: 'appointment:' + detail.idCita,
          import_metadata: { raw: detail, raw_extra: { untouched: true }, source_appointment_id: detail.idCita,
            source_contact_id: detail.idContacto, source_service_id: '999999', source_agenda_id: detail.idAgenda },
        }, { transaction, hooks: false });
        await row.reload({ transaction }); models.push(row); ids.push(row.id_cita);
        const provenance = { source_row: i + 2, file_sha256: hash(marker), row_sha256: hash(detail) };
        provenance.row_key = `appointment:${provenance.file_sha256}:${provenance.source_row}:${provenance.row_sha256}`;
        const source = { kind: 'appointment', source_contact_id: detail.idContacto, start_local: '2030-01-07T10:00:00', end_local: '2030-01-07T11:00:00',
          start_utc: localToUtc('2030-01-07T10:00:00'), end_utc: localToUtc('2030-01-07T11:00:00'), agenda_key: detail.agenda.nombre,
          service_key: 'SYNTHETIC', status: 'pendiente', details: detail.detalles, validation_errors: [], provenance };
        actions.push({ entity: 'appointment', action: 'update_imported_candidate', requires_review: true, reasons: [],
          patient_id: patient.id_paciente, local_id: row.id_cita, source, provenance });
      }
      const before = models.map(plain), now = Date.now();
      const receipt = prepareDuplicateVisit({ rows: before, actions,
        detailEvidence: { origin: 'https://app.clinic-cloud.com/agenda_new.php', captured_at: new Date(now - 1000).toISOString(), data: { rows: details } },
        canonicalAppointmentId: models[1].id_cita, sourcePlanSha256: hash('fictional plan'),
        reviewedBy: 'Fictional QA', reason: 'Exact synthetic visit duplicated across two old calendars', now });
      const resources = { doctor_id: doctor.id_usuario, installation_id: rooms[2].id, equipment_ids: [equipment.id], evidence_sha256: hash('synthetic proof') };
      return { before, receipt, resources, now, models, rooms, equipment, patient };
    };
    await run(async transaction => {
      const f = await seed(transaction);
      const result = await consolidateReviewedDuplicate({ db, ...f, transaction,
        beforeUpdate: async ({ before }) => assert.deepEqual(before, f.before) });
      assert.equal(result.rows.length, 2); assert.equal(result.occupancies.length, 3);
      assert.equal(result.rows.find(r => r.id_cita === f.receipt.retired_id).estado, 'cancelada');
      assert.equal(result.rows.find(r => r.id_cita === f.receipt.canonical_id).instalacion_id, f.rooms[2].id);
      assert.equal(duplicateVisitLinks(result.rows).size, 1);
      assert.equal(await db.CitaPaciente.count({ where: { paciente_id: f.patient.id_paciente }, transaction }), 2);
      for (const row of result.rows) {
        const before = f.before.find(r => r.id_cita === row.id_cita);
        assert.deepEqual(row.import_metadata.raw, before.import_metadata.raw); assert.equal(row.nota, before.nota);
        assert.equal(row.inicio, before.inicio); assert.equal(row.fin, before.fin);
      }
      await assert.rejects(consolidateReviewedDuplicate({ db, ...f, transaction, beforeUpdate: async () => {} }), /DUPLICATE_VISIT_REVIEW_REQUIRED/);
      checks.push('One active visit, both source records retained, no insert/delete, room/doctor/mobile machine occupancy atomic; stale replay rejected');
    });
    for (const failure of ['guard', 'room', 'equipment']) await run(async transaction => {
      const f = await seed(transaction);
      if (failure !== 'guard') {
        const other = await db.Paciente.create({ clinica_id: 66, nombre: 'Otro ficticio', apellidos: marker,
          public_id: 'pac_' + randomUUID().replaceAll('-', '').slice(0, 20) }, { transaction, hooks: false });
        const blocking = await db.CitaPaciente.create({ clinica_id: 66, paciente_id: other.id_paciente, titulo: marker,
          instalacion_id: failure === 'room' ? f.rooms[2].id : f.rooms[0].id, doctor_id: null,
          tipo_cita: 'continuacion', estado: 'pendiente', inicio: '2030-01-07T09:00:00.000Z', fin: '2030-01-07T10:00:00.000Z',
        }, { transaction, hooks: false });
        ids.push(blocking.id_cita);
        if (failure === 'equipment') {
          await db.AppointmentBookingResource.create({ resource_key: 'equipment:' + f.equipment.id, resource_kind: 'equipment' }, { transaction });
          await db.AppointmentBookingOccupancy.create({ appointment_id: blocking.id_cita, clinic_id: 66,
            resource_key: 'equipment:' + f.equipment.id, resource_kind: 'equipment', resource_id: f.equipment.id,
            start_at: '2030-01-07T09:00:00.000Z', end_at: '2030-01-07T10:00:00.000Z', phase_index: 0, phase_key: 'appointment',
          }, { transaction });
        }
      }
      const savepoint = await db.sequelize.transaction({ transaction, isolationLevel: 'READ COMMITTED' });
      try {
        await assert.rejects(consolidateReviewedDuplicate({ db, ...f, transaction: savepoint,
          beforeUpdate: async () => { if (failure === 'guard') throw Error('DEPENDENT_HISTORY_FOUND'); } }),
        failure === 'guard' ? /DEPENDENT_HISTORY_FOUND/ : { code: 'booking_unavailable' });
      } finally { await savepoint.rollback(); }
      for (const model of f.models) await model.reload({ transaction });
      assert.deepEqual(f.models.map(plain), f.before);
      assert.equal(await db.AppointmentBookingOccupancy.count({ where: { appointment_id: f.before.map(r => r.id_cita) }, transaction }), 0);
      checks.push(failure + ' conflict rolls back cancellation, reassignment and reservations together');
    });
    assert.equal(await db.Clinica.findByPk(66), null); assert.equal(await db.GrupoClinica.findByPk(29), null);
    assert.equal(await db.CitaPaciente.count({ where: { titulo: marker } }), 0);
    assert.equal(await db.AppointmentBookingOccupancy.count({ where: { appointment_id: ids } }), 0);
    console.log(JSON.stringify({ success: true, checks, rolled_back: true, real_data_writes: 0, messages_sent: 0 }));
  } finally { await db.sequelize.close(); }
}
main().catch(e => { console.error(JSON.stringify({ success: false, code: e.code || e.message, message: e.message,
  location: e.stack?.split('\n').filter(l => l.trim().startsWith('at ')).slice(0, 4) })); process.exitCode = 1; });
