#!/usr/bin/env node
'use strict';

// Explicit operator CLI. Default is read-only dry-run. All inputs/outputs are
// private, pinned source files are hashed from their full bytes, and writable
// modes require an independent fresh scoped approval + exact verified backup.
const { hash } = require('../lib/cliniccloud-import/adapter');
const { parseArgs, writePrivateJson } = require('../lib/cliniccloud-import/io');
const { readPrivateBytes } = require('../lib/cliniccloud-import/bs-catalog-migration-journal');
const { connectOperatorDatabase } = require('../lib/cliniccloud-import/operator-database');
const { capturePiedadAppointmentSnapshot } = require('../lib/cliniccloud-import/bs-physical-profile-appointment-snapshot');
const contract = require('../lib/cliniccloud-import/bs-physical-profile-appointment-plan');
const executor = require('../lib/cliniccloud-import/bs-physical-profile-appointment-apply');
const fail = code => { throw Error(code); };
function jsonFile(filename) { const bytes = readPrivateBytes(filename); return { value: JSON.parse(bytes.toString('utf8')), sha256: hash(bytes) }; }
function readPlanInputs(options) {
    for (const key of ['--snapshot', '--source-calendar', '--source-history']) if (!options[key]) fail('BS_APPOINTMENT_INPUT_FILES_REQUIRED');
    const snapshot = jsonFile(options['--snapshot']), calendar = jsonFile(options['--source-calendar']), history = jsonFile(options['--source-history']);
    const sourceFileHashes = { calendar: calendar.sha256, history: history.sha256 };
    if (hash(sourceFileHashes) !== hash(contract.SOURCE_FILES)) fail('BS_APPOINTMENT_PINNED_ORIGINAL_FILES_CHANGED');
    const jointCsv = options['--approved-joint-pair'];
    if (jointCsv != null && !/^[1-9]\d*,[1-9]\d*$/.test(jointCsv)) fail('BS_APPOINTMENT_ONLY_EXACT_APPROVED_JOINT_PAIR_ALLOWED');
    return { snapshot: snapshot.value, calendarSource: calendar.value, historySource: history.value, sourceFileHashes,
        ...(jointCsv != null ? { approvedJointPair: contract.normalizeApprovedJointPair(jointCsv.split(',').map(Number)) } : {}) };
}
function createBackup(plan, snapshot, now = new Date()) {
    const assessment = executor.assessBatch({ plan, snapshot, direction: 'forward', last: null, now });
    const body = { version: 'bs-piedad-appointment-backup/1', target: 'crm', database: snapshot.database,
        generated_at: now.toISOString(), plan_sha256: plan.plan_sha256, state: assessment.state,
        verified_against_consistent_read_only_snapshot: true, no_app_bootstrap_or_events: true };
    return { ...body, backup_sha256: hash(body) };
}
async function run(args) {
    const options = parseArgs(args, ['--mode', '--target', '--snapshot', '--source-calendar', '--source-history', '--plan', '--approval', '--backup',
        '--journal', '--private-output', '--confirm-plan-sha256', '--max-operations', '--direction', '--approved-joint-pair']);
    const mode = options['--mode'] || 'dry-run';
    if (!['capture', 'plan', 'dry-run', 'backup', 'apply', 'rollback', 'recover'].includes(mode) || !options['--private-output']) fail('BS_APPOINTMENT_CLI_MODE_AND_PRIVATE_OUTPUT_REQUIRED');
    const writable = ['apply', 'rollback', 'recover'].includes(mode);
    if (options['--direction'] && (mode !== 'recover' || !['forward', 'rollback'].includes(options['--direction']))) fail('BS_APPOINTMENT_RECOVERY_DIRECTION_INVALID');
    if (mode !== 'plan' && options['--target'] !== 'crm') fail('BS_APPOINTMENT_EXPLICIT_CRM_TARGET_REQUIRED');
    if (mode === 'capture') {
        const db = await connectOperatorDatabase('crm');
        try {
            const snapshot = await capturePiedadAppointmentSnapshot(db); writePrivateJson(options['--private-output'], snapshot);
            return { mode: 'read_only_capture', candidates: snapshot.targets.length, snapshot_sha256: snapshot.snapshot_sha256, clinical_writes: 0 };
        } finally { await db.end(); }
    }
    const inputs = readPlanInputs(options);
    const plan = options['--plan'] ? jsonFile(options['--plan']).value : contract.buildPiedadAppointmentPlan(inputs);
    contract.verifyPiedadAppointmentPlan(plan, inputs);
    if (mode === 'plan') { writePrivateJson(options['--private-output'], plan); return { ...plan.summary, plan_sha256: plan.plan_sha256, clinical_writes: 0 }; }
    if (writable && (options['--confirm-plan-sha256'] !== plan.plan_sha256
        || !options['--plan'] || !options['--approval'] || !options['--backup'] || !options['--journal'])) fail('BS_APPOINTMENT_WRITE_REQUIRES_EXACT_PLAN_APPROVAL_BACKUP_JOURNAL');
    const backupFile = options['--backup'] ? jsonFile(options['--backup']) : null;
    const approval = options['--approval'] ? jsonFile(options['--approval']).value : null;
    const db = await connectOperatorDatabase('crm'); let journal;
    try {
        const store = executor.createPiedadAppointmentStore(db);
        if (mode === 'backup') {
            await store.begin(true);
            try { const snapshot = await store.readSnapshot(plan, false), backup = createBackup(plan, snapshot);
                writePrivateJson(options['--private-output'], backup);
                return { mode: 'read_only_backup', appointments: backup.state.appointments.length, backup_sha256: backup.backup_sha256, clinical_writes: 0 };
            } finally { await store.rollback(); }
        }
        if (options['--journal']) journal = executor.openPiedadAppointmentJournal(options['--journal'], plan.plan_sha256, { readOnly: !writable });
        const parameters = { plan, inputs, store, journal, approval, backup: backupFile?.value, backupFileSha256: backupFile?.sha256,
            direction: mode === 'rollback' ? 'rollback' : mode === 'recover' ? options['--direction'] || 'forward' : 'forward', dryRun: !writable,
            maxOperations: options['--max-operations'] ? Number(options['--max-operations']) : 50 };
        const result = mode === 'recover' ? await executor.recoverPiedadAppointmentMigration(parameters) : await executor.executePiedadAppointmentMigration(parameters);
        writePrivateJson(options['--private-output'], result); return result;
    } finally { journal?.close(); await db.end(); }
}
if (require.main === module) run(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result, null, 2) + '\n')).catch(error => {
    process.stderr.write(/^BS_APPOINTMENT_[A-Z0-9_]+$/.test(error.message) ? `${error.message}\n` : 'BS_APPOINTMENT_OPERATOR_FAILED_NO_UNREVIEWED_ACTION\n'); process.exitCode = 1;
});
module.exports = { run, readPlanInputs, createBackup };
