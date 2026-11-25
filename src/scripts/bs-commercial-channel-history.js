#!/usr/bin/env node
'use strict';

const { connectOperatorDatabase } = require('../lib/cliniccloud-import/operator-database');
const { createHash } = require('node:crypto');
const { parseArgs, writePrivateJson } = require('../lib/cliniccloud-import/io');
const { normalizePhoneDigits } = require('../lib/phone');
const { verifiedSignedChoices } = require('../lib/bs-privacy-commercial-preferences');
const { hash } = require('./registration-privacy-settings-release');
const CLINIC = 72;
const EVENT = 'patient.commercial_channels_attested';
const SOURCE = 'clinic_historical_attestation';
const EVIDENCE = 'bs-medical-commercial-channels-2026-11-25';
const CHANNELS = ['whatsapp', 'email', 'sms'];
const digits = row => normalizePhoneDigits(row.phone_digits || row.telefono_movil || '');
const emailHash = value => value && createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');

async function candidates(connection, lock = false) {
  const [patients] = await connection.query(
    'SELECT id_paciente,telefono_movil,email FROM Pacientes WHERE clinica_id=? AND fecha_baja IS NULL ORDER BY id_paciente' +
    (lock ? ' FOR UPDATE' : ''), [CLINIC]);
  const [fields] = await connection.query(`SELECT id,paciente_id,JSON_UNQUOTE(JSON_EXTRACT(value,'$.publicidad')) AS flag
    FROM PatientCustomFields WHERE clinica_id=? AND field_key='cliniccloud_publicidad_historica'
      AND source='cliniccloud_publicidad_legacy' AND source_column='PUBLICIDAD' ORDER BY id`, [CLINIC]);
  const [documents] = await connection.query(`SELECT d.* FROM PatientConsentDocuments d JOIN Pacientes p ON p.id_paciente=d.paciente_id
    WHERE d.clinica_id=? AND p.clinica_id=? AND p.fecha_baja IS NULL AND d.purpose='data_protection' AND d.status='signed'
      AND d.signed_at<=UTC_TIMESTAMP() AND d.revoked_at IS NULL AND (d.expires_at IS NULL OR d.expires_at>UTC_TIMESTAMP())
    ORDER BY d.signed_at DESC,d.id DESC`, [CLINIC, CLINIC]);
  const byId = rows => new Map(rows.map(row => [Number(row.id), row]));
  const versionIds = [...new Set(documents.map(row => row.clinic_template_version_id))];
  const templateIds = [...new Set(documents.map(row => row.clinic_template_id))];
  const versions = byId(versionIds.length ? (await connection.query(
    'SELECT * FROM ClinicConsentTemplateVersions WHERE id IN (?)', [versionIds]))[0] : []);
  const templates = byId(templateIds.length ? (await connection.query(
    'SELECT id,clinic_id,purpose FROM ClinicConsentTemplates WHERE id IN (?)', [templateIds]))[0] : []);
  const [restrictions] = await connection.query(`SELECT paciente_id,phone_digits FROM MarketingContactOptOuts
    WHERE clinica_id IN (66,?) AND status='active' AND scope IN ('marketing','whatsapp_channel','all','wrong_recipient')`, [CLINIC]);
  const [[clinic]] = await connection.query('SELECT grupoClinicaId FROM Clinicas WHERE id_clinica=?', [CLINIC]);
  const scopes = ['global', `clinic:${CLINIC}`, ...(clinic?.grupoClinicaId ? [`group:${clinic.grupoClinicaId}`] : [])];
  const [emailRestrictions] = await connection.query(`SELECT email_hash FROM EmailSuppressions
    WHERE status='active' AND stream IN ('all','marketing') AND scope IN (?)
      AND (source='marketing_unsubscribe' OR reason IN ('unsubscribe','complaint'))`, [scopes]);
  const [legacyNo] = await connection.query(`SELECT c.paciente_id FROM PacienteConsentimientos c JOIN Pacientes p ON p.id_paciente=c.paciente_id
    WHERE p.clinica_id=? AND c.tipo='comunicaciones' AND c.estado='rechazado'`, [CLINIC]);
  const [already] = await connection.query('SELECT patient_id AS paciente_id FROM PatientOperationalEvents WHERE clinic_id=? AND event_type=?',
    [CLINIC, EVENT]);
  const excluded = new Set([...restrictions, ...legacyNo, ...already].map(row => Number(row.paciente_id)).filter(Boolean));
  const blockedPhones = new Set(restrictions.map(digits).filter(Boolean));
  const blockedEmails = new Set(emailRestrictions.map(row => row.email_hash));
  const evidence = new Map();
  for (const row of fields) {
    const id = Number(row.paciente_id);
    if (row.flag === 'SI') evidence.set(id, { kind: 'clinic_cloud_marketing_yes', id: Number(row.id) });
    else if (row.flag === 'NO' || row.flag === 'conflicto') excluded.add(id);
  }
  const signedYes = new Set();
  for (const doc of documents) {
    const id = Number(doc.paciente_id);
    const answers = verifiedSignedChoices(doc, { sourceVersion: versions.get(Number(doc.clinic_template_version_id)),
      sourceTemplate: templates.get(Number(doc.clinic_template_id)) });
    if (answers?.commercial === 'no' || answers?.sms_whatsapp === 'no' || answers && Object.hasOwn(answers, 'commercial_whatsapp')) excluded.add(id);
    if (answers?.commercial === 'yes' && !signedYes.has(id)) {
      signedYes.add(id);
      evidence.set(id, { kind: 'signed_marketing_yes_without_channels', id: Number(doc.id) });
    }
  }
  return patients.filter(row => evidence.has(Number(row.id_paciente)) &&
    !excluded.has(Number(row.id_paciente)) && !blockedPhones.has(digits(row)) && !blockedEmails.has(emailHash(row.email)))
    .map(row => ({ patient_id: Number(row.id_paciente), evidence: evidence.get(Number(row.id_paciente)) }));
}

