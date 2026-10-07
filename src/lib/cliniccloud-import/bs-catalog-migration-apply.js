'use strict';

// Explicit operator API; importing this file never connects or writes. The
// default is read-only dry-run. Each row is a separate transaction, not a promise
// of batch atomicity. Durable journal intents precede every possible commit.
const { randomUUID } = require('node:crypto');
const { hash } = require('./adapter');
const commercial = require('./bs-catalog-migration-plan');
const visibility = require('./bs-catalog-visibility-plan');
const VERSION = 'bs-catalog-migration-executor/1';
const copy = value => JSON.parse(JSON.stringify(value));
const fail = code => { throw Error(code); };
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const same = (a, b) => hash(a) === hash(b);
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
function whitelist(plan) {
    if (plan.version === commercial.VERSION) return commercial.FIELD_WHITELIST;
    if (plan.version === visibility.VERSION) return visibility.FIELD_WHITELIST;
    fail('BS_CATALOG_PLAN_VERSION_INVALID');
}
function verifyPlan(plan, sourceInputs) {
    const fields = whitelist(plan), { plan_sha256, ...body } = plan;
    if (!sha(plan_sha256) || hash(body) !== plan_sha256 || !same(plan.field_whitelist, fields)
        || plan.target !== 'crm' || plan.group_id !== 29) fail('BS_CATALOG_PLAN_INTEGRITY_INVALID');
    const rebuild = plan.version === commercial.VERSION ? commercial.buildBsCatalogMigrationPlan : visibility.buildBsCatalogVisibilityPlan;
    const expected = rebuild({ ...sourceInputs, ...(plan.version === commercial.VERSION ? { badge: plan.badge_proposal } : {}) });
    if (!same(expected, plan)) fail('BS_CATALOG_PLAN_NOT_REPRODUCIBLE_FROM_ORIGINAL_INPUTS');
    if (new Set(plan.operations.map(op => op.treatment_id)).size !== plan.operations.length) fail('BS_CATALOG_DUPLICATE_OPERATION');
    for (const op of plan.operations) {
        const { operation_sha256, ...operationBody } = op;
        if (!sha(operation_sha256) || hash(operationBody) !== operation_sha256 || ![66, 72].includes(op.clinic_id)
            || op.before.id_tratamiento !== op.treatment_id || op.after.id_tratamiento !== op.treatment_id
            || op.before.clinica_id !== op.clinic_id || op.after.clinica_id !== op.clinic_id
            || !op.changes.length || op.changes.some(change => !fields.includes(change.path)
                || hash(change.before) !== change.before_sha256 || hash(change.after) !== change.after_sha256)
            || !same(op.before.updatedAt, op.after.updatedAt)) fail('BS_CATALOG_OPERATION_INVALID');
    }
    return true;
}
// mysql2 returns DECIMAL(10,2) as strings, including when the old value was NULL
// and the offline proposal contains a numeric amount. Do not treat that known
// storage representation as a clinical/data change or silently add VAT.
function decimal(value) {
    if (value == null) return value;
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(String(value)) || Number(value) > 99999999.99) fail('BS_CATALOG_PRICE_STORAGE_INVALID');
    return Number(value).toFixed(2);
}
function materializedRow(row) {
    const result = copy(row);
    if (typeof result.clinical_config === 'string') result.clinical_config = JSON.parse(result.clinical_config);
    if (!isObject(result.clinical_config)) fail('BS_CATALOG_CONFIG_INVALID');
    if (Object.hasOwn(result, 'precio_base')) result.precio_base = decimal(result.precio_base);
    return result;
}
function dataSha(row) { const result = materializedRow(row); delete result.updatedAt; return hash(result); }
function fullSha(row) { return hash(materializedRow(row)); }
function validateStoragePatch({ op, current, target, direction }) {
    const fields = op.kind === 'propose_existing_treatment_commercial_patch' ? commercial.FIELD_WHITELIST
        : op.kind === 'propose_existing_treatment_continuation_visibility_patch' ? visibility.FIELD_WHITELIST : null;
    const { operation_sha256, ...body } = op;
    if (!fields || hash(body) !== operation_sha256 || !['forward', 'rollback'].includes(direction)
        || !Array.isArray(op.changes) || !op.changes.length || new Set(op.changes.map(c => c.path)).size !== op.changes.length
        || op.changes.some(c => !fields.includes(c.path) || hash(c.before) !== c.before_sha256 || hash(c.after) !== c.after_sha256)) fail('BS_CATALOG_STORAGE_PATCH_NOT_WHITELISTED');
    const reconstructed = copy(op.before);
    for (const change of op.changes) {
        const parts = change.path.split('.'); let parent = reconstructed;
        for (const part of parts.slice(0, -1)) {
            if (parent[part] == null) parent[part] = {};
            if (!isObject(parent[part])) fail('BS_CATALOG_STORAGE_PATCH_PARENT_INVALID');
            parent = parent[part];
        }
        const key = parts.at(-1), cell = Object.hasOwn(parent, key) ? { present: true, value: parent[key] } : { present: false };
        if (!same(cell, change.before)) fail('BS_CATALOG_STORAGE_PATCH_BEFORE_CELL_INVALID');
        if (change.after.present === true) parent[key] = copy(change.after.value);
        else if (change.after.present === false) delete parent[key];
        else fail('BS_CATALOG_STORAGE_PATCH_AFTER_CELL_INVALID');
    }
    if (dataSha(reconstructed) !== dataSha(op.after) || dataSha(target) !== dataSha(direction === 'forward' ? op.after : op.before)
        || dataSha(current) !== dataSha(direction === 'forward' ? op.before : op.after)
        || current.id_tratamiento !== op.treatment_id || current.clinica_id !== op.clinic_id) fail('BS_CATALOG_STORAGE_PATCH_PROTECTED_DATA_CHANGED');
}
function receiptBody(entry) { const { receipt_sha256, ...body } = entry || {}; return body; }
function validateReceipt(receipt, plan, op, direction) {
    if (!receipt || receipt.version !== VERSION || receipt.plan_sha256 !== plan.plan_sha256
        || receipt.operation_sha256 !== op.operation_sha256 || receipt.treatment_id !== op.treatment_id
        || receipt.clinic_id !== op.clinic_id || receipt.direction !== direction || !sha(receipt.receipt_sha256)
        || hash(receiptBody(receipt)) !== receipt.receipt_sha256
        || fullSha(receipt.before_row) !== receipt.before_row_sha256 || fullSha(receipt.after_row) !== receipt.after_row_sha256
        || dataSha(receipt.before_row) !== dataSha(direction === 'forward' ? op.before : op.after)
        || dataSha(receipt.after_row) !== dataSha(direction === 'forward' ? op.after : op.before)) fail('BS_CATALOG_RECEIPT_INVALID');
    return true;
}
function journalState(entries, plan, op) {
    const relevant = entries.filter(e => e.operation_sha256 === op.operation_sha256);
    const attempts = new Map();
    for (const entry of relevant) {
        if (entry.plan_sha256 !== plan.plan_sha256 || !['prepared', 'written_before_commit', 'committed', 'aborted'].includes(entry.stage)
            || !['forward', 'rollback'].includes(entry.direction) || typeof entry.attempt_id !== 'string') fail('BS_CATALOG_JOURNAL_EVENT_INVALID');
        const previous = attempts.get(entry.attempt_id);
        if (entry.stage === 'prepared') {
            if (previous) fail('BS_CATALOG_JOURNAL_SEQUENCE_INVALID');
        } else if (!previous || previous.direction !== entry.direction
            || (entry.stage === 'written_before_commit' && previous.stage !== 'prepared')
            || (entry.stage === 'committed' && previous.stage !== 'written_before_commit')
            || (entry.stage === 'aborted' && !['prepared', 'written_before_commit'].includes(previous.stage))) fail('BS_CATALOG_JOURNAL_SEQUENCE_INVALID');
        if (['written_before_commit', 'committed'].includes(entry.stage)) {
            validateReceipt(entry.receipt, plan, op, entry.direction);
            if (entry.stage === 'written_before_commit' && (entry.receipt.before_row_sha256 !== previous.before_row_sha256
                || dataSha(entry.receipt.after_row) !== previous.target_data_sha256
                || entry.receipt.attempt_id !== entry.attempt_id)) fail('BS_CATALOG_JOURNAL_INTENT_RECEIPT_MISMATCH');
            if (entry.stage === 'committed' && !same(entry.receipt, previous.receipt)) fail('BS_CATALOG_JOURNAL_RECEIPT_CHANGED');
        }
        attempts.set(entry.attempt_id, entry);
    }
    if ([...attempts.values()].some(e => ['prepared', 'written_before_commit'].includes(e.stage))) fail('BS_CATALOG_UNFINISHED_ATTEMPT_REQUIRES_REVIEW');
    const committed = relevant.filter(e => e.stage === 'committed');
    return committed[committed.length - 1];
}
function assessRow({ plan, op, current, direction, lastCommitted }) {
    if (!current || Number(current.id_tratamiento) !== op.treatment_id || Number(current.clinica_id) !== op.clinic_id) return 'scope_or_row_missing';
    const original = materializedRow(op.before), proposed = materializedRow(op.after);
    const target = direction === 'forward' ? proposed : original;
    if (dataSha(current) === dataSha(target)) return 'already_at_target_no_write';
    if (direction === 'forward') {
        // Initial application is tied to the observed FULL row, including the
        // timestamp. A completed rollback may establish a new exact baseline.
        const expected = lastCommitted?.direction === 'rollback' ? lastCommitted.receipt.after_row : op.before;
        return fullSha(current) === fullSha(expected) ? 'cas_matches' : 'later_row_change_stop';
    }
    if (lastCommitted?.direction !== 'forward') return 'rollback_requires_committed_receipt';
    validateReceipt(lastCommitted.receipt, plan, op, 'forward');
    return fullSha(current) === lastCommitted.receipt.after_row_sha256 ? 'cas_matches' : 'later_row_change_prevents_rollback';
}
function verifyAuthorization({ plan, approval, backup, direction, now }) {
    const created = Date.parse(approval?.created_at), until = Date.parse(approval?.expires_at), time = now.getTime();
    if (!approval || approval.version !== 'bs-catalog-operator-approval/1' || approval.plan_sha256 !== plan.plan_sha256
        || approval.direction !== direction || approval.target !== 'crm' || approval.group_id !== 29
        || !same(approval.clinic_ids, [66, 72]) || !same(approval.field_whitelist, whitelist(plan))
        || approval.matrix_file_sha256 !== plan.matrix_file_sha256 || approval.snapshot_file_sha256 !== plan.snapshot_file_sha256
        || typeof approval.operator_identity !== 'string' || !approval.operator_identity.trim() || approval.operator_identity.length > 128
        || !Number.isFinite(created) || !Number.isFinite(until) || created > time || time - created > 7200000
        || until <= time || until - created > 7200000 || approval.commercial_or_visibility_only !== true
        || approval.preserve_activation_approvals_profiles_provenance_and_entitlements !== true
        || approval.gross_includes_provisional_vat_not_added_on_top !== true
        || approval.fiscal_draft_preparation_is_not_approval !== true
        || !backup || backup.verified !== true || backup.target !== 'crm' || backup.group_id !== 29
        || !same(backup.clinic_ids, [66, 72]) || !sha(backup.manifest_file_sha256) || !sha(backup.backup_sha256)
        || approval.backup_manifest_sha256 !== backup.manifest_file_sha256
        || !Number.isFinite(Date.parse(backup.generated_at)) || Date.parse(backup.generated_at) > time
        || time - Date.parse(backup.generated_at) > 43200000 || typeof backup.database !== 'string' || !backup.database
        || approval.database !== backup.database) fail('BS_CATALOG_FRESH_SCOPED_APPROVAL_AND_BACKUP_REQUIRED');
    if (plan.version === visibility.VERSION && (approval.hide_old_cliniccloud_only_new_offers !== true
        || approval.server_continuation_guard_verified !== true || !sha(approval.continuation_contract_release_sha256)
        || approval.legacy_services_file_sha256 !== plan.legacy_services_file_sha256)) fail('BS_CATALOG_CONTINUATION_RELEASE_EVIDENCE_REQUIRED');
}

