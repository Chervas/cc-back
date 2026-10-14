#!/usr/bin/env node
'use strict';

// Explicit, offline-source administrative operator. Never start the application
// to run this tool. It does not send events, messages or automation jobs.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { hash, stableJson } = require('../lib/cliniccloud-import/adapter');
const { writePrivateJson, parseArgs, PRIVATE_ROOT } = require('../lib/cliniccloud-import/io');
const { connectOperatorDatabase } = require('../lib/cliniccloud-import/operator-database');
const { ADDRESS_FIELDS, buildAddressBackfillPlan, validateAddressBackfillPlan } = require('../lib/cliniccloud-import/address-backfill');
const { SCOPE, preflightAddressDatabase, captureAddressSnapshot, expectedAfter, applyAddressBackfillPlan } = require('../lib/cliniccloud-import/address-backfill-store');

const VERSION = 'cliniccloud-address-operator/1';
const COUNTRIES = Object.freeze({ values: {}, provenance: null }); // Never guess numeric country IDs.
const CODE_FILES = ['src/scripts/cliniccloud-backfill-addresses.js', 'src/lib/cliniccloud-import/address-backfill.js',
  'src/lib/cliniccloud-import/address-backfill-store.js', 'src/lib/cliniccloud-import/operator-database.js',
  'src/lib/cliniccloud-import/io.js', 'src/lib/cliniccloud-import/adapter.js', 'src/lib/patient-profile-fields.js', 'src/lib/databaseTlsConfig.js'];
const ROOT = path.resolve(__dirname, '../..');
const assert = (condition, code) => { if (!condition) throw Error(code); };
const seal = value => ({ ...value, envelope_sha256: hash(value) });

function sourceProof() {
  assert(fs.realpathSync(ROOT) === '/home/ubuntu/wt/back-dev', 'CANONICAL_OPERATOR_WORKTREE_REQUIRED');
  const git = args => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
  assert(git(['branch', '--show-current']) === 'dev', 'CANONICAL_OPERATOR_BRANCH_REQUIRED');
  const files = {};
  for (const file of CODE_FILES) {
    const actual = fs.readFileSync(path.join(ROOT, file));
    const committed = execFileSync('git', ['show', `HEAD:${file}`], { cwd: ROOT, stdio: ['ignore','pipe','pipe'] });
    assert(hash(actual) === hash(committed), 'ADDRESS_OPERATOR_SOURCE_UNCOMMITTED');
    files[file] = hash(actual);
  }
  return { commit: git(['rev-parse', 'HEAD']), files };
}

function privateDirectory(directory) {
  assert(path.isAbsolute(directory), 'PRIVATE_DIRECTORY_ABSOLUTE_REQUIRED');
  const root = fs.realpathSync(PRIVATE_ROOT), resolved = fs.realpathSync(directory);
  const stat = fs.lstatSync(directory);
  assert(!stat.isSymbolicLink() && stat.isDirectory() && stat.uid === process.getuid() && !(stat.mode & 0o077)
    && resolved.startsWith(`${root}${path.sep}`), 'PRIVATE_DIRECTORY_INVALID');
  return resolved;
}

function readPlan(filename) {
  const directory = privateDirectory(path.dirname(filename)), stat = fs.lstatSync(filename);
  assert(stat.isFile() && !stat.isSymbolicLink() && !(stat.mode & 0o077) && stat.uid === process.getuid()
    && stat.size <= 64 * 1024 * 1024, 'PRIVATE_PLAN_INVALID');
  const envelope = JSON.parse(fs.readFileSync(path.join(directory, path.basename(filename)), 'utf8'));
  const { envelope_sha256, ...body } = envelope;
  assert(envelope.version === VERSION && envelope_sha256 === hash(body), 'ADDRESS_ENVELOPE_PROOF_INVALID');
  validateAddressBackfillPlan(envelope.plan);
  assert(stableJson(envelope.countries) === stableJson(COUNTRIES), 'ADDRESS_COUNTRY_POLICY_CHANGED');
  return envelope;
}

async function readOnlySnapshot(connection) {
  try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    return { database: await preflightAddressDatabase(connection), snapshot: await captureAddressSnapshot(connection) };
  } finally { await connection.rollback(); }
}

