#!/usr/bin/env node
'use strict';

// Own short-lived synthetic fixtures in DEV only. No providers, signatures,
// delivery or jobs. Exact-ID cleanup runs even if an assertion fails.
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const path = require('node:path');
const { MARKER, PATIENT_ID } = require('./prepare-isolated-clinical-fixture');
const digest = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');

async function main() {
  assert.equal(process.env.QA_ISOLATED_CLINICAL_WRITES, MARKER);
  require('dotenv').config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });
  assert.equal(process.env.DB_NAME, 'clinicaclick_dev_isolated');
  assert.equal(process.env.DB_USERNAME, 'cc_dev_api');
  let db;
  const log = console.log;
  try { console.log = () => {}; db = require('../../../models'); } finally { console.log = log; }
  const marker = `qa-ca-${randomUUID()}`, checks = [], templates = [], appointments = [];
  let treatment, patient, patientHash, held, writers = [], timer, completed = false;
  const hook = 'isolated-consent-package-atomic';
  try {
    assert.equal(db.sequelize.config.database, 'clinicaclick_dev_isolated');
    assert.equal((await db.Clinica.findByPk(1)).nombre_clinica, 'Clinica ficticia DEV');
    patient = await db.Paciente.findOne({ where: { public_id: PATIENT_ID, clinica_id: 1 } });
    assert(patient); patientHash = digest(patient.toJSON());
    await db.sequelize.transaction(async transaction => {
      treatment = await db.Tratamiento.create({ nombre: 'Solo QA temporal — no usar', codigo: marker,
        clinica_id: 1, origen: 'clinica', disciplina: 'estetica', activo: false, precio_base: 0 }, { transaction });
      for (const index of [1, 2]) {
        const template = await db.ClinicConsentTemplate.create({ public_id: `${marker}-${index}`, clinic_id: 1,
          name: `Documento ficticio temporal ${index}`, status: 'active', purpose: 'clinical', validity_mode: 'single_act' }, { transaction });
        templates.push(template);
        await db.ClinicConsentTemplateVersion.create({ clinic_template_id: template.id, version: 1, locale: 'es',
          title: 'Documento ficticio, no consentimiento clínico', body_html: '<p>Solo prueba técnica temporal.</p>', status: 'published' }, { transaction });
        await db.TreatmentConsentRequirement.create({ tratamiento_id: treatment.id_tratamiento, clinica_id: 1,
          clinic_template_id: template.id, required: true, blocking_policy: 'hard', sort_order: index }, { transaction });
        appointments.push(await db.CitaPaciente.create({ paciente_id: patient.id_paciente, clinica_id: 1,
          tratamiento_id: treatment.id_tratamiento, inicio: '2030-01-07T10:00:00Z', fin: '2030-01-07T10:30:00Z',
          estado: 'pendiente', tipo_cita: 'continuacion', source_system: 'qa_isolated', source_reference: `${marker}-${index}`,
          import_metadata: { notification_suppression: { appointment_details: true, day_before: true, same_day: true },
            cliniccloud_reconciliation: { automation_policy: 'hold' } } }, { transaction }));
      }
    });
    const { createPackageForAppointment } = require('../../services/consentimientos.service');
    const prepare = index => createPackageForAppointment(appointments[index].id_cita, { createdBy: 1, triggerSource: marker });
    const appointmentHash = digest((await appointments[0].reload()).toJSON());
    held = await db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' });
    await db.CitaPaciente.findByPk(appointments[0].id_cita, { transaction: held, lock: held.LOCK.UPDATE });
    const transactions = new Set(); let reached;
    const bothWaiting = new Promise(resolve => { reached = resolve; });
    db.sequelize.addHook('beforeQuery', hook, options => {
      if (options.model === db.CitaPaciente && options.type === 'SELECT' && options.lock === 'UPDATE'
        && options.transaction && options.transaction !== held) {
        transactions.add(options.transaction.id); if (transactions.size === 2) reached();
      }
    });
    writers = [prepare(0), prepare(0)].map(promise => promise.then(value => ({ value }), error => ({ error })));
    const first = await Promise.race([bothWaiting.then(() => 'both_waiting'),
      Promise.race(writers).then(() => 'settled_early'),
      new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), 10000); })]);
    clearTimeout(timer); assert.equal(first, 'both_waiting');
    await held.rollback();
    const results = await Promise.all(writers);
    for (const result of results) if (result.error) throw result.error;
    assert.equal(results[0].value.id, results[1].value.id);
    assert.equal(await db.ConsentSignaturePackage.count({ where: { cita_id: appointments[0].id_cita } }), 1);
    assert.equal(await db.PatientConsentDocument.count({ where: { cita_id: appointments[0].id_cita } }), 2);
    checks.push('Two real concurrent preparations wait on the same appointment and produce one package with two documents');
    db.sequelize.removeHook('beforeQuery', hook);
    db.PatientConsentDocument.addHook('beforeCreate', hook, row => {
      if (row.cita_id === appointments[1].id_cita && row.clinic_template_id === templates[1].id) throw Error('synthetic_second_document_failure');
    });
    await assert.rejects(prepare(1), /synthetic_second_document_failure/);
    db.PatientConsentDocument.removeHook('beforeCreate', hook);
    assert.equal(await db.ConsentSignaturePackage.count({ where: { cita_id: appointments[1].id_cita } }), 0);
    assert.equal(await db.PatientConsentDocument.count({ where: { cita_id: appointments[1].id_cita } }), 0);
    checks.push('A failure on the second SQL document rolls back the package and the first document');
    const documents = await db.PatientConsentDocument.findAll({ where: { cita_id: appointments[0].id_cita }, order: [['id', 'ASC']] });
    const originalHashes = documents.map(row => row.snapshot_hash);
    // Synthetic state transitions only, not evidence of a legal/tablet signature.
    for (const document of documents) await document.update({ status: 'signed', signed_at: new Date() });
    const signed = await prepare(0);
    assert.equal(signed.documents.length, 2); assert.equal(signed.status, 'signed');
    assert.deepEqual(signed.documents.sort((a, b) => a.id - b.id).map(row => row.snapshot_hash), originalHashes);
    await documents[0].update({ status: 'revoked', revoked_at: new Date() });
    const revokedHash = digest((await documents[0].reload()).toJSON());
    await prepare(0); const repeated = await prepare(0);
    assert.equal(repeated.documents.length, 3); assert.equal(repeated.required_count, 2);
    assert.equal(digest((await documents[0].reload()).toJSON()), revokedHash);
    assert.equal(digest((await appointments[0].reload()).toJSON()), appointmentHash);
    checks.push('Re-preparation preserves signed snapshots; a revoked attempt gets one replacement without duplicating the obligation or changing the appointment/HOLD');
    completed = true;
  } finally {
    clearTimeout(timer);
    if (held && !held.finished) await held.rollback();
    await Promise.all(writers);
    db.sequelize.removeHook('beforeQuery', hook);
    db.PatientConsentDocument.removeHook('beforeCreate', hook);
    try {
      const ids = appointments.map(row => row.id_cita);
      if (ids.length || treatment) await db.sequelize.transaction(async transaction => {
        for (const appointment of appointments) {
          const row = await db.CitaPaciente.findByPk(appointment.id_cita, { transaction, lock: transaction.LOCK.UPDATE });
          if (row) assert.equal(row.source_reference, appointment.source_reference);
        }
        if (ids.length) {
          const packages = await db.ConsentSignaturePackage.findAll({ where: { cita_id: ids }, transaction });
          assert.equal(await db.ConsentDeliveryEvent.count({ where: { package_id: packages.map(row => row.id) }, transaction }), 0);
          await db.PatientConsentDocument.destroy({ where: { cita_id: ids }, transaction });
          await db.ConsentSignaturePackage.destroy({ where: { cita_id: ids }, transaction });
          await db.CitaPaciente.destroy({ where: { id_cita: ids, source_reference: appointments.map(row => row.source_reference) }, transaction });
        }
        if (treatment) await db.TreatmentConsentRequirement.destroy({ where: { tratamiento_id: treatment.id_tratamiento }, transaction });
        for (const template of templates) {
          await db.ClinicConsentTemplateVersion.destroy({ where: { clinic_template_id: template.id }, transaction });
          await db.ClinicConsentTemplate.destroy({ where: { id: template.id, public_id: template.public_id }, transaction });
        }
        if (treatment) await db.Tratamiento.destroy({ where: { id_tratamiento: treatment.id_tratamiento, codigo: marker }, transaction });
      });
      if (patient) assert.equal(digest((await patient.reload()).toJSON()), patientHash);
      if (ids.length) {
        assert.equal(await db.CitaPaciente.count({ where: { id_cita: ids } }), 0);
        assert.equal(await db.PatientConsentDocument.count({ where: { cita_id: ids } }), 0);
        assert.equal(await db.ConsentSignaturePackage.count({ where: { cita_id: ids } }), 0);
      }
      if (completed) log(JSON.stringify({ ok: true, database: 'isolated_dev', real_sql: true, checks,
        synthetic_fixtures_removed: true, patient_unchanged: true, public_database_touched: false, signatures_or_messages: 0 }));
    } finally { await db.sequelize.close(); }
  }
}
main().catch(error => { console.error('ISOLATED_CONSENT_ATOMIC_FAILED', error.name, error.code, error.message,
  error.errors?.map(item => ({ path: item.path, message: item.message })),
  error.stack?.split('\n').find(line => line.includes('isolated-consent-package-atomic.js:'))); process.exitCode = 1; });
