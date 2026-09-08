#!/usr/bin/env node
'use strict';

// This script defaults to preparation. Only an explicit apply invocation with
// an approved prepared hash, actor, backup hash and HOLD acknowledgement writes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { readBytes, parseArgs, writePrivateJson } = require('../lib/cliniccloud-import/io');
const { hash } = require('../lib/cliniccloud-import/adapter');
const contract = require('../lib/cliniccloud-import/primary-followups-apply');
const runtime = require('../lib/cliniccloud-import/primary-followups-runtime');
const fail = code => { throw new Error(code); };
const DEFAULT_HISTORICAL = '/home/ubuntu/secure-imports/clinic-real-20260722/review/backup_data';
const DEFAULT_EXPORTS = '/home/ubuntu/frontend_clinicaclick/temp';
function readPrivate(filename) { runtime.privateFile(filename); return JSON.parse(readBytes(filename).toString('utf8')); }
function verifySources(files) {
  if (!Array.isArray(files) || files.length !== 10) fail('SOURCE_MANIFEST_INCOMPLETE');
  const known = {
    new_contacts: path.join(DEFAULT_EXPORTS, 'BACKUP_CONTACTOS_2026-09-05.csv'),
    new_appointments: path.join(DEFAULT_EXPORTS, 'BACKUP_CITAS_2026-08-01_2026-12-31.csv'),
    alerts: path.join(DEFAULT_EXPORTS, 'Alertas.xlsx'),
  };
  const historical = ['servicio_1.csv', 'tiposervicio_1.csv', 'cita_1.csv', 'cita_2.csv', 'citaconcepto_1.csv', 'citaconcepto_2.csv', 'aviso_1.csv'];
  const roles = new Set();
  for (const file of files) {
    if (roles.has(file.role)) fail('SOURCE_MANIFEST_DUPLICATE'); roles.add(file.role);
    const filename = known[file.role] || (historical.includes(file.role) ? path.join(DEFAULT_HISTORICAL, file.role) : null);
    if (!filename || hash(readBytes(filename)) !== file.sha256) fail('SOURCE_FILE_CHANGED');
  }
}
async function verifyBackup(filename, expectedHash) {
  runtime.privateFile(filename);
  if (!/^[a-f0-9]{64}$/.test(expectedHash || '') || !filename.endsWith('.sql.gz')) fail('VERIFIED_BACKUP_REQUIRED');
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) digest.update(chunk);
  if (digest.digest('hex') !== expectedHash) fail('BACKUP_HASH_MISMATCH');
}
async function run(args) {
  const o = parseArgs(args, ['--mode', '--plan', '--local-snapshot', '--private-output', '--prepared', '--approve-sha256', '--actor-id', '--actor-kind', '--backup-file', '--backup-sha256', '--journal', '--confirm-hold']);
  if (!['prepare', 'apply'].includes(o['--mode'] || 'prepare')) fail('INVALID_MODE');
  if ((o['--mode'] || 'prepare') === 'prepare') {
    if (!o['--plan'] || !o['--local-snapshot'] || !o['--private-output']) fail('PREPARE_ARGUMENTS_REQUIRED');
    const plan = readPrivate(o['--plan']), snapshot = readPrivate(o['--local-snapshot']);
    verifySources(plan.manifest?.files);
    const live = await runtime.captureLive(snapshot.patients.map(row => Number(row.id)));
    const prepared = contract.prepare({ plan, snapshot, live });
    writePrivateJson(o['--private-output'], prepared);
    return { mode: 'read_only_prepared', prepared_sha256: prepared.prepared_sha256, plan_sha256: prepared.plan_sha256, captured_at: prepared.captured_at, summary: prepared.summary };
  }
  for (const key of ['--prepared', '--approve-sha256', '--actor-kind', '--backup-file', '--backup-sha256', '--journal']) if (!o[key]) fail('APPLY_ARGUMENTS_REQUIRED');
  if (!['system_import', 'existing_actor'].includes(o['--actor-kind']) || (o['--actor-kind'] === 'system_import' && o['--actor-id']) || (o['--actor-kind'] === 'existing_actor' && !/^[1-9]\d*$/.test(o['--actor-id'] || ''))) fail('INVALID_EXPLICIT_IMPORT_ACTOR');
  const actorId = o['--actor-kind'] === 'system_import' ? null : Number(o['--actor-id']);
  if (o['--confirm-hold'] !== 'yes') fail('HOLD_ACKNOWLEDGEMENT_REQUIRED');
  const dev = '/home/ubuntu/wt/back-dev';
  if (fs.realpathSync(path.resolve(__dirname, '../..')) !== fs.realpathSync(dev) || execFileSync('git', ['-C', dev, 'branch', '--show-current'], { encoding: 'utf8' }).trim() !== 'dev') fail('DEV_WORKTREE_REQUIRED');
  const prepared = readPrivate(o['--prepared']);
  contract.verifyPrepared(prepared, o['--approve-sha256']);
  verifySources(prepared.source_files);
  await verifyBackup(o['--backup-file'], o['--backup-sha256']);
  return runtime.withAccountLock(async () => {
    const live = await runtime.captureLive([...new Set(prepared.operations.map(row => row.patient_id))]);
    runtime.verifyLiveIdentity(prepared, live);
    const journal = runtime.openJournal(o['--journal'], prepared.prepared_sha256);
    let db;
    try {
      await journal.append({ event: 'application_started', prepared_sha256: prepared.prepared_sha256, source_account: contract.ACCOUNT, actor_id: actorId, actor_kind: o['--actor-kind'], backup_sha256: o['--backup-sha256'], automation_policy: 'hold', at: new Date().toISOString() });
      db = runtime.createIsolatedModels();
      const result = await contract.createExecutor({ db, journal }).apply({ prepared, approvedHash: o['--approve-sha256'], actorId });
      await journal.append({ event: 'application_completed', prepared_sha256: prepared.prepared_sha256, summary: result, at: new Date().toISOString() });
      return { mode: 'applied_hold', prepared_sha256: prepared.prepared_sha256, ...result };
    } finally { if (db) await db.sequelize.close(); journal.close(); }
  });
}
if (require.main === module) run(process.argv.slice(2)).then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch(error => {
  // SQL, patient text and validation internals never escape to stdout/stderr.
  process.stderr.write(`${/^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'PRIMARY_FOLLOWUPS_APPLICATION_FAILED'}\n`); process.exitCode = 1;
});
module.exports = { run, verifySources, verifyBackup };
