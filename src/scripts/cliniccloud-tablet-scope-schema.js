#!/usr/bin/env node
'use strict';
// One additive migration only. No app bootstrap, pending migration queue,
// device grants, passwords, reminders or runtime settings are changed.
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { hash } = require('../lib/cliniccloud-import/adapter');
const { parseArgs, readBytes } = require('../lib/cliniccloud-import/io');
const { connectOperatorDatabase } = require('../lib/cliniccloud-import/operator-database');
const { privateJson, openJournal, acquireExecutorLocks } = require('./cliniccloud-import-appointments-apply');
const { validateBackup } = require('./cliniccloud-import-contacts-apply');
const NAME = '20260921080000-add-tablet-consent-group-scope.js';
async function run(args) {
    const o = parseArgs(args, ['--target', '--approved-migration-sha256', '--backup-manifest', '--private-journal']);
    if (!['dev', 'crm'].includes(o['--target']) || !o['--private-journal']) throw Error('TABLET_SCHEMA_EXPLICIT_TARGET_REQUIRED');
    if (process.cwd() !== '/home/ubuntu/wt/back-dev'
        || execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim() !== 'dev'
        || execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) throw Error('TABLET_SCHEMA_COMMITTED_DEV_SOURCE_REQUIRED');
    const file = path.resolve(__dirname, '../../migrations', NAME), sha = hash(readBytes(file));
    if (sha !== o['--approved-migration-sha256']) throw Error('TABLET_SCHEMA_APPROVED_MIGRATION_REQUIRED');
    if (o['--target'] === 'crm') {
        const manifest = privateJson(o['--backup-manifest']);
        if (manifest.database_target !== 'crm' || manifest.full_gzip_verified !== true || manifest.dump_completion_verified !== true) throw Error('TABLET_SCHEMA_VERIFIED_CRM_BACKUP_REQUIRED');
        await validateBackup(o['--backup-manifest']);
    }
    const c = await connectOperatorDatabase(o['--target']); let journal;
    try {
        await c.query('SET SESSION lock_wait_timeout=10');
        await acquireExecutorLocks(c, sha, path.resolve(o['--private-journal']));
        journal = openJournal(o['--private-journal'], sha);
        const Sequelize = require('sequelize'), sequelize = new Sequelize({ dialect: 'mysql', logging: false });
        sequelize.connectionManager.getConnection = async () => c.connection;
        sequelize.connectionManager.releaseConnection = async () => {};
        const q = sequelize.getQueryInterface();
        const before = await q.describeTable('ClinicTabletKiosks');
        const [meta] = await c.query('SELECT name FROM SequelizeMeta WHERE name=?', [NAME]);
        if (meta.length && !before.consent_group_id) throw Error('TABLET_SCHEMA_METADATA_DRIFT');
        await journal.append({ phase: 'before_additive_ddl', target: o['--target'], migration: NAME, sha256: sha, before,
            backup_manifest_sha256: o['--backup-manifest'] ? hash(readBytes(o['--backup-manifest'])) : null });
        await require(file).up(q, Sequelize);
        const after = await q.describeTable('ClinicTabletKiosks');
        if (!after.consent_group_id?.allowNull) throw Error('TABLET_SCHEMA_VERIFICATION_FAILED');
        if (!before.consent_group_id) {
            const [[row]] = await c.query('SELECT COUNT(*) AS total FROM ClinicTabletKiosks WHERE consent_group_id IS NOT NULL');
            if (Number(row.total)) throw Error('TABLET_SCHEMA_UNEXPECTED_OPT_IN');
        }
        if (!meta.length) await c.query('INSERT INTO SequelizeMeta(name) VALUES (?)', [NAME]);
        await journal.append({ phase: 'verified', target: o['--target'], migration: NAME, after });
        return { status: before.consent_group_id ? 'already_present_verified' : 'applied_verified', target: o['--target'], migration: NAME, device_grants_changed: 0, reminders_changed: 0 };
    } finally { journal?.close(); await c.end(); }
}
if (require.main === module) run(process.argv.slice(2)).then(r => console.log(JSON.stringify(r))).catch(e => {
    console.error(/^[A-Z_]+$/.test(e.message) ? e.message : 'TABLET_SCHEMA_FAILED_INSPECT_PRIVATE_JOURNAL'); process.exitCode = 1;
});
module.exports = { run, NAME };
