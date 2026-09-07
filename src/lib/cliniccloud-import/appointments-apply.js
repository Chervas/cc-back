'use strict';

// Deliberately narrower than review.js: NO creation, reschedule, reassignment,
// native aliasing, supersession, clinical/economic mutation, or event dispatch.
const { hash, utcToLocal } = require('./adapter');
const VERSION = 'cliniccloud-appointments-hold-v1';
const fail = code => { throw new Error(code); };
const positive = value => /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value));
const object = value => {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('INVALID_IMPORT_METADATA');
  return parsed;
};
function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d{1,6})?Z?$/.test(value)) fail('INVALID_UTC_DATABASE_TIMESTAMP');
  const result = new Date(value.replace(' ', 'T').replace(/Z?$/, 'Z'));
  if (!Number.isFinite(result.getTime())) fail('INVALID_UTC_DATABASE_TIMESTAMP');
  return result.toISOString();
}
function normalizedRow(row) {
  if (!row) fail('APPOINTMENT_NOT_FOUND');
  return { ...row, import_metadata: object(row.import_metadata || {}), inicio: instant(row.inicio), fin: instant(row.fin),
    created_at: row.created_at ? instant(row.created_at) : null, updated_at: row.updated_at ? instant(row.updated_at) : null };
}
function verifyPlan(plan, snapshot) {
  if (hash({ manifest: plan.manifest, actions: plan.actions }) !== plan.plan_sha256) fail('PLAN_INTEGRITY_MISMATCH');
  if (hash(snapshot) !== plan.manifest.snapshot_sha256) fail('SNAPSHOT_INTEGRITY_MISMATCH');
  if (plan.manifest.source_system !== 'cliniccloud' || plan.manifest.automation_policy !== 'hold'
    || plan.manifest.source_account !== snapshot.source_account || plan.manifest.timezone !== 'Europe/Madrid'
    || plan.manifest.coverage?.authority !== 'source_snapshot_plus_protected_native') fail('UNSUPPORTED_IMPORT_CONTRACT');
  if (!Array.isArray(snapshot.complete_for?.clinic_ids) || !snapshot.complete_for.clinic_ids.length) fail('MISSING_CLINIC_SCOPE');
}
function validateCandidate(action, local, row, context, manifest) {
  const reasons = [];
  const reject = (condition, reason) => { if (condition) reasons.push(reason); };
  reject(action.entity !== 'appointment' || action.action !== 'update_imported_candidate' || action.reasons?.length || action.source?.validation_errors?.length, 'NOT_INEQUIVOCAL_IMPORTED_UPDATE');
  reject(!local || hash(local) !== action.expected_local_hash, 'PLAN_LOCAL_HASH_MISMATCH');
  if (!local || !row) return [...reasons, 'APPOINTMENT_NOT_FOUND'];
  const source = action.source || {}, metadata = row.import_metadata;
  reject(row.source_system !== 'cliniccloud' || local.source_system !== 'cliniccloud', 'NATIVE_APPOINTMENT_PROTECTED');
  reject(!positive(action.source_external_id) || String(action.source_external_id) !== String(local.source_external_id)
    || String(metadata.source_appointment_id) !== String(action.source_external_id)
    || row.source_reference !== `appointment:${action.source_external_id}`, 'EXACT_HISTORIC_APPOINTMENT_ID_REQUIRED');
  reject(String(metadata.source_contact_id) !== String(source.source_contact_id) || String(local.source_contact_id) !== String(source.source_contact_id)
    || Number(action.patient_id) !== Number(row.paciente_id), 'EXACT_PATIENT_IDENTITY_REQUIRED');
  reject(!context.identity_unique || !context.patient_scope || !context.clinic_scope || !context.doctor_scope || !context.installation_scope || !context.treatment_scope, 'CURRENT_FOREIGN_KEY_OR_SCOPE_CONFLICT');
  reject(['paciente_id', 'clinica_id', 'doctor_id', 'instalacion_id', 'tratamiento_id'].some(key => !positive(row[key])), 'INCOMPLETE_EXISTING_ASSIGNMENT');
  const fields = { id: 'id_cita', patient_id: 'paciente_id', clinic_id: 'clinica_id', doctor_id: 'doctor_id', installation_id: 'instalacion_id', treatment_id: 'tratamiento_id', status: 'estado', source_reference: 'source_reference' };
  reject(Object.entries(fields).some(([key, column]) => String(local[key]) !== String(row[column])) || instant(local.updated_at) !== row.updated_at, 'LOCAL_CHANGED_SINCE_RECONCILIATION');
  reject(utcToLocal(row.inicio) !== source.start_local || utcToLocal(row.fin) !== source.end_local
    || local.start_local !== source.start_local || local.end_local !== source.end_local
    || instant(source.start_utc) !== row.inicio || instant(source.end_utc) !== row.fin, 'SCHEDULE_CHANGE_NOT_SUPPORTED');
  const day = source.start_local?.slice(0, 10);
  reject(!day || day < manifest.coverage.start || day > manifest.coverage.end, 'OUTSIDE_AUTHORITATIVE_INTERVAL');
  reject(!['pendiente', 'cancelada', 'completada', 'no_asistio'].includes(source.status), 'UNSUPPORTED_SOURCE_STATUS');
  // Shared old writers do not all lock/index appointment dependencies. This
  // release does not accept an operator assertion as a substitute for safety.
  reject(row.estado !== source.status, 'STATE_CHANGE_EXECUTOR_DISABLED');
  reject(context.overlap_count > 0, 'CURRENT_PATIENT_OVERLAP_REQUIRES_REVIEW');
  reject(context.active_job_count > 0 || context.automation_count > 0, 'AUTOMATION_ALREADY_PRESENT_REQUIRES_REVIEW');
  reject(row.voucher_id != null || row.lead_intake_id != null || row.es_provisional || row.hold_expires_at != null || metadata.booking, 'LINKED_OR_ADVANCED_APPOINTMENT_REQUIRES_REVIEW');
  if (row.estado !== source.status) reject(Object.values(context.references || {}).some(count => count > 0), 'DEPENDENT_HISTORY_REQUIRES_REVIEW');
  return reasons;
}

