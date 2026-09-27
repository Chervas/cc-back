#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const { KEY, CLINIC_NAME, buildPlan, assertEnvironment, seed } = require('./prepare-dev-clinical-workspace');
const object = value => typeof value === 'string' ? JSON.parse(value) : value;

async function main(monday) {
  const plan = buildPlan(monday);
  require('dotenv').config({ path: require('node:path').resolve(__dirname, '../../../.env'), quiet: true });
  assertEnvironment(process.env);
  let db; const log = console.log;
  try { console.log = () => {}; db = require('../../../models'); } finally { console.log = log; }
  let tx;
  try {
    assert.equal(db.sequelize.config.database, 'clinicaclick_dev_isolated');
    assert.equal(db.sequelize.config.username, 'cc_dev_api');
    const clinic = await db.Clinica.findOne({ where: { nombre_clinica: CLINIC_NAME } });
    assert.equal(object(clinic.configuracion)?.qa_demo?.key, KEY);
    const clinicId = clinic.id_clinica;
    assert.equal(await db.Paciente.count({ where: { clinica_id: clinicId } }), 24);
    assert.equal(await db.Tratamiento.count({ where: { clinica_id: clinicId } }), 6);
    const service = require('../../services/medicalAreaContracts.service').createMedicalAreaContractsService(db);
    const contracts = await service.getMedicalAreaContracts({ clinicId });
    assert.equal(contracts.configuration_scope, 'clinic');
    for (const contract of Object.values(contracts.contracts)) assert(contract.revision.id > 0);
    const checks = ['24 fictitious patients and six individual treatments', 'clinic uses pinned area revisions'];
    let occupied = 0;
    for (const row of plan.appointments) {
      const appointment = await db.CitaPaciente.findOne({ where: { source_system: row.source_system, source_reference: row.source_reference } });
      assert(appointment); assert.equal(appointment.clinica_id, clinicId);
      assert.equal(appointment.inicio.toISOString(), new Date(row.inicio).toISOString());
      assert.equal(appointment.fin.toISOString(), new Date(row.fin).toISOString());
      assert.equal(appointment.estado, row.estado);
      const patient = await db.Paciente.findByPk(appointment.paciente_id);
      assert.equal(patient.public_id, plan.patients[row.patientIndex].public_id);
      for (const key of ['email', 'telefono_movil', 'telefono_secundario', 'dni']) assert.equal(patient[key], null);
      const metadata = object(appointment.import_metadata);
      assert.equal(metadata.qa_demo, KEY); assert.equal(metadata.automation_policy, 'hold');
      assert.deepEqual(metadata.notification_suppression, row.import_metadata.notification_suppression);
      assert.equal(metadata.booking.phases.length, 1);
      const rows = await db.AppointmentBookingOccupancy.findAll({ where: { appointment_id: appointment.id_cita }, raw: true });
      assert.equal(rows.length, 2);
      const doctor = rows.find(r => r.resource_kind === 'doctor'), room = rows.find(r => r.resource_kind === 'installation');
      assert.equal(doctor.doctor_id, appointment.doctor_id); assert.equal(room.installation_id, appointment.instalacion_id);
      for (const resource of rows) {
        assert.equal(resource.start_at.toISOString(), appointment.inicio.toISOString());
        assert.equal(resource.end_at.toISOString(), appointment.fin.toISOString());
      }
      occupied += rows.length;
    }
    checks.push('48 appointments match their synthetic patients and dates; 96 canonical occupancies; all HOLD');
    const patient = await db.Paciente.findOne({ where: { public_id: plan.patients[0].public_id } });
    const owner = await db.UsuarioClinica.findOne({ where: { id_usuario: 1, id_clinica: clinicId } });
    const membership = await db.DoctorClinica.findOne({ where: { clinica_id: clinicId } });
    const before = { patient: patient.toJSON(), membership: membership.toJSON(), owner: owner.toJSON() };
    // Prove replay preserves user changes and cannot reinstate revoked access.
    // All edits below are restricted to this marker and always rolled back.
    tx = await db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' });
    await patient.update({ nombre: 'DEMO · nombre editado durante ensayo' }, { transaction: tx, hooks: false });
    await membership.update({ recibe_citas: false }, { transaction: tx, hooks: false });
    const forbid = () => { throw Error('REPLAY_MUST_NOT_BOOK_OR_REPIN'); };
    const replay = await seed({ db, plan, transaction: tx, book: forbid, initializeClinic: forbid });
    assert.deepEqual(replay.created, {}); assert.equal(replay.preserved.CitaPaciente, 48);
    assert.equal((await db.Paciente.findByPk(patient.id_paciente, { transaction: tx })).nombre, patient.nombre);
    assert.equal((await db.DoctorClinica.findByPk(membership.id, { transaction: tx })).recibe_citas, false);
    checks.push('replay preserves edited names and disabled booking staff, with zero new writes');
    await db.UsuarioClinica.destroy({ where: { id_usuario: 1, id_clinica: clinicId }, transaction: tx, hooks: false });
    await assert.rejects(seed({ db, plan, transaction: tx, book: forbid, initializeClinic: forbid }), /changed or removed/);
    assert.equal(await db.UsuarioClinica.count({ where: { id_usuario: 1, id_clinica: clinicId }, transaction: tx }), 0);
    checks.push('replay refuses to recreate revoked owner access');
    await tx.rollback(); tx = null;
    await patient.reload(); await membership.reload(); await owner.reload();
    assert.deepEqual(patient.toJSON(), before.patient); assert.deepEqual(membership.toJSON(), before.membership);
    assert.deepEqual(owner.toJSON(), before.owner);
    checks.push('all verification mutations rolled back and independently reread');
    console.log(JSON.stringify({ synthetic_only: true, clinicId, occupied, checks, committed_verification_mutations: 0 }));
  } finally {
    if (tx && !tx.finished) await tx.rollback();
    await db.sequelize.close();
  }
}
if (require.main === module) main(process.argv[2]).catch(error => {
  console.error(JSON.stringify({ error: error.code || error.name, message: error.message })); process.exitCode = 1;
});
