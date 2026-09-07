'use strict';

// Application boundary. All decisions are supplied by a hashed, reviewed plan;
// this module neither guesses identities nor imports app/Redis/queue runtimes.
const { hash, norm } = require('./adapter');
const { normalizeValues, sourceKey, dateOnly } = require('../patientFollowUps.contract');
const { createPatientFollowUpService } = require('../../services/patientFollowUps.service');
const ACCOUNT = 'cliniccloud-5880';
const CLINICS = [66, 72];
const KIND = 'cliniccloud_alert';
const CONTACT_SNAPSHOT_COLUMNS = ['contacto_1.csv', 'cliniccloud_contact_snapshot'];
const plain = row => row?.toJSON ? row.toJSON() : row;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const clone = value => JSON.parse(JSON.stringify(value));
const unique = values => [...new Set(values.map(String))].sort();
const same = (left, right) => hash(left) === hash(right);
const validId = value => /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value));
const logicalHash = (value, field) => hash(Object.fromEntries(Object.entries(value).filter(([key]) => key !== field)));
const timestamp = value => value == null ? null : (value instanceof Date ? value : new Date(String(value).replace(' ', 'T').replace(/Z?$/, 'Z'))).toISOString();

function identityRows(rows) {
  return rows.filter(row => row.source === 'cliniccloud' && (row.source_column === 'idContacto' || row.field_key === 'cliniccloud_source_contact_id' || CONTACT_SNAPSHOT_COLUMNS.includes(row.source_column)));
}
function identityOf(patient, fields) {
  const ids = [], histories = [];
  for (const row of identityRows(fields)) {
    if (Number(row.paciente_id) !== Number(patient.id_paciente)) continue;
    if (CONTACT_SNAPSHOT_COLUMNS.includes(row.source_column)) {
      let value;
      try { value = typeof row.value === 'string' ? JSON.parse(row.value) : row.value; } catch { fail('INVALID_LOCAL_IDENTITY_JSON'); }
      if (row.source_column === 'cliniccloud_contact_snapshot' && (value?.version !== 'cliniccloud_contact_snapshot/1' || value?.source_account !== ACCOUNT)) fail('UNSUPPORTED_LOCAL_IDENTITY_SNAPSHOT');
      // Only identifiers are read. Contact details, dates, provenance and import
      // metadata remain the new-patient executor's separate allowlisted payload.
      if (value?.contact?.idContacto) ids.push(String(value.contact.idContacto));
      if (value?.contact?.num != null) histories.push(String(value.contact.num));
    } else if (row.source_column === 'idContacto' || row.field_key === 'cliniccloud_source_contact_id') ids.push(String(row.value || '').trim());
  }
  return { source_contact_ids: unique(ids.filter(Boolean)), source_history_numbers: unique(histories.filter(Boolean)) };
}
function patientGuard(patient, memberships, fields) {
  const value = plain(patient);
  return { patient_id: Number(value.id_paciente), clinic_id: Number(value.clinica_id), updated_at: timestamp(value.updatedAt),
    identity: identityOf(value, fields.map(plain)),
    memberships: memberships.map(plain).map(row => ({ id: Number(row.id), paciente_id: Number(row.paciente_id), clinica_id: Number(row.clinica_id), es_principal: !!row.es_principal, updated_at: timestamp(row.updatedAt) })).sort((a, b) => a.id - b.id) };
}
function importedAlert(row) {
  if (!validId(row.local_patient_id) || !CLINICS.includes(Number(row.clinic_id)) || row.reasons?.length || row.automation_policy !== 'hold' || row.occupies_agenda !== false) fail('UNSAFE_FOLLOWUP_DECISION');
  if (!['pending', 'closed', 'cancelled'].includes(row.payload?.status)) fail('UNSUPPORTED_IMPORTED_FOLLOWUP_STATE');
  const date = dateOnly(row.source_contact_due_at?.slice(0, 10), 'source_date');
  if (!date || row.payload.contact_due_date !== date || row.payload.clinical_target_date != null || row.payload.source_date_semantics !== 'contact_due') fail('IMPORTED_ALERT_DATE_SEMANTICS_CHANGED');
  const provenance = row.provenance;
  if (!provenance || !/^[a-f0-9]{64}$/.test(provenance.file_sha256) || !/^[a-f0-9]{64}$/.test(provenance.row_sha256) || !validId(provenance.source_row)) fail('INVALID_ALERT_PROVENANCE');
  // A row locator is not advertised as an external ID. Reuse across a different
  // export needs an explicit reconciliation; idAviso remains account-wide.
  const reference = row.source_external_id ? `alert:${row.source_external_id}` : `row:${provenance.file_sha256}:${provenance.source_row}:${provenance.row_sha256}`;
  if (reference.length > 200 || (row.source_external_id && !validId(row.source_external_id))) fail('INVALID_ALERT_SOURCE_ID');
  return { payload: normalizeValues({ operational_reason: row.payload.operational_reason, clinical_notes: row.payload.clinical_notes, status: row.payload.status, contact_due_date: date, clinical_target_date: null }, { creating: true, imported: true }),
    importedSource: { kind: KIND, namespace: ACCOUNT, reference, date, date_semantics: 'contact_due' },
    source_key: sourceKey(KIND, ACCOUNT, reference), provenance: clone(provenance),
    source_contact_id: String(row.source_contact_id), history_number: String(row.history_number),
    row_identity_requires_reconciliation_on_new_export: !row.source_external_id };
}

