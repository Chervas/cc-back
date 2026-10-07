#!/usr/bin/env node
'use strict';

// Dry-run defaults to the supplied offline snapshot: NO environment/DB read.
// inspect is explicitly live/read-only; apply/rollback require fresh, scoped
// approval and a verified backup. This file has not been run against a DB.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { hash } = require('../lib/cliniccloud-import/adapter');
const { parseCsv } = require('../lib/cliniccloud-import/csv');
const { COLUMNS } = require('../lib/cliniccloud-import/catalog-matrix');
const { MATRIX_FILE_SHA } = require('../lib/cliniccloud-import/catalog-preflight');
const { VERSION: VISIBILITY_VERSION, LEGACY_SERVICES_SHA, buildBsCatalogVisibilityPlan } = require('../lib/cliniccloud-import/bs-catalog-visibility-plan');
const { verifyPlan, verifyAuthorization, executeBsCatalogMigration } = require('../lib/cliniccloud-import/bs-catalog-migration-apply');
const { createBsCatalogMigrationStore } = require('../lib/cliniccloud-import/bs-catalog-migration-store');
const { readPrivateBytes, privatePath, openBsCatalogJournal, acquireBsCatalogExecutorLocks } = require('../lib/cliniccloud-import/bs-catalog-migration-journal');
const { parseArgs, writePrivateJson, PRIVATE_ROOT } = require('../lib/cliniccloud-import/io');
const physical = require('../lib/cliniccloud-import/bs-physical-profile-migration-plan');
const physicalWriter = require('../lib/cliniccloud-import/bs-physical-profile-migration-apply');
const fail = code => { throw Error(code); };
const readJson = filename => JSON.parse(readPrivateBytes(filename).toString('utf8'));
function readOriginalServices(filename) {
    // Original source folders predate private artifact directories. Do not chmod
    // or rewrite them: accept their existing layout only for the pinned source,
    // using a private, bounded, non-symlink file descriptor and content hash.
    const root = fs.realpathSync(PRIVATE_ROOT), parent = fs.realpathSync(path.dirname(filename));
    if (!path.isAbsolute(filename || '') || !parent.startsWith(`${root}${path.sep}`)) fail('BS_CATALOG_ORIGINAL_SOURCE_PATH_REQUIRED');
    const descriptor = fs.openSync(path.join(parent, path.basename(filename)), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const stat = fs.fstatSync(descriptor);
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 64 * 1024 * 1024) fail('BS_CATALOG_ORIGINAL_SOURCE_FILE_INVALID');
        return fs.readFileSync(descriptor);
    } finally { fs.closeSync(descriptor); }
}
function sourceInputs(options, needsLegacy) {
    const matrix = readPrivateBytes(options['--matrix']), snapshot = readPrivateBytes(options['--snapshot']);
    if (hash(matrix) !== MATRIX_FILE_SHA) fail('BS_CATALOG_PINNED_MATRIX_CHANGED');
    const input = { matrixRows: parseCsv(matrix.toString('utf8'), { required: COLUMNS }).map(r => r.values),
        preflight: JSON.parse(snapshot.toString('utf8')), matrixFileSha256: hash(matrix), snapshotFileSha256: hash(snapshot) };
    if (needsLegacy) {
        const services = readOriginalServices(options['--legacy-services']);
        if (hash(services) !== LEGACY_SERVICES_SHA) fail('BS_CATALOG_PINNED_LEGACY_SOURCE_CHANGED');
        input.legacyServices = parseCsv(services.toString('utf8'), { required: ['idServicio', 'idEmpresa', 'nombre'] });
        input.legacyServicesFileSha256 = hash(services);
    }
    return input;
}
function offlineSnapshotStore(snapshot) {
    return { async verifyScope() {}, async begin() {}, async rollback() {}, async readTreatment(id, clinic) {
        const row = snapshot.treatments.find(r => r.id_tratamiento === id && r.clinica_id === clinic);
        return row ? JSON.parse(JSON.stringify(row)) : null;
    } };
}
async function verifiedBackup(filename) {
    // Existing backup verification streams and hashes the actual compressed SQL
    // file. The additional manifest scope is mandatory, not inferred from paths.
    const bytes = readPrivateBytes(filename), manifest = JSON.parse(bytes);
    if (manifest.target !== 'crm' || manifest.group_id !== 29 || hash(manifest.clinic_ids) !== hash([66, 72])
        || typeof manifest.database !== 'string' || !manifest.database) fail('BS_CATALOG_BACKUP_SCOPE_REQUIRED');
    const backupPath = path.join(path.dirname(privatePath(filename)), 'database-before.sql.gz');
    privatePath(backupPath);
    const metadata = fs.lstatSync(backupPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.uid !== process.getuid() || (metadata.mode & 0o077)) fail('BS_CATALOG_BACKUP_PRIVATE_FILE_REQUIRED');
    const verified = await require('./cliniccloud-import-contacts-apply').validateBackup(filename);
    return { verified: true, target: manifest.target, group_id: manifest.group_id, clinic_ids: manifest.clinic_ids,
        database: manifest.database, generated_at: verified.generated_at, backup_sha256: verified.backup_sha256,
        manifest_file_sha256: hash(bytes) };
}
async function run(args) {
    const o = parseArgs(args, ['--mode', '--target', '--plan', '--matrix', '--snapshot', '--legacy-services', '--approval',
        '--backup-manifest', '--private-journal', '--private-output', '--approved-plan-sha256', '--max-operations', '--direction',
        '--physical-reconciliation', '--physical-recipe-review', '--physical-source-plan', '--physical-resource-map']);
    const mode = o['--mode'] || 'dry-run';
    if (!['prepare-visibility', 'prepare-physical', 'dry-run', 'inspect', 'apply', 'rollback', 'recover-physical'].includes(mode) || !o['--matrix'] || !o['--snapshot'] || !o['--private-output']
        || (o['--target'] !== undefined && o['--target'] !== 'crm')) fail('BS_CATALOG_EXPLICIT_SCOPED_INPUTS_REQUIRED');
    if (fs.existsSync(privatePath(o['--private-output']))) fail('BS_CATALOG_EXCLUSIVE_NEW_OUTPUT_REQUIRED');
    const live = ['inspect', 'apply', 'rollback'].includes(mode) || mode === 'recover-physical';
    if (live && (o['--target'] !== 'crm' || process.cwd() !== '/home/ubuntu/wt/back-dev'
        || path.resolve(__dirname, '../..') !== '/home/ubuntu/wt/back-dev'
        || execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim() !== 'dev')) fail('BS_CATALOG_DEV_OPERATOR_CRM_TARGET_REQUIRED');
    const preparation = ['prepare-visibility', 'prepare-physical'].includes(mode);
    const plan = preparation ? null : readJson(o['--plan']);
    const physicalMode = mode === 'prepare-physical' || plan?.version === physical.VERSION;
    if (mode === 'recover-physical' && !physicalMode) fail('BS_PHYSICAL_RECOVERY_PLAN_REQUIRED');
    const inputs = sourceInputs(o, mode === 'prepare-visibility' || plan?.version === VISIBILITY_VERSION);
    if (physicalMode) {
        if (['--physical-reconciliation', '--physical-recipe-review', '--physical-source-plan', '--physical-resource-map'].some(key => !o[key]))
            fail('BS_PHYSICAL_ORIGINAL_INPUTS_AND_RECIPE_REVIEW_REQUIRED');
        const mapBytes = readPrivateBytes(o['--physical-resource-map']);
        if (hash(mapBytes) !== require('./bs-physical-profile-reconciliation-offline').RESOURCE_MAP_FILE_SHA)
            fail('BS_PHYSICAL_PINNED_RESOURCE_MAP_CHANGED');
        inputs.reconciliation = readJson(o['--physical-reconciliation']); inputs.recipeReview = readJson(o['--physical-recipe-review']);
        inputs.sourcePlan = readJson(o['--physical-source-plan']); inputs.resourceMap = JSON.parse(mapBytes.toString('utf8'));
        inputs.resourceMapSha256 = hash(inputs.resourceMap);
    }
    if (mode === 'prepare-visibility') {
        const prepared = buildBsCatalogVisibilityPlan(inputs); writePrivateJson(o['--private-output'], prepared);
        return { mode: 'offline_visibility_preparation', plan_sha256: prepared.plan_sha256, ...prepared.summary };
    }
    if (mode === 'prepare-physical') {
        const prepared = physical.buildBsPhysicalProfileMigrationPlan(inputs); writePrivateJson(o['--private-output'], prepared);
        return { mode: 'offline_reviewed_physical_preparation', plan_sha256: prepared.plan_sha256, ...prepared.summary };
    }
    const verify = physicalMode ? physical.verifyPhysicalPlan : verifyPlan;
    const authorize = physicalMode ? physicalWriter.verifyPhysicalAuthorization : verifyAuthorization;
    verify(plan, inputs);
    const dryRun = !['apply', 'rollback', 'recover-physical'].includes(mode), direction = mode === 'rollback' ? 'rollback' : o['--direction'] || 'forward';
    if (!dryRun && mode !== 'recover-physical' && o['--direction'] !== undefined) fail('BS_CATALOG_DIRECTION_FROM_MUTATION_MODE_ONLY');
    const maxOperations = o['--max-operations'] === undefined ? 25 : Number(o['--max-operations']);
    if (!Number.isSafeInteger(maxOperations) || maxOperations < 1 || maxOperations > (physicalMode ? 167 : 200)
        || !['forward', 'rollback'].includes(direction)) fail('BS_CATALOG_EXECUTION_OPTIONS_INVALID');
    let approval, backup, connection, journal;
    try {
        if (!dryRun) {
            if (!o['--approval'] || !o['--backup-manifest'] || !o['--private-journal'] || o['--approved-plan-sha256'] !== plan.plan_sha256) fail('BS_CATALOG_APPROVAL_BACKUP_JOURNAL_REQUIRED');
            approval = readJson(o['--approval']); backup = await verifiedBackup(o['--backup-manifest']);
            authorize({ plan, approval, backup, direction, now: new Date(), recovery: mode === 'recover-physical' });
        }
        if (live) {
            // No connect or .env read occurs in offline default/preparation modes.
            connection = await require('../lib/cliniccloud-import/operator-database').connectOperatorDatabase('crm');
            if (!dryRun) {
                await acquireBsCatalogExecutorLocks(connection, plan.plan_sha256, o['--private-journal']);
                journal = physicalMode ? physicalWriter.openBsPhysicalProfileMigrationJournal(o['--private-journal'], plan.plan_sha256)
                    : openBsCatalogJournal(o['--private-journal'], plan.plan_sha256);
            }
        }
        if (dryRun && o['--private-journal']) journal = openBsCatalogJournal(o['--private-journal'], plan.plan_sha256, { readOnly: true });
        const store = live ? physicalMode ? physicalWriter.createBsPhysicalProfileMigrationStore(connection, { readOnly: dryRun })
            : createBsCatalogMigrationStore(connection, { readOnly: dryRun }) : offlineSnapshotStore(inputs.preflight.snapshot);
        if (!live && physicalMode) store.readPhysicalResources = async () => physical.resourceSnapshot(inputs.preflight.snapshot);
        const executor = mode === 'recover-physical' ? physicalWriter.recoverBsPhysicalProfileMigration
            : physicalMode ? physicalWriter.executeBsPhysicalProfileMigration : executeBsCatalogMigration;
        const result = await executor({ plan, sourceInputs: inputs, store, journal, approval, backup, direction, dryRun, maxOperations });
        result.execution_scope = live ? 'explicit_crm_connection' : 'offline_snapshot_no_environment_or_database';
        writePrivateJson(o['--private-output'], result);
        return { ...(result.summary || { recovered: result.recovered, profile_writes: result.profile_writes }),
            execution_scope: result.execution_scope, durable_journal_used: Boolean(journal && !dryRun) };
    } finally { journal?.close(); if (connection) await connection.end(); }
}
if (require.main === module) run(process.argv.slice(2)).then(summary => process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)).catch(error => {
    process.stderr.write(`${/^[A-Z][A-Z0-9_:]+$/.test(error.message) ? error.message : 'BS_CATALOG_MIGRATION_OPERATOR_FAILED'}\n`); process.exitCode = 1;
});
module.exports = { run, sourceInputs, offlineSnapshotStore, verifiedBackup, readOriginalServices };
