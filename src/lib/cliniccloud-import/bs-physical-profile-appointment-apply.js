'use strict';

// Raw SQL, injected connection. No Sequelize/hooks/bootstrap/socket/provider.
// One bounded batch, same resource anchors as ordinary booking writers, and
// one transaction. Only metadata + clinician occupancy rows may be written.
const { randomUUID } = require('node:crypto');
const { hash } = require('./adapter');
const contract = require('./bs-physical-profile-appointment-plan');
const { capturePiedadAppointmentSnapshot } = require('./bs-physical-profile-appointment-snapshot');
const { openBsCatalogJournal, readPrivateBytes, readJournalEntries } = require('./bs-catalog-migration-journal');
const VERSION = 'bs-piedad-appointment-executor/2';
const APPROVAL_VERSION = 'bs-piedad-appointment-approval/2';
const fail = code => { throw Error(code); };
const same = (a, b) => hash(a) === hash(b);
function batchState(snapshot, plan) {
    const ids = new Set(plan.operations.map(op => op.appointment_id));
    return { appointments: snapshot.appointments.filter(row => ids.has(Number(row.id_cita))).map(contract.materializeAppointment).sort((a, b) => a.id_cita - b.id_cita),
        occupancies: snapshot.occupancies.filter(row => ids.has(Number(row.appointment_id))).sort((a, b) => a.id - b.id) };
}
function verifyAuthorization({ plan, approval, backup, backupFileSha256, direction, now, recovery = false }) {
    const created = Date.parse(approval?.created_at), expires = Date.parse(approval?.expires_at), time = now.getTime();
    const { backup_sha256, ...backupBody } = backup || {};
    if (approval?.version !== APPROVAL_VERSION || approval.plan_sha256 !== plan.plan_sha256 || approval.direction !== direction
        || approval.target !== 'crm' || approval.group_id !== 29 || !same(approval.clinic_ids, [72]) || !same(approval.doctor_ids, [221])
        || !same(approval.field_whitelist, contract.FIELD_WHITELIST) || approval.backup_file_sha256 !== backupFileSha256
        || approval.preserve_all_appointment_fields_and_updated_at !== true || approval.preserve_room_and_unchanged_equipment_occupancies !== true
        || approval.allow_exact_listed_ems_machine_corrections !== true
        || !same(approval.appointment_ids, plan.operations.map(op => op.appointment_id).sort((a, b) => a - b))
        || approval.no_messages_jobs_events_or_financial_writes !== true || typeof approval.operator_identity !== 'string' || !approval.operator_identity.trim()
        || !Number.isFinite(created) || !Number.isFinite(expires) || created > time || time - created > 7200000 || expires <= time || expires - created > 7200000
        || recovery && approval.recover_indeterminate_commit !== true
        || backup?.version !== 'bs-piedad-appointment-backup/1' || hash(backupBody) !== backup_sha256 || backup.plan_sha256 !== plan.plan_sha256
        || backup.target !== 'crm' || backup.database !== plan.database || !Number.isFinite(Date.parse(backup.generated_at))
        || Date.parse(backup.generated_at) > time || time - Date.parse(backup.generated_at) > 43200000
        || !same(backup.state, { appointments: plan.operations.map(op => op.before).sort((a, b) => a.id_cita - b.id_cita),
            occupancies: plan.operations.flatMap(op => op.before_occupancies).sort((a, b) => a.id - b.id) }))
        fail('BS_APPOINTMENT_FRESH_SCOPED_APPROVAL_AND_BACKUP_REQUIRED');
}
function validateStoragePatch(op, before, after, occupancies) {
    const a = contract.materializeAppointment(before), b = contract.materializeAppointment(after);
    const am = a.import_metadata, bm = b.import_metadata;
    delete a.import_metadata; delete b.import_metadata;
    if (!same(a, b)) fail('BS_APPOINTMENT_PROTECTED_FIELD_CHANGED');
    const beforeMetadata = { ...am }, afterMetadata = { ...bm };
    for (const key of ['booking', 'piedad_preparation_migration']) { delete beforeMetadata[key]; delete afterMetadata[key]; }
    if (!same(beforeMetadata, afterMetadata) || !same(bm, op.after.import_metadata)
        || !same(contract.occupancySignature(occupancies.filter(row => row.resource_kind !== 'doctor')), op.after_physical_occupancy_signature))
        fail('BS_APPOINTMENT_PROTECTED_METADATA_OR_PHYSICAL_OCCUPANCY_CHANGED');
}
function readBatchJournal(entries, plan, { allowUnfinished = false } = {}) {
    const attempts = new Map();
    for (const entry of entries) {
        const old = attempts.get(entry.attempt_id);
        if (entry.plan_sha256 !== plan.plan_sha256 || !['forward', 'rollback'].includes(entry.direction)
            || !['prepared', 'written_before_commit', 'committed', 'aborted'].includes(entry.stage)
            || entry.stage === 'prepared' && old || entry.stage !== 'prepared' && (!old || old.direction !== entry.direction)
            || entry.stage === 'written_before_commit' && old.stage !== 'prepared'
            || entry.stage === 'committed' && old.stage !== 'written_before_commit'
            || entry.stage === 'aborted' && !['prepared', 'written_before_commit'].includes(old.stage)) fail('BS_APPOINTMENT_JOURNAL_SEQUENCE_INVALID');
        if (['written_before_commit', 'committed'].includes(entry.stage)) {
            const { receipt_sha256, ...body } = entry.receipt || {};
            if (hash(body) !== receipt_sha256 || body.version !== VERSION || body.plan_sha256 !== plan.plan_sha256
                || body.attempt_id !== entry.attempt_id || body.direction !== entry.direction
                || body.before_sha256 !== hash(body.before) || body.after_sha256 !== hash(body.after)
                || entry.stage === 'written_before_commit' && old.before_sha256 !== body.before_sha256
                || entry.stage === 'committed' && !same(old.receipt, entry.receipt)) fail('BS_APPOINTMENT_JOURNAL_RECEIPT_INVALID');
        }
        attempts.set(entry.attempt_id, entry);
    }
    const unfinished = [...attempts.values()].filter(entry => ['prepared', 'written_before_commit'].includes(entry.stage));
    if (unfinished.length && !allowUnfinished) fail('BS_APPOINTMENT_INDETERMINATE_ATTEMPT_REQUIRES_RECOVERY');
    return { unfinished, last: entries.filter(entry => entry.stage === 'committed').at(-1) };
}
function assessBatch({ plan, snapshot, direction, last, now }) {
    const state = batchState(snapshot, plan);
    if (snapshot.engines?.length !== 4 || snapshot.engines.some(row => row.ENGINE !== 'InnoDB') || snapshot.triggers?.length)
        fail('BS_APPOINTMENT_LIVE_TRANSACTIONAL_TABLES_OR_TRIGGERS_CHANGED');
    if (snapshot.database !== plan.database || hash({ clinics: snapshot.clinics, resources: snapshot.resources, treatments: snapshot.treatments }) !== plan.resource_snapshot_sha256)
        fail('BS_APPOINTMENT_RESOURCE_CONFIGURATION_DRIFT');
    if (last?.direction === direction && same(state, last.receipt.after)) return { decision: 'already_committed_no_write', state };
    const expected = direction === 'forward' ? last?.direction === 'rollback' ? last.receipt.after : {
        appointments: plan.operations.map(op => op.before).sort((a, b) => a.id_cita - b.id_cita),
        occupancies: plan.operations.flatMap(op => op.before_occupancies).sort((a, b) => a.id - b.id),
    } : last?.direction === 'forward' ? last.receipt.after : null;
    if (!expected || !same(state, expected)) fail('BS_APPOINTMENT_BATCH_ROW_OR_OCCUPANCY_CAS_DRIFT');
    for (const op of plan.operations) {
        const row = state.appointments.find(item => Number(item.id_cita) === op.appointment_id);
        if (Date.parse(contract.timestamp(row.inicio)) <= now.getTime()
            || ['arrived_at', 'arrived_by', 'care_started_at', 'care_started_by', 'care_completed_at', 'care_completed_by', 'care_schedule_start'].some(key => row[key] != null)
            || Number(row.care_legacy_attendance) === 1 || snapshot.care_events.some(event => Number(event.appointment_id) === op.appointment_id))
            fail('BS_APPOINTMENT_PAST_OR_CARE_STARTED_STOP');
        if (hash(contract.competingReservationEvidence(snapshot, row, { resourceKeys: op.resource_keys,
            excludedAppointmentIds: plan.operations.map(item => item.appointment_id), plannedOccupancies: [...op.before_occupancies, ...op.after_occupancies] })) !== op.competing_reservation_evidence_sha256)
            fail('BS_APPOINTMENT_COMPETING_RESERVATION_DRIFT');
    }
    if (direction === 'forward') contract.assertFinalCapacity(snapshot, plan.operations);
    return { decision: 'cas_matches', state };
}
function createPiedadAppointmentStore(connection) {
    let executionLocked = false;
    return {
        async acquireExecutionLock() {
            const [rows] = await connection.query("SELECT GET_LOCK('bs-piedad:crm:clinic72:doctor221',0) AS acquired");
            if (Number(rows[0]?.acquired) !== 1) fail('BS_APPOINTMENT_EXECUTOR_ALREADY_RUNNING'); executionLocked = true;
        },
        async releaseExecutionLock() { if (executionLocked) { await connection.query("SELECT RELEASE_LOCK('bs-piedad:crm:clinic72:doctor221')"); executionLocked = false; } },
        async begin(readOnly) {
            if (readOnly) await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
            else { await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED'); await connection.beginTransaction(); }
        },
        async lockResources(plan) {
            for (const key of [...new Set(plan.operations.flatMap(op => op.resource_keys))].sort()) {
                if (!/^(doctor|installation|patient|equipment):[1-9]\d*$/.test(key)) fail('BS_APPOINTMENT_RESOURCE_KEY_INVALID');
                const [rows] = await connection.query('SELECT resource_key FROM AppointmentBookingResources WHERE resource_key=? FOR UPDATE', [key]);
                if (rows.length !== 1) fail('BS_APPOINTMENT_EXISTING_RESOURCE_ANCHOR_REQUIRED');
            }
            const ids = plan.operations.map(op => op.appointment_id).sort((a, b) => a - b);
            await connection.query('SELECT id_cita FROM CitasPacientes WHERE id_cita IN (?) ORDER BY id_cita FOR UPDATE', [ids]);
            await connection.query('SELECT id FROM AppointmentBookingOccupancies WHERE appointment_id IN (?) ORDER BY id FOR UPDATE', [ids]);
        },
        async readSnapshot(plan, lock = false) {
            const reader = lock ? { async query(sql, params) {
                // Lock evidence records after common resource anchors. Aggregate
                // and information_schema queries are verification, not locks.
                const recordRead = /^SELECT /.test(sql) && !/information_schema|DATABASE\(\)|COUNT\(/.test(sql);
                return connection.query(sql + (recordRead ? ' LOCK IN SHARE MODE' : ''), params);
            } } : connection;
            return capturePiedadAppointmentSnapshot(reader, { now: new Date(plan.captured_at), transactionAlreadyOpen: true });
        },
        async automationCounters() {
            const [tables] = await connection.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('AppointmentVisitCommunications','FlowExecutionsV2','Notifications','JobRequests') ORDER BY TABLE_NAME");
            const result = {};
            for (const { TABLE_NAME: table } of tables) {
                // Fixed allowlist; output counts only, never payloads/messages.
                if (!['AppointmentVisitCommunications', 'FlowExecutionsV2', 'Notifications', 'JobRequests'].includes(table)) fail('BS_APPOINTMENT_AUDIT_TABLE_INVALID');
                const filter = table === 'Notifications' ? ' WHERE clinica_id=72' : table === 'JobRequests' ? '' : ' WHERE clinic_id=72';
                const [rows] = await connection.query(`SELECT COUNT(*) AS total,MAX(id) AS max_id FROM ${table}${filter}`);
                result[table] = rows[0];
            }
            return result;
        },
        async write(plan, direction, beforeState, rollbackState) {
            for (const op of plan.operations) {
                const current = beforeState.appointments.find(row => Number(row.id_cita) === op.appointment_id);
                const target = direction === 'forward' ? op.after : op.before;
                const [result] = await connection.query('UPDATE CitasPacientes SET import_metadata=?,updated_at=updated_at WHERE id_cita=? AND clinica_id=72 AND doctor_id=221 AND updated_at <=> ?',
                    [target.import_metadata == null ? null : JSON.stringify(target.import_metadata), op.appointment_id, current.updated_at]);
                if (result.affectedRows !== 1) fail('BS_APPOINTMENT_METADATA_SQL_CAS_FAILED');
                const doctorRows = beforeState.occupancies.filter(row => Number(row.appointment_id) === op.appointment_id && row.resource_kind === 'doctor');
                if (!doctorRows.length || doctorRows.some(row => row.resource_key !== 'doctor:221' || Number(row.doctor_id) !== 221)) fail('BS_APPOINTMENT_DOCTOR_OCCUPANCY_SCOPE_INVALID');
                const [deleted] = await connection.query("DELETE FROM AppointmentBookingOccupancies WHERE appointment_id=? AND resource_kind='doctor' AND resource_key='doctor:221' AND id IN (?)", [op.appointment_id, doctorRows.map(row => row.id)]);
                if (deleted.affectedRows !== doctorRows.length) fail('BS_APPOINTMENT_DOCTOR_DELETE_CAS_FAILED');
                const desired = direction === 'forward' ? op.after_occupancies.filter(row => row.resource_kind === 'doctor')
                    : rollbackState.occupancies.filter(row => Number(row.appointment_id) === op.appointment_id && row.resource_kind === 'doctor');
                for (const row of desired) {
                    if (row.resource_key !== 'doctor:221' || Number(row.doctor_id) !== 221 || row.installation_id != null) fail('BS_APPOINTMENT_DOCTOR_INSERT_SCOPE_INVALID');
                    if (direction === 'rollback') await connection.query('INSERT INTO AppointmentBookingOccupancies (id,appointment_id,phase_key,resource_kind,resource_key,installation_id,doctor_id,start_at,end_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                        [row.id, op.appointment_id, row.phase_key, 'doctor', 'doctor:221', null, 221, row.start_at, row.end_at, row.created_at, row.updated_at]);
                    else await connection.query('INSERT INTO AppointmentBookingOccupancies (appointment_id,phase_key,resource_kind,resource_key,installation_id,doctor_id,start_at,end_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,UTC_TIMESTAMP(6),UTC_TIMESTAMP(6))',
                        [op.appointment_id, row.phase_key, 'doctor', 'doctor:221', null, 221,
                            new Date(row.start_at).toISOString().slice(0, 23).replace('T', ' '), new Date(row.end_at).toISOString().slice(0, 23).replace('T', ' ')]);
                }
                if (op.equipment_correction) {
                    if (op.equipment_correction.new_equipment_id !== 5 || op.equipment_correction.client_authorization_date !== '2026-10-10') fail('BS_APPOINTMENT_EQUIPMENT_CORRECTION_NOT_AUTHORIZED');
                    const existing = beforeState.occupancies.filter(row => Number(row.appointment_id) === op.appointment_id && row.resource_kind === 'equipment');
                    if (existing.length > 1) fail('BS_APPOINTMENT_EQUIPMENT_CORRECTION_SINGLE_UNIT_REQUIRED');
                    if (existing.length) {
                        const [deletedUnit] = await connection.query("DELETE FROM AppointmentBookingOccupancies WHERE appointment_id=? AND resource_kind='equipment' AND id IN (?)", [op.appointment_id, existing.map(row => row.id)]);
                        if (deletedUnit.affectedRows !== existing.length) fail('BS_APPOINTMENT_EQUIPMENT_DELETE_CAS_FAILED');
                    }
                    const required = direction === 'forward' ? op.after_occupancies.filter(row => row.resource_kind === 'equipment')
                        : rollbackState.occupancies.filter(row => Number(row.appointment_id) === op.appointment_id && row.resource_kind === 'equipment');
                    for (const row of required) {
                        if (direction === 'rollback') await connection.query('INSERT INTO AppointmentBookingOccupancies (id,appointment_id,phase_key,resource_kind,resource_key,installation_id,doctor_id,start_at,end_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                            [row.id, op.appointment_id, row.phase_key, 'equipment', row.resource_key, null, null, row.start_at, row.end_at, row.created_at, row.updated_at]);
                        else {
                            if (row.resource_key !== 'equipment:5' || row.doctor_id != null || row.installation_id != null) fail('BS_APPOINTMENT_EQUIPMENT_INSERT_SCOPE_INVALID');
                            await connection.query('INSERT INTO AppointmentBookingOccupancies (appointment_id,phase_key,resource_kind,resource_key,installation_id,doctor_id,start_at,end_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,UTC_TIMESTAMP(6),UTC_TIMESTAMP(6))',
                                [op.appointment_id, row.phase_key, 'equipment', row.resource_key, null, null,
                                    new Date(row.start_at).toISOString().slice(0, 23).replace('T', ' '), new Date(row.end_at).toISOString().slice(0, 23).replace('T', ' ')]);
                        }
                    }
                }
            }
        },
        commit: () => connection.commit(), rollback: () => connection.rollback(),
    };
}
function openPiedadAppointmentJournal(filename, planSha256, options) {
    const journal = openBsCatalogJournal(filename, planSha256, options);
    return { ...journal, async reload() { const entries = readJournalEntries(readPrivateBytes(filename), planSha256); journal.entries.splice(0, journal.entries.length, ...entries); } };
}
async function executePiedadAppointmentMigration({ plan, inputs, store, journal, approval, backup, backupFileSha256,
    direction = 'forward', dryRun = true, maxOperations = 50, now = new Date(), attemptId = randomUUID } = {}) {
    contract.verifyPiedadAppointmentPlan(plan, inputs);
    if (!['forward', 'rollback'].includes(direction) || typeof dryRun !== 'boolean' || !Number.isInteger(maxOperations) || maxOperations < 1 || maxOperations > 50
        || !plan.operations.length || plan.operations.length > maxOperations || !(now instanceof Date) || !Number.isFinite(now.getTime()) || !store
        || !dryRun && (!journal || typeof journal.reload !== 'function')) fail('BS_APPOINTMENT_EXECUTION_OPTIONS_INVALID');
    if (!dryRun) verifyAuthorization({ plan, approval, backup, backupFileSha256, direction, now });
    let transactionOpen = false, commitAttempted = false, prepared = false;
    const event = { plan_sha256: plan.plan_sha256, direction, attempt_id: attemptId(), approval_sha256: dryRun ? null : hash(approval) };
    if (!dryRun) await store.acquireExecutionLock();
    try {
        if (!dryRun) await journal.reload();
        const { last } = readBatchJournal(journal?.entries || [], plan);
        await store.begin(dryRun); transactionOpen = true;
        if (!dryRun) await store.lockResources(plan);
        const snapshot = await store.readSnapshot(plan, !dryRun), assessment = assessBatch({ plan, snapshot, direction, last, now });
        if (assessment.decision === 'already_committed_no_write' || dryRun) {
            await store.rollback(); transactionOpen = false;
            return { version: VERSION, mode: dryRun ? 'read_only_dry_run' : direction, decision: assessment.decision,
                would_write: assessment.decision === 'cas_matches' ? plan.operations.length : 0, written: 0, messages_dispatched: 0 };
        }
        const countersBefore = await store.automationCounters();
        await journal.append({ ...event, stage: 'prepared', before: assessment.state, before_sha256: hash(assessment.state) }); prepared = true;
        const rollbackState = direction === 'rollback' ? last.receipt.before : null;
        await store.write(plan, direction, assessment.state, rollbackState);
        const actual = batchState(await store.readSnapshot(plan, true), plan);
        for (const op of plan.operations) {
            const before = assessment.state.appointments.find(row => Number(row.id_cita) === op.appointment_id);
            const after = actual.appointments.find(row => Number(row.id_cita) === op.appointment_id);
            const occupancies = actual.occupancies.filter(row => Number(row.appointment_id) === op.appointment_id);
            if (direction === 'forward') {
                validateStoragePatch(op, before, after, occupancies);
                if (!same(contract.occupancySignature(occupancies), contract.occupancySignature(op.after_occupancies))) fail('BS_APPOINTMENT_AFTER_DOCTOR_OCCUPANCY_INVALID');
            } else if (!same(after, op.before) || !same(occupancies, rollbackState.occupancies.filter(row => Number(row.appointment_id) === op.appointment_id))) fail('BS_APPOINTMENT_ROLLBACK_NOT_EXACT');
        }
        const countersAfter = await store.automationCounters();
        const body = { version: VERSION, ...event, before: assessment.state, before_sha256: hash(assessment.state),
            after: actual, after_sha256: hash(actual), automation_counters_before: countersBefore, automation_counters_after: countersAfter,
            queue_counters_identical_within_transaction: same(countersBefore, countersAfter),
            automation_counters_are_observational_external_activity_may_advance: true, messages_dispatched: 0, appointment_updated_at_preserved: true };
        const receipt = { ...body, receipt_sha256: hash(body) };
        await journal.append({ ...event, stage: 'written_before_commit', receipt });
        commitAttempted = true; await store.commit(); transactionOpen = false;
        await journal.append({ ...event, stage: 'committed', receipt });
        return { version: VERSION, mode: direction, written: plan.operations.length, plan_sha256: plan.plan_sha256,
            receipt_sha256: receipt.receipt_sha256, messages_dispatched: 0, appointment_updated_at_preserved: true,
            automation_counters_before: countersBefore, automation_counters_after: countersAfter };
    } catch (error) {
        if (transactionOpen) await store.rollback().catch(() => {});
        if (commitAttempted) fail('BS_APPOINTMENT_INDETERMINATE_COMMIT_REQUIRES_RECOVERY');
        if (prepared) await journal.append({ ...event, stage: 'aborted' }).catch(() => {});
        throw error;
    } finally { if (!dryRun) await store.releaseExecutionLock(); }
}
async function recoverPiedadAppointmentMigration({ plan, inputs, store, journal, approval, backup, backupFileSha256,
    direction = 'forward', now = new Date() } = {}) {
    contract.verifyPiedadAppointmentPlan(plan, inputs);
    verifyAuthorization({ plan, approval, backup, backupFileSha256, direction, now, recovery: true });
    await store.acquireExecutionLock();
    try {
        await journal.reload(); const { unfinished } = readBatchJournal(journal.entries, plan, { allowUnfinished: true });
        if (unfinished.length > 1) fail('BS_APPOINTMENT_MULTIPLE_UNFINISHED_ATTEMPTS');
        const outcomes = [];
        for (const entry of unfinished) {
            if (entry.direction !== direction) fail('BS_APPOINTMENT_RECOVERY_DIRECTION_MISMATCH');
            await store.begin(false);
            try {
                await store.lockResources(plan);
                const state = batchState(await store.readSnapshot(plan, true), plan);
                const stage = entry.stage === 'written_before_commit' && same(state, entry.receipt.after) ? 'committed'
                    : hash(state) === (entry.receipt?.before_sha256 || entry.before_sha256) ? 'aborted' : null;
                if (!stage) fail('BS_APPOINTMENT_RECOVERY_EXTERNAL_CHANGE_REQUIRES_REVIEW');
                await store.rollback(); // Recovery only appends proven journal outcome, no clinical SQL writes.
                const { entry_sha256, sequence, previous_entry_sha256, journal_at, ...body } = entry;
                await journal.append({ ...body, stage, recovered_at: now.toISOString() }); outcomes.push({ attempt_id: entry.attempt_id, stage });
            } catch (error) { await store.rollback().catch(() => {}); throw error; }
        }
        return { version: VERSION, outcomes, clinical_writes: 0, messages_dispatched: 0 };
    } finally { await store.releaseExecutionLock(); }
}
module.exports = { VERSION, APPROVAL_VERSION, batchState, verifyAuthorization, validateStoragePatch, readBatchJournal, assessBatch,
    createPiedadAppointmentStore, openPiedadAppointmentJournal, executePiedadAppointmentMigration, recoverPiedadAppointmentMigration };