async function executeBsCatalogMigration({ plan, sourceInputs, store, journal, approval, backup,
    direction = 'forward', dryRun = true, maxOperations = 25, now = new Date(), attemptId = randomUUID } = {}) {
    verifyPlan(plan, sourceInputs);
    if (!['forward', 'rollback'].includes(direction) || typeof dryRun !== 'boolean'
        || !Number.isSafeInteger(maxOperations) || maxOperations < 1 || maxOperations > 200
        || !(now instanceof Date) || !Number.isFinite(now.getTime()) || typeof attemptId !== 'function'
        || !store || typeof store.verifyScope !== 'function') fail('BS_CATALOG_EXECUTION_OPTIONS_INVALID');
    if (!dryRun) {
        verifyAuthorization({ plan, approval, backup, direction, now });
        if (!journal || !Array.isArray(journal.entries) || typeof journal.append !== 'function') fail('BS_CATALOG_DURABLE_JOURNAL_REQUIRED');
    }
    await store.verifyScope({ expectedDatabase: dryRun ? undefined : backup.database });
    const outcomes = [], summary = { mode: dryRun ? 'read_only_dry_run' : direction === 'forward' ? 'apply' : 'rollback',
        plan_sha256: plan.plan_sha256, inspected: 0, would_write: 0, written: 0, no_write: 0, conflicts: 0,
        activation_changed: false, snapshots_or_entitlements_changed: false, per_row_transactions: true };
    const operations = direction === 'rollback' ? [...plan.operations].reverse() : plan.operations;
    for (const op of operations) {
        if (!dryRun && summary.written >= maxOperations) break;
        let transactionOpen = false, commitAttempted = false, intentWritten = false, receipt;
        const id = attemptId();
        try {
            const lastCommitted = journalState(journal?.entries || [], plan, op);
            await store.begin({ readOnly: dryRun }); transactionOpen = true;
            await store.verifyScope({ expectedDatabase: dryRun ? undefined : backup.database, inTransaction: true });
            const current = await store.readTreatment(op.treatment_id, op.clinic_id, { lock: !dryRun });
            const decision = assessRow({ plan, op, current, direction, lastCommitted });
            summary.inspected++;
            if (decision !== 'cas_matches') {
                await store.rollback(); transactionOpen = false;
                const okay = decision === 'already_at_target_no_write';
                summary[okay ? 'no_write' : 'conflicts']++;
                outcomes.push({ treatment_id: op.treatment_id, clinic_id: op.clinic_id, decision });
                if (!okay && !dryRun) fail('BS_CATALOG_CAS_CONFLICT_STOP');
                continue;
            }
            summary.would_write++;
            if (dryRun) {
                await store.rollback(); transactionOpen = false;
                outcomes.push({ treatment_id: op.treatment_id, clinic_id: op.clinic_id, decision: 'would_write_after_review' }); continue;
            }
            const target = materializedRow(direction === 'forward' ? op.after : op.before);
            const event = { plan_sha256: plan.plan_sha256, operation_sha256: op.operation_sha256,
                direction, attempt_id: id, approval_sha256: hash(approval), backup_manifest_sha256: backup.manifest_file_sha256 };
            await journal.append({ ...event, stage: 'prepared', before_row: materializedRow(current), before_row_sha256: fullSha(current), target_data_sha256: dataSha(target) });
            intentWritten = true;
            await store.writeTreatment({ op, current: materializedRow(current), target, direction });
            const actual = await store.readTreatment(op.treatment_id, op.clinic_id, { lock: true });
            if (!actual || dataSha(actual) !== dataSha(target) || !Object.hasOwn(actual, 'updatedAt')) fail('BS_CATALOG_POST_WRITE_VERIFICATION_FAILED');
            const body = { version: VERSION, ...event, treatment_id: op.treatment_id, clinic_id: op.clinic_id,
                before_row: materializedRow(current), before_row_sha256: fullSha(current),
                after_row: materializedRow(actual), after_row_sha256: fullSha(actual) };
            receipt = { ...body, receipt_sha256: hash(body) };
            validateReceipt(receipt, plan, op, direction);
            await journal.append({ ...event, stage: 'written_before_commit', receipt });
            commitAttempted = true; await store.commit(); transactionOpen = false;
            await journal.append({ ...event, stage: 'committed', receipt });
            summary.written++; outcomes.push({ treatment_id: op.treatment_id, clinic_id: op.clinic_id, decision: 'committed', receipt_sha256: receipt.receipt_sha256 });
        } catch (error) {
            if (transactionOpen) await store.rollback().catch(() => {});
            if (commitAttempted) fail('BS_CATALOG_INDETERMINATE_COMMIT_REQUIRES_JOURNAL_REVIEW');
            if (intentWritten) await journal.append({ plan_sha256: plan.plan_sha256, operation_sha256: op.operation_sha256,
                direction, attempt_id: id, stage: 'aborted' }).catch(() => {});
            error.summary = { ...summary }; throw error;
        }
    }
    summary.remaining_uninspected = plan.operations.length - summary.inspected;
    return { version: VERSION, summary, outcomes };
}
module.exports = { VERSION, verifyPlan, materializedRow, dataSha, fullSha, validateReceipt, journalState,
    verifyAuthorization, assessRow, validateStoragePatch, executeBsCatalogMigration };
