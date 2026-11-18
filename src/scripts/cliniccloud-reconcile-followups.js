#!/usr/bin/env node
'use strict';

// Preparation is read-only and is the default. Application is a separate,
// explicitly approved invocation. Neither mode starts application workers.
const fs = require('node:fs');
const path = require('node:path');
const { hash } = require('../lib/cliniccloud-import/adapter');
const { readBytes, parseArgs, writePrivateJson, PRIVATE_ROOT } = require('../lib/cliniccloud-import/io');
const runtime = require('../lib/cliniccloud-import/primary-followups-runtime');
const live = require('../lib/cliniccloud-import/followup-reconciliation-runtime');
const contract = require('../lib/cliniccloud-import/followup-reconciliation');
const { createSourceProof } = require('../lib/cliniccloud-import/followup-reconciliation-source');
const { verifyBackup } = require('./cliniccloud-import-primary-followups-apply');
const { verifyReconciliationBackup, createOperationVerifier } = require('../lib/cliniccloud-import/reconciliation-backup');
const fail = code => { throw new Error(code); };
const readPrivate = filename => JSON.parse(readBytes(runtime.privateFile(filename)).toString('utf8'));

function verifySources(files) {
  if (!Array.isArray(files) || !files.length || files.length > 30) fail('FOLLOWUP_SOURCE_MANIFEST_REQUIRED');
  const roots = [fs.realpathSync(PRIVATE_ROOT), '/home/ubuntu/frontend_clinicaclick/temp'];
  for (const f of files) {
    if (!path.isAbsolute(f.path || '') || !/\.(?:csv|xlsx|json)$/i.test(f.path) || !/^[a-f0-9]{64}$/.test(f.sha256 || '')) fail('FOLLOWUP_SOURCE_MANIFEST_INVALID');
    const stat = fs.lstatSync(f.path), real = fs.realpathSync(f.path);
    if (!stat.isFile() || stat.isSymbolicLink() || !roots.some(root => real.startsWith(`${root}/`))) fail('FOLLOWUP_SOURCE_PATH_INVALID');
    if (hash(readBytes(real)) !== f.sha256) fail('FOLLOWUP_SOURCE_FILE_CHANGED');
  }
}

async function run(argv) {
  const o = parseArgs(argv, ['--mode','--target','--input','--private-output','--prepared','--approve-sha256',
    '--actor-kind','--actor-id','--backup-file','--backup-sha256','--rds-backup-receipt','--rds-backup-sha256','--journal','--confirm-hold']);
  const mode = o['--mode'] || 'prepare', target = o['--target'];
  if (!['prepare','apply'].includes(mode) || !['crm','dev'].includes(target)) fail('FOLLOWUP_EXPLICIT_MODE_TARGET_REQUIRED');
  if (mode === 'prepare') {
    if (!o['--input'] || !o['--private-output']) fail('FOLLOWUP_PREPARE_ARGUMENTS_REQUIRED');
    const input = readPrivate(o['--input']);
    if (input.version !== 'cliniccloud-followup-reconciliation-input/v1') fail('FOLLOWUP_INPUT_VERSION_INVALID');
    verifySources(input.source_files);
    const proof = createSourceProof({ sourceFiles: input.source_files });
    proof.verifyRecords(input.records);
    const snapshot = await live.captureLive({ target, records: input.records });
    const decisions = proof.decisionsFor(input.records, snapshot);
    const prepared = contract.prepare({ records: input.records, decisions, sourceFiles: input.source_files, live: snapshot,
      now: snapshot.captured_at, target, authorizedClinicIds: input.authorized_clinic_ids || [66] });
    writePrivateJson(o['--private-output'], prepared);
    writePrivateJson(`${o['--private-output']}.snapshot.json`, snapshot);
    return { mode: 'read_only_prepared', target, prepared_sha256: prepared.prepared_sha256, summary: prepared.summary };
  }
  for (const key of ['--prepared','--approve-sha256','--actor-kind','--journal']) if (!o[key]) fail('FOLLOWUP_APPLY_ARGUMENTS_REQUIRED');
  if (o['--confirm-hold'] !== 'yes' || !['system_import','existing_actor'].includes(o['--actor-kind'])
    || o['--actor-kind'] === 'system_import' && o['--actor-id']
    || o['--actor-kind'] === 'existing_actor' && !/^[1-9]\d*$/.test(o['--actor-id'] || '')) fail('FOLLOWUP_EXPLICIT_ACTOR_HOLD_REQUIRED');
  const actorId = o['--actor-kind'] === 'system_import' ? null : Number(o['--actor-id']);
  const prepared = readPrivate(o['--prepared']);
  contract.verifyPrepared(prepared, o['--approve-sha256']);
  if (prepared.target !== target) fail('FOLLOWUP_DATABASE_TARGET_CHANGED');
  verifySources(prepared.source_files);
  const proof = createSourceProof({ sourceFiles: prepared.source_files });
  proof.verifyRecords(prepared.operations.map(op => op.record), { normalized: true });
  const backupProof = await verifyReconciliationBackup({ options: o, prepared, verifySqlBackup: verifyBackup });
  return runtime.withAccountLock(async () => {
    const journal = runtime.openJournal(o['--journal'], prepared.prepared_sha256);
    let db;
    try {
      db = runtime.createIsolatedModels({ target });
      if (actorId && !await db.Usuario.findByPk(actorId, { attributes: ['id_usuario'] })) fail('FOLLOWUP_IMPORT_ACTOR_MISSING');
      await journal.append({ event: 'application_started', prepared_sha256: prepared.prepared_sha256,
        target, actor_id: actorId, actor_kind: o['--actor-kind'], backup_sha256: o['--rds-backup-sha256'] || o['--backup-sha256'],
        backup_kind: target === 'crm' ? 'rds_snapshot' : 'sql_dump', backup_proof: backupProof,
        automation_policy: 'hold', at: new Date().toISOString() });
      const result = await contract.createExecutor({ db, journal, captureIdentity: live.transactionalIdentityReader(db),
        getDatabaseIdentity: live.databaseIdentityReader(db), verifyOperation: createOperationVerifier(backupProof, prepared, proof.verifyOperation) })
        .apply({ prepared, approvedHash: o['--approve-sha256'], actorId });
      await journal.append({ event: 'application_completed', prepared_sha256: prepared.prepared_sha256, summary: result, at: new Date().toISOString() });
      return { mode: 'applied_hold', target, prepared_sha256: prepared.prepared_sha256,
        patients: result.patients, outcomes: result.outcomes.reduce((a, r) => { a[r.action] = (a[r.action] || 0) + 1; return a; }, {}) };
    } finally { if (db) await db.sequelize.close(); journal.close(); }
  }, { target });
}

if (require.main === module) run(process.argv.slice(2)).then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch(error => {
  process.stderr.write(`${/^[A-Z][A-Z0-9_]+$/.test(error.code || error.message) ? error.code || error.message : 'FOLLOWUP_RECONCILIATION_FAILED'}\n`);
  process.exitCode = 1;
});
module.exports = { run, verifySources };
