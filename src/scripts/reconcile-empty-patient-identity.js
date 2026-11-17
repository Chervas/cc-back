#!/usr/bin/env node
'use strict';

// This operator command has no scheduling/sending path. By default it reads a
// single selected case and writes a private preflight. Applying needs that exact
// reviewed preimage, an explicit operator and an authorization reference.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { connectOperatorDatabase } = require('../lib/cliniccloud-import/operator-database');
const { inspectEmptyPatientReconciliation, applyEmptyPatientReconciliation } = require('../lib/empty-patient-identity-reconciliation');
const ISABEL = Object.freeze({ clinicId: 72, canonicalPatientId: 1671, duplicatePatientId: 68547,
  appointmentId: 79741, leadId: 8328, conversationId: 3624, failedExecutionId: 8933,
  scheduledJobId: 682433, executionJobId: 682432, canonicalHistoryNumber: '14011', duplicateHistoryNumber: '14975' });
const hash = value => createHash('sha256').update(value).digest('hex');
function privateFile(filename, contents) {
  const directory = path.dirname(path.resolve(filename));
  if (!directory.startsWith('/home/ubuntu/artifacts/')) throw Error('PRIVATE_ARTIFACT_DIRECTORY_REQUIRED');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) throw Error('PRIVATE_ARTIFACT_DIRECTORY_REQUIRED');
  fs.writeFileSync(filename, contents, { flag: 'wx', mode: 0o600 });
}
function readPrivate(filename) {
  const info = fs.lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) throw Error('PRIVATE_PREFLIGHT_REQUIRED');
  return fs.readFileSync(filename, 'utf8');
}
async function main(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--apply') args.apply = true;
    else if (['--target', '--output', '--plan', '--actor-user-id', '--authorization-ref'].includes(key)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw Error('ARGUMENT_VALUE_REQUIRED');
      args[key.slice(2)] = argv[++i];
    } else throw Error('UNKNOWN_ARGUMENT');
  }
  if (!['dev', 'crm'].includes(args.target)) throw Error('EXPLICIT_TARGET_REQUIRED');
  if (args.apply && (!args.plan || !args['actor-user-id'] || !args['authorization-ref'])) throw Error('REVIEWED_PLAN_OPERATOR_AUTHORIZATION_REQUIRED');
  if (!args.apply && !args.output) throw Error('PRIVATE_PREFLIGHT_OUTPUT_REQUIRED');
  const connection = await connectOperatorDatabase(args.target);
  try {
    if (!args.apply) {
      await connection.query('START TRANSACTION READ ONLY');
      const plan = await inspectEmptyPatientReconciliation(connection, ISABEL);
      await connection.rollback();
      privateFile(args.output, JSON.stringify(plan, null, 2) + '\n');
      return { status: 'preflight', target: args.target, sha256: plan.sha256, path: args.output,
        canonicalPatientId: ISABEL.canonicalPatientId, duplicatePatientId: ISABEL.duplicatePatientId, writes: 0, sends: 0 };
    }
    const plan = JSON.parse(readPrivate(args.plan));
    if (JSON.stringify(plan.recipe) !== JSON.stringify(ISABEL)) throw Error('SELECTED_REPAIR_CASE_REQUIRED');
    const backup = JSON.stringify(plan.snapshot, null, 2) + '\n';
    const backupPath = path.join(path.dirname(path.resolve(args.plan)), 'isabel-preimage-' + plan.sha256 + '.json');
    if (fs.existsSync(backupPath)) {
      if (readPrivate(backupPath) !== backup) throw Error('PREFLIGHT_BACKUP_MISMATCH');
    } else privateFile(backupPath, backup);
    const result = await applyEmptyPatientReconciliation(connection, plan, { actorUserId: Number(args['actor-user-id']),
      authorizationRef: args['authorization-ref'], backupRef: { path: backupPath, sha256: hash(backup) } });
    return { ...result, target: args.target, planSha256: plan.sha256, backupPath };
  } finally { await connection.end(); }
}
if (require.main === module) main().then(result => process.stdout.write(JSON.stringify(result) + '\n'))
  .catch(error => { process.stderr.write(JSON.stringify({ status: 'failed', code: error.code || error.message }) + '\n'); process.exitCode = 1; });
module.exports = { main, ISABEL };
