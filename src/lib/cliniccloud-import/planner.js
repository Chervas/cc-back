'use strict';

const { ADAPTER_VERSION, TIMEZONE, hash, stableJson, index, norm, dateOnly } = require('./adapter');
const { sourceReference } = require('./week-appointments');

const appointmentKey = (r) => stableJson([r.kind || 'appointment', r.source_contact_id, r.start_local, r.end_local, r.agenda_key]);
const patientTimeKey = (r) => r.patient_id ? stableJson([r.kind || 'appointment', String(r.patient_id), r.start_local, r.end_local]) : null;
const sourceId = (r) => r.source_external_id || (r.source_reference?.startsWith('appointment:') ? r.source_reference.slice(12) : null);
const isImported = (r) => r.source_system === 'cliniccloud';
const inCoverage = (r, c) => Boolean(r.start_local && r.start_local.slice(0, 10) >= c.start && r.start_local.slice(0, 10) <= c.end);
const count = (rows, field) => rows.reduce((result, row) => { const key = String(row[field] ?? 'unknown'); result[key] = (result[key] || 0) + 1; return result; }, {});
const comparable = (r) => ({ start_local: r.start_local, end_local: r.end_local, status: r.status, agenda_key: r.agenda_key });

function validateContext({ sourceAccount, coverage, snapshot }) {
  if (!sourceAccount || !/^[a-zA-Z0-9_.:-]+$/.test(sourceAccount)) throw new Error('SOURCE_ACCOUNT_REQUIRED');
  if (dateOnly(coverage?.start) !== coverage?.start || dateOnly(coverage?.end) !== coverage?.end || coverage.start > coverage.end) throw new Error('INVALID_COVERAGE');
  if (snapshot && snapshot.source_account !== sourceAccount) throw new Error('SNAPSHOT_SOURCE_ACCOUNT_MISMATCH');
  if (snapshot && (!Array.isArray(snapshot.appointments) || !Array.isArray(snapshot.patients))) throw new Error('INVALID_LOCAL_SNAPSHOT');
  if (snapshot?.complete_for && (!Array.isArray(snapshot.complete_for.clinic_ids) || !snapshot.complete_for.clinic_ids.length)) throw new Error('INVALID_SNAPSHOT_SCOPE');
  if (snapshot?.complete_for && snapshot.appointments.some((row) => row.clinic_id !== undefined && !snapshot.complete_for.clinic_ids.includes(row.clinic_id))) throw new Error('APPOINTMENT_OUTSIDE_SNAPSHOT_CLINICS');
}

function planContacts(contacts, historical, patients) {
  const bySource = new Map();
  for (const patient of patients) for (const external of patient.source_contact_ids || []) {
    const key = String(external);
    if (!bySource.has(key)) bySource.set(key, []);
    if (!bySource.get(key).some((r) => String(r.id) === String(patient.id))) bySource.get(key).push(patient);
  }
  const oldById = index(historical, (r) => r.source_contact_id);
  const newById = index(contacts, (r) => r.source_contact_id);
  const oldPhone = index(historical, (r) => norm(r.fields.phone).replace(/\D/g, ''));
  const oldDocument = index(historical, (r) => norm(r.fields.national_id));
  const oldEmail = index(historical, (r) => norm(r.fields.email));
  const actions = [];
  for (const contact of contacts) {
    const targets = bySource.get(contact.source_contact_id) || [];
    const action = { entity: 'patient', source_contact_id: contact.source_contact_id, provenance: contact.provenance, action: 'review', reasons: [], fields_patch: {}, local_id: targets.length === 1 ? targets[0].id : null };
    if (!contact.source_contact_id || newById.get(contact.source_contact_id).length !== 1) action.reasons.push('DUPLICATE_OR_MISSING_SOURCE_CONTACT_ID');
    else if (targets.length > 1) action.reasons.push('CONFLICTING_PATIENT_SOURCE_LINKS');
    else if (targets.length === 1) {
      action.action = 'link_patient';
      const local = targets[0];
      // No known baseline => propose review, never overwrite a local field.
      const baseline = local.last_imported_fields || oldById.get(contact.source_contact_id)?.[0]?.fields;
      // Source and persisted representation may differ (name casing, phone
      // formatting). Preserve both baselines: formatting is not a source edit,
      // and a subsequent genuine source edit must not erase a local correction.
      const localBaseline = local.last_imported_local_fields || baseline;
      for (const [field, value] of Object.entries(contact.fields)) {
        const current = local.fields?.[field];
        if (!value || value === current || value === baseline?.[field]) continue;
        if (current === undefined || !baseline || (current !== localBaseline[field] && current !== value)) action.reasons.push(`LOCAL_FIELD_CONFLICT:${field}`);
        else action.fields_patch[field] = value;
      }
      if (action.reasons.length) action.action = 'review';
    } else if (oldById.has(contact.source_contact_id)) {
      action.action = 'recover_patient_link_candidate';
      action.reasons.push('HISTORIC_SOURCE_WITHOUT_LOCAL_LINK');
    } else {
      const hints = [oldPhone.get(norm(contact.fields.phone).replace(/\D/g, '')), oldDocument.get(norm(contact.fields.national_id)), oldEmail.get(norm(contact.fields.email))].flat().filter(Boolean);
      action.action = hints.length ? 'review' : 'create_patient_candidate';
      action.candidate_source_ids = [...new Set(hints.map((r) => r.source_contact_id))];
      action.reasons.push(hints.length ? 'IDENTITY_HINT_IS_NOT_A_MERGE_AUTHORIZATION' : 'REQUIRES_LOCAL_IDENTITY_VALIDATION');
    }
    action.requires_review = action.action !== 'link_patient';
    actions.push(action);
  }
  return { actions, bySource };
}

