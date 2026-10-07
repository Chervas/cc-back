'use strict';

// Injected connection only. This writer cannot alter activation, prices,
// appointments, entitlements, documents or existing physical profiles.
const { randomUUID } = require('node:crypto');
const { hash } = require('./adapter');
const contract = require('./bs-physical-profile-migration-plan');
const { QUERIES, LIMITS } = require('./catalog-preflight');
const { createBsCatalogMigrationStore } = require('./bs-catalog-migration-store');
const { materializedRow, dataSha, fullSha } = require('./bs-catalog-migration-apply');
const { openBsCatalogJournal, readPrivateBytes, readJournalEntries } = require('./bs-catalog-migration-journal');
const VERSION = 'bs-physical-profile-migration-executor/1';
const APPROVAL_VERSION = 'bs-physical-profile-operator-approval/1';
const same = (a, b) => hash(a) === hash(b);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = code => { throw Error(code); };
function verifyPhysicalAuthorization({ plan, approval, backup, direction, now, recovery = false }) {
    const created = Date.parse(approval?.created_at), expires = Date.parse(approval?.expires_at), time = now.getTime();
    if (approval?.version !== APPROVAL_VERSION || approval.plan_sha256 !== plan.plan_sha256 || approval.direction !== direction
        || approval.target !== 'crm' || approval.group_id !== 29 || !same(approval.clinic_ids, [66, 72])
        || !same(approval.field_whitelist, contract.FIELD_WHITELIST) || approval.recipe_review_sha256 !== plan.recipe_review_sha256
        || approval.matrix_file_sha256 !== plan.matrix_file_sha256 || approval.snapshot_file_sha256 !== plan.snapshot_file_sha256
        || approval.physical_profiles_only !== true || approval.missing_profiles_only !== true
        || approval.no_activation_or_appointment_history_changes !== true
        || typeof approval.operator_identity !== 'string' || !approval.operator_identity.trim()
        || !Number.isFinite(created) || !Number.isFinite(expires) || created > time || time - created > 7200000
        || expires <= time || expires - created > 7200000 || (recovery && approval.recover_indeterminate_commit !== true)
        || backup?.verified !== true || backup.target !== 'crm' || backup.group_id !== 29 || !same(backup.clinic_ids, [66, 72])
        || !sha(backup.manifest_file_sha256) || !sha(backup.backup_sha256)
        || approval.backup_manifest_sha256 !== backup.manifest_file_sha256 || approval.database !== backup.database
        || typeof backup.database !== 'string' || !backup.database || !Number.isFinite(Date.parse(backup.generated_at))
        || Date.parse(backup.generated_at) > time || time - Date.parse(backup.generated_at) > 43200000)
        fail('BS_PHYSICAL_FRESH_SCOPED_APPROVAL_AND_BACKUP_REQUIRED');
}
function validatePhysicalReceipt(receipt, plan, op, direction) {
    const { receipt_sha256, ...body } = receipt || {};
    if (receipt?.version !== VERSION || !sha(receipt_sha256) || hash(body) !== receipt_sha256
        || receipt.plan_sha256 !== plan.plan_sha256 || receipt.operation_sha256 !== op.operation_sha256
        || receipt.direction !== direction || receipt.treatment_id !== op.treatment_id || receipt.clinic_id !== op.clinic_id
        || fullSha(receipt.before_row) !== receipt.before_row_sha256 || fullSha(receipt.after_row) !== receipt.after_row_sha256
        || dataSha(receipt.before_row) !== dataSha(direction === 'forward' ? op.before : op.after)
        || dataSha(receipt.after_row) !== dataSha(direction === 'forward' ? op.after : op.before)) fail('BS_PHYSICAL_RECEIPT_INVALID');
    return true;
}
function physicalJournalState(entries, plan, op, { allowUnfinished = false } = {}) {
    const attempts = new Map(), relevant = entries.filter(entry => entry.operation_sha256 === op.operation_sha256);
    for (const entry of relevant) {
        const previous = attempts.get(entry.attempt_id);
        if (entry.plan_sha256 !== plan.plan_sha256 || !['forward', 'rollback'].includes(entry.direction)
            || typeof entry.attempt_id !== 'string' || !entry.attempt_id || !['prepared', 'written_before_commit', 'committed', 'aborted'].includes(entry.stage)
            || (entry.stage === 'prepared' ? previous : !previous || previous.direction !== entry.direction
                || entry.stage === 'written_before_commit' && previous.stage !== 'prepared'
                || entry.stage === 'committed' && previous.stage !== 'written_before_commit'
                || entry.stage === 'aborted' && !['prepared', 'written_before_commit'].includes(previous.stage)))
            fail('BS_PHYSICAL_JOURNAL_SEQUENCE_INVALID');
        if (['written_before_commit', 'committed'].includes(entry.stage)) {
            validatePhysicalReceipt(entry.receipt, plan, op, entry.direction);
            if (entry.stage === 'written_before_commit' && (entry.receipt.before_row_sha256 !== previous.before_row_sha256
                || dataSha(entry.receipt.after_row) !== previous.target_data_sha256 || entry.receipt.attempt_id !== entry.attempt_id)
                || entry.stage === 'committed' && !same(entry.receipt, previous.receipt)) fail('BS_PHYSICAL_JOURNAL_RECEIPT_CHANGED');
        }
        attempts.set(entry.attempt_id, entry);
    }
    const unfinished = [...attempts.values()].filter(entry => ['prepared', 'written_before_commit'].includes(entry.stage));
    if (unfinished.length && !allowUnfinished) fail('BS_PHYSICAL_UNFINISHED_ATTEMPT_REQUIRES_REVIEW');
    return { lastCommitted: relevant.filter(entry => entry.stage === 'committed').at(-1), unfinished };
}
function assessPhysicalRow({ op, current, direction, lastCommitted }) {
    if (!current || Number(current.id_tratamiento) !== op.treatment_id || Number(current.clinica_id) !== op.clinic_id)
        return 'scope_or_row_missing';
    const target = direction === 'forward' ? op.after : op.before;
    if (dataSha(current) === dataSha(target)) return lastCommitted?.direction === direction
        && fullSha(current) === lastCommitted.receipt.after_row_sha256 ? 'already_at_target_no_write' : 'target_without_exact_committed_receipt';
    if (direction === 'rollback') return lastCommitted?.direction === 'forward'
        && fullSha(current) === lastCommitted.receipt.after_row_sha256 ? 'cas_matches' : 'later_row_change_or_missing_receipt_prevents_rollback';
    const expected = lastCommitted?.direction === 'rollback' ? lastCommitted.receipt.after_row : op.before;
    return fullSha(current) === fullSha(expected) ? 'cas_matches' : 'later_row_change_stop';
}
function createBsPhysicalProfileMigrationStore(connection, { readOnly = true } = {}) {
    const base = createBsCatalogMigrationStore(connection, { readOnly });
    const { writeTreatment: unusedCommercialWriter, ...readAndTransactionMethods } = base;
    let locked = false;
    return { ...readAndTransactionMethods,
        async acquireExecutionLock() {
            const [rows] = await connection.query('SELECT GET_LOCK(?,0) AS acquired', ['bs-catalog:crm:group29']);
            if (Number(rows[0]?.acquired) !== 1) fail('BS_PHYSICAL_EXECUTOR_ALREADY_RUNNING');
            locked = true;
        },
        async releaseExecutionLock() {
            if (locked) { await connection.query('SELECT RELEASE_LOCK(?) AS released', ['bs-catalog:crm:group29']); locked = false; }
        },
        async readPhysicalResources({ lock = false } = {}) {
            if (lock && readOnly) fail('BS_PHYSICAL_READ_ONLY_RESOURCE_LOCK');
            const tables = ['Instalaciones', 'InstallationPhysicalAliases', 'DoctorClinicas', 'BookingEquipment',
                'BookingEquipmentClinics', 'BookingEquipmentRoomPolicies'];
            const [engines] = await connection.query('SELECT TABLE_NAME,ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?)', [tables]);
            if (engines.length !== tables.length || engines.some(row => row.ENGINE !== 'InnoDB')) fail('BS_PHYSICAL_TRANSACTIONAL_RESOURCES_REQUIRED');
            const snapshot = {};
            for (const key of contract.RESOURCE_KEYS) {
                const [rows] = await connection.query(QUERIES[key] + (lock ? ' LOCK IN SHARE MODE' : ''));
                if (!Array.isArray(rows) || rows.length > LIMITS[key]) fail('BS_PHYSICAL_RESOURCE_SCOPE_LIMIT_EXCEEDED');
                snapshot[key] = rows;
            }
            return snapshot;
        },
        async writePhysicalTreatment({ plan, op, current, target, direction }) {
            if (readOnly) fail('BS_PHYSICAL_READ_ONLY_STORE');
            const live = await this.readTreatment(op.treatment_id, op.clinic_id, { lock: true });
            if (!live || fullSha(live) !== fullSha(current)) fail('BS_PHYSICAL_LOCKED_ROW_CAS_FAILED');
            await this.verifyScope({ inTransaction: true });
            contract.validatePhysicalStoragePatch({ op, current: live, target, direction });
            const resources = await this.readPhysicalResources({ lock: true });
            if (hash(resources) !== plan.resource_snapshot_sha256) fail('BS_PHYSICAL_RESOURCE_DRIFT_STOP');
            const [result] = await connection.query('UPDATE Tratamientos SET clinical_config=?,updatedAt=UTC_TIMESTAMP(6) WHERE id_tratamiento=? AND clinica_id=? AND updatedAt <=> ?',
                [JSON.stringify(target.clinical_config), op.treatment_id, op.clinic_id, live.updatedAt]);
            if (result.affectedRows !== 1) fail('BS_PHYSICAL_SQL_CAS_UPDATE_COUNT_INVALID');
        },
    };
}
function openBsPhysicalProfileMigrationJournal(filename, planSha256, options) {
    const journal = openBsCatalogJournal(filename, planSha256, options);
    return { ...journal, async reload() {
        // Always refresh after the database-wide executor lock. A handle opened
        // earlier must not append from an obsolete sequence/hash-chain cache.
        const fresh = readJournalEntries(readPrivateBytes(journal.filename), planSha256);
        journal.entries.splice(0, journal.entries.length, ...fresh);
    } };
}
function optionsValid({ direction, dryRun, maxOperations, now, store, journal }) {
    if (!['forward', 'rollback'].includes(direction) || typeof dryRun !== 'boolean'
        || !Number.isSafeInteger(maxOperations) || maxOperations < 1 || maxOperations > 167
        || !(now instanceof Date) || !Number.isFinite(now.getTime()) || !store || typeof store.verifyScope !== 'function'
        || !dryRun && (!journal || !Array.isArray(journal.entries) || typeof journal.append !== 'function'
            || typeof journal.reload !== 'function'
            || typeof store.acquireExecutionLock !== 'function' || typeof store.releaseExecutionLock !== 'function'))
        fail('BS_PHYSICAL_EXECUTION_OPTIONS_INVALID');
}
async function executeBsPhysicalProfileMigration({ plan, sourceInputs, store, journal, approval, backup,
    direction = 'forward', dryRun = true, maxOperations = 25, now = new Date(), attemptId = randomUUID } = {}) {
    contract.verifyPhysicalPlan(plan, sourceInputs);
    optionsValid({ direction, dryRun, maxOperations, now, store, journal });
    if (typeof attemptId !== 'function') fail('BS_PHYSICAL_EXECUTION_OPTIONS_INVALID');
    if (!dryRun) verifyPhysicalAuthorization({ plan, approval, backup, direction, now });
    const outcomes = [], summary = { mode: dryRun ? 'read_only_dry_run' : direction, plan_sha256: plan.plan_sha256,
        inspected: 0, would_write: 0, written: 0, no_write: 0, conflicts: 0,
        activation_changed: false, appointment_snapshots_or_entitlements_changed: false, per_row_transactions: true };
    if (!dryRun) await store.acquireExecutionLock();
    try {
        if (!dryRun) await journal.reload();
        await store.verifyScope({ expectedDatabase: dryRun ? undefined : backup.database });
        const operations = direction === 'rollback' ? [...plan.operations].reverse() : plan.operations;
        for (const op of operations) {
            if (!dryRun && summary.written >= maxOperations) break;
            const { lastCommitted } = physicalJournalState(journal?.entries || [], plan, op);
            let transactionOpen = false, commitAttempted = false, prepared = false;
            const id = attemptId(), event = { plan_sha256: plan.plan_sha256, operation_sha256: op.operation_sha256,
                direction, attempt_id: id, approval_sha256: dryRun ? null : hash(approval), backup_manifest_sha256: backup?.manifest_file_sha256 || null };
            try {
                await store.begin({ readOnly: dryRun }); transactionOpen = true;
                await store.verifyScope({ expectedDatabase: dryRun ? undefined : backup.database, inTransaction: true });
                const current = await store.readTreatment(op.treatment_id, op.clinic_id, { lock: !dryRun });
                const resources = await store.readPhysicalResources({ lock: !dryRun });
                if (hash(resources) !== plan.resource_snapshot_sha256) fail('BS_PHYSICAL_RESOURCE_DRIFT_STOP');
                const decision = assessPhysicalRow({ op, current, direction, lastCommitted }); summary.inspected++;
                if (decision !== 'cas_matches') {
                    await store.rollback(); transactionOpen = false;
                    const okay = decision === 'already_at_target_no_write'; summary[okay ? 'no_write' : 'conflicts']++;
                    outcomes.push({ treatment_id: op.treatment_id, decision });
                    if (!okay && !dryRun) fail('BS_PHYSICAL_CAS_CONFLICT_STOP');
                    continue;
                }
                summary.would_write++;
                if (dryRun) { await store.rollback(); transactionOpen = false;
                    outcomes.push({ treatment_id: op.treatment_id, decision: 'would_write_reviewed_missing_profile' }); continue; }
                const target = materializedRow(direction === 'forward' ? op.after : op.before);
                await journal.append({ ...event, stage: 'prepared', before_row: materializedRow(current),
                    before_row_sha256: fullSha(current), target_data_sha256: dataSha(target) }); prepared = true;
                await store.writePhysicalTreatment({ plan, op, current, target, direction });
                const actual = await store.readTreatment(op.treatment_id, op.clinic_id, { lock: true });
                if (!actual || dataSha(actual) !== dataSha(target)) fail('BS_PHYSICAL_POST_WRITE_VERIFICATION_FAILED');
                const body = { version: VERSION, ...event, treatment_id: op.treatment_id, clinic_id: op.clinic_id,
                    before_row: materializedRow(current), before_row_sha256: fullSha(current),
                    after_row: materializedRow(actual), after_row_sha256: fullSha(actual) };
                const receipt = { ...body, receipt_sha256: hash(body) }; validatePhysicalReceipt(receipt, plan, op, direction);
                await journal.append({ ...event, stage: 'written_before_commit', receipt });
                commitAttempted = true; await store.commit(); transactionOpen = false;
                await journal.append({ ...event, stage: 'committed', receipt }); summary.written++;
                outcomes.push({ treatment_id: op.treatment_id, decision: 'committed', receipt_sha256: receipt.receipt_sha256 });
            } catch (error) {
                if (transactionOpen) await store.rollback().catch(() => {});
                if (commitAttempted) fail('BS_PHYSICAL_INDETERMINATE_COMMIT_REQUIRES_REVIEW');
                if (prepared) await journal.append({ ...event, stage: 'aborted' }).catch(() => {});
                error.summary = { ...summary }; throw error;
            }
        }
        summary.remaining_uninspected = plan.operations.length - summary.inspected;
        return { version: VERSION, summary, outcomes };
    } finally { if (!dryRun) await store.releaseExecutionLock(); }
}
async function recoverBsPhysicalProfileMigration({ plan, sourceInputs, store, journal, approval, backup,
    direction = 'forward', now = new Date() } = {}) {
    contract.verifyPhysicalPlan(plan, sourceInputs);
    optionsValid({ direction, dryRun: false, maxOperations: 25, now, store, journal });
    verifyPhysicalAuthorization({ plan, approval, backup, direction, now, recovery: true });
    await store.acquireExecutionLock();
    const recovered = [];
    try {
        await journal.reload();
        await store.verifyScope({ expectedDatabase: backup.database });
        for (const op of plan.operations) {
            const { unfinished } = physicalJournalState(journal.entries, plan, op, { allowUnfinished: true });
            if (unfinished.length > 1) fail('BS_PHYSICAL_MULTIPLE_UNFINISHED_ATTEMPTS_REQUIRE_REVIEW');
            for (const entry of unfinished) {
                if (entry.direction !== direction) fail('BS_PHYSICAL_RECOVERY_DIRECTION_APPROVAL_MISMATCH');
                await store.begin({ readOnly: false });
                try {
                    const current = await store.readTreatment(op.treatment_id, op.clinic_id, { lock: true });
                    let stage;
                    if (entry.stage === 'written_before_commit' && current && fullSha(current) === entry.receipt.after_row_sha256) stage = 'committed';
                    else if (current && fullSha(current) === entry.before_row_sha256
                        || entry.stage === 'written_before_commit' && current && fullSha(current) === entry.receipt.before_row_sha256) stage = 'aborted';
                    else fail('BS_PHYSICAL_RECOVERY_ROW_CHANGED_REQUIRES_REVIEW');
                    await journal.append({ plan_sha256: plan.plan_sha256, operation_sha256: op.operation_sha256,
                        direction: entry.direction, attempt_id: entry.attempt_id, stage,
                        ...(stage === 'committed' ? { receipt: entry.receipt } : {}),
                        recovery_approval_sha256: hash(approval), recovery_verified_full_row_sha256: fullSha(current) });
                    recovered.push({ treatment_id: op.treatment_id, decision: stage });
                } finally { await store.rollback(); }
            }
        }
        return { version: VERSION, recovered, profile_writes: 0, activation_changed: false, appointment_history_changed: false };
    } finally { await store.releaseExecutionLock(); }
}
module.exports = { VERSION, APPROVAL_VERSION, verifyPhysicalAuthorization, validatePhysicalReceipt, physicalJournalState,
    assessPhysicalRow, createBsPhysicalProfileMigrationStore, openBsPhysicalProfileMigrationJournal,
    executeBsPhysicalProfileMigration, recoverBsPhysicalProfileMigration };
