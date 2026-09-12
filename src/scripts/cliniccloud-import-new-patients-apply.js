#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { hash } = require('../lib/cliniccloud-import/adapter');
const { readCsv, readBytes, writePrivateJson, parseArgs } = require('../lib/cliniccloud-import/io');
const { prepareNewPatients, reviewedSourceIds, operationsFromAudit, executeNewPatients, verifyPackage, ACCOUNT } = require('../lib/cliniccloud-import/new-patients-apply');
const { createNewPatientsStore } = require('../lib/cliniccloud-import/new-patients-store');
const { privateJson, openJournal, acquireExecutorLocks } = require('./cliniccloud-import-appointments-apply');
const { validateBackup } = require('./cliniccloud-import-contacts-apply');
function loadSources(options) {
  return Object.fromEntries([
    ['contacts', options['--source-dir'], 'BACKUP_CONTACTOS_2026-09-05.csv'],
    ['appointments', options['--source-dir'], 'BACKUP_CITAS_2026-08-01_2026-12-31.csv'],
    ['historic_contacts', options['--historical-dir'], 'contacto_1.csv'],
    ['historic_types', options['--historical-dir'], 'tiposervicio_1.csv'],
  ].map(([role, directory, name]) => [role, readCsv(path.join(directory, name), role)]));
}
function validateReviewEvidence(review, filename) {
  if (!Array.isArray(review.peer_evidence) || !review.peer_evidence.length) throw new Error('PEER_REVIEW_EVIDENCE_REQUIRED');
  for (const entry of review.peer_evidence) {
    if (!entry.file || path.basename(entry.file) !== entry.file) throw new Error('PEER_REVIEW_EVIDENCE_PATH_INVALID');
    const evidencePath = path.join(path.dirname(filename), entry.file);
    privateJson(evidencePath);
    if (hash(readBytes(evidencePath)) !== entry.sha256bytes) throw new Error('PEER_REVIEW_EVIDENCE_HASH_MISMATCH');
  }
}
async function run(args) {
  const options = parseArgs(args, ['--mode', '--audit', '--review', '--global-snapshot', '--source-dir', '--historical-dir', '--private-output', '--package', '--approval', '--backup-manifest', '--private-journal']);
  if (!['prepare', 'apply'].includes(options['--mode'])) throw new Error('EXPLICIT_PREPARE_OR_APPLY_REQUIRED');
  for (const key of ['--audit', '--review', '--source-dir', '--historical-dir']) if (!options[key]) throw new Error('AUDIT_REVIEW_AND_SOURCES_REQUIRED');
  if (path.resolve(__dirname, '../..') !== '/home/ubuntu/wt/back-dev' || process.cwd() !== '/home/ubuntu/wt/back-dev'
    || execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim() !== 'dev') throw new Error('DEV_WORKTREE_REQUIRED');
  const audit = privateJson(options['--audit']), review = privateJson(options['--review']), sources = loadSources(options);
  validateReviewEvidence(review, options['--review']);
  let pkg, approval, groupId;
  if (options['--mode'] === 'prepare') {
    if (!options['--global-snapshot'] || !options['--private-output']) throw new Error('GLOBAL_SNAPSHOT_AND_PRIVATE_OUTPUT_REQUIRED');
    const snapshot = privateJson(options['--global-snapshot']);
    if (hash(snapshot) !== audit.manifest.local_snapshot_sha256) throw new Error('AUDIT_GLOBAL_SNAPSHOT_HASH_MISMATCH');
    groupId = Number(snapshot.database_group_id);
  } else {
    for (const key of ['--package', '--approval', '--backup-manifest', '--private-journal']) if (!options[key]) throw new Error('REVIEW_BACKUP_AND_JOURNAL_REQUIRED');
    pkg = privateJson(options['--package']); approval = privateJson(options['--approval']); verifyPackage(pkg);
    if (pkg.source_audit_sha256 !== audit.plan_sha256 || pkg.identity_review_sha256 !== hash(review)) throw new Error('APPROVED_SOURCE_REVIEW_CHANGED');
    const expected = operationsFromAudit(audit, sources, { sourceIds: reviewedSourceIds(audit, sources, review) });
    if (hash(expected) !== hash(pkg.operations)) throw new Error('PREPARED_OPERATIONS_CHANGED');
    privateJson(options['--backup-manifest']);
    if (hash(readBytes(options['--backup-manifest'])) !== approval.backup_manifest_sha256) throw new Error('BACKUP_MANIFEST_HASH_MISMATCH');
    await validateBackup(options['--backup-manifest']); // Verifies physical .gz bytes, length, hash and freshness.
    groupId = Number(pkg.group_id);
  }
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
  const connection = await require('mysql2/promise').createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME, timezone: 'Z', dateStrings: true, multipleStatements: false, ...require('../lib/databaseTlsConfig').buildDatabaseTlsOptions(process.env) });
  let journal;
  try {
    await connection.query('SET SESSION innodb_lock_wait_timeout = 5');
    if (options['--mode'] === 'prepare') {
      await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      const store = await createNewPatientsStore(connection, { groupId });
      const live = await store.captureGroup();
      pkg = prepareNewPatients({ audit, sources, review, live });
      await connection.rollback();
      writePrivateJson(options['--private-output'], pkg);
      return { mode: 'read_only_prepare', package_sha256: pkg.package_sha256, created_patients: 0, proposed_patients: pkg.operations.length,
        deferred_patients: pkg.excluded.length, group_patients_checked: live.patients.length, automation_policy: 'hold', native_create_uniqueness_guaranteed: false };
    }
    const [locks] = await connection.query('SELECT GET_LOCK(?, 0) AS acquired', [`cc-new-patients:${ACCOUNT}`]);
    if (Number(locks[0]?.acquired) !== 1) throw new Error('SOURCE_ACCOUNT_IMPORT_ALREADY_RUNNING');
    const canonicalJournal = path.join(fs.realpathSync(path.dirname(options['--private-journal'])), path.basename(options['--private-journal']));
    await acquireExecutorLocks(connection, pkg.package_sha256, canonicalJournal);
    journal = openJournal(options['--private-journal'], pkg.package_sha256);
    const store = await createNewPatientsStore(connection, { groupId, readOnly: false });
    return await executeNewPatients({ pkg, approval, store, journal });
  } finally { journal?.close(); await connection.end(); }
}
if (require.main === module) run(process.argv.slice(2)).then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch(error => {
  // The private journal and durable source IDs distinguish rollback from a lost
  // commit response. Never claim rollback merely because the CLI returned 1.
  process.stderr.write(`${/^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'NEW_PATIENT_RESULT_REQUIRES_PRIVATE_JOURNAL_REVIEW'}\n`); process.exitCode = 1;
});
module.exports = { run, loadSources, validateReviewEvidence };
