#!/usr/bin/env node
'use strict';
// No public DB, runtime changes, jobs, signatures or outbound messages. All
// synthetic writes roll back in finally, including unexpected test failures.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { MARKER, PATIENT_ID } = require('./prepare-isolated-clinical-fixture');
async function main() {
  assert.equal(process.env.QA_ISOLATED_CLINICAL_WRITES, MARKER);
  require('dotenv').config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });
  assert.equal(process.env.DB_NAME, 'clinicaclick_dev_isolated');
  assert.equal(process.env.DB_USERNAME, 'cc_dev_api');
  let db; const log = console.log;
  try { console.log = () => {}; db = require('../../../models'); } finally { console.log = log; }
  const { resolveImportedTreatment } = require('../../services/appointmentImportResolution.service');
  const { importReviewVersion, importTreatmentPending, hasReviewedImportResources, appointmentImportReview } = require('../../lib/appointment-import-review');
  const { assessAppointmentClinicalConsent } = require('../../services/appointmentConsentEligibility.service');
  const capabilities = { simple: true, multi: true }, marker = `qa-import-${randomUUID()}`, checks = [], ids = [];
  const run = async callback => {
    const transaction = await db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' });
    try { await callback(transaction); } finally { if (!transaction.finished) await transaction.rollback(); }
  };
  try {
    assert.equal(db.sequelize.config.database, 'clinicaclick_dev_isolated');
    assert.equal(db.sequelize.config.username, 'cc_dev_api');
    assert.equal((await db.Clinica.findByPk(1)).nombre_clinica, 'Clinica ficticia DEV');
    const patient = await db.Paciente.findOne({ where: { public_id: PATIENT_ID, clinica_id: 1 } });
    const staff = await db.Usuario.findAll({ where: { notas_usuario: MARKER }, order: [['id_usuario', 'ASC']] });
    const rooms = await db.Instalacion.findAll({ where: { clinica_id: 1, descripcion: MARKER }, order: [['id', 'ASC']] });
    assert(patient && staff.length >= 2 && rooms.length >= 2);
    const make = async (transaction, duration = 30) => {
      const row = await db.CitaPaciente.create({ clinica_id: 1, paciente_id: patient.id_paciente,
        doctor_id: staff[0].id_usuario, instalacion_id: rooms[0].id, tratamiento_id: null,
        inicio: '2030-01-07T10:00:00Z', fin: duration === 30 ? '2030-01-07T10:30:00Z' : '2030-01-07T10:15:00Z',
        estado: 'pendiente', tipo_cita: 'continuacion', source_system: 'cliniccloud', source_reference: marker,
        nota: 'Only synthetic import evidence', import_metadata: {
          notification_suppression: { appointment_details: true, day_before: true, same_day: true },
          cliniccloud_delta: { pending_assignment: ['treatment_id'], source: { service_key: 'Synthetic' } },
          cliniccloud_reconciliation: { automation_policy: 'hold' } } }, { transaction });
      ids.push(row.id_cita); await row.reload({ transaction }); return row;
    };
    const treatment = transaction => db.Tratamiento.create({ nombre: marker, disciplina: 'estetica', activo: true,
      clinica_id: 1, origen: 'clinica', duracion_min: 30, precio_base: 0, clinical_config: {
        catalog_status: 'active', booking_profile: { version: 1, phases: [{ key: 'care', label: 'Synthetic',
          duration_minutes: 30, installation_ids: [rooms[0].id],
          professionals: { mode: 'any', ids: [staff[0].id_usuario], preferred_id: staff[0].id_usuario } }] } } }, { transaction });
    await run(async transaction => {
      const row = await make(transaction), before = row.toJSON(), catalog = await treatment(transaction);
      const input = { mode: 'treatment', treatment_id: catalog.id_tratamiento,
        expected_version: importReviewVersion(before), reason: 'Synthetic verified treatment' };
      const args = { db, appointmentId: row.id_cita, clinicId: 1, actorId: 1, input, capabilities, transaction };
      await resolveImportedTreatment(args);
      await row.reload({ transaction });
      assert.equal(row.tratamiento_id, catalog.id_tratamiento);
      for (const field of ['paciente_id', 'clinica_id', 'inicio', 'fin', 'estado', 'nota', 'source_reference']) assert.deepEqual(row[field], before[field]);
      assert.deepEqual(row.import_metadata.notification_suppression, before.import_metadata.notification_suppression);
      assert.deepEqual(row.import_metadata.cliniccloud_delta, before.import_metadata.cliniccloud_delta);
      const occupancy = await db.AppointmentBookingOccupancy.findAll({ where: { appointment_id: row.id_cita }, transaction });
      assert.equal(occupancy.length, 2); assert(occupancy.some(r => r.doctor_id === staff[0].id_usuario));
      assert(occupancy.some(r => r.installation_id === rooms[0].id));
      assert.equal((await resolveImportedTreatment(args)).replayed, true);
      const events = await db.PatientOperationalEvent.findAll({ where: { patient_id: patient.id_paciente, event_type: 'appointment.import_resolved' }, transaction });
      assert.equal(events.filter(e => e.metadata.appointment_id === row.id_cita).length, 1);
      checks.push('Catalog treatment, canonical occupancy and one operational event are atomic; retries preserve the import HOLD');
    });
    await run(async transaction => {
      const row = await make(transaction), before = row.toJSON();
      await assert.rejects(assessAppointmentClinicalConsent({ db, appointment: before, transaction }), { code: 'appointment_consent_import_review_required' });
      await resolveImportedTreatment({ db, appointmentId: row.id_cita, clinicId: 1, actorId: 1, capabilities, transaction,
        input: { mode: 'no_treatment', visit_type: 'revision', reason: 'Only a synthetic review', expected_version: importReviewVersion(before) } });
      await row.reload({ transaction });
      assert.equal(row.tratamiento_id, null); assert.equal(row.tipo_cita, 'revision');
      assert.equal(importTreatmentPending(row.toJSON()), false);
      assert.equal((await assessAppointmentClinicalConsent({ db, appointment: row, transaction })).allowed, true);
      checks.push('An unresolved import cannot complete care; an explicit no-treatment review can');
    });
    await run(async transaction => {
      const row = await make(transaction, 15), before = row.toJSON(), catalog = await treatment(transaction);
      await assert.rejects(resolveImportedTreatment({ db, appointmentId: row.id_cita, clinicId: 1, actorId: 1,
        capabilities, transaction, input: { mode: 'treatment', treatment_id: catalog.id_tratamiento,
          reason: 'Synthetic duration conflict', expected_version: importReviewVersion(before) } }), { code: 'booking_unavailable' });
      await row.reload({ transaction }); assert.deepEqual(row.toJSON(), before);
      assert.equal(await db.AppointmentBookingOccupancy.count({ where: { appointment_id: row.id_cita }, transaction }), 0);
      checks.push('A mismatched treatment duration is rejected without stretching or moving the appointment');
    });
    await run(async transaction => {
      const row=await make(transaction), before=row.toJSON();
      const args={db,appointmentId:row.id_cita,clinicId:1,actorId:1,capabilities,transaction,
        input:{mode:'resources',reason:'Synthetic room and professional checked',expected_version:importReviewVersion(before)}};
      await resolveImportedTreatment(args); await row.reload({transaction});
      assert.equal(hasReviewedImportResources(row.toJSON()),true);
      assert.deepEqual(appointmentImportReview(row.toJSON()).pending_assignment,['treatment']);
      for(const key of Object.keys(before).filter(k=>!['updated_by','updated_at','import_metadata'].includes(k)))
        assert.deepEqual(row[key],before[key]);
      for(const key of Object.keys(before.import_metadata)) assert.deepEqual(row.import_metadata[key],before.import_metadata[key]);
      assert.equal(await db.AppointmentBookingOccupancy.count({where:{appointment_id:row.id_cita},transaction}),2);
      assert.equal((await resolveImportedTreatment(args)).replayed,true);
      const events=await db.PatientOperationalEvent.findAll({where:{patient_id:patient.id_paciente,event_type:'appointment.import_resolved'},transaction});
      assert.equal(events.filter(e=>e.metadata.appointment_id===row.id_cita && e.metadata.mode==='resources').length,1);
      await row.update({nota:'Edited note only'},{transaction});
      assert.equal(hasReviewedImportResources(row.toJSON()),true);
      checks.push('Explicit resource confirmation writes canonical occupancy, preserves source/HOLD and emits once; note edits keep approval');
    });
    await run(async transaction => {
      const row=await make(transaction), catalog=await treatment(transaction);
      await catalog.update({clinical_config:{catalog_status:'active',booking_profile:{version:1,phases:[
        {key:'first',label:'Synthetic first room',duration_minutes:15,installation_ids:[rooms[0].id],professionals:{mode:'any',ids:[staff[0].id_usuario],preferred_id:staff[0].id_usuario}},
        {key:'second',label:'Synthetic second room',duration_minutes:15,installation_ids:[rooms[1].id],professionals:{mode:'any',ids:[staff[0].id_usuario],preferred_id:staff[0].id_usuario}},
      ]}}},{transaction});
      await resolveImportedTreatment({db,appointmentId:row.id_cita,clinicId:1,actorId:1,capabilities,transaction,
        input:{mode:'treatment',treatment_id:catalog.id_tratamiento,reason:'Synthetic two-phase treatment',expected_version:importReviewVersion(row.toJSON())}});
      await row.reload({transaction}); const before=row.toJSON();
      await resolveImportedTreatment({db,appointmentId:row.id_cita,clinicId:1,actorId:1,capabilities,transaction,
        input:{mode:'resources',reason:'Both synthetic phases checked',expected_version:importReviewVersion(before)}});
      await row.reload({transaction});
      assert.deepEqual(row.import_metadata.booking.phases,before.import_metadata.booking.phases);
      assert.equal(hasReviewedImportResources(row.toJSON()),true);
      const occupancy=await db.AppointmentBookingOccupancy.findAll({where:{appointment_id:row.id_cita},transaction});
      assert(occupancy.some(o=>o.installation_id===rooms[0].id)); assert(occupancy.some(o=>o.installation_id===rooms[1].id));
      checks.push('Explicit review of an existing two-phase reservation preserves both cabin/time segments and their occupancy');
    });
    await run(async transaction => {
      const row=await make(transaction), before=row.toJSON();
      await db.Instalacion.update({activo:false},{where:{id:rooms[0].id},transaction});
      await assert.rejects(resolveImportedTreatment({db,appointmentId:row.id_cita,clinicId:1,actorId:1,capabilities,transaction,
        input:{mode:'resources',reason:'Cannot approve inactive room',expected_version:importReviewVersion(before)}}));
      await row.reload({transaction}); assert.deepEqual(row.toJSON(),before);
      assert.equal(await db.AppointmentBookingOccupancy.count({where:{appointment_id:row.id_cita},transaction}),0);
      checks.push('An inactive cabin cannot be approved; all synthetic room and appointment changes roll back');
    });
    await run(async transaction => {
      const row=await make(transaction), before=row.toJSON();
      const conflict=await db.CitaPaciente.create({clinica_id:1,paciente_id:patient.id_paciente,doctor_id:staff[0].id_usuario,
        instalacion_id:rooms[0].id,inicio:before.inicio,fin:before.fin,estado:'pendiente',tipo_cita:'revision',source_reference:marker},{transaction});
      ids.push(conflict.id_cita);
      await assert.rejects(resolveImportedTreatment({db,appointmentId:row.id_cita,clinicId:1,actorId:1,capabilities,transaction,
        input:{mode:'resources',reason:'Cannot force a conflict',expected_version:importReviewVersion(before),force:true}}),{code:'booking_unavailable'});
      await row.reload({transaction}); assert.deepEqual(row.toJSON(),before);
      checks.push('A real SQL overlap is rejected even if a forged force flag is submitted');
    });
    // A real report writer must wait for the appointment lock before choosing
    // its treatment snapshot. The uncommitted synthetic appointment disappears
    // on rollback, so even a broken writer can never leave a report behind.
    const held = await db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' });
    let pendingReport;
    try {
      const row = await make(held);
      let settled = false;
      pendingReport = require('../../services/appointmentClinicalReports.service').save({ appointmentId: row.id_cita,
        actorId: 1, payload: {} }).then(() => { settled = true; return null; }, error => { settled = true; return error; });
      await new Promise(resolve => setTimeout(resolve, 200));
      assert.equal(settled, false, 'Report writer did not wait for the appointment row');
      await held.rollback();
      assert.equal((await pendingReport)?.code, 'appointment_not_found');
      checks.push('The real clinical report writer waits on the appointment lock before reading its treatment');
    } finally { if (!held.finished) await held.rollback(); if (pendingReport) await pendingReport; }
    assert.equal(await db.CitaPaciente.count({ where: { source_reference: marker } }), 0);
    assert.equal(await db.Tratamiento.count({ where: { nombre: marker } }), 0);
    assert.equal(await db.AppointmentBookingOccupancy.count({ where: { appointment_id: ids } }), 0);
    const events = await db.PatientOperationalEvent.findAll({ where: { patient_id: patient.id_paciente, event_type: 'appointment.import_resolved' }, raw: true });
    assert(!events.some(e => ids.includes(e.metadata?.appointment_id)));
    console.log(JSON.stringify({ ok: true, database: 'isolated_dev', real_sql: true, checks,
      committed_mutations: 0, public_database_touched: false }));
  } finally { await db.sequelize.close(); }
}
main().catch(error => { console.error('ISOLATED_IMPORT_QA_FAILED', error.code || error.message); process.exitCode = 1; });
