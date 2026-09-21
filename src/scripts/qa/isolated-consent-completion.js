#!/usr/bin/env node
'use strict';
// SQL contract acceptance. All synthetic rows and signatures are rolled back;
// never boot HTTP, queues, providers or operate on a clinical database.
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { MARKER, PATIENT_ID } = require('./prepare-isolated-clinical-fixture');

async function main() {
  assert.equal(process.env.QA_ISOLATED_CLINICAL_WRITES, MARKER);
  require('dotenv').config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });
  assert.equal(process.env.DB_NAME, 'clinicaclick_dev_isolated');
  assert.equal(process.env.DB_USERNAME, 'cc_dev_api');
  const source = path.resolve(process.argv[2] || path.resolve(__dirname, '../../..'));
  assert(source.startsWith('/home/ubuntu/wt/back-'));
  const log = console.log;
  let db;
  try { console.log = () => {}; db = require('../../../models'); } finally { console.log = log; }
  const { mutateAppointmentBooking } = require(path.join(source, 'src/services/appointmentBookingCommand.service'));
  const { assertClinicalCompletion } = require(path.join(source, 'src/services/appointmentConsentEligibility.service'));
  const marker = `qa-consent-${randomUUID()}`;
  const rollback = Error('QA_ALWAYS_ROLL_BACK');
  try {
    assert.equal(db.sequelize.config.database, 'clinicaclick_dev_isolated');
    assert.equal((await db.Clinica.findByPk(1))?.nombre_clinica, 'Clinica ficticia DEV');
    const patient = await db.Paciente.findOne({ where: { public_id: PATIENT_ID, clinica_id: 1 } });
    assert(patient);
    const before = await db.CitaPaciente.count({ where: { clinica_id: 1 } });
    await assert.rejects(db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
      // The visual fixture can acquire real test requirements over time. Keep
      // this rolled-back SQL test independent of those persistent QA settings.
      const treatment = await db.Tratamiento.create({ nombre: 'Tratamiento ficticio — rollback',
        codigo: marker, disciplina: 'estetica', clinica_id: 1, duracion_min: 30,
        precio_base: 0 }, { transaction });
      const template = await db.ClinicConsentTemplate.create({ public_id: marker, clinic_id: 1,
        name: 'Consentimiento ficticio QA — rollback', purpose: 'clinical', status: 'active', validity_mode: 'single_act' }, { transaction });
      await db.TreatmentConsentRequirement.create({ clinica_id: 1, tratamiento_id: treatment.id_tratamiento,
        clinic_template_id: template.id, required: true, blocking_policy: 'hard' }, { transaction });
      const appointment = await db.CitaPaciente.create({ clinica_id: 1, paciente_id: patient.id_paciente,
        tratamiento_id: treatment.id_tratamiento, inicio: '2026-10-27T10:00:00Z', fin: '2026-10-27T10:30:00Z',
        estado: 'pendiente', source_system: 'qa_rollback', source_reference: marker }, { transaction });
      let writes = 0;
      const complete = () => mutateAppointmentBooking({ db, existingAppointmentId: appointment.id_cita,
        appointmentValues: { estado: 'completada' }, stateOnly: true, transaction,
        capabilities: { simple: true, multi: true }, force: true,
        persist: ({ existing, values, transaction: tx }) => { writes++; return existing.update(values, { transaction: tx }); } });
      await assert.rejects(complete(), { code: 'appointment_consent_required' });
      assert.equal(writes, 0);
      assert.equal((await appointment.reload({ transaction })).estado, 'pendiente');
      const doc = await db.PatientConsentDocument.create({ public_id: marker, paciente_id: patient.id_paciente,
        clinica_id: 1, tratamiento_id: treatment.id_tratamiento, cita_id: appointment.id_cita, clinic_template_id: template.id,
        purpose: 'clinical', status: 'pending', title: 'Evidencia sintética SQL, no firma clínica' }, { transaction });
      await assert.rejects(complete(), { code: 'appointment_consent_required' });
      // Synthetic database evidence only; does not stand in for tablet UX QA.
      await doc.update({ status: 'signed', signed_at: new Date(Date.now() - 1000) }, { transaction });
      await assertClinicalCompletion({ db, previous: appointment, appointment: { ...appointment.toJSON(), estado: 'completada' }, transaction });
      await complete();
      assert.equal(writes, 1);
      assert.equal((await appointment.reload({ transaction })).estado, 'completada');
      await doc.update({ revoked_at: new Date() }, { transaction });
      await assert.rejects(assertClinicalCompletion({ db, appointment, transaction }), { code: 'appointment_consent_required' });
      throw rollback;
    }), error => error === rollback);
    assert.equal(await db.CitaPaciente.count({ where: { clinica_id: 1 } }), before);
    assert.equal(await db.ClinicConsentTemplate.count({ where: { public_id: marker } }), 0);
    assert.equal(await db.PatientConsentDocument.count({ where: { public_id: marker } }), 0);
    log(JSON.stringify({ status: 'passed', database: 'isolated-dev-only', source,
      checks: ['joined-requirement-share-lock', 'missing-blocks-without-writes', 'pending-blocks', 'signed-permits', 'revoked-blocks', 'full-rollback'], persistedRows: 0 }));
  } finally { await db.sequelize.close(); }
}
main().catch(error => { console.error('ISOLATED_CONSENT_COMPLETION_FAILED', error.code || error.name,
  error.name === 'AssertionError' ? error.message : 'Revisar contrato SQL aislado.'); process.exitCode = 1; });
