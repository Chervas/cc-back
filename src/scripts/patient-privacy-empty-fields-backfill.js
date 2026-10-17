#!/usr/bin/env node
'use strict';

// Explicit, bounded operator for previously completed LOPDs. Uses the same
// collision checks, immutable-source verification and audit as native signing.
// It never creates a document, grants an opt-in, starts a worker or sends.
const { createHash } = require('node:crypto');
const path = require('node:path');
const profile = require('../services/patientPrivacyProfile.service');
const VERSION = 'patient-privacy-empty-fields-backfill/v1';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value instanceof Date ? value.toISOString()
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const plain = value => value?.toJSON ? value.toJSON() : value;
const fail = code => { throw Object.assign(new Error(code), { code }); };

async function buildPlan({ db, clinicIds = [66, 72], target = 'owned-test' }) {
  if (!Array.isArray(clinicIds) || !clinicIds.length || clinicIds.length > 20
    || clinicIds.some(id => !Number.isSafeInteger(id) || id < 1)) fail('PRIVACY_BACKFILL_CLINIC_SCOPE_REQUIRED');
  const entries = await db.sequelize.transaction({ readOnly: true, isolationLevel: 'REPEATABLE READ' }, async transaction => {
    const documents = (await db.PatientConsentDocument.findAll({ where: { clinica_id: { [db.Sequelize.Op.in]: clinicIds },
      purpose: 'data_protection', status: 'signed', revoked_at: null },
    order: [['signed_at', 'DESC'], ['id', 'DESC']], limit: 5001, transaction })).map(plain);
    if (documents.length > 5000) fail('PRIVACY_BACKFILL_SCOPE_TOO_LARGE');
    const seen = new Set(), result = [];
    for (const doc of documents) {
      const key = Number(doc.paciente_id);
      if (seen.has(key)) continue;
      const review = await profile.view({ db, patientId: Number(doc.paciente_id), clinicId: Number(doc.clinica_id), transaction });
      if (!review.available || review.document?.id !== Number(doc.id)) continue;
      seen.add(key);
      const fields = profile.emptyCandidates(review).map(field => field.key);
      if (!fields.length) continue;
      result.push({ patient_id: Number(doc.paciente_id), clinic_id: Number(doc.clinica_id), document_id: Number(doc.id),
        snapshot_hash: review.document.snapshot_hash, document_digest: digest(doc),
        patient_version: review.patient_version, fields });
    }
    return result.sort((a, b) => a.patient_id - b.patient_id || a.clinic_id - b.clinic_id);
  });
  const body = { version: VERSION, target, clinic_ids: [...clinicIds].sort((a, b) => a - b),
    generated_at: new Date().toISOString(), entries, policy: { only_empty_fields: true, contact_collision_checks: true,
      signed_documents_unchanged: true, no_messages: true, no_opt_in_grants: true } };
  return { ...body, sha256: digest(body) };
}