async function main() {
  const args = parseArgs(process.argv.slice(2), ['--mode','--target','--outdir','--plan','--approve']);
  assert(['prepare','apply','verify'].includes(args['--mode']) && ['dev','crm'].includes(args['--target']), 'EXPLICIT_MODE_AND_TARGET_REQUIRED');
  const code = sourceProof(), target = args['--target'], mode = args['--mode'];
  const output = privateDirectory(args['--outdir']);
  const connection = await connectOperatorDatabase(target);
  let operatorLock = false;
  try {
    if (mode === 'prepare') {
      assert(!args['--plan'] && !args['--approve'], 'PREPARE_ARGUMENTS_INVALID');
      const { database, snapshot } = await readOnlySnapshot(connection);
      const plan = buildAddressBackfillPlan({ ...snapshot, countries: COUNTRIES, scope: SCOPE, target, generatedAt: new Date().toISOString() });
      const envelope = seal({ version: VERSION, code, database, countries: COUNTRIES, plan, before_capture_sha256: hash(snapshot),
        intended_after_sha256: hash(expectedAfter(snapshot, plan.operations)), field_allowlist: ADDRESS_FIELDS });
      writePrivateJson(path.join(output, 'plan.json'), envelope);
      console.log(JSON.stringify({ mode, target, database_writes: 0, envelope_sha256: envelope.envelope_sha256, plan_sha256: plan.plan_sha256, summary: plan.summary }));
      return;
    }
    assert(args['--plan'], 'ADDRESS_PLAN_FILE_REQUIRED');
    const envelope = readPlan(args['--plan']);
    assert(envelope.plan.target === target && stableJson(envelope.code) === stableJson(code), 'ADDRESS_PLAN_SOURCE_OR_TARGET_CHANGED');
    assert(stableJson(envelope.field_allowlist) === stableJson(ADDRESS_FIELDS), 'ADDRESS_FIELD_ALLOWLIST_CHANGED');
    if (mode === 'verify') {
      assert(!args['--approve'], 'VERIFY_IS_READ_ONLY');
      const { database, snapshot } = await readOnlySnapshot(connection);
      assert(stableJson(database) === stableJson(envelope.database), 'ADDRESS_DATABASE_IDENTITY_CHANGED');
      assert(hash(snapshot) === envelope.intended_after_sha256, 'ADDRESS_FINAL_CAPTURE_MISMATCH');
      const replay = buildAddressBackfillPlan({ ...snapshot, countries: COUNTRIES, scope: SCOPE, target, generatedAt: envelope.plan.generated_at });
      assert(replay.operations.length === 0, 'ADDRESS_VERIFICATION_NOT_IDEMPOTENT');
      const result = { mode, target, verified: true, database_writes: 0, patients_updated: envelope.plan.operations.length,
        fields_updated: envelope.plan.summary.fields_updated, remaining_operations: 0, patients_review: replay.summary.patients_review,
        capture_sha256: hash(snapshot), verified_at: new Date().toISOString() };
      writePrivateJson(path.join(output, 'verification.json'), result);
      console.log(JSON.stringify(result)); return;
    }
    assert(args['--approve'] === envelope.envelope_sha256, 'EXACT_ADDRESS_PLAN_APPROVAL_REQUIRED');
    const age = Date.now() - Date.parse(envelope.plan.generated_at);
    assert(age >= 0 && age <= 2 * 60 * 60 * 1000, 'ADDRESS_PLAN_EXPIRED');
    assert(!fs.existsSync(path.join(output,'before.json')) && !fs.existsSync(path.join(output,'intent.json'))
      && !fs.existsSync(path.join(output,'result.json')), 'ADDRESS_RUN_DIRECTORY_ALREADY_USED');
    const [[lock]] = await connection.query("SELECT GET_LOCK('cc:address-backfill:cliniccloud-5880:29',0) AS acquired");
    assert(Number(lock.acquired) === 1, 'ADDRESS_OPERATOR_ALREADY_RUNNING'); operatorLock = true;
    let backupSha;
    const result = await applyAddressBackfillPlan(connection, envelope.plan, { countries: COUNTRIES, expectedDatabase: envelope.database,
      beforeWrite: async ({ snapshot, operations, database }) => {
        assert(hash(snapshot) === envelope.before_capture_sha256, 'ADDRESS_BEFORE_CAPTURE_CHANGED');
        // A field-level before-image is sufficient here: there is no DDL, no
        // trigger, and the reviewed SQL only changes these five columns. It is
        // smaller and safer to restore than an unrelated full CRM database.
        const patients = new Map(snapshot.patients.map(row => [Number(row.id_paciente),row]));
        const backup = { version: 'cliniccloud-address-before-image/1', created_at: new Date().toISOString(), database,
          envelope_sha256: envelope.envelope_sha256, capture_sha256: hash(snapshot), field_allowlist: ADDRESS_FIELDS,
          rows: operations.map(operation => ({ patient_id: operation.patient_id, history_number: operation.history_number,
            expected: operation.expected, memberships: patients.get(operation.patient_id).memberships,
            after_address: { ...operation.expected.address, ...operation.updates }, source_fingerprints: operation.source_fingerprints })) };
        backupSha = hash(backup);
        writePrivateJson(path.join(output,'before.json'), { ...backup, backup_sha256: backupSha });
        writePrivateJson(path.join(output,'intent.json'), { version: VERSION, state: 'prepared_before_any_dml', target,
          database, envelope_sha256: envelope.envelope_sha256, backup_sha256: backupSha, before_sha256: envelope.before_capture_sha256,
          intended_after_sha256: envelope.intended_after_sha256, patients: operations.length,
          fields: envelope.plan.summary.fields_updated, created_at: new Date().toISOString() });
        const readback = JSON.parse(fs.readFileSync(path.join(output,'before.json'),'utf8'));
        const { backup_sha256, ...body } = readback;
        assert(backup_sha256 === backupSha && hash(body) === backupSha, 'ADDRESS_BACKUP_READBACK_FAILED');
      } });
    assert(result.after_sha256 === envelope.intended_after_sha256, 'ADDRESS_COMMITTED_CAPTURE_MISMATCH');
    const receipt = { ...result, target, mode, version: VERSION, envelope_sha256: envelope.envelope_sha256,
      backup_sha256: backupSha, committed_at: new Date().toISOString() };
    writePrivateJson(path.join(output,'result.json'), receipt);
    console.log(JSON.stringify(receipt));
  } finally {
    if (operatorLock) await connection.query("SELECT RELEASE_LOCK('cc:address-backfill:cliniccloud-5880:29')").catch(() => {});
    await connection.end();
  }
}

if (require.main === module) main().catch(error => {
  // Never leak a mysql error's sql/sqlMessage, patient values or credentials.
  const message = /^[A-Z][A-Z0-9_]+$/.test(error.message || '') ? error.message : 'ADDRESS_OPERATOR_FAILED_CHECK_PRIVATE_RUN';
  console.error(JSON.stringify({ failed: true, error: message, sql_code: error.code || null,
    warning: 'Do not retry apply blindly after any interruption; inspect the durable intent and verify first.' }));
  process.exitCode = 1;
});
module.exports = { main, readPlan, sourceProof };
