#!/usr/bin/env node
'use strict';

// Explicit operator command; importing this module has no database side effect.
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { hash } = require('../lib/cliniccloud-import/adapter');
const { parseCsv } = require('../lib/cliniccloud-import/csv');
const { parseArgs, readBytes, writePrivateJson } = require('../lib/cliniccloud-import/io');
const { connectOperatorDatabase } = require('../lib/cliniccloud-import/operator-database');
const { VERSION, MATRIX_FILE_SHA, checkedMatrix, captureCatalog, reconcileCatalog } = require('../lib/cliniccloud-import/catalog-preflight');

async function run(args, dependencies = {}) {
    const options = parseArgs(args, ['--target', '--matrix', '--private-output']);
    if (options['--target'] !== 'crm' || !options['--matrix'] || !options['--private-output']) throw Error('EXPLICIT_CRM_READONLY_PREFLIGHT_REQUIRED');
    if (process.cwd() !== '/home/ubuntu/wt/back-dev' || path.resolve(__dirname, '../..') !== process.cwd()
        || execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim() !== 'dev') throw Error('DEV_OPERATOR_WORKTREE_REQUIRED');
    const bytes = (dependencies.readBytes || readBytes)(options['--matrix']);
    if (hash(bytes) !== MATRIX_FILE_SHA) throw Error('PREFLIGHT_MATRIX_FILE_CHANGED');
    const rows = parseCsv(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).map(row => row.values);
    checkedMatrix(rows);
    const connection = await (dependencies.connect || connectOperatorDatabase)('crm');
    try {
        await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
        const snapshot = await captureCatalog(connection);
        const reconciliation = reconcileCatalog(rows, snapshot);
        const result = { version: VERSION, target: 'crm', mode: 'read_only', group_id: 29,
            created_at: new Date().toISOString(), matrix_file_sha256: MATRIX_FILE_SHA,
            snapshot, snapshot_sha256: hash(snapshot), reconciliation,
            policy: { database_written: false, patient_rows_exported: false, application_bootstrapped: false,
                reminders_sent: false, protocols_approved: false, treatments_activated: false,
                existing_entitlements_unchanged: true } };
        await connection.rollback();
        (dependencies.write || writePrivateJson)(options['--private-output'], result);
        return { status: 'captured_read_only', ...reconciliation.summary,
            inventory_counts: Object.fromEntries(Object.entries(snapshot).map(([key, value]) => [key, value.length])),
            snapshot_sha256: result.snapshot_sha256 };
    } catch (error) {
        await connection.rollback().catch(() => {});
        throw error;
    } finally { await connection.end(); }
}

if (require.main === module) run(process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(/^PREFLIGHT_[A-Z_]+$|^EXPLICIT_CRM_READONLY_PREFLIGHT_REQUIRED$|^DEV_OPERATOR_WORKTREE_REQUIRED$/.test(error.message)
        ? error.message : 'PREFLIGHT_CAPTURE_FAILED_NO_WRITES');
    process.exitCode = 1;
});
module.exports = { run };