async function applyPlan({ db, plan, target = 'owned-test', dryRun = true, backup = null }) {
  const { sha256, ...body } = plan || {};
  if (body.version !== VERSION || body.target !== target || sha256 !== digest(body)
    || !Array.isArray(body.entries) || body.entries.length > 5000
    || body.entries.some(entry => !body.clinic_ids.includes(entry.clinic_id))) fail('PRIVACY_BACKFILL_PLAN_INVALID');
  if (!Number.isFinite(Date.parse(body.generated_at)) || Date.parse(body.generated_at) > Date.now()
    || Date.now() - Date.parse(body.generated_at) > 2 * 60 * 60 * 1000) fail('PRIVACY_BACKFILL_PLAN_EXPIRED');
  const receipt = { version: VERSION, plan_sha256: sha256, target, dry_run: dryRun,
    applied_patients: 0, applied_fields: 0, already_complete: 0, skipped_fields: [], no_messages: true };
  const rolledBack = Symbol('owned backfill rollback');
  try {
    await db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
      const docs = [];
      for (const entry of body.entries) {
        const doc = plain(await db.PatientConsentDocument.findByPk(entry.document_id, { transaction }));
        if (!doc || Number(doc.paciente_id) !== entry.patient_id || Number(doc.clinica_id) !== entry.clinic_id
          || digest(doc) !== entry.document_digest) fail('PRIVACY_BACKFILL_SOURCE_CHANGED');
        docs.push(doc);
      }
      await profile.lockAutofillAnchors({ db, documents: docs, transaction });
      const before = [];
      for (const entry of body.entries) {
        const patient = plain(await db.Paciente.findByPk(entry.patient_id, { transaction, lock: transaction.LOCK.UPDATE }));
        const review = await profile.view({ db, patientId: entry.patient_id, clinicId: entry.clinic_id, transaction });
        const fields = profile.emptyCandidates(review).map(field => field.key);
        if (!review.available || review.document.id !== entry.document_id || review.document.snapshot_hash !== entry.snapshot_hash) fail('PRIVACY_BACKFILL_SOURCE_CHANGED');
        // A replay does nothing. Any new/different still-empty set must be
        // replanned, not interpreted as fresh authority to add another field.
        if (!fields.length) { receipt.already_complete++; continue; }
        if (review.patient_version !== entry.patient_version || digest(fields) !== digest(entry.fields)) {
          // A previous successful application may leave only contact collisions.
          // Accept that exact audited result, never arbitrary later master edits.
          const events = (await db.PatientOperationalEvent.findAll({ where: { patient_id: entry.patient_id,
            clinic_id: entry.clinic_id, event_type: 'patient.privacy_profile_autofilled' },
          order: [['id', 'DESC']], limit: 101, transaction })).map(plain);
          const previous = events.find(event => Number(event.metadata?.document_id) === entry.document_id
            && event.metadata?.snapshot_hash === entry.snapshot_hash);
          const applied = previous?.metadata?.applied || {}, skipped = previous?.metadata?.skipped_fields || [];
          const keys = Object.keys(applied);
          const replay = keys.length && keys.every(key => entry.fields.includes(key)
            && String(patient[key] ?? '') === String(applied[key] ?? ''))
            && fields.every(key => entry.fields.includes(key) && skipped.some(field => field.key === key))
            && entry.fields.every(key => keys.includes(key) || fields.includes(key));
          if (replay) { receipt.already_complete++; continue; }
          fail('PRIVACY_BACKFILL_PATIENT_CHANGED');
        }
        before.push({ patient, document_id: entry.document_id, document_digest: entry.document_digest });
      }
      if (backup) await backup({ version: VERSION, target, plan_sha256: sha256, before });
      for (const row of before) {
        const result = await profile.autofillEmptyFromDocument({ db, documentId: row.document_id, transaction, anchorsLocked: true });
        if (result.applied) { receipt.applied_patients++; receipt.applied_fields += result.fields.length; }
        receipt.skipped_fields.push(...result.skipped_fields.map(field => ({ document_id: row.document_id, ...field })));
        const source = plain(await db.PatientConsentDocument.findByPk(row.document_id, { transaction }));
        if (digest(source) !== row.document_digest) fail('PRIVACY_BACKFILL_SIGNED_DOCUMENT_CHANGED');
        const after = plain(await db.Paciente.findByPk(row.patient.id_paciente, { transaction }));
        const allowed = new Set([...result.fields, 'updatedAt', ...(result.fields.includes('fecha_nacimiento') ? ['edad'] : [])]);
        for (const key of new Set([...Object.keys(row.patient), ...Object.keys(after)])) {
          if (!allowed.has(key) && digest(row.patient[key] ?? null) !== digest(after[key] ?? null)) fail('PRIVACY_BACKFILL_UNRELATED_FIELD_CHANGED');
        }
      }
      if (dryRun) throw rolledBack;
    });
  } catch (error) { if (error !== rolledBack) throw error; }
  return receipt;
}

async function operatorModels(target) {
  const options = require('../lib/cliniccloud-import/operator-database').databaseOptions(target);
  const { Sequelize, DataTypes } = require('sequelize');
  const sql = new Sequelize(options.database, options.user, options.password, { dialect: 'mysql',
    host: options.host, port: options.port, logging: false, timezone: '+00:00',
    dialectOptions: { dateStrings: true, ...(options.ssl ? { ssl: options.ssl } : {}) } });
  const db = { sequelize: sql, Sequelize };
  for (const name of ['Clinica', 'Paciente', 'PacienteClinica', 'CitaPaciente', 'PatientCustomField',
    'ClinicConsentTemplate', 'ClinicConsentTemplateVersion', 'PatientConsentDocument', 'ConsentSignaturePackage',
    'ConsentDeliveryEvent', 'PatientConsentExternalAttestation', 'PatientOperationalEvent', 'Conversation']) {
    db[name] = require(path.join('../../models', name.toLowerCase()))(sql, DataTypes);
  }
  await sql.authenticate();
  return db;
}

async function main() {
  const { parseArgs, writePrivateJson, readBytes } = require('../lib/cliniccloud-import/io');
  const args = parseArgs(process.argv.slice(2), ['--target', '--mode', '--output', '--plan', '--backup', '--expected-plan-sha']);
  const target = args['--target'], mode = args['--mode'];
  if (!['dev', 'crm'].includes(target) || !['plan', 'dry-run', 'apply'].includes(mode) || !args['--output']) fail('PRIVACY_BACKFILL_EXPLICIT_MODE_REQUIRED');
  const db = await operatorModels(target);
  try {
    if (mode === 'plan') {
      const plan = await buildPlan({ db, target });
      writePrivateJson(args['--output'], plan);
      console.log(JSON.stringify({ target, mode, patients: plan.entries.length, fields: plan.entries.reduce((sum, entry) => sum + entry.fields.length, 0), sha256: plan.sha256 }));
    } else {
      const plan = JSON.parse(readBytes(args['--plan']));
      if (args['--expected-plan-sha'] !== plan.sha256 || !args['--backup']) fail('PRIVACY_BACKFILL_PLAN_ACKNOWLEDGEMENT_REQUIRED');
      const receipt = await applyPlan({ db, plan, target, dryRun: mode !== 'apply',
        backup: value => writePrivateJson(args['--backup'], value) });
      writePrivateJson(args['--output'], receipt);
      console.log(JSON.stringify(receipt));
    }
  } finally { await db.sequelize.close(); }
}
if (require.main === module) main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
module.exports = { buildPlan, applyPlan, digest, operatorModels };
