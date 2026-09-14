#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseArgs, writePrivateJson } = require('../lib/cliniccloud-import/io');
const { buildNewPatientsAudit } = require('../lib/cliniccloud-import/new-patients-audit');
const { createNewPatientsStore } = require('../lib/cliniccloud-import/new-patients-store');
const { loadSources } = require('./cliniccloud-import-new-patients-apply');

async function run(args) {
  const keys = ['--source-dir', '--historical-dir', '--contacts-csv', '--appointments-csv', '--contacts-as-of', '--coverage-start', '--coverage-end', '--private-output', '--private-snapshot'];
  const options = parseArgs(args, keys);
  if (keys.some(key => !options[key])) throw Error('ALL_AUDIT_INPUTS_REQUIRED');
  if (path.resolve(__dirname, '../..') !== '/home/ubuntu/wt/back-dev' || process.cwd() !== '/home/ubuntu/wt/back-dev'
    || execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim() !== 'dev') throw Error('DEV_WORKTREE_REQUIRED');
  const sources = loadSources(options);
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
  const c = await require('mysql2/promise').createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, timezone: 'Z', dateStrings: true,
    multipleStatements: false, ...require('../lib/databaseTlsConfig').buildDatabaseTlsOptions(process.env) });
  let snapshot;
  try {
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const [clinics] = await c.query('SELECT id_clinica,grupoClinicaId FROM Clinicas WHERE id_clinica IN (66,72)');
    if (clinics.length !== 2 || !clinics[0].grupoClinicaId || clinics[0].grupoClinicaId !== clinics[1].grupoClinicaId) throw Error('CLINIC_GROUP_DRIFT');
    const store = await createNewPatientsStore(c, { groupId: Number(clinics[0].grupoClinicaId) });
    const live = await store.captureGroup();
    snapshot = { ...live, database_group_id: live.group_id };
    await c.rollback();
  } finally { await c.end(); }
  const audit = buildNewPatientsAudit({ sources, live: snapshot,
    coverage: { start: options['--coverage-start'], end: options['--coverage-end'] }, contactsAsOf: options['--contacts-as-of'] });
  writePrivateJson(options['--private-snapshot'], snapshot);
  writePrivateJson(options['--private-output'], audit);
  return { mode: 'read_only_audit', plan_sha256: audit.plan_sha256, ...audit.summary, appointments_created: 0, messages_enabled: false };
}

if (require.main === module) run(process.argv.slice(2)).then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch(error => {
  process.stderr.write(`${/^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'NEW_PATIENT_AUDIT_FAILED'}\n`); process.exitCode = 1;
});
module.exports = { run };
