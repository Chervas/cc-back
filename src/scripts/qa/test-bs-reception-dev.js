#!/usr/bin/env node
'use strict';
// Integration smoke for the explicitly fictitious BS workspace, isolated DEV.
// Leaves its synthetic appointments visible for operator/browser testing.
const assert = require('node:assert/strict');
require('dotenv').config({ path: require('node:path').resolve(__dirname, '../../../.env'), quiet: true });
assert.equal(process.env.DB_NAME, 'clinicaclick_dev_isolated');
assert.equal(process.env.DB_USERNAME, 'cc_dev_api');
assert.equal(process.env.QA_BS_RECEPTION_WRITES, 'bs-reception-dev-v1');
const db = require('../../../models');
const q = require('../../lib/patient-intake-questionnaire');
const intake = require('../../services/patientIntake.service');
const care = require('../../services/appointmentCare.service');
const KEY = 'bs-reception-smoke-v1';
async function main() {
  try {
    const clinic = await db.Clinica.findOne({ where: { nombre_clinica: 'BS Medical · DEV' } });
    assert.equal(clinic.configuracion.qa_demo.key, 'bs-reception-dev-v1');
    const clinicId = clinic.id_clinica;
    const treatments = await db.Tratamiento.findAll({ where: { clinica_id: clinicId, activo: true } });
    const treatment = treatments.find(t => t.nombre.startsWith('INDIBA PREMIUM NS') && t.nombre.includes('Corporal'));
    assert(treatment); const phase = treatment.clinical_config.booking_profile.phases[0];
    const appointments = [];
    for (let i = 1; i <= 4; i++) {
      const patient = await db.Paciente.findOne({ where: { public_id: `pac_bs_reception_demo_${i}` } });
      let appointment = await db.CitaPaciente.findOne({ where: { source_system: 'clinicaclick_demo', source_reference: `${KEY}:${i}` } });
      if (!appointment) {
        const start = new Date(`2026-09-28T${String(7 + i).padStart(2, '0')}:00:00Z`);
        await db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
          appointment = await require('../../services/appointmentBookingCommand.service').mutateAppointmentBooking({ db, transaction,
            force: false, capabilities: { simple: true, multi: true, equipment: true },
            appointmentValues: { clinica_id: clinicId, paciente_id: patient.id_paciente, doctor_id: phase.professionals.preferred_id,
              instalacion_id: phase.installation_ids[0], tratamiento_id: treatment.id_tratamiento, inicio: start,
              fin: new Date(+start + phase.duration_minutes * 60000), tipo_cita: 'primera_con_trat', estado: 'pendiente',
              titulo: 'Prueba recepción BS · ficticia', source_system: 'clinicaclick_demo', source_reference: `${KEY}:${i}`,
              created_by: 1, updated_by: 1, import_metadata: { qa_demo: KEY, automation_policy: 'hold', notification_suppression: { appointment_details: true, day_before: true, same_day: true } } },
            persist: ({ values, transaction: tx }) => db.CitaPaciente.create(values, { transaction: tx, hooks: false }),
          });
        });
      }
      appointments.push(appointment?.id_cita || appointment?.appointment?.id_cita);
    }
    assert(appointments.every(Number.isInteger));
    const appointmentId = appointments[3], actorId = 1;
    const [a, b] = await Promise.all([care.record({ appointmentId, clinicId, actorId, action: 'arrive' }), care.record({ appointmentId, clinicId, actorId, action: 'arrive' })]);
    assert(a.care.arrived_at && b.care.arrived_at); assert(a.replayed || b.replayed);
    assert.equal(await db.AppointmentCareEvent.count({ where: { appointment_id: appointmentId, action: 'arrive' } }), 1);
    assert.equal((await db.CitaPaciente.findByPk(appointmentId)).estado, 'pendiente');
    await assert.rejects(care.record({ appointmentId, clinicId: -1, actorId, action: 'start' }), { code: 'appointment_clinic_changed' });
    await assert.rejects(care.record({ appointmentId, clinicId, actorId, action: 'start' }), { code: 'appointment_consent_required' });
    assert.equal((await db.CitaPaciente.findByPk(appointmentId)).care_started_at, null);
    const patient = await db.Paciente.findOne({ where: { public_id: 'pac_bs_reception_demo_4' } });
    const patientId = patient.id_paciente;
    await assert.rejects(intake.prepare({ patientId, clinicId: -1, actorId }), { code: 'intake_patient_scope' });
    const prepared = await Promise.all([intake.prepare({ patientId, clinicId, actorId }), intake.prepare({ patientId, clinicId, actorId })]);
    assert.equal(prepared[0].package_id, prepared[1].package_id);
    const pkg = await db.ConsentSignaturePackage.findByPk(prepared[0].package_id);
    const view = await intake.publicView(pkg);
    const input = { schema_version: q.VERSION, expected_version: view.version, reviewed_answers: true,
      personal: view.personal, answers: { allergies: 'Alergia ficticia declarada', medication: 'Medicación ficticia', pregnancy: 'unknown' } };
    const before = await patient.reload(); const previousAllergies = before.alergias;
    await intake.submit(pkg, input);
    assert.equal((await intake.submit(pkg, input)).replayed, true);
    assert.equal((await patient.reload()).alergias, previousAllergies);
    await assert.rejects(intake.submit(pkg, { ...input, answers: { allergies: 'Cambio tardío' } }), { code: 'intake_already_submitted' });
    const review = await intake.reviewView({ patientId, clinicId });
    const confirmation = { id: review.request.id, expected_version: review.request.version, patient_version: review.patient_version,
      summary: review.proposed, apply_personal_changes: false };
    await assert.rejects(intake.confirm({ patientId, clinicId, actorId, payload: { ...confirmation, patient_version: 'stale' } }), { code: 'intake_patient_changed' });
    await intake.confirm({ patientId, clinicId, actorId, payload: confirmation });
    assert.match((await patient.reload()).alergias, /Alergia ficticia declarada/);
    await assert.rejects(intake.confirm({ patientId, clinicId, actorId, payload: confirmation }), { code: 'intake_review_conflict' });
    assert.equal((await intake.publicView(pkg)).confirmed_summary, undefined);
    console.log(JSON.stringify({ passed: true, clinicId, appointments, checks: ['idempotent arrival', 'canonical state preserved', 'consent gate', 'wrong clinic rejected', 'concurrent prepare reused', 'patient submission immutable', 'no unreviewed history writes', 'optimistic professional review', 'clinical review not returned to patient'] }));
  } finally { await db.sequelize.close(); }
}
main().catch(e => { console.error(JSON.stringify({ code: e.code || e.name, message: e.message, stack: e.stack?.split('\n').slice(0,4) })); process.exitCode = 1; });
