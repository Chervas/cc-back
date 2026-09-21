#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { hash } = require('../lib/cliniccloud-import/adapter');
const { parseArgs, readBytes, writePrivateJson } = require('../lib/cliniccloud-import/io');
const { connectOperatorDatabase } = require('../lib/cliniccloud-import/operator-database');
const { capture, verifyResources, verifySources } = require('./cliniccloud-import-catalog-drafts');
const { prepareResourceRefresh, verifyResourceRefresh, refreshedConfig, isResourceRefreshReplay } = require('../lib/cliniccloud-import/catalog-resource-refresh');
const { privateJson, openJournal, acquireExecutorLocks } = require('./cliniccloud-import-appointments-apply');
const { validateBackup } = require('./cliniccloud-import-contacts-apply');

async function executeRefresh({ connection: c, pkg, journal }) {
  let commitAttempted = false;
  try {
    await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED'); await c.beginTransaction();
    const current = await capture(c, true);
    const replayed = pkg.operations.filter(op => {
      const row = current.treatments.find(t => t.id_tratamiento === op.id);
      return row && isResourceRefreshReplay(row, op, pkg);
    });
    if (pkg.operations.length && replayed.length === pkg.operations.length) {
      await c.rollback(); await journal.append({ stage: 'resource_refresh_replay', count: replayed.length });
      return { status: 'replay_preserved', updated: 0, replayed: replayed.length, reminders_activated: false };
    }
    if (hash(current) !== pkg.before_sha256) throw Error('CATALOG_REFRESH_STATE_DRIFT');
    for (const op of pkg.operations) verifyResources({ ...op.before, clinical_config: op.after_config }, current);
    await journal.append({ stage: 'resource_refresh_prepared', before: current, operations: pkg.operations });
    for (const op of pkg.operations) {
      const [result] = await c.query('UPDATE Tratamientos SET clinical_config=?,updatedAt=UTC_TIMESTAMP() WHERE id_tratamiento=?',
        [JSON.stringify(refreshedConfig(op, pkg)), op.id]);
      if (result.affectedRows !== 1) throw Error('CATALOG_REFRESH_WRITE_MISMATCH');
    }
    const after = await capture(c);
    for (const op of pkg.operations) {
      const row = after.treatments.find(t => t.id_tratamiento === op.id);
      if (!row || !isResourceRefreshReplay(row, op, pkg)) throw Error('CATALOG_REFRESH_AFTER_MISMATCH');
    }
    const restored = { ...after, treatments: after.treatments.map(row => pkg.operations.find(op => op.id === row.id_tratamiento)
      ? pkg.before.treatments.find(t => t.id_tratamiento === row.id_tratamiento) : row) };
    if (hash(restored) !== pkg.before_sha256) throw Error('CATALOG_REFRESH_UNRELATED_CHANGE');
    await journal.append({ stage: 'resource_refresh_written_before_commit', after_sha256: hash(after),
      after: after.treatments.filter(row => pkg.operations.some(op => op.id === row.id_tratamiento)) });
    commitAttempted = true; await c.commit();
    await journal.append({ stage: 'resource_refresh_committed', updated: pkg.operations.length, after_sha256: hash(after) });
    return { status: 'committed', updated: pkg.operations.length, active_changed: 0, prices_changed: 0, reminders_activated: false };
  } catch (error) {
    await c.rollback().catch(() => {});
    if (commitAttempted) throw Error('CATALOG_REFRESH_COMMIT_RESULT_REQUIRES_JOURNAL_REVIEW');
    throw error;
  }
}
async function run(args) {
  const o = parseArgs(args, ['--mode', '--target', '--plan', '--initial-package', '--workbook', '--client-replies',
    '--resource-map', '--private-output', '--package', '--approved-sha256', '--backup-manifest', '--private-journal']);
  if (o['--target'] !== 'crm' || !['prepare','apply'].includes(o['--mode'])) throw Error('EXPLICIT_CRM_REFRESH_MODE_REQUIRED');
  if (process.cwd() !== '/home/ubuntu/wt/back-dev' || path.resolve(__dirname, '../..') !== process.cwd()
    || execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim() !== 'dev') throw Error('DEV_OPERATOR_WORKTREE_REQUIRED');
  const plan = privateJson(o['--plan']), initial = privateJson(o['--initial-package']); verifySources(o, plan);
  const c = await connectOperatorDatabase('crm'); let journal;
  try {
    if (o['--mode'] === 'prepare') {
      await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      const before = await capture(c); const pkg = prepareResourceRefresh({ plan, initial, before });
      for (const op of pkg.operations) verifyResources({ ...op.before, clinical_config: op.after_config }, before);
      await c.rollback(); writePrivateJson(o['--private-output'], pkg);
      return { status: 'prepared', proposed: pkg.operations.length, preserved: pkg.preserved.length,
        deferred: pkg.deferred.length, package_sha256: pkg.package_sha256, writes: 0 };
    }
    const pkg = privateJson(o['--package']); verifyResourceRefresh(pkg, { plan, initial });
    if (o['--approved-sha256'] !== pkg.package_sha256 || !Number.isFinite(Date.parse(pkg.created_at))
      || Date.now() - Date.parse(pkg.created_at) > 7200000 || Date.parse(pkg.created_at) > Date.now()) throw Error('FRESH_CATALOG_REFRESH_APPROVAL_REQUIRED');
    if (!pkg.operations.length) throw Error('CATALOG_REFRESH_EMPTY_PACKAGE');
    const manifest = privateJson(o['--backup-manifest']);
    if (manifest.database_target !== 'crm' || !manifest.full_gzip_verified || !manifest.dump_completion_verified) throw Error('CATALOG_VERIFIED_BACKUP_REQUIRED');
    await validateBackup(o['--backup-manifest']);
    await acquireExecutorLocks(c, pkg.package_sha256, path.resolve(o['--private-journal']));
    journal = openJournal(o['--private-journal'], pkg.package_sha256);
    await journal.append({ stage: 'resource_refresh_verified', backup_manifest_sha256: hash(readBytes(o['--backup-manifest'])) });
    return await executeRefresh({ connection: c, pkg, journal });
  } finally { journal?.close(); await c.end(); }
}
if (require.main === module) run(process.argv.slice(2)).then(r => console.log(JSON.stringify(r))).catch(e => {
  console.error(/^[A-Z_]+$/.test(e.message) ? e.message : 'CATALOG_REFRESH_FAILED_REVIEW_PRIVATE_JOURNAL'); process.exitCode = 1;
});
module.exports = { run, executeRefresh };
