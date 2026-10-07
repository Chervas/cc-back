#!/usr/bin/env node
'use strict';

// Catalogue files only. No database/env credentials/runtime/network imports.
const { TextDecoder } = require('node:util');
const { hash } = require('../lib/cliniccloud-import/adapter');
const { parseCsv } = require('../lib/cliniccloud-import/csv');
const { MATRIX_FILE_SHA } = require('../lib/cliniccloud-import/catalog-preflight');
const { COLUMNS } = require('../lib/cliniccloud-import/catalog-matrix');
const { readBytes, parseArgs, writePrivateJson } = require('../lib/cliniccloud-import/io');
const { buildBsCatalogMigrationPlan } = require('../lib/cliniccloud-import/bs-catalog-migration-plan');

function run(args) {
    const options = parseArgs(args, ['--matrix', '--snapshot', '--private-output', '--badge']);
    if (!options['--matrix'] || !options['--snapshot'] || !options['--private-output']) throw Error('BS_PLAN_THREE_FILE_OPTIONS_REQUIRED');
    const matrixBytes = readBytes(options['--matrix']), snapshotBytes = readBytes(options['--snapshot']);
    if (hash(matrixBytes) !== MATRIX_FILE_SHA) throw Error('BS_PLAN_PINNED_MATRIX_HASH_MISMATCH');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const matrixRows = parseCsv(decoder.decode(matrixBytes), { required: COLUMNS }).map(row => row.values);
    const preflight = JSON.parse(decoder.decode(snapshotBytes));
    const plan = buildBsCatalogMigrationPlan({ matrixRows, preflight, matrixFileSha256: hash(matrixBytes),
        snapshotFileSha256: hash(snapshotBytes), ...(options['--badge'] ? { badge: options['--badge'] } : {}) });
    writePrivateJson(options['--private-output'], plan);
    return { ...plan.summary, plan_sha256: plan.plan_sha256, originals_modified: false, applicator_present: false };
}
if (require.main === module) {
    try { process.stdout.write(JSON.stringify(run(process.argv.slice(2)), null, 2) + '\n'); }
    catch (error) { process.stderr.write(/^BS_PLAN_[A-Z0-9_]+$/.test(error.message) ? error.message + '\n' : 'BS_PLAN_OFFLINE_FAILED_NO_WRITES\n'); process.exitCode = 1; }
}
module.exports = { run };