async function prepareAppointments({ plan, snapshot, store, capturedAt = new Date().toISOString() }) {
  verifyPlan(plan, snapshot);
  const locals = new Map(snapshot.appointments.map(row => [String(row.id), row]));
  const candidates = plan.actions.filter(action => action.entity === 'appointment' && action.action === 'update_imported_candidate');
  const operations = [], excluded = [], targets = new Set();
  const eligible = [];
  for (const action of candidates) {
    if (targets.has(String(action.local_id))) fail('DUPLICATE_PACKAGE_TARGET');
    targets.add(String(action.local_id));
    const local = locals.get(String(action.local_id));
    const earlyReasons = [];
    if (!local || hash(local) !== action.expected_local_hash) earlyReasons.push('PLAN_LOCAL_HASH_MISMATCH');
    if (local?.source_system !== 'cliniccloud') earlyReasons.push('NATIVE_APPOINTMENT_PROTECTED');
    if (action.source.status !== local?.status) earlyReasons.push('STATE_CHANGE_EXECUTOR_DISABLED');
    if (action.source.start_local !== local?.start_local || action.source.end_local !== local?.end_local) earlyReasons.push('SCHEDULE_CHANGE_NOT_SUPPORTED');
    if (earlyReasons.length) { excluded.push({ action_key: action.action_key, local_id: action.local_id, reasons: earlyReasons }); continue; }
    eligible.push(action);
  }
  if (store.prepareIdentities) await store.prepareIdentities(eligible.map(action => action.source.source_contact_id));
  for (const action of eligible) {
    const { row: raw, context } = await store.inspect(action.local_id, action.source.source_contact_id, false);
    const row = raw ? normalizedRow(raw) : null;
    const reasons = validateCandidate(action, locals.get(String(action.local_id)), row, context, plan.manifest);
    if (reasons.length) { excluded.push({ action_key: action.action_key, local_id: action.local_id, reasons }); continue; }
    const stateChange = row.estado !== action.source.status;
    const body = { action_key: action.action_key, local_id: row.id_cita, source_external_id: action.source_external_id,
      source_contact_id: action.source.source_contact_id, provenance: action.provenance, expected_row_sha256: hash(row),
      expected_context_sha256: hash(context), before: row, context, desired_status: action.source.status,
      start_utc: row.inicio, end_utc: row.fin, state_change: stateChange,
      allowed_columns: ['import_metadata', 'updated_at'] };
    operations.push({ ...body, operation_sha256: hash(body) });
  }
  const body = { version: VERSION, captured_at: capturedAt, plan_sha256: plan.plan_sha256, snapshot_sha256: plan.manifest.snapshot_sha256,
    source_account: plan.manifest.source_account, clinic_ids: snapshot.complete_for.clinic_ids, coverage: plan.manifest.coverage,
    automation_policy: 'hold', sends_messages: false, invokes_events: false, creates_appointments: false, physical_deletes: false,
    operations, excluded, summary: { candidates: candidates.length, prepared: operations.length,
      hold_only: operations.length, state_changes_enabled: false,
      excluded: excluded.length, exclusion_reasons: excluded.flatMap(row => row.reasons).reduce((out, key) => { out[key] = (out[key] || 0) + 1; return out; }, {}) } };
  return { ...body, package_sha256: hash(body) };
}
function verifyPackage(pkg) {
  const { package_sha256, ...body } = pkg;
  if (pkg.version !== VERSION || hash(body) !== package_sha256 || pkg.automation_policy !== 'hold') fail('PACKAGE_INTEGRITY_MISMATCH');
  const ids = new Set(), keys = new Set();
  for (const operation of pkg.operations) {
    const { operation_sha256, ...value } = operation;
    if (hash(value) !== operation_sha256 || hash(operation.before) !== operation.expected_row_sha256 || hash(operation.context) !== operation.expected_context_sha256) fail('OPERATION_INTEGRITY_MISMATCH');
    if (ids.has(operation.local_id) || keys.has(operation.action_key)) fail('DUPLICATE_PACKAGE_TARGET');
    ids.add(operation.local_id); keys.add(operation.action_key);
    if (!positive(operation.local_id) || !['pendiente', 'cancelada', 'completada', 'no_asistio'].includes(operation.desired_status)
      || operation.before.source_system !== 'cliniccloud' || operation.state_change !== false || operation.before.estado !== operation.desired_status) fail('INVALID_OPERATION');
  }
}
function approvalContext(pkg, approval, now) {
  verifyPackage(pkg);
  if (approval.package_sha256 !== pkg.package_sha256 || !String(approval.reviewed_by || '').trim()
    || !/^[a-f0-9]{64}$/.test(approval.backup_manifest_sha256 || '') || !/T.*Z$/.test(approval.reviewed_at || '') || !/T.*Z$/.test(approval.expires_at || '') || !Number.isFinite(Date.parse(approval.reviewed_at))
    || !Number.isFinite(Date.parse(approval.expires_at)) || Date.parse(approval.expires_at) <= now || Date.parse(approval.reviewed_at) > now
    || approval.automation_policy !== 'hold' || approval.confirm_in_place_only !== true) fail('EXPLICIT_CURRENT_APPROVAL_REQUIRED');
  if (!Array.isArray(approval.action_keys) || !approval.action_keys.length || new Set(approval.action_keys).size !== approval.action_keys.length
    || approval.action_keys.some(key => !pkg.operations.some(operation => operation.action_key === key))) fail('INVALID_APPROVED_ACTIONS');
  return new Set(approval.action_keys);
}
function holdPatch(row, pkg, operation, approval, now) {
  const metadata = row.import_metadata;
  const history = metadata.cliniccloud_reconciliation || { version: 1, applied: {} };
  if (history.version !== 1 || !history.applied || typeof history.applied !== 'object' || Array.isArray(history.applied)) fail('UNKNOWN_RECONCILIATION_METADATA');
  return { updated_at: new Date(Math.floor(now / 1000) * 1000).toISOString(), import_metadata: { ...metadata,
    notification_suppression: { ...object(metadata.notification_suppression || metadata.notificationSuppression || {}), appointment_details: true, day_before: true, same_day: true },
    cliniccloud_reconciliation: { ...history, automation_policy: 'hold', applied: { ...history.applied, [operation.action_key]: {
      package_sha256: pkg.package_sha256, operation_sha256: operation.operation_sha256, plan_sha256: pkg.plan_sha256,
      source_account: pkg.source_account, source_external_id: operation.source_external_id, provenance: operation.provenance,
      before_sha256: operation.expected_row_sha256, applied_at: new Date(now).toISOString(), reviewed_by: approval.reviewed_by,
      before_status: row.estado, after_status: operation.desired_status, automation_policy: 'hold', events_dispatched: false,
    } } },
  } };
}

