#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { readBytes, readCsv, readAlerts, parseArgs, writePrivateJson } = require('../lib/cliniccloud-import/io');
const { hash, normalizeContacts, normalizeAlerts } = require('../lib/cliniccloud-import/adapter');
const primary = require('../lib/cliniccloud-import/primary-clinics');

async function readMemberships(snapshot) {
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
  const connection = await require('mysql2/promise').createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, dateStrings: true, multipleStatements: false, ...require('../lib/databaseTlsConfig').buildDatabaseTlsOptions(process.env) });
  try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const [clinics] = await connection.query('SELECT id_clinica, grupoClinicaId FROM Clinicas WHERE id_clinica IN (66,72)');
    if (clinics.length !== 2 || clinics.some((c) => Number(c.grupoClinicaId) !== Number(snapshot.database_group_id))) throw new Error('CLINIC_GROUP_SCOPE_CHANGED');
    const ids = snapshot.patients.map((p) => Number(p.id));
    const [memberships] = await connection.query('SELECT id, paciente_id, clinica_id, es_principal FROM PacienteClinicas WHERE paciente_id IN (?) ORDER BY paciente_id, clinica_id, id', [ids]);
    const [patients] = await connection.query('SELECT id_paciente, clinica_id FROM Pacientes WHERE id_paciente IN (?) ORDER BY id_paciente', [ids]);
    await connection.rollback();
    return { captured_at: new Date().toISOString(), memberships, patients };
  } finally { await connection.end(); }
}

async function run(args) {
  const o = parseArgs(args, ['--historical-dir', '--contacts', '--appointments', '--alerts', '--local-snapshot', '--membership-snapshot', '--capture-memberships', '--private-output']);
  for (const key of ['--historical-dir', '--contacts', '--appointments', '--alerts', '--local-snapshot', '--private-output']) if (!o[key]) throw new Error('MISSING_REQUIRED_CLI_ARGUMENT');
  if (!o['--membership-snapshot'] && !o['--capture-memberships']) throw new Error('MEMBERSHIP_SNAPSHOT_REQUIRED');
  const snapshot = JSON.parse(readBytes(o['--local-snapshot']).toString('utf8'));
  if (snapshot.source_account !== 'cliniccloud-5880') throw new Error('UNSUPPORTED_SOURCE_ACCOUNT');
  let memberSnapshot;
  if (o['--membership-snapshot']) memberSnapshot = JSON.parse(readBytes(o['--membership-snapshot']).toString('utf8'));
  else { memberSnapshot = await readMemberships(snapshot); writePrivateJson(o['--capture-memberships'], memberSnapshot); }
  const files = [];
  const annotate = (source) => { files.push(source.file); return source.rows.map((r) => ({ ...r, provenance: { file_sha256: source.file.sha256, source_row: r.source_row, row_sha256: hash(r.values) } })); };
  const old = (file) => annotate(readCsv(path.join(o['--historical-dir'], file), file));
  const services = old('servicio_1.csv'), types = old('tiposervicio_1.csv');
  const appointments = [...old('cita_1.csv'), ...old('cita_2.csv')];
  const concepts = [...old('citaconcepto_1.csv'), ...old('citaconcepto_2.csv')];
  const historical = primary.historicalEvidence({ appointments, concepts, services, coverage: { start: '2026-08-01', end: '2026-12-31' } });
  const latest = primary.newEvidence(annotate(readCsv(o['--appointments'], 'new_appointments')), types);
  const current = new Map(memberSnapshot.patients.map((p) => [Number(p.id_paciente), p]));
  const patients = snapshot.patients.map((p) => ({ ...p, clinic_id: current.get(Number(p.id))?.clinica_id ?? null }));
  const result = primary.assignmentPlan({ evidence: [...historical.evidence, ...latest.evidence], patients, memberships: memberSnapshot.memberships });
  const contacts = readCsv(o['--contacts'], 'new_contacts'); files.push(contacts.file);
  const alerts = readAlerts(o['--alerts']); files.push(alerts.file);
  const oldAlerts = old('aviso_1.csv');
  const normalizedAlerts = normalizeAlerts(alerts.rows, alerts.file.sha256, normalizeContacts(contacts.rows, contacts.file.sha256), oldAlerts);
  const followups = primary.alertPlan({ alerts: normalizedAlerts, patients, assignments: result.assignments, memberships: memberSnapshot.memberships });
  const manifest = { version: 'cliniccloud-primary/1', source_account: snapshot.source_account, snapshot_sha256: hash(snapshot), membership_snapshot_sha256: hash(memberSnapshot),
    membership_captured_at: memberSnapshot.captured_at, files, mode: 'dry_run_only', can_apply: false, technical_actor_required: true,
    automation_policy: 'hold', whatsapp_policy: 'ignored_no_patient_mutation', historical_code_3_is_not_paid_evidence: true,
    membership_policy: 'preserve_existing_ensure_evidenced_and_primary_clinics_no_group_wide_expansion' };
  const summary = { assignments: result.summary, followups: followups.summary, evidence: { historic_concepts: concepts.length, historic_eligible: historical.evidence.length, historic_excluded: historical.excluded.length,
    new_eligible: latest.evidence.length, new_excluded: latest.excluded.length,
    historic_payment_evidence: historical.evidence.filter((r) => r.paid_evidence).length, latest_literal_pagada: latest.evidence.filter((r) => r.payment_evidence_kind === 'literal_export_state_pagada_not_money').length } };
  const plan = { manifest, summary, assignments: result.assignments, followups: followups.rows, excluded_evidence: [...historical.excluded, ...latest.excluded] };
  plan.plan_sha256 = hash(plan);
  writePrivateJson(o['--private-output'], plan);
  return { plan_sha256: plan.plan_sha256, membership_snapshot_sha256: manifest.membership_snapshot_sha256, summary };
}
if (require.main === module) run(process.argv.slice(2)).then((s) => process.stdout.write(`${JSON.stringify(s, null, 2)}\n`)).catch((e) => { process.stderr.write(`${/^[A-Z][A-Z0-9_:]+$/.test(e.message) ? e.message : 'PRIMARY_PLAN_FAILED'}\n`); process.exitCode = 1; });
module.exports = { run };
