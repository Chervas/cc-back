'use strict';

// Source-faithful creation of explicitly reviewed, already-linked appointments.
// Does not reschedule/cancel existing appointments, merge patients, book a
// program, invent a professional, send events or turn reminders on.
const { hash, dateOnly, localToUtc } = require('./adapter');
const { verifyPlan, instant } = require('./appointments-apply');
const { revisedSource, validateSourceRevision, assertFreshRevision } = require('./source-revisions');
const { validateDistinctVisit, assertFreshDistinctVisit } = require('./distinct-visits');
const VERSION = 'cliniccloud-week-appointments/1';
const ACCOUNT = 'cliniccloud-5880';
const positive = value => Number.isSafeInteger(value) && value > 0;
const fail = code => { throw Error(code); };
const digest = value => { const { package_sha256, ...body } = value; return hash(body); };
function sourceReference(source) {
  // Not an invented ClinicCloud appointment ID: this is explicitly an import
  // fingerprint. A later export is reconciled against the persisted baseline.
  return `delta:${ACCOUNT}:${hash([source.source_contact_id, source.start_local, source.end_local, source.agenda_key, source.service_key])}`;
}
function weekActions(plan, week) {
  if (!week || dateOnly(week.start) !== week.start || dateOnly(week.end) !== week.end
    || week.start > week.end || Date.parse(week.end) - Date.parse(week.start) > 6 * 86400000
    || week.start < plan.manifest.coverage.start || week.end > plan.manifest.coverage.end) fail('IMPORT_WEEK_INVALID');
  return plan.actions.filter(a => a.entity === 'appointment' && a.source
    && a.source.start_local.slice(0, 10) >= week.start && a.source.start_local.slice(0, 10) <= week.end);
}
function prepareWeekAppointments({ plan, snapshot, review, target, capturedAt = new Date().toISOString() }) {
  verifyPlan(plan, snapshot);
  if (!['dev', 'crm'].includes(target) || snapshot.database_target !== target || snapshot.source_account !== ACCOUNT
    || ![66, 72].every(id => snapshot.complete_for.clinic_ids.includes(id))) fail('WEEK_IMPORT_TARGET_OR_SCOPE_INVALID');
  if (review.plan_sha256 !== plan.plan_sha256 || !String(review.reviewed_by || '').trim()
    || !Number.isFinite(Date.parse(review.reviewed_at)) || !Array.isArray(review.decisions)) fail('WEEK_REVIEW_REQUIRED');
  const actions = weekActions(plan, review.week), byKey = new Map(actions.map(a => [a.action_key, a]));
  if (review.decisions.length !== actions.length || new Set(review.decisions.map(d => d.action_key)).size !== actions.length
    || review.decisions.some(d => !byKey.has(d.action_key) || !String(d.reason || '').trim())) fail('COMPLETE_WEEK_REVIEW_REQUIRED');
  const operations = [], deferred = [], references = new Set();
  for (const decision of review.decisions) {
    const action = byKey.get(decision.action_key);
    if (decision.disposition === 'defer') { deferred.push({ action_key: action.action_key, reason: decision.reason }); continue; }
    const source = decision.source_revision ? revisedSource(action.source, decision.source_revision) : action.source;
    if (decision.distinct_visit) {
      validateDistinctVisit(decision.distinct_visit, action);
      if (decision.source_revision || decision.assignment?.appointment_type !== 'continuacion') fail('WEEK_DISTINCT_VISIT_SCOPE_INVALID');
      const native = snapshot.appointments.find(a => a.id === Number(decision.distinct_visit.preserved_native.id_cita));
      if (!native || native.patient_id !== action.patient_id || native.source_system
        || native.end_local >= source.start_local) fail('WEEK_DISTINCT_VISIT_SCOPE_INVALID');
    }
    if (decision.disposition !== 'create' || (!decision.distinct_visit && (action.action !== 'create_appointment_candidate'
      || action.candidate_local_ids.length || action.reasons.some(r => r !== 'RESOURCE_AND_SERVICE_MAP_REQUIRED')))
      || source.validation_errors.length || !positive(action.patient_id)) fail('WEEK_CREATION_NOT_UNAMBIGUOUS');
    if (!['pendiente', 'cancelada'].includes(source.status)) fail('WEEK_CLINICAL_STATUS_REQUIRES_REVIEW');
    if (localToUtc(source.start_local) !== source.start_utc || localToUtc(source.end_local) !== source.end_utc
      || source.end_utc <= source.start_utc || new Date(source.end_utc) - new Date(source.start_utc) > 86400000) fail('WEEK_SOURCE_INTERVAL_INVALID');
    if (source.start_local.slice(0, 10) < review.week.start || source.end_local.slice(0, 10) > review.week.end) fail('WEEK_REVISED_INTERVAL_OUTSIDE_WEEK');
    const patients = snapshot.patients.filter(p => p.source_contact_ids.includes(source.source_contact_id));
    if (patients.length !== 1 || patients[0].id !== action.patient_id) fail('WEEK_PATIENT_LINK_AMBIGUOUS');
    const assignment = decision.assignment || {};
    if (![66, 72].includes(assignment.clinic_id)) fail('WEEK_CLINIC_ASSIGNMENT_REQUIRED');
    for (const key of ['doctor_id', 'installation_id', 'treatment_id']) {
      if (assignment[key] !== null && !positive(assignment[key])) fail('WEEK_ASSIGNMENT_INVALID');
      if (assignment[key] === null && !decision.pending_assignment?.includes(key)) fail('WEEK_MISSING_ASSIGNMENT_MUST_BE_EXPLICIT');
    }
    if (!['primera_sin_trat', 'primera_con_trat', 'continuacion', 'revision', 'urgencia'].includes(assignment.appointment_type)) fail('WEEK_APPOINTMENT_TYPE_INVALID');
    if (!Array.isArray(decision.evidence) || !decision.evidence.length || decision.evidence.some(e => typeof e !== 'string' || !e.trim())) fail('WEEK_ASSIGNMENT_EVIDENCE_REQUIRED');
    const reference = sourceReference(source);
    if (references.has(reference)) fail('WEEK_DUPLICATE_SOURCE_SLOT');
    references.add(reference);
    const sourceBaseline = Object.fromEntries(['source_contact_id', 'start_local', 'end_local', 'agenda_key', 'service_key', 'status'].map(key => [key, source[key]]));
    const body = { action_key: action.action_key, source_reference: reference, source_contact_id: source.source_contact_id,
      patient_id: action.patient_id, assignment, pending_assignment: decision.pending_assignment || [], evidence: decision.evidence,
      source: sourceBaseline, provenance: action.provenance, title: String(source.service_key || 'Cita importada').slice(0, 255),
      note: source.details || null, start_utc: source.start_utc, end_utc: source.end_utc, status: source.status };
    if (decision.source_revision) body.source_revision = decision.source_revision;
    if (decision.distinct_visit) body.distinct_visit = decision.distinct_visit;
    operations.push({ ...body, operation_sha256: hash(body) });
  }
  if (!operations.length || operations.length > 250) fail('WEEK_BATCH_SIZE_INVALID');
  const body = { version: VERSION, source_account: ACCOUNT, database_target: target, group_id: snapshot.database_group_id,
    clinic_ids: [66, 72], week: review.week, captured_at: capturedAt, plan_sha256: plan.plan_sha256,
    snapshot_sha256: plan.manifest.snapshot_sha256, review_sha256: hash(review), reviewed_by: review.reviewed_by,
    automation_policy: 'hold', sends_messages: false, invokes_events: false, changes_existing_appointments: false,
    operations, deferred };
  return { ...body, package_sha256: hash(body) };
}
function verifyWeekPackage(pkg) {
  if (pkg.version !== VERSION || digest(pkg) !== pkg.package_sha256 || pkg.source_account !== ACCOUNT
    || !['dev', 'crm'].includes(pkg.database_target) || hash(pkg.clinic_ids) !== hash([66, 72])
    || pkg.automation_policy !== 'hold' || pkg.sends_messages !== false || pkg.invokes_events !== false
    || pkg.changes_existing_appointments !== false || !pkg.operations.length || pkg.operations.length > 250) fail('WEEK_PACKAGE_INVALID');
  if (new Set(pkg.operations.map(o => o.source_reference)).size !== pkg.operations.length) fail('WEEK_DUPLICATE_SOURCE_SLOT');
  for (const operation of pkg.operations) {
    const { operation_sha256, ...body } = operation;
    if (hash(body) !== operation_sha256 || sourceReference(operation.source) !== operation.source_reference) fail('WEEK_OPERATION_CHANGED');
    if (operation.distinct_visit) {
      const reviewed = validateDistinctVisit(operation.distinct_visit);
      if (operation.source_revision || operation.assignment.appointment_type !== 'continuacion'
        || reviewed.patient_id !== operation.patient_id || reviewed.source.source_contact_id !== operation.source_contact_id
        || Object.keys(operation.source).some(k => operation.source[k] !== reviewed.source[k])
        || operation.note !== (reviewed.source.details || null)
        || operation.start_utc !== localToUtc(reviewed.source.start_local)
        || operation.end_utc !== localToUtc(reviewed.source.end_local) || operation.status !== 'pendiente') fail('WEEK_OPERATION_CHANGED');
    }
    if (operation.source_revision) {
      const revision = validateSourceRevision(operation.source_revision);
      if (Object.keys(operation.source).some(key => operation.source[key] !== revision.current[key])
        || operation.note !== (revision.current.details || null) || hash(operation.provenance) !== hash(revision.provenance)
        || operation.start_utc !== localToUtc(revision.current.start_local) || operation.end_utc !== localToUtc(revision.current.end_local)
        || operation.source_contact_id !== revision.current.source_contact_id || operation.status !== revision.current.status) fail('WEEK_OPERATION_CHANGED');
    }
  }
}
function appointmentPayload(operation, pkg, approval, now) {
  const timestamp = new Date(Math.floor(now / 1000) * 1000).toISOString();
  return { clinica_id: operation.assignment.clinic_id, paciente_id: operation.patient_id,
    doctor_id: operation.assignment.doctor_id, instalacion_id: operation.assignment.installation_id,
    tratamiento_id: operation.assignment.treatment_id, titulo: operation.title, nota: operation.note,
    motivo: 'Cita importada de ClinicCloud', tipo_cita: operation.assignment.appointment_type, estado: operation.status,
    inicio: operation.start_utc, fin: operation.end_utc, source_system: 'cliniccloud', source_reference: operation.source_reference,
    es_provisional: 0, created_at: timestamp, updated_at: timestamp,
    import_metadata: { source_account: ACCOUNT, source_contact_id: operation.source_contact_id,
      ...(operation.distinct_visit ? { cliniccloud_distinct_visit: operation.distinct_visit } : {}),
      ...(operation.source_revision ? { source_appointment_id: operation.source_revision.source_appointment_id,
        cliniccloud_source_revision: operation.source_revision } : {}),
      notification_suppression: { appointment_details: true, day_before: true, same_day: true },
      cliniccloud_delta: { version: 1, source: operation.source, provenance: operation.provenance,
        source_reference_kind: 'import_fingerprint_not_source_appointment_id', pending_assignment: operation.pending_assignment,
        evidence: operation.evidence, imported_at: timestamp },
      cliniccloud_reconciliation: { version: 1, automation_policy: 'hold', applied: { [operation.action_key]: {
        package_sha256: pkg.package_sha256, operation_sha256: operation.operation_sha256, reviewed_by: approval.reviewed_by,
        imported_at: timestamp, events_dispatched: false, automation_policy: 'hold' } } } } };
}
async function executeWeekAppointments({ pkg, approval, store, journal, now = () => Date.now() }) {
  verifyWeekPackage(pkg);
  const approve = () => {
    if (approval.package_sha256 !== pkg.package_sha256 || approval.automation_policy !== 'hold'
      || approval.confirm_create_only !== true || !String(approval.reviewed_by || '').trim()
      || !/^[a-f0-9]{64}$/.test(approval.backup_manifest_sha256 || '')
      || !Number.isFinite(Date.parse(approval.expires_at)) || Date.parse(approval.expires_at) <= now()) fail('WEEK_APPROVAL_REQUIRED');
  };
  approve();
  const summary = { created: 0, replayed: 0, deferred: 0, pending_assignment: 0, appointments_modified: 0, messages_sent: 0, automation_policy: 'hold' };
  for (const operation of pkg.operations) {
    approve(); let outcome;
    await store.transaction(async tx => {
      const existing = await tx.findSource(operation.source_reference);
      if (existing) {
        const metadata = typeof existing.import_metadata === 'string' ? JSON.parse(existing.import_metadata) : existing.import_metadata;
        const marker = metadata?.cliniccloud_reconciliation?.applied?.[operation.action_key];
        if (marker?.package_sha256 !== pkg.package_sha256 || marker?.operation_sha256 !== operation.operation_sha256
          || Number(existing.paciente_id) !== operation.patient_id) fail('WEEK_REPLAY_IDENTITY_CONFLICT');
        outcome = { phase: 'week_already_applied', action_key: operation.action_key, local_id: Number(existing.id_cita) };
        return; // A replay never restores a later user's field changes.
      }
      const checked = await tx.validate(operation, pkg);
      if (checked.reasons.length) {
        outcome = { phase: 'week_deferred', action_key: operation.action_key, reasons: checked.reasons };
        return;
      }
      if (operation.source_revision) assertFreshRevision(operation.source_revision, now());
      if (operation.distinct_visit) assertFreshDistinctVisit(operation.distinct_visit, now());
      const payload = appointmentPayload(operation, pkg, approval, now());
      await journal.append({ phase: 'week_prepared', package_sha256: pkg.package_sha256,
        action_key: operation.action_key, operation_sha256: operation.operation_sha256, payload,
        backup_manifest_sha256: approval.backup_manifest_sha256 });
      const id = await tx.insert(payload);
      const saved = await tx.read(id);
      if (!saved || Number(saved.paciente_id) !== operation.patient_id || saved.source_reference !== operation.source_reference
        || saved.estado !== operation.status) fail('WEEK_INSERT_VERIFICATION_FAILED');
      for (const [key, value] of Object.entries(payload)) {
        const stored = key === 'import_metadata' ? (typeof saved[key] === 'string' ? JSON.parse(saved[key]) : saved[key])
          : ['inicio', 'fin', 'created_at', 'updated_at'].includes(key) ? instant(saved[key]) : saved[key];
        if (hash(stored) !== hash(value)) fail('WEEK_INSERT_VERIFICATION_FAILED');
      }
      outcome = { phase: 'week_committed', action_key: operation.action_key, local_id: Number(id),
        pending_assignment: operation.pending_assignment, after_sha256: hash(saved) };
    });
    await journal.append({ ...outcome, package_sha256: pkg.package_sha256 });
    if (outcome.phase === 'week_committed') { summary.created++; if (outcome.pending_assignment.length) summary.pending_assignment++; }
    else if (outcome.phase === 'week_already_applied') summary.replayed++;
    else summary.deferred++;
  }
  return summary;
}

module.exports = { VERSION, ACCOUNT, sourceReference, weekActions, prepareWeekAppointments, verifyWeekPackage, appointmentPayload, executeWeekAppointments };