async function applyAppointments({ pkg, approval, store, journal, now = () => Date.now(), maxOperations = 25 }) {
  const selected = approvalContext(pkg, approval, now());
  if (!Number.isSafeInteger(maxOperations) || maxOperations < 1 || maxOperations > 100) fail('INVALID_BATCH_LIMIT');
  if (!journal || typeof journal.append !== 'function') fail('DURABLE_PRIVATE_JOURNAL_REQUIRED');
  const summary = { selected: selected.size, committed: 0, already_applied: 0, deferred: 0, automation_policy: 'hold' };
  for (const operation of pkg.operations.filter(row => selected.has(row.action_key))) {
    if (summary.committed >= maxOperations) { summary.deferred++; continue; }
    approvalContext(pkg, approval, now());
    let outcome;
    await store.transaction(async tx => {
      const inspected = await tx.inspect(operation.local_id, operation.source_contact_id, true);
      const current = normalizedRow(inspected.row);
      const marker = current.import_metadata.cliniccloud_reconciliation?.applied?.[operation.action_key];
      if (marker) {
        if (marker.package_sha256 !== pkg.package_sha256 || marker.operation_sha256 !== operation.operation_sha256) fail('IDEMPOTENCY_MARKER_CONFLICT');
        // A later clinical/user change remains authoritative. Never restore the
        // import's old state simply to make a replay look identical.
        outcome = { phase: 'already_applied', action_key: operation.action_key, local_id: operation.local_id, current_row_sha256: hash(current) };
        return;
      }
      if (hash(current) !== operation.expected_row_sha256) fail('CURRENT_ROW_HASH_CONFLICT');
      if (hash(inspected.context) !== operation.expected_context_sha256) fail('CURRENT_CONTEXT_HASH_CONFLICT');
      if (current.source_system !== 'cliniccloud' || !pkg.clinic_ids.includes(Number(current.clinica_id))) fail('CURRENT_SOURCE_OR_CLINIC_CONFLICT');
      const patch = holdPatch(current, pkg, operation, approval, now());
      await journal.append({ phase: 'prepared', action_key: operation.action_key, local_id: operation.local_id,
        package_sha256: pkg.package_sha256, before: current, after: { ...current, ...patch }, operation_sha256: operation.operation_sha256 });
      await tx.update(operation.local_id, patch, current);
      const persisted = normalizedRow(await tx.read(operation.local_id));
      if (hash(persisted) !== hash({ ...current, ...patch, updated_at: instant(patch.updated_at) })) fail('AFTER_WRITE_VERIFICATION_FAILED');
      outcome = { phase: 'committed', action_key: operation.action_key, local_id: operation.local_id, after_row_sha256: hash(persisted) };
    });
    // Failure here aborts the invocation; resume reads the committed row marker.
    await journal.append({ ...outcome, package_sha256: pkg.package_sha256 });
    if (outcome.phase === 'committed') summary.committed++; else summary.already_applied++;
  }
  return summary;
}

module.exports = { VERSION, instant, normalizedRow, verifyPlan, verifyPackage, validateCandidate, prepareAppointments, applyAppointments, holdPatch, approvalContext };