function choosePrimaryClinic(evidence) {
  const eligible = evidence.filter((r) => r.clinic_id && r.treatment_id && dateOnly(r.treatment_date) && !r.cancelled && r.kind !== 'block').map((r) => ({ ...r, treatment_date: dateOnly(r.treatment_date) }));
  const paid = eligible.filter((r) => r.paid_evidence === true && !r.payment_reversed);
  const pool = (paid.length ? paid : eligible).slice().sort((a, b) => a.treatment_date.localeCompare(b.treatment_date));
  if (!pool.length) return { clinic_id: null, rule: null, requires_review: true, reason: 'NO_TREATMENT_EVIDENCE' };
  const firstDate = pool[0].treatment_date;
  const oldest = pool.filter((r) => r.treatment_date === firstDate);
  const clinics = [...new Set(oldest.map((r) => String(r.clinic_id)))];
  return { clinic_id: clinics.length === 1 ? oldest[0].clinic_id : null, rule: paid.length ? 'oldest_paid_treatment' : 'oldest_recorded_treatment', evidence: oldest, requires_review: clinics.length !== 1, reason: clinics.length !== 1 ? 'OLDEST_TREATMENT_CLINIC_TIE' : null };
}

function buildPlan({ sourceAccount, coverage, files = [], contacts = [], appointments = [], alerts = [], historicalContacts = [], historicalAppointments = [], snapshot = null, priorityDate = '2026-09-07' }) {
  validateContext({ sourceAccount, coverage, snapshot });
  const patients = snapshot?.patients || [];
  const localAppointments = snapshot?.appointments || [];
  const contactPlan = planContacts(contacts, historicalContacts, patients);
  const contactIds = index(contacts, (r) => r.source_contact_id);
  const historicalExact = index(historicalAppointments, appointmentKey);
  const historicalIds = index(historicalAppointments, sourceId);
  const sourceExact = index(appointments, appointmentKey);
  const sourceExternalIds = index(appointments, sourceId);
  const sourceRowHashes = new Map();
  const localSourceIds = index(localAppointments.filter(isImported), sourceId);
  const localTime = index(localAppointments, patientTimeKey);
  const localPatient = index(localAppointments, (r) => String(r.patient_id || ''));
  // Persisted, validated aliases only. Never infer a parallel visit merely
  // from simultaneous times or allow it to rewrite the shared appointment.
  const parallelReferences = index(localAppointments.filter(isImported).flatMap(local =>
    (local.parallel_sources || []).map(entry => ({ local, entry }))), item => item.entry.source_reference);
  const revisionReferences = index(localAppointments.filter(local => isImported(local) && local.source_revision),
    local => sourceReference(local.source_revision.original));
  const reconciledReferences = index(localAppointments.filter(isImported).flatMap(local =>
    ((local.source_reconciliation || local.legacy_source_reconciliation)?.entries || []).map(entry => ({ local, entry }))), item => item.entry.source_reference);
  const claimedLocal = new Set();
  const recoveredHistoricalIds = new Set();
  const decisions = [];
  for (const row of appointments) {
    const patientTargets = contactPlan.bySource.get(row.source_contact_id) || [];
    const patient = patientTargets.length === 1 ? patientTargets[0] : null;
    const decision = { entity: row.kind, provenance: row.provenance, source_external_id: row.source_external_id, patient_id: patient?.id || null, action: 'review', reasons: [...row.validation_errors], candidate_local_ids: [], requires_review: true, automation_policy: 'hold', source: row };
    const duplicate = sourceRowHashes.get(row.provenance.row_sha256);
    if (duplicate) {
      decision.action = 'alias_identical_source_row'; decision.alias_of = duplicate;
      decision.reasons = ['IDENTICAL_SOURCE_BYTES']; decision.requires_review = false;
      decisions.push(decision); continue;
    }
    sourceRowHashes.set(row.provenance.row_sha256, row.provenance.row_key);
    if (!inCoverage(row, coverage)) decision.reasons.push('SOURCE_ROW_OUTSIDE_DECLARED_COVERAGE');
    if (row.kind !== 'block' && (contactIds.get(row.source_contact_id)?.length || 0) !== 1) decision.reasons.push('SOURCE_PATIENT_NOT_UNIQUE');
    if (row.source_external_id && sourceExternalIds.get(row.source_external_id).length > 1) decision.reasons.push('DUPLICATE_SOURCE_APPOINTMENT_ID');
    const sameIdentity = sourceExact.get(appointmentKey(row)) || [];
    if (new Set(sameIdentity.map((r) => r.provenance.row_sha256)).size > 1) decision.reasons.push('MULTIPLE_DISTINCT_SOURCE_ROWS_SAME_SLOT');
    const reconciled = row.kind === 'appointment' ? reconciledReferences.get(sourceReference(row)) || [] : [];
    if (reconciled.length) {
      decision.candidate_local_ids = reconciled.map(item => item.local.id);
      if (reconciled.length !== 1) decision.reasons.push('RECONCILED_SOURCE_MULTIPLE_LOCAL_MATCHES');
      else {
        const { local, entry } = reconciled[0], current = (local.source_reconciliation || local.legacy_source_reconciliation).current;
        decision.local_id = local.id; decision.expected_local_hash = hash(local);
        decision.source_external_id = entry.source_appointment_id;
        if (!patient || String(local.patient_id) !== String(patient.id)) decision.reasons.push('LOCAL_PATIENT_IDENTITY_CONFLICT');
        if (row.status !== entry.source.status || norm(row.details || '') !== norm(entry.source.details)
          || (row.source_external_id && String(row.source_external_id) !== entry.source_appointment_id)) decision.reasons.push('RECONCILED_SOURCE_CHANGED_REQUIRES_REVIEW');
        if (local.local_modified || local.reconciliation_local_changed
          || ['start_local', 'end_local', 'status'].some(key => local[key] !== current[key])) decision.reasons.push('LOCAL_EDIT_REQUIRES_REVIEW');
        const overlaps = current.status !== 'cancelada' && patient ? localTime.get(patientTimeKey({ ...current, patient_id: patient.id })) || [] : [];
        if (overlaps.some(other => String(other.id) !== String(local.id) && other.status !== 'cancelada')) decision.reasons.push('RECONCILED_SOURCE_LOCAL_OVERLAP');
        if (!decision.reasons.length) { decision.action = 'preserve_reconciled_legacy_source'; decision.requires_review = false; claimedLocal.add(String(local.id)); }
      }
      decisions.push(decision); continue;
    }
    const revised = revisionReferences.get(sourceReference(row)) || [];
    if (revised.length) {
      decision.candidate_local_ids = revised.map(local => local.id);
      if (revised.length !== 1) decision.reasons.push('SOURCE_REVISION_MULTIPLE_LOCAL_MATCHES');
      else {
        const local = revised[0], revision = local.source_revision;
        decision.local_id = local.id; decision.expected_local_hash = hash(local);
        decision.source_external_id = revision.source_appointment_id;
        if (!patient || String(local.patient_id) !== String(patient.id)) decision.reasons.push('LOCAL_PATIENT_IDENTITY_CONFLICT');
        if (row.status !== revision.original.status || norm(row.details || '') !== norm(revision.original.details)
          || (row.source_external_id && String(row.source_external_id) !== revision.source_appointment_id)) decision.reasons.push('REVISED_SOURCE_CHANGED_REQUIRES_REVIEW');
        if (local.local_modified || local.revision_local_note_changed
          || ['start_local', 'end_local', 'status'].some(key => local[key] !== revision.current[key])) decision.reasons.push('LOCAL_EDIT_REQUIRES_REVIEW');
        const overlaps = patient ? localTime.get(patientTimeKey({ ...revision.current, patient_id: patient.id })) || [] : [];
        if (overlaps.some(other => String(other.id) !== String(local.id))) decision.reasons.push('REVISED_SOURCE_LOCAL_OVERLAP');
        if (!decision.reasons.length) { decision.action = 'preserve_verified_source_revision'; decision.requires_review = false; claimedLocal.add(String(local.id)); }
      }
      decisions.push(decision); continue;
    }
    const parallelMatches = row.kind === 'appointment' ? parallelReferences.get(sourceReference(row)) || [] : [];
    if (parallelMatches.length) {
      const ids = [...new Set(parallelMatches.map(item => item.local.id))];
      decision.candidate_local_ids = ids;
      if (parallelMatches.length !== 1) decision.reasons.push('PARALLEL_SOURCE_MULTIPLE_LOCAL_MATCHES');
      else {
        const { local, entry } = parallelMatches[0], baseline = entry.source;
        decision.local_id = local.id; decision.expected_local_hash = hash(local);
        decision.source_external_id = entry.source_appointment_id;
        if (!patient || String(local.patient_id) !== String(patient.id)) decision.reasons.push('LOCAL_PATIENT_IDENTITY_CONFLICT');
        if (row.status !== baseline.status || norm(row.details || '') !== norm(baseline.details || '')
          || (row.source_external_id && String(row.source_external_id) !== entry.source_appointment_id)) decision.reasons.push('PARALLEL_SOURCE_CHANGED_REQUIRES_REVIEW');
        if (local.local_modified === true || local.parallel_local_note_changed === true
          || ['start_local', 'end_local', 'status'].some(key => local[key] !== baseline[key])) decision.reasons.push('LOCAL_EDIT_REQUIRES_REVIEW');
        const overlaps = patient ? localTime.get(patientTimeKey({ ...row, patient_id: patient.id })) || [] : [];
        if (overlaps.some(other => String(other.id) !== String(local.id))) decision.reasons.push('PARALLEL_LOCAL_OVERLAP_REQUIRES_REVIEW');
        if (!decision.reasons.length) {
          decision.action = 'preserve_parallel_source_link'; decision.requires_review = false;
          claimedLocal.add(String(local.id));
        }
      }
      decisions.push(decision); continue;
    }
    let oldMatches = row.source_external_id ? historicalIds.get(row.source_external_id) || [] : historicalExact.get(appointmentKey(row)) || [];
    // Distinct statuses/clinical records at the same instant are not duplicate
    // rows. Do not recover an old ID for more than one non-identical input row.
    if (oldMatches.length > 1) decision.reasons.push('AMBIGUOUS_HISTORIC_IDENTITY');
    const old = oldMatches.length === 1 && !decision.reasons.includes('MULTIPLE_DISTINCT_SOURCE_ROWS_SAME_SLOT') ? oldMatches[0] : null;
    if (!decision.source_external_id && old) decision.source_external_id = sourceId(old);
    if (decision.source_external_id) recoveredHistoricalIds.add(decision.source_external_id);
    let targets = decision.source_external_id ? localSourceIds.get(decision.source_external_id) || [] : [];
    const atSameTime = patient ? localTime.get(patientTimeKey({ ...row, patient_id: patient.id })) || [] : [];
    if (!targets.length) targets = atSameTime.filter((r) => norm(r.agenda_key) === row.agenda_key && row.service_key && norm(r.service_key) === row.service_key);
    if (targets.length > 1) decision.reasons.push('MULTIPLE_LOCAL_MATCHES');
    const target = targets.length === 1 ? targets[0] : null;
    const competingNative = target && isImported(target) ? atSameTime.filter((r) => !isImported(r) && String(r.id) !== String(target.id)) : [];
    if (competingNative.length) decision.reasons.push('NATIVE_OVERLAP_WITH_MATCHED_SOURCE');
    if (target && claimedLocal.has(String(target.id))) decision.reasons.push('LOCAL_TARGET_ALREADY_CLAIMED');
    if (target && row.kind !== 'block' && patient && String(target.patient_id) !== String(patient.id)) decision.reasons.push('LOCAL_PATIENT_IDENTITY_CONFLICT');
    if (target) {
      decision.local_id = target.id;
      decision.expected_local_hash = hash(target);
      decision.preserve = { doctor_id: target.doctor_id ?? null, installation_id: target.installation_id ?? null, treatment_id: target.treatment_id ?? null, clinical_relations: true, economic_relations: true, local_optouts: true };
      // Even an exact source-ID link can have a later local reschedule. The
      // snapshot baseline distinguishes source progress from a local edit.
      const baseline = target.last_imported || old;
      const localChanged = target.local_modified === true || (baseline && Object.keys(comparable(row)).some((key) => baseline[key] !== undefined && target[key] !== baseline[key] && target[key] !== row[key]));
      if (localChanged) decision.reasons.push('LOCAL_EDIT_REQUIRES_REVIEW');
      if (!isImported(target)) {
        if (target.status !== row.status) decision.reasons.push('NATIVE_SOURCE_STATE_CONFLICT');
        decision.action = decision.reasons.length ? 'review' : 'link_native_preserve';
      } else decision.action = decision.reasons.length ? 'review' : 'update_imported_candidate';
      if (!decision.reasons.length) { claimedLocal.add(String(target.id)); decision.requires_review = decision.action !== 'link_native_preserve'; }
      decision.candidate_local_ids = [...targets, ...competingNative].map((r) => r.id);
    } else {
      // Matching one source row does not make its patient interval disappear.
      // Another agenda may describe the same visit with a longer or shifted
      // interval. Surface that ambiguity before SQL, without picking a winner
      // or treating an adjacent session as a duplicate.
      const claimedOverlaps = patient && row.kind === 'appointment'
        ? (localPatient.get(String(patient.id)) || []).filter(r => claimedLocal.has(String(r.id))
          && r.kind !== 'block' && r.status !== 'cancelada'
          && r.start_local < row.end_local && r.end_local > row.start_local) : [];
      const possibleMoves = patient ? (localPatient.get(String(patient.id)) || []).filter((r) => inCoverage(r, coverage) && !claimedLocal.has(String(r.id))) : [];
      decision.candidate_local_ids = [...new Set([...targets, ...atSameTime, ...possibleMoves, ...claimedOverlaps].map((r) => r.id))];
      if (claimedOverlaps.length) decision.reasons.push('CLAIMED_PATIENT_INTERVAL_OVERLAP');
      if (decision.candidate_local_ids.length) decision.reasons.push('POSSIBLE_RESCHEDULE_OR_NATIVE_DUPLICATE');
      if (row.kind !== 'block' && !patient) decision.reasons.push('PATIENT_LINK_NOT_RESOLVED');
      if (!decision.reasons.length) decision.action = row.kind === 'block' ? 'create_block_candidate' : 'create_appointment_candidate';
      else if (decision.reasons.every((r) => r === 'PATIENT_LINK_NOT_RESOLVED')) decision.action = 'create_appointment_candidate';
      decision.reasons.push(row.kind === 'block' ? 'BLOCK_SCOPE_REQUIRES_EXPLICIT_RESOURCE_MAP' : 'RESOURCE_AND_SERVICE_MAP_REQUIRED');
      if (old && !snapshot) decision.reasons.push('LOCAL_SNAPSHOT_NOT_PROVIDED');
    }
    decisions.push(decision);
  }
  const absenceActions = [];
  // A possible reschedule is not evidence that the old appointment disappeared.
  // Keep every unresolved local candidate until that source row is reconciled,
  // even when the CSV has no IDCITA and cannot recover its historical ID.
  const unresolvedLocalIds = new Set(decisions.filter(row => row.reasons.length)
    .flatMap(row => row.candidate_local_ids).map(String));
  const snapshotCovers = snapshot?.complete_for && snapshot.complete_for.start <= coverage.start && snapshot.complete_for.end >= coverage.end;
  for (const local of localAppointments) {
    if (claimedLocal.has(String(local.id))) continue;
    const inside = inCoverage(local, coverage);
    let action = 'preserve_local', reason = !isImported(local) ? 'NATIVE_APPOINTMENT_PRESERVED' : !inside ? 'OUTSIDE_SOURCE_COVERAGE' : 'SNAPSHOT_COVERAGE_NOT_CONFIRMED';
    const linkUnderReview = recoveredHistoricalIds.has(sourceId(local)) || unresolvedLocalIds.has(String(local.id));
    const localChanged = local.local_modified || (local.last_imported && Object.keys(comparable(local))
      .some(key => local.last_imported[key] !== undefined && local[key] !== local.last_imported[key]));
    if (isImported(local) && inside && snapshotCovers && !linkUnderReview) {
      action = 'supersede_candidate'; reason = localChanged ? 'LOCAL_EDIT_REQUIRES_REVIEW' : 'ABSENT_FROM_AUTHORITATIVE_INTERVAL';
    } else if (isImported(local) && inside && linkUnderReview) reason = 'SOURCE_LINK_UNDER_REVIEW';
    absenceActions.push({ entity: local.kind || 'appointment', local_id: local.id, action, reasons: [reason], requires_review: action === 'supersede_candidate', physical_delete: false, preserve_clinical_evidence: true, automation_policy: 'unchanged_until_explicit_apply', expected_local_hash: hash(local) });
  }
  const alertDecisions = alerts.map((row) => ({ entity: row.kind, action: row.validation_errors.length ? 'review' : row.kind === 'general_alert' ? 'preserve_general_alert_history' : row.status === 'pending' ? 'create_followup_candidate' : 'preserve_followup_history_candidate', source: row, provenance: row.provenance, source_external_id: row.source_external_id, reasons: row.validation_errors, requires_review: row.kind !== 'general_alert' || row.validation_errors.length > 0, automation_policy: 'hold', target_date: null, contact_due_at: row.contact_due_at, occupies_agenda: false }));
  const manifest = { adapter_version: ADAPTER_VERSION, source_system: 'cliniccloud', source_account: sourceAccount, timezone: TIMEZONE, coverage: { ...coverage, authority: 'source_snapshot_plus_protected_native' }, files: [...files].sort((a, b) => a.role.localeCompare(b.role)), snapshot_sha256: snapshot ? hash(snapshot) : null, snapshot_captured_at: snapshot?.captured_at || null, mode: 'dry_run_only', automation_policy: 'hold', whatsapp_column_policy: 'ignored_no_consent_mutation', physical_deletes: false };
  const actions = [...contactPlan.actions, ...decisions, ...absenceActions, ...alertDecisions];
  for (const action of actions) action.action_key = hash([action.entity, action.provenance?.row_key || null, action.local_id ?? null, action.action]);
  const summary = { input: { contacts: contacts.length, appointment_rows: appointments.length, alerts: alerts.length, historic_appointments: historicalAppointments.length, local_appointments: localAppointments.length }, actions: count(actions, 'action'), appointment_states: count(appointments, 'status'), appointment_kinds: count(appointments, 'kind'), review_actions: actions.filter((r) => r.requires_review).length, priority_day: { date: priorityDate, clinical_active: appointments.filter((r) => r.kind === 'appointment' && r.status !== 'cancelada' && r.start_local?.startsWith(priorityDate)).length, clinical_cancelled: appointments.filter((r) => r.kind === 'appointment' && r.status === 'cancelada' && r.start_local?.startsWith(priorityDate)).length, blocks_active: appointments.filter((r) => r.kind === 'block' && r.status !== 'cancelada' && r.start_local?.startsWith(priorityDate)).length }, automation_activation_allowed: false, application_implemented: false, local_snapshot_available: Boolean(snapshot), reasons: count(actions.flatMap((r) => r.reasons.map((reason) => ({ reason }))), 'reason') };
  return { manifest, plan_sha256: hash({ manifest, actions }), summary, actions };
}

module.exports = { buildPlan, choosePrimaryClinic, planContacts, appointmentKey };