function prepare({ plan, snapshot, live, now = new Date().toISOString() }) {
  if (plan?.plan_sha256 !== logicalHash(plan, 'plan_sha256')) fail('PLAN_HASH_MISMATCH');
  if (plan.manifest?.source_account !== ACCOUNT || snapshot?.source_account !== ACCOUNT || plan.manifest.snapshot_sha256 !== hash(snapshot)) fail('PLAN_SNAPSHOT_MISMATCH');
  if (plan.manifest.automation_policy !== 'hold' || !Array.isArray(plan.assignments) || !Array.isArray(plan.followups)) fail('INVALID_PRIMARY_PLAN');
  if (live.clinics.length !== 2 || live.clinics.some(row => !CLINICS.includes(Number(row.id_clinica)) || Number(row.grupoClinicaId) !== Number(snapshot.database_group_id))) fail('CLINIC_GROUP_SCOPE_CHANGED');
  const patients = new Map(live.patients.map(row => [Number(row.id_paciente), row]));
  const old = new Map(snapshot.patients.map(row => [Number(row.id), row]));
  const memberships = new Map(), fields = new Map(), bySource = new Map();
  for (const row of live.memberships) { const id = Number(row.paciente_id); if (!memberships.has(id)) memberships.set(id, []); memberships.get(id).push(row); }
  for (const row of identityRows(live.identities)) { const id = Number(row.paciente_id); if (!fields.has(id)) fields.set(id, []); fields.get(id).push(row); }
  for (const [id, rows] of fields) for (const source of identityOf({ id_paciente: id }, rows).source_contact_ids) { if (!bySource.has(source)) bySource.set(source, []); bySource.get(source).push(id); }
  const guards = new Map(), conflicts = [], primary = [], alerts = [], seenSources = new Set();
  const guardFor = id => {
    id = Number(id); if (guards.has(id)) return guards.get(id);
    const patient = patients.get(id), prior = old.get(id);
    if (!patient || !prior) return null;
    const guard = patientGuard(patient, memberships.get(id) || [], fields.get(id) || []);
    if (!same(guard.identity.source_contact_ids, unique(prior.source_contact_ids || [])) || !same(guard.identity.source_history_numbers, unique(prior.source_history_numbers || [])) || guard.identity.source_contact_ids.some(source => bySource.get(source)?.length !== 1)) return null;
    if (!CLINICS.includes(guard.clinic_id) || guard.memberships.some(row => !CLINICS.includes(row.clinica_id))) return null;
    guards.set(id, guard); return guard;
  };
  for (const decision of plan.assignments) {
    if (!['move_primary_candidate', 'preserve_primary'].includes(decision.action) || decision.reasons?.length) continue;
    const id = Number(decision.local_patient_id), guard = guardFor(id);
    const target = Number(decision.proposed_clinic_id);
    const expected = (decision.memberships?.existing || []).map(row => ({ id: Number(row.id), paciente_id: Number(row.paciente_id), clinica_id: Number(row.clinica_id), es_principal: !!row.es_principal })).sort((a, b) => a.id - b.id);
    if (!guard || guard.clinic_id !== Number(decision.current_clinic_id) || !same(expected, guard.memberships.map(({ updated_at, ...row }) => row))) { conflicts.push({ entity: 'primary', patient_id: id, code: 'LIVE_IDENTITY_OR_MEMBERSHIP_DRIFT' }); continue; }
    if (!CLINICS.includes(target) || decision.memberships?.remove?.length || !['oldest_paid_treatment', 'oldest_recorded_treatment'].includes(decision.rule) || !decision.evidence?.length) fail('UNSAFE_PRIMARY_DECISION');
    const ensure = [...new Set([guard.clinic_id, target, ...(decision.evidence_clinic_ids || []).map(Number)])].sort();
    if (ensure.some(clinic => !CLINICS.includes(clinic)) || !same(ensure, [...decision.memberships.ensure].sort())) fail('UNSAFE_MEMBERSHIP_EXPANSION');
    const add = ensure.filter(clinic => !guard.memberships.some(row => row.clinica_id === clinic));
    if (guard.clinic_id === target && !add.length && guard.memberships.every(row => row.es_principal === (row.clinica_id === target))) continue;
    primary.push({ entity: 'primary', patient_id: id, clinic_id: target, before: guard, ensure_clinic_ids: ensure, add_clinic_ids: add, rule: decision.rule, evidence: decision.evidence, evidence_sha256: hash(decision.evidence) });
  }
  const existingSources = new Map(live.followups.filter(row => row.source_key).map(row => [row.source_key, row]));
  for (const decision of plan.followups) {
    if (!['ready_existing_identity', 'ready_after_membership'].includes(decision.action)) continue;
    const id = Number(decision.local_patient_id), guard = guardFor(id), alert = importedAlert(decision);
    if (!guard || !guard.identity.source_contact_ids.includes(alert.source_contact_id) || !guard.identity.source_history_numbers.includes(alert.history_number)) { conflicts.push({ entity: 'followup', patient_id: id, source_key: alert.source_key, code: 'LIVE_ALERT_IDENTITY_DRIFT' }); continue; }
    const clinicId = Number(decision.clinic_id);
    if (guard.clinic_id !== clinicId && !guard.memberships.some(row => row.clinica_id === clinicId) && !primary.some(row => row.patient_id === id && row.ensure_clinic_ids.includes(clinicId))) { conflicts.push({ entity: 'followup', patient_id: id, source_key: alert.source_key, code: 'MISSING_APPROVED_MEMBERSHIP' }); continue; }
    if (seenSources.has(alert.source_key)) fail('DUPLICATE_SOURCE_IN_PREPARED_PLAN');
    seenSources.add(alert.source_key);
    const existing = existingSources.get(alert.source_key);
    if (existing && (Number(existing.patient_id) !== id || Number(existing.clinic_id) !== clinicId)) { conflicts.push({ entity: 'followup', patient_id: id, source_key: alert.source_key, code: 'EXISTING_SOURCE_CONTEXT_CONFLICT' }); continue; }
    if (!existing && live.followups.some(row => row.source_namespace === ACCOUNT && Number(row.patient_id) === id && (alert.row_identity_requires_reconciliation_on_new_export || String(row.source_reference || '').startsWith('row:')) && norm(row.clinical_notes) === norm(alert.payload.clinical_notes))) {
      conflicts.push({ entity: 'followup', patient_id: id, source_key: alert.source_key, code: 'POSSIBLE_EXISTING_ROW_IDENTITY_REPEAT' }); continue;
    }
    // Never replay an imported pending state over local work, especially closed,
    // cancelled or scheduled records. Existing source is preservation, not update.
    alerts.push({ entity: 'followup', patient_id: id, clinic_id: clinicId, before: guard, ...alert, action: existing ? 'preserve_existing' : 'create', existing_id: existing?.public_id || null, existing_version: existing?.version_number || null });
  }
  const operations = [...primary, ...alerts].map(operation => ({ ...operation, operation_key: hash({ plan: plan.plan_sha256, entity: operation.entity, identity: operation.source_key || operation.patient_id }) }));
  const prepared = { version: 'cliniccloud-primary-followups-apply/1', source_account: ACCOUNT, plan_sha256: plan.plan_sha256, snapshot_sha256: hash(snapshot), global_identity_sha256: hash(identityRows(live.identities)), group_id: Number(snapshot.database_group_id), captured_at: live.captured_at, prepared_at: now,
    automation_policy: 'hold', messages_enabled: false, scope_clinic_ids: CLINICS, source_files: clone(plan.manifest.files || []), operations, conflicts,
    summary: { primary_operations: primary.length, primary_moves: primary.filter(row => row.before.clinic_id !== row.clinic_id).length, memberships_add: primary.reduce((sum, row) => sum + row.add_clinic_ids.length, 0), followups_create: alerts.filter(row => row.action === 'create').length, followups_preserve: alerts.filter(row => row.action !== 'create').length, followups_status: alerts.reduce((sum, row) => ({ ...sum, [row.payload.status]: (sum[row.payload.status] || 0) + 1 }), {}), row_identity_only: alerts.filter(row => row.row_identity_requires_reconciliation_on_new_export).length, conflicts: conflicts.length } };
  prepared.prepared_sha256 = hash(prepared); return prepared;
}

