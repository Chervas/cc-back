#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseArgs, readBytes, writePrivateJson } = require('../lib/cliniccloud-import/io');
const { hash } = require('../lib/cliniccloud-import/adapter');
const { prepareWeekAppointments, verifyWeekPackage, executeWeekAppointments, ACCOUNT } = require('../lib/cliniccloud-import/week-appointments');
const { createWeekAppointmentsStore } = require('../lib/cliniccloud-import/week-appointments-store');
const { privateJson, openJournal, acquireExecutorLocks } = require('./cliniccloud-import-appointments-apply');
const { validateBackup } = require('./cliniccloud-import-contacts-apply');
async function run(args) {
  const options = parseArgs(args, ['--target','--mode','--plan','--snapshot','--review','--private-output','--package','--approval','--backup-manifest','--private-journal']);
  if (process.cwd() !== '/home/ubuntu/wt/back-dev' || path.resolve(__dirname, '../..') !== process.cwd()
    || execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim() !== 'dev') throw Error('DEV_OPERATOR_WORKTREE_REQUIRED');
  if (!['prepare','apply'].includes(options['--mode']) || !['dev','crm'].includes(options['--target'])) throw Error('EXPLICIT_WEEK_MODE_AND_TARGET_REQUIRED');
  for (const key of ['--plan','--snapshot','--review']) if (!options[key]) throw Error('WEEK_REVIEW_INPUTS_REQUIRED');
  const plan = privateJson(options['--plan']), snapshot = privateJson(options['--snapshot']), review = privateJson(options['--review']);
  const prepared = prepareWeekAppointments({ plan, snapshot, review, target: options['--target'] });
  let pkg = prepared, approval;
  if (options['--mode'] === 'apply') {
    for (const key of ['--package','--approval','--backup-manifest','--private-journal']) if (!options[key]) throw Error('WEEK_BACKUP_APPROVAL_JOURNAL_REQUIRED');
    pkg = privateJson(options['--package']); approval = privateJson(options['--approval']); verifyWeekPackage(pkg);
    if (pkg.database_target !== options['--target'] || pkg.review_sha256 !== hash(review) || pkg.plan_sha256 !== plan.plan_sha256
      || hash(pkg.operations) !== hash(prepared.operations)) throw Error('WEEK_REVIEW_OR_TARGET_CHANGED');
    const backup = privateJson(options['--backup-manifest']);
    if (backup.database_target !== pkg.database_target || backup.full_gzip_verified !== true || backup.dump_completion_verified !== true
      || hash(readBytes(options['--backup-manifest'])) !== approval.backup_manifest_sha256) throw Error('WEEK_VERIFIED_TARGET_BACKUP_REQUIRED');
    await validateBackup(options['--backup-manifest']);
  } else if (!options['--private-output']) throw Error('PRIVATE_WEEK_OUTPUT_REQUIRED');
  const connection = await require('../lib/cliniccloud-import/operator-database').connectOperatorDatabase(options['--target']);
  let journal;
  try {
    await connection.query('SET SESSION innodb_lock_wait_timeout=5');
    if (options['--mode'] === 'prepare') {
      await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      const store = await createWeekAppointmentsStore(connection, { groupId: pkg.group_id });
      const preflight = [];
      for (const operation of pkg.operations) {
        if (await store.findSource(operation.source_reference)) preflight.push({ action_key: operation.action_key, reasons: ['SOURCE_REFERENCE_ALREADY_EXISTS'] });
        else preflight.push({ action_key: operation.action_key, ...(await store.validate(operation, pkg)) });
      }
      await connection.rollback();
      const { package_sha256, ...body } = pkg;
      const enriched = { ...body, preflight };
      pkg = { ...enriched, package_sha256: hash(enriched) };
      writePrivateJson(options['--private-output'], pkg);
      return { mode: 'read_only_week_prepare', package_sha256: pkg.package_sha256, proposed: pkg.operations.length,
        live_preflight_clear: preflight.filter(r => !r.reasons.length).length, deferred_by_review: pkg.deferred.length,
        preflight_reasons: preflight.flatMap(r => r.reasons).reduce((out, key) => { out[key] = (out[key] || 0) + 1; return out; }, {}),
        appointments_created: 0, automation_policy: 'hold' };
    }
    const [locks] = await connection.query('SELECT GET_LOCK(?,0) AS acquired', [`cc-week-appointments:${ACCOUNT}`]);
    if (Number(locks[0]?.acquired) !== 1) throw Error('WEEK_IMPORT_ALREADY_RUNNING');
    const canonicalJournal = path.join(fs.realpathSync(path.dirname(options['--private-journal'])), path.basename(options['--private-journal']));
    await acquireExecutorLocks(connection, pkg.package_sha256, canonicalJournal);
    journal = openJournal(options['--private-journal'], pkg.package_sha256);
    const store = await createWeekAppointmentsStore(connection, { groupId: pkg.group_id, readOnly: false });
    return await executeWeekAppointments({ pkg, approval, store, journal });
  } finally { journal?.close(); await connection.end(); }
}
if (require.main === module) run(process.argv.slice(2)).then(value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)).catch(error => {
  process.stderr.write(`${/^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'WEEK_IMPORT_RESULT_REQUIRES_PRIVATE_JOURNAL_REVIEW'}\n`); process.exitCode = 1;
});
module.exports = { run };
