'use strict';

const { hash, index } = require('./adapter');

// A review is bound to the exact plan AND the exact local snapshot. It prepares
// immutable domain commands, not SQL. The live appointment command must still
// check permissions, resource availability and freshness inside its transaction.
function prepareReview({ plan, snapshot, review }) {
  if (hash({ manifest: plan.manifest, actions: plan.actions }) !== plan.plan_sha256) throw new Error('PLAN_INTEGRITY_MISMATCH');
  if (!snapshot || hash(snapshot) !== plan.manifest.snapshot_sha256) throw new Error('SNAPSHOT_INTEGRITY_MISMATCH');
  if (review.plan_sha256 !== plan.plan_sha256) throw new Error('REVIEW_PLAN_MISMATCH');
  if (!String(review.reviewed_by || '').trim() || !Number.isFinite(Date.parse(review.reviewed_at))) throw new Error('REVIEW_ACTOR_AND_DATE_REQUIRED');
  if (!Array.isArray(review.decisions)) throw new Error('REVIEW_DECISIONS_REQUIRED');
  const actions = index(plan.actions, (r) => r.action_key);
  const locals = index(snapshot.appointments, (r) => String(r.id));
  const patients = index(snapshot.patients, (r) => String(r.id));
  const decisions = index(review.decisions, (r) => r.action_key);
  const patientMappings = new Map();
  const commands = [];
  const nativeLinks = new Set();
  const targetClaims = new Map();
  const reviewedKeys = new Set();
  const scopes = new Set(snapshot.complete_for?.clinic_ids || []);
  const numericId = (v) => Number.isSafeInteger(Number(v)) && Number(v) > 0;
  const getLocal = (id) => {
    const rows = locals.get(String(id)) || [];
    if (rows.length !== 1 || !scopes.has(rows[0].clinic_id)) throw new Error('REVIEW_LOCAL_APPOINTMENT_NOT_IN_SCOPE');
    return rows[0];
  };
  const getPatient = (id) => {
    const rows = patients.get(String(id)) || [];
    if (rows.length !== 1) throw new Error('REVIEW_PATIENT_NOT_IN_SNAPSHOT');
    return rows[0];
  };
  function add(action, command) {
    commands.push({ action_key: action.action_key, source_system: 'cliniccloud', source_account: plan.manifest.source_account, provenance: action.provenance || null, source_external_id: action.source_external_id || null, automation_policy: 'hold', ...command });
    reviewedKeys.add(action.action_key);
  }
  // Resolve contact links first, independent of the order in a review file.
  for (const decision of review.decisions) {
    if (!decision.action_key || decisions.get(decision.action_key).length !== 1 || actions.get(decision.action_key)?.length !== 1) throw new Error('UNKNOWN_OR_DUPLICATE_REVIEW_ACTION');
    const action = actions.get(decision.action_key)[0];
    if (decision.disposition === 'map_patient') {
      if (action.entity !== 'patient') throw new Error('REVIEW_ENTITY_MISMATCH');
      const patient = getPatient(decision.local_patient_id);
      if (!String(decision.reason || '').trim()) throw new Error('IDENTITY_REVIEW_REASON_REQUIRED');
      patientMappings.set(action.source_contact_id, patient.id);
      add(action, { command: 'link_patient_source', patient_id: patient.id, expected_patient_hash: hash(patient), source_contact_id: action.source_contact_id, reason: decision.reason, mutate_contact_fields: false, mutate_consents: false });
    }
  }
  for (const decision of review.decisions) {
    const action = actions.get(decision.action_key)[0];
    if (decision.disposition === 'map_patient') continue;
    if (decision.disposition === 'defer') continue;
    if (!String(decision.reason || '').trim()) throw new Error('REVIEW_REASON_REQUIRED');
    if (decision.disposition === 'preserve') {
      // This records a deliberate conflict resolution; it does not erase or
      // downgrade any patient/appointment state.
      add(action, { command: 'preserve', reason: decision.reason, local_id: action.local_id || null });
      continue;
    }
    if (decision.disposition === 'supersede') {
      if (action.action !== 'supersede_candidate') throw new Error('SUPERSEDE_NOT_PROPOSED');
      const local = getLocal(action.local_id);
      if (local.source_system !== 'cliniccloud') throw new Error('CANNOT_SUPERSEDE_NATIVE_APPOINTMENT');
      if (!local.start_local || local.start_local.slice(0, 10) < plan.manifest.coverage.start || local.start_local.slice(0, 10) > plan.manifest.coverage.end) throw new Error('CANNOT_SUPERSEDE_OUTSIDE_COVERAGE');
      add(action, { command: 'supersede_imported_appointment', local_id: local.id, expected_local_hash: hash(local), reason: decision.reason, retain_clinical_evidence: true, physical_delete: false, cancellation_origin: 'source_snapshot_superseded' });
      continue;
    }
    if (decision.disposition === 'link_appointment' || decision.disposition === 'upsert_appointment') {
      if (action.entity !== 'appointment' || !action.source) throw new Error('REVIEW_ENTITY_MISMATCH');
      const source = action.source;
      if (source.validation_errors?.length || !source.start_utc || !source.end_utc) throw new Error('SOURCE_APPOINTMENT_INVALID');
      const target = decision.local_appointment_id ? getLocal(decision.local_appointment_id) : null;
      if (decision.disposition === 'link_appointment' && !target) throw new Error('LINK_TARGET_REQUIRED');
      const patientId = decision.local_patient_id || patientMappings.get(source.source_contact_id) || action.patient_id;
      getPatient(patientId);
      if (target && String(target.patient_id) !== String(patientId)) throw new Error('PATIENT_IDENTITY_CONFLICT');
      if (target && targetClaims.has(String(target.id))) throw new Error('DUPLICATE_CANONICAL_APPOINTMENT_CLAIM');
      if (target) targetClaims.set(String(target.id), action.action_key);
      if (decision.disposition === 'link_appointment') {
        nativeLinks.add(String(target.id));
        add(action, { command: 'link_appointment_source', local_id: target.id, patient_id: target.patient_id, expected_local_hash: hash(target), preserve_native_state: true, mutate_schedule: false, reason: decision.reason });
      } else {
        if (target && target.source_system !== 'cliniccloud') throw new Error('CANNOT_OVERWRITE_NATIVE_APPOINTMENT');
        const assignment = decision.assignment || {};
        const clinicId = assignment.clinic_id || target?.clinic_id;
        const doctorId = assignment.doctor_id || target?.doctor_id;
        const installationId = assignment.installation_id || target?.installation_id;
        const treatmentId = assignment.treatment_id || target?.treatment_id;
        if (![clinicId, doctorId, installationId, treatmentId].every(numericId) || !scopes.has(clinicId)) throw new Error('COMPLETE_RESOURCE_ASSIGNMENT_REQUIRED');
        const type = assignment.appointment_type;
        if (!['primera_sin_trat', 'primera_con_trat', 'continuacion', 'urgencia', 'revision'].includes(type)) throw new Error('APPOINTMENT_TYPE_REQUIRED');
        add(action, { command: target ? 'update_imported_appointment' : 'create_imported_appointment', local_id: target?.id || null, expected_local_hash: target ? hash(target) : null, patient_id: Number(patientId), clinic_id: clinicId, doctor_id: doctorId, installation_id: installationId, treatment_id: treatmentId, appointment_type: type, start_utc: source.start_utc, end_utc: source.end_utc, source_status: source.status, reason: decision.reason, retain_clinical_evidence: true });
      }
      for (const duplicateId of decision.superseded_local_ids || []) {
        const duplicate = getLocal(duplicateId);
        if (duplicate.source_system !== 'cliniccloud' || String(duplicate.patient_id) !== String(patientId) || String(duplicate.id) === String(target?.id) || targetClaims.has(String(duplicate.id))) throw new Error('INVALID_DUPLICATE_SUPERSESSION');
        if (!duplicate.start_local || duplicate.start_local.slice(0, 10) < plan.manifest.coverage.start || duplicate.start_local.slice(0, 10) > plan.manifest.coverage.end) throw new Error('CANNOT_SUPERSEDE_OUTSIDE_COVERAGE');
        targetClaims.set(String(duplicate.id), action.action_key);
        add(action, { command: 'supersede_imported_duplicate', local_id: duplicate.id, canonical_local_id: target?.id || null, canonical_action_key: action.action_key, expected_local_hash: hash(duplicate), physical_delete: false, retain_clinical_evidence: true, reason: decision.reason });
      }
      continue;
    }
    if (decision.disposition === 'import_followup') {
      if (action.entity !== 'followup' || action.source.validation_errors.length) throw new Error('FOLLOWUP_SOURCE_INVALID');
      const patientId = decision.local_patient_id || patientMappings.get(action.source.source_contact_id) || (snapshot.patients.find((p) => (p.source_contact_ids || []).includes(action.source.source_contact_id))?.id);
      getPatient(patientId);
      if (!scopes.has(decision.clinic_id)) throw new Error('FOLLOWUP_CLINIC_REQUIRED');
      add(action, { command: 'upsert_imported_followup', patient_id: patientId, clinic_id: decision.clinic_id, contact_due_at: action.source.contact_due_at, target_date: null, status: action.source.status, body: action.source.body, reason: decision.reason, occupies_agenda: false });
      continue;
    }
    throw new Error('UNSUPPORTED_REVIEW_DISPOSITION');
  }
  // An appointment cannot simultaneously be canonical and superseded, even if
  // those decisions were submitted under different source/absence actions.
  const supersededIds = commands.filter((r) => r.command.startsWith('supersede_')).map((r) => String(r.local_id));
  const canonicalIds = new Set(commands.filter((r) => ['link_appointment_source', 'update_imported_appointment'].includes(r.command)).map((r) => String(r.local_id)));
  if (new Set(supersededIds).size !== supersededIds.length || supersededIds.some((id) => nativeLinks.has(id) || canonicalIds.has(id))) throw new Error('CONFLICTING_SUPERSESSION_DECISIONS');
  const result = { version: 1, mode: 'reviewed_commands_only', plan_sha256: plan.plan_sha256, snapshot_sha256: plan.manifest.snapshot_sha256, review_sha256: hash(review), source_account: plan.manifest.source_account, reviewed_by: review.reviewed_by, reviewed_at: review.reviewed_at, automation_policy: 'hold', requires_live_validation: ['snapshot_freshness', 'clinic_permissions', 'patient_identity_and_scope', 'resource_eligibility', 'atomic_calendar_availability', 'idempotency_ledger'], executable: false, unresolved_review_actions: plan.actions.filter((r) => r.requires_review && !reviewedKeys.has(r.action_key)).length, commands };
  return { ...result, package_sha256: hash(result) };
}

module.exports = { prepareReview };