function verifyPrepared(prepared, approvedHash) {
  if (prepared?.prepared_sha256 !== logicalHash(prepared, 'prepared_sha256') || prepared.prepared_sha256 !== approvedHash) fail('PREPARED_APPROVAL_HASH_MISMATCH');
  if (prepared.version !== 'cliniccloud-primary-followups-apply/1' || prepared.source_account !== ACCOUNT || !same(prepared.scope_clinic_ids, CLINICS) || prepared.automation_policy !== 'hold' || prepared.messages_enabled !== false) fail('INVALID_PREPARED_SCOPE');
  if (new Set(prepared.operations.map(row => row.operation_key)).size !== prepared.operations.length) fail('DUPLICATE_PREPARED_OPERATION');
}

function assertPrimaryAfter(operation, after) {
  const before = operation.before;
  if (after.patient_id !== before.patient_id || after.clinic_id !== operation.clinic_id || !same(before.identity, after.identity)
    || after.memberships.length !== before.memberships.length + operation.add_clinic_ids.length
    || new Set(after.memberships.map(row => row.clinica_id)).size !== after.memberships.length
    || after.memberships.filter(row => row.es_principal).length !== 1) fail('PRIMARY_AFTER_WRITE_VERIFICATION_FAILED');
  for (const row of after.memberships) {
    const previous = before.memberships.find(member => member.id === row.id);
    if (row.paciente_id !== before.patient_id || (!previous && !operation.ensure_clinic_ids.includes(row.clinica_id)) || row.es_principal !== (row.clinica_id === operation.clinic_id)
      || (previous && (previous.paciente_id !== row.paciente_id || previous.clinica_id !== row.clinica_id))
      || (!previous && !operation.add_clinic_ids.includes(row.clinica_id))) fail('PRIMARY_AFTER_WRITE_VERIFICATION_FAILED');
  }
  if (before.memberships.some(previous => !after.memberships.some(row => row.id === previous.id))) fail('PRIMARY_AFTER_WRITE_VERIFICATION_FAILED');
}