async function main(args) {
  const flags = parseArgs(args, ['--target', '--mode', '--actor-id', '--output', '--approved-plan-sha256']);
  const mode = flags['--mode'] || 'plan', target = flags['--target'], actor = Number(flags['--actor-id']);
  if (!['plan', 'dry-run', 'apply'].includes(mode) || !Number.isSafeInteger(actor) || actor <= 0) throw Error('INVALID_HISTORY_REQUEST');
  const connection = await connectOperatorDatabase(target);
  const guardName = 'cc-bs-commercial-channel-history-v1';
  try {
    const [[guard]] = await connection.query('SELECT GET_LOCK(?, 0) AS ok', [guardName]);
    if (Number(guard.ok) !== 1) throw Error('HISTORY_OPERATION_BUSY');
    await connection.query(mode === 'plan' ? 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY' : 'START TRANSACTION');
    const [[operator]] = await connection.query('SELECT id_usuario,estado_cuenta FROM Usuarios WHERE id_usuario=?', [actor]);
    if (operator?.estado_cuenta !== 'activo' || !require('../lib/role-helpers').isGlobalAdmin(actor)) throw Error('ACTIVE_ADMIN_REQUIRED');
    const entries = await candidates(connection, mode !== 'plan');
    const plan = { target, clinic_id: CLINIC, actor, source: SOURCE, attestation_ref: EVIDENCE, channels: CHANNELS, entries };
    const planHash = hash(plan);
    if (mode !== 'plan' && (planHash !== flags['--approved-plan-sha256'] || !entries.length)) throw Error('HISTORY_PLAN_CHANGED');
    writePrivateJson(flags['--output'], plan);
    if (mode !== 'plan') {
      for (let i = 0; i < entries.length; i += 250) {
        const chunk = entries.slice(i, i + 250).map(row => [row.patient_id, CLINIC, actor, EVENT, SOURCE, 'internal',
          JSON.stringify({ channels: CHANNELS, attestation_ref: EVIDENCE, original_evidence: row.evidence })]);
        const [result] = await connection.query(`INSERT INTO PatientOperationalEvents
          (patient_id,clinic_id,actor_user_id,event_type,source,channel,metadata,occurred_at,created_at)
          VALUES ${chunk.map(() => '(?,?,?,?,?,?,?,UTC_TIMESTAMP(),UTC_TIMESTAMP())').join(',')}`, chunk.flat());
        if (result.affectedRows !== chunk.length) throw Error('HISTORY_WRITE_INCOMPLETE');
      }
      if ((await candidates(connection)).length) throw Error('HISTORY_VERIFICATION_FAILED');
    }
    if (mode === 'apply') await connection.commit();
    else await connection.rollback();
    console.log(JSON.stringify({ mode, plan_sha256: planHash, records: entries.length }));
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    await connection.end();
  }
}

if (require.main === module) main(process.argv.slice(2)).catch(error => {
  process.stderr.write((error.code || error.message) + '\n');
  process.exitCode = 1;
});