function createExecutor({ db, journal, now = () => new Date() }) {
  const service = createPatientFollowUpService({ db, now });
  async function lockedGuard(patientId, transaction) {
    const patient = await db.Paciente.findOne({ where: { id_paciente: patientId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!patient) fail('PATIENT_DISAPPEARED');
    const [memberships, identities] = await Promise.all([
      db.PacienteClinica.findAll({ where: { paciente_id: patientId }, order: [['id', 'ASC']], transaction, lock: transaction.LOCK.UPDATE }),
      db.PatientCustomField.findAll({ where: { paciente_id: patientId, source: 'cliniccloud' }, order: [['id', 'ASC']], transaction, lock: transaction.LOCK.UPDATE }),
    ]);
    return { patient, memberships, guard: patientGuard(patient, memberships, identities) };
  }
  async function apply({ prepared, approvedHash, actorId }) {
    verifyPrepared(prepared, approvedHash); if (actorId !== null && !validId(actorId)) fail('EXPLICIT_IMPORT_ACTOR_REQUIRED');
    const effectiveActor = actorId === null ? null : Number(actorId);
    const summary = { committed: 0, resumed: 0, preserved_followups: 0 };
    // Group by patient: membership/primary + follow-ups share one transaction,
    // so a membership failure cannot leave a hidden, orphaned follow-up.
    const groups = new Map();
    for (const row of prepared.operations) { if (!groups.has(row.patient_id)) groups.set(row.patient_id, []); groups.get(row.patient_id).push(row); }
    for (const [patientId, operations] of [...groups].sort(([a], [b]) => a - b)) {
      const previous = journal.latestPatient(patientId, prepared.prepared_sha256);
      // Primary changes have no dedicated transactional audit table. Do not
      // fabricate one in patient-visible custom fields: a crash between prepare
      // and durable commit record is a manual reconciliation boundary.
      if (previous?.event === 'prepared_patient') fail('AMBIGUOUS_PREVIOUS_PATIENT_TRANSACTION');
      const txResult = await db.sequelize.transaction(async transaction => {
        const clinics = await db.Clinica.findAll({ where: { id_clinica: { [db.Sequelize.Op.in]: CLINICS } }, attributes: ['id_clinica', 'grupoClinicaId'], order: [['id_clinica', 'ASC']], transaction, lock: transaction.LOCK.SHARE });
        if (clinics.length !== 2 || clinics.some(row => Number(row.grupoClinicaId) !== prepared.group_id)) fail('CLINIC_GROUP_SCOPE_CHANGED');
        if (effectiveActor !== null) {
          const actor = await db.Usuario.findOne({ where: { id_usuario: effectiveActor, estado_cuenta: 'activo' }, attributes: ['id_usuario'], transaction });
          if (!actor) fail('TECHNICAL_ACTOR_NOT_ACTIVE');
        }
        const locked = await lockedGuard(patientId, transaction), primary = operations.find(row => row.entity === 'primary');
        let resumedPrimary = false;
        if (primary) {
          if (previous?.event === 'committed_patient') {
            if (!same(previous.after, locked.guard)) fail('PRIMARY_POST_IMPORT_DRIFT');
            resumedPrimary = true;
          } else if (!same(primary.before, locked.guard)) fail('PATIENT_GUARD_CHANGED');
        } else if (!same(operations[0].before, locked.guard)) fail('PATIENT_GUARD_CHANGED');
        await journal.append({ event: 'prepared_patient', patient_id: patientId, prepared_sha256: prepared.prepared_sha256, source_account: ACCOUNT, actor_id: effectiveActor, actor_kind: effectiveActor === null ? 'system_import' : 'existing_actor', operations: operations.map(row => row.operation_key), before: locked.guard, at: now().toISOString() });
        if (primary && !resumedPrimary) {
          for (const clinicId of primary.ensure_clinic_ids) {
            const membership = locked.memberships.find(row => Number(row.clinica_id) === clinicId);
            if (!membership) await db.PacienteClinica.create({ paciente_id: patientId, clinica_id: clinicId, es_principal: clinicId === primary.clinic_id }, { transaction });
          }
          for (const membership of locked.memberships) if (!!membership.es_principal !== (Number(membership.clinica_id) === primary.clinic_id)) await membership.update({ es_principal: Number(membership.clinica_id) === primary.clinic_id }, { transaction });
          if (Number(locked.patient.clinica_id) !== primary.clinic_id) await locked.patient.update({ clinica_id: primary.clinic_id }, { transaction });
          assertPrimaryAfter(primary, (await lockedGuard(patientId, transaction)).guard);
        }
        const outcomes = [];
        for (const operation of operations.filter(row => row.entity === 'followup')) {
          const existing = await db.PatientFollowUp.findOne({ where: { source_key: operation.source_key }, transaction, lock: transaction.LOCK.UPDATE });
          if (existing) {
            if (Number(existing.patient_id) !== patientId || Number(existing.clinic_id) !== operation.clinic_id) fail('FOLLOWUP_SOURCE_CONTEXT_CHANGED');
            outcomes.push({ operation_key: operation.operation_key, action: 'preserved_existing', id: existing.public_id, version: existing.version_number }); continue;
          }
          if (operation.action === 'preserve_existing') fail('EXISTING_FOLLOWUP_DISAPPEARED');
          const result = await service.create({ clinicId: operation.clinic_id, patientIdentifier: String(patientId), actorId: effectiveActor, payload: operation.payload, importedSource: operation.importedSource, includeClinical: true, transaction });
          outcomes.push({ operation_key: operation.operation_key, action: result.created ? 'created' : 'preserved_existing', id: result.item.id, version: result.item.version });
        }
        return { patient_id: patientId, primary: primary ? resumedPrimary ? 'resumed' : 'applied' : null, outcomes, after: (await lockedGuard(patientId, transaction)).guard };
      });
      // A failed append after commit MUST stop. Re-run checks the transactional
      // source_key; primary ambiguity stops for manual review, never replay.
      await journal.append({ event: 'committed_patient', prepared_sha256: prepared.prepared_sha256, ...txResult, at: now().toISOString() });
      summary.committed++; if (txResult.primary === 'resumed') summary.resumed++;
      summary.preserved_followups += txResult.outcomes.filter(row => row.action === 'preserved_existing').length;
    }
    return summary;
  }
  return { apply };
}
module.exports = { ACCOUNT, CLINICS, KIND, logicalHash, identityOf, identityRows, patientGuard, importedAlert, prepare, verifyPrepared, assertPrimaryAfter, createExecutor };
