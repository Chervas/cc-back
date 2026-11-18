'use strict';

// Operator-only reconciliation. No application bootstrap, provider, queue or
// notification runtime is loaded. Decisions and source files remain private.
const { Op } = require('sequelize');
const { hash, norm } = require('./adapter');
const { ACCOUNT, CLINICS, KIND } = require('./primary-followups-apply');
const { dateOnly, monthOnly, sourceKey, normalizeValues, ACTIVE_STATUSES } = require('../patientFollowUps.contract');
const { createPatientFollowUpService } = require('../../services/patientFollowUps.service');
const clinicOverride = require('./followup-clinic-override');
const dateReconciliation = require('./followup-date-reconciliation');
const VERSION = 'cliniccloud-followup-reconciliation/v1';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const plain = row => row?.get ? row.get({ plain: true }) : row;
const positive = x => Number.isSafeInteger(Number(x)) && Number(x) > 0;
const hex = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const months = { ENERO: 1, FEBRERO: 2, MARZO: 3, ABRIL: 4, MAYO: 5, JUNIO: 6,
  JULIO: 7, AGOSTO: 8, SEPTIEMBRE: 9, SETIEMBRE: 9, OCTUBRE: 10, NOVIEMBRE: 11, DICIEMBRE: 12 };
const monthNames = Object.keys(months).join('|');
const targetReviewReason = inference => !inference.month && ['TARGET_MONTH_BEFORE_CONTACT','TARGET_YEAR_AMBIGUOUS','MULTIPLE_TARGET_MONTHS'].includes(inference.reason) ? inference.reason : null;

function validateDatabaseIdentity(identity) {
  if (!identity || Object.keys(identity).sort().join(',') !== 'database,host,port,server_hostname,server_uuid'
    || !/^[a-zA-Z0-9_.-]+$/.test(identity.host || '') || !Number.isInteger(identity.port) || identity.port < 1 || identity.port > 65535
    || !/^[a-zA-Z0-9_$-]+$/.test(identity.database || '') || !/^[a-zA-Z0-9_.-]+$/.test(identity.server_hostname || '')
    || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(identity.server_uuid || '')) fail('FOLLOWUP_DATABASE_IDENTITY_REQUIRED');
}

function inferTargetMonth({ text, contactDueDate }) {
  const contact = dateOnly(contactDueDate, 'contact_due_date');
  if (!contact) return { month: null, reason: 'CONTACT_DATE_REQUIRED' };
  const body = norm(text), matches = [...body.matchAll(new RegExp(`\\b(${monthNames})\\b`, 'g'))];
  const values = [...new Set(matches.map(m => months[m[1]]))];
  if (values.length !== 1) return { month: null, reason: values.length ? 'MULTIPLE_TARGET_MONTHS' : 'TARGET_MONTH_MISSING' };
  const explicit = [...body.matchAll(new RegExp(`\\b(?:${monthNames})(?:\\s*[-/]\\s*|\\s+(?:DE(?:L)?\\s+)?)([12]\\d{3})\\b`, 'g'))].map(m => Number(m[1]));
  const allYears = [...body.matchAll(/\b([12]\d{3})\b/g)].map(m => Number(m[1]));
  const years = [...new Set(explicit)];
  if (years.length > 1 || allYears.some(y => !years.includes(y))) return { month: null, reason: 'TARGET_YEAR_AMBIGUOUS' };
  const contactYear = Number(contact.slice(0, 4)), contactMonth = Number(contact.slice(5, 7));
  const targetYear = years[0] || contactYear + (values[0] < contactMonth ? 1 : 0);
  const month = monthOnly(`${targetYear}-${String(values[0]).padStart(2, '0')}`);
  if (month < contact.slice(0, 7)) return { month: null, reason: 'TARGET_MONTH_BEFORE_CONTACT' };
  return { month, reason: years.length ? 'EXPLICIT_TARGET_MONTH_YEAR' : 'NEXT_NAMED_MONTH_FROM_SOURCE_CONTACT',
    year_explicit: !!years.length, offset_months: (targetYear - contactYear) * 12 + values[0] - contactMonth };
}

function intervalTreatmentMonth(record) {
  const intervals = [...new Set([...norm(record.clinical_notes).matchAll(/\b(\d{1,2})\s*(?:MESES?|M)\b/g)].map(m => Number(m[1])))];
  const target = inferTargetMonth({ text: record.clinical_notes, contactDueDate: record.contact_due_date });
  if (intervals.length !== 1 || ![6,12].includes(intervals[0]) || !target.month) return null;
  const [year, month] = target.month.split('-').map(Number);
  return { month: new Date(Date.UTC(year, month - 1 - intervals[0], 1)).toISOString().slice(0,7), interval_months: intervals[0] };
}

function clinicalArea(text) {
  const body = norm(text);
  const hair = /\b(CAPILAR|DUTASTERIDE|ALOPECIA|TRICOSCOPIA|FOTORREGENERADOR)\b/.test(body);
  const medical = /\b(FACIAL|CORPORAL|BOTOX|NUTRICION|GASTRICO|GASTRICA|BYPASS|MASTOPEXIA|BLEFAROPLASTIA)\b/.test(body);
  return { clinic_id: hair !== medical ? hair ? 66 : 72 : null, ambiguous: hair && medical };
}

function normalizedRecord(input) {
  const p = input.provenance || {}, payload = input.payload || {};
  if (!positive(input.local_patient_id) || !positive(input.source_contact_id) || !positive(input.history_number)
    || !hex(p.file_sha256) || !hex(p.row_sha256) || !positive(p.source_row)
    || !['pending', 'closed', 'cancelled'].includes(payload.status)
    || typeof payload.clinical_notes !== 'string' || !payload.clinical_notes.trim()) fail('FOLLOWUP_SOURCE_RECORD_INVALID');
  const due = dateOnly(String(input.source_contact_due_at || '').slice(0, 10), 'source_contact_due_at');
  if (!due || payload.contact_due_date && payload.contact_due_date !== due) fail('FOLLOWUP_SOURCE_CONTACT_DATE_MISMATCH');
  if (input.source_external_id != null && !positive(input.source_external_id)) fail('FOLLOWUP_SOURCE_ID_INVALID');
  const reference = input.source_external_id ? `alert:${input.source_external_id}` : `row:${p.file_sha256}:${p.source_row}:${p.row_sha256}`;
  const result = { patient_id: Number(input.local_patient_id), source_contact_id: String(input.source_contact_id), history_number: String(input.history_number),
    source_key: sourceKey(KIND, ACCOUNT, reference), source_reference: reference, contact_due_date: due,
    source_status: payload.status, clinical_notes: payload.clinical_notes, operational_reason: payload.operational_reason || 'Seguimiento importado de ClinicCloud',
    validation_errors: (input.reasons || []).filter(reason => reason !== 'FOLLOWUP_CLINIC_NOT_UNAMBIGUOUS'
      && !(input.contact_date_reconciliation && reason === 'POSSIBLE_CHANGED_ALERT_DATE')), provenance: p,
    ...(input.contact_date_reconciliation ? { contact_date_reconciliation: input.contact_date_reconciliation } : {}) };
  if (result.contact_date_reconciliation) dateReconciliation.assertRecord(result.contact_date_reconciliation, result);
  return result;
}

const SNAPSHOT_FIELDS = ['id', 'public_id', 'clinic_id', 'patient_id', 'treatment_id', 'operational_reason', 'clinical_notes',
  'clinical_target_date', 'clinical_target_month', 'contact_due_date', 'reminder_advance_days', 'recipient_mode', 'recipient_role_ids',
  'notice_cycle', 'notice_enabled', 'status', 'linked_appointment_id', 'source_appointment_id', 'source_report_id',
  'source_kind', 'source_namespace', 'source_reference', 'source_key', 'source_date', 'source_date_semantics',
  'version_number', 'created_by', 'updated_by', 'created_at', 'updated_at'];
const NUMERIC_FIELDS = new Set(['id','clinic_id','patient_id','treatment_id','reminder_advance_days','notice_cycle',
  'linked_appointment_id','source_appointment_id','source_report_id','version_number','created_by','updated_by']);
function sqlInstant(value) {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(/(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : String(value).replace(' ', 'T') + 'Z');
  if (!Number.isFinite(+d)) fail('FOLLOWUP_TIMESTAMP_INVALID');
  return d.toISOString();
}
function rowSnapshot(input) {
  const row = plain(input) || {};
  return Object.fromEntries(SNAPSHOT_FIELDS.map(key => [key, key.endsWith('_at') ? sqlInstant(row[key])
    : key === 'notice_enabled' ? !!row[key] : key === 'recipient_role_ids' ? (typeof row[key] === 'string' ? JSON.parse(row[key]) : row[key]) || null
      : NUMERIC_FIELDS.has(key) && row[key] != null ? Number(row[key]) : row[key] ?? null]));
}
function patientGuard(live, patientId) {
  const p = live.patients.find(p => Number(p.id_paciente) === Number(patientId));
  if (!p) fail('FOLLOWUP_PATIENT_MISSING');
  return { patient_id: Number(p.id_paciente), primary_clinic_id: Number(p.clinica_id),
    memberships: live.memberships.filter(m => Number(m.paciente_id) === Number(patientId)).map(m => Number(m.clinica_id)).sort((a, b) => a - b),
    identities: live.identities.filter(i => Number(i.paciente_id) === Number(patientId))
      .map(i => [String(i.source_contact_id || ''), String(i.history_number || ''), i.source_column || null,
        i.source_snapshot_valid == null ? null : !!Number(i.source_snapshot_valid)]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) };
}
function validateIdentity(record, live) {
  if (live.identities.some(i => Number(i.paciente_id) === record.patient_id
    && (i.source_column === 'cliniccloud_contact_snapshot' && Number(i.source_snapshot_valid) !== 1
      || i.source_snapshot_valid != null && !Number(i.source_snapshot_valid)))) fail('FOLLOWUP_SOURCE_IDENTITY_CHANGED');
  const matching = [...new Set(live.identities.filter(i => String(i.source_contact_id) === record.source_contact_id).map(i => Number(i.paciente_id)))];
  if (matching.length !== 1 || matching[0] !== record.patient_id
    || !live.identities.some(i => Number(i.paciente_id) === record.patient_id && String(i.history_number) === record.history_number)) fail('FOLLOWUP_SOURCE_IDENTITY_CHANGED');
  return patientGuard(live, record.patient_id);
}

function approvedClinic(record, decision, guard, sourceFiles) {
  if (!decision || decision.action === 'review') return null;
  const clinic = Number(decision.clinic_id), rule = decision.rule;
  if (!CLINICS.includes(clinic) || !(guard.primary_clinic_id === clinic || guard.memberships.includes(clinic))) fail('FOLLOWUP_CLINIC_MEMBERSHIP_REQUIRED');
  const area = clinicalArea(record.clinical_notes);
  if (rule === 'explicit_followup_clinical_area') {
    if (!area.clinic_id || clinic !== area.clinic_id) fail('FOLLOWUP_CLINICAL_AREA_NOT_SUPPORTED');
  } else if (rule === 'exclusive_capilar_membership_authorized_20261118') {
    if (clinic !== 66 || new Set([guard.primary_clinic_id, ...guard.memberships]).size !== 1 || guard.primary_clinic_id !== 66) fail('FOLLOWUP_EXCLUSIVE_CLINIC_NOT_SUPPORTED');
  } else if (rule === clinicOverride.RULE) {
    if (clinic !== 66) fail('FOLLOWUP_OVERRIDE_TARGET_INVALID');
    clinicOverride.validateDecisionAuthorization(decision.administrative_authorization, sourceFiles);
  } else if (rule === clinicOverride.MEDICAL_RULE) {
    if (clinic !== 72 || new Set([guard.primary_clinic_id, ...guard.memberships]).size !== 1 || guard.primary_clinic_id !== 72) fail('FOLLOWUP_EXCLUSIVE_CLINIC_NOT_SUPPORTED');
    clinicOverride.validateScopeDecisionAuthorization(decision.administrative_authorization, sourceFiles);
  } else if (['single_evidenced_clinic_in_patient_history', 'documented_paid_treatment_scope', 'single_prior_documented_clinic', 'interval_matched_documented_treatment'].includes(rule)) {
    const evidence = decision.evidence || [];
    const interval = rule === 'interval_matched_documented_treatment' ? intervalTreatmentMonth(record) : null;
    if (rule === 'interval_matched_documented_treatment' && !interval) fail('FOLLOWUP_INTERVAL_NOT_SUPPORTED');
    if (!evidence.length || evidence.some(e => Number(e.clinic_id) !== clinic || String(e.source_contact_id) !== record.source_contact_id
      || !dateOnly(e.treatment_date, 'treatment_date') || e.treatment_date > record.contact_due_date
      || !sourceFiles.some(f => f.sha256 === e.provenance?.file_sha256) || !hex(e.provenance?.row_sha256)
      || !positive(e.provenance?.source_row) || e.payment_reversed === true
      || interval && e.treatment_date.slice(0,7) !== interval.month
      || rule === 'documented_paid_treatment_scope' && e.paid_evidence !== true)) fail('FOLLOWUP_CLINIC_EVIDENCE_INVALID');
  } else fail('FOLLOWUP_CLINIC_RULE_REQUIRED');
  return { clinic_id: clinic, rule, evidence: decision.evidence || [],
    ...([clinicOverride.RULE, clinicOverride.MEDICAL_RULE].includes(rule) ? { administrative_authorization: decision.administrative_authorization } : {}) };
}

function prepare({ records, decisions = [], live, sourceFiles, now = new Date().toISOString(), target = 'crm', authorizedClinicIds = [66] }) {
  if (!['crm', 'dev'].includes(target) || !Array.isArray(records) || records.length > 2000
    || !Array.isArray(sourceFiles) || !sourceFiles.length || sourceFiles.some(f => !hex(f.sha256))
    || !Array.isArray(authorizedClinicIds) || !authorizedClinicIds.length || authorizedClinicIds.some(id => !CLINICS.includes(id))) fail('FOLLOWUP_RECONCILIATION_INPUT_INVALID');
  validateDatabaseIdentity(live.database_identity);
  const operations = [], reviews = [], preserved = [], seen = new Set();
  const byDecision = new Map(decisions.map(d => [d.source_key, d]));
  for (const raw of records) {
    const record = normalizedRecord(raw);
    if (!sourceFiles.some(file => file.sha256 === record.provenance.file_sha256)) fail('FOLLOWUP_RECORD_FILE_NOT_IN_MANIFEST');
    if (record.contact_date_reconciliation) dateReconciliation.assertRecord(record.contact_date_reconciliation,record,sourceFiles);
    if (seen.has(record.source_key)) fail('FOLLOWUP_DUPLICATE_SOURCE_KEY');
    seen.add(record.source_key);
    let guard;
    try { guard = validateIdentity(record, live); }
    catch (error) {
      if (!['FOLLOWUP_SOURCE_IDENTITY_CHANGED','FOLLOWUP_PATIENT_MISSING'].includes(error.code)) throw error;
      reviews.push({ source_key: record.source_key, patient_id: record.patient_id, reason: error.code }); continue;
    }
    const existing = live.followups.filter(f => f.source_key === record.source_key);
    if (record.contact_date_reconciliation && live.followups.some(f => record.contact_date_reconciliation.alias_source_keys.includes(f.source_key))) {
      reviews.push({source_key:record.source_key,patient_id:record.patient_id,reason:'FOLLOWUP_ALIAS_SOURCE_ALREADY_EXISTS'}); continue;
    }
    if (existing.length > 1) fail('FOLLOWUP_DUPLICATE_PERSISTED_SOURCE');
    const row = existing[0], inference = inferTargetMonth({ text: record.clinical_notes, contactDueDate: record.contact_due_date });
    const decision = byDecision.get(record.source_key);
    if (row) {
      if (Number(row.patient_id) !== record.patient_id || !CLINICS.includes(Number(row.clinic_id)) || row.source_kind !== KIND || row.source_namespace !== ACCOUNT) fail('FOLLOWUP_EXISTING_SOURCE_CONTEXT_CONFLICT');
      if (!ACTIVE_STATUSES.includes(row.status) || record.source_status !== 'pending') { preserved.push({ source_key: record.source_key, reason: 'HISTORY_STATE_PRESERVED' }); continue; }
      if (!authorizedClinicIds.includes(Number(row.clinic_id))) { reviews.push({ source_key: record.source_key, patient_id: record.patient_id, reason: 'CLINIC_OUTSIDE_AUTHORIZED_BATCH' }); continue; }
      if (norm(row.clinical_notes) !== norm(record.clinical_notes) || row.contact_due_date !== record.contact_due_date
        || row.source_date !== record.contact_due_date || row.source_date_semantics !== 'contact_due'
        || row.clinical_target_date || row.clinical_target_month || row.linked_appointment_id || row.notice_enabled) {
        if (!row.clinical_target_date && row.clinical_target_month === inference.month) preserved.push({ source_key: record.source_key, reason: 'TARGET_ALREADY_PRESENT' });
        else reviews.push({ source_key: record.source_key, patient_id: record.patient_id, reason: 'LIVE_FOLLOWUP_EDIT_REQUIRES_REVIEW' });
        continue;
      }
      if (!inference.month) {
        const item = { source_key: record.source_key, patient_id: record.patient_id, reason: inference.reason };
        (inference.reason === 'TARGET_MONTH_MISSING' ? preserved : reviews).push(item); continue;
      }
      operations.push({ action: 'backfill_month', patient_id: record.patient_id, clinic_id: Number(row.clinic_id), record, inference,
        before: rowSnapshot(row), guard, decision: { rule: 'PRESERVE_IMPORTED_CLINIC' } });
    } else {
      if (record.validation_errors.length) { reviews.push({ source_key: record.source_key, patient_id: record.patient_id, reason: record.validation_errors.join(',') }); continue; }
      const clinic = approvedClinic(record, decision, guard, sourceFiles);
      if (!clinic) { reviews.push({ source_key: record.source_key, patient_id: record.patient_id, reason: decision?.reason || 'FOLLOWUP_CLINIC_NOT_UNAMBIGUOUS' }); continue; }
      if (!authorizedClinicIds.includes(clinic.clinic_id)) { reviews.push({ source_key: record.source_key, patient_id: record.patient_id, reason: 'CLINIC_OUTSIDE_AUTHORIZED_BATCH', decision: clinic,
        ...(record.source_status === 'pending' && !inference.month ? { target_month_review_reason: inference.reason } : {}) }); continue; }
      if (live.followups.some(f => Number(f.patient_id) === record.patient_id && f.source_kind === KIND && f.source_namespace === ACCOUNT
        && norm(f.clinical_notes) === norm(record.clinical_notes))) {
        reviews.push({ source_key: record.source_key, patient_id: record.patient_id, reason: 'POSSIBLE_EXISTING_BODY_REQUIRES_REVIEW' }); continue;
      }
      operations.push({ action: 'create', patient_id: record.patient_id, clinic_id: clinic.clinic_id, record,
        inference: record.source_status === 'pending' ? inference : { month: null, reason: 'HISTORY_STATE_PRESERVED' }, before: null, guard, decision: clinic });
    }
  }
  for (const op of operations) {
    op.clinical_target_review_reason = targetReviewReason(op.inference);
    op.operation_key = hash({ action: op.action, source_key: op.record.source_key, before: op.before, month: op.inference.month,
      clinical_target_review_reason: op.clinical_target_review_reason, clinic_id: op.clinic_id });
  }
  const result = { version: VERSION, target, database_identity: live.database_identity, authorized_clinic_ids: [...new Set(authorizedClinicIds)].sort(), source_account: ACCOUNT, automation_policy: 'hold', captured_at: now, source_files: sourceFiles,
    operations, reviews, preserved, summary: { records: records.length, backfill_month: operations.filter(o => o.action === 'backfill_month').length,
      create: operations.filter(o => o.action === 'create').length, review: reviews.length, preserved: preserved.length,
      preserved_history: preserved.filter(p => p.reason === 'HISTORY_STATE_PRESERVED').length,
      preserved_without_target_month: preserved.filter(p => p.reason === 'TARGET_MONTH_MISSING').length },
    identity_index: live.identities, patient_guards: [...new Map(operations.map(o => [o.patient_id, o.guard])).values()] };
  result.prepared_sha256 = hash(result);
  return result;
}
function verifyPrepared(prepared, approvedHash) {
  const { prepared_sha256, ...value } = prepared || {};
  if (!hex(approvedHash) || approvedHash !== prepared_sha256 || hash(value) !== prepared_sha256
    || prepared.version !== VERSION || prepared.source_account !== ACCOUNT || prepared.automation_policy !== 'hold') fail('FOLLOWUP_RECONCILIATION_PLAN_CHANGED');
  validateDatabaseIdentity(prepared.database_identity);
  if (!['crm','dev'].includes(prepared.target) || !Array.isArray(prepared.operations) || prepared.operations.length > 2000
    || !Array.isArray(prepared.authorized_clinic_ids) || !prepared.authorized_clinic_ids.length
    || prepared.authorized_clinic_ids.some(id => !CLINICS.includes(id))) fail('FOLLOWUP_RECONCILIATION_PLAN_INVALID');
  const keys = new Set();
  for (const op of prepared.operations) {
    if (!['create','backfill_month'].includes(op.action) || !positive(op.patient_id) || !prepared.authorized_clinic_ids.includes(op.clinic_id)
      || op.record.patient_id !== op.patient_id || !hex(op.record.source_key) || keys.has(op.record.source_key)
      || !['pending','closed','cancelled'].includes(op.record.source_status) || op.record.validation_errors.length
      || op.record.source_key !== sourceKey(KIND,ACCOUNT,op.record.source_reference)
      || !prepared.source_files.some(file => file.sha256 === op.record.provenance.file_sha256)
      || op.clinical_target_review_reason !== targetReviewReason(op.inference)
      || op.operation_key !== hash({ action: op.action, source_key: op.record.source_key, before: op.before, month: op.inference.month,
        clinical_target_review_reason: op.clinical_target_review_reason, clinic_id: op.clinic_id })) fail('FOLLOWUP_RECONCILIATION_OPERATION_INVALID');
    keys.add(op.record.source_key);
    dateOnly(op.record.contact_due_date,'contact_due_date');
    if (op.record.contact_date_reconciliation) dateReconciliation.assertRecord(op.record.contact_date_reconciliation,op.record,prepared.source_files);
    monthOnly(op.inference.month);
    if (op.action === 'backfill_month' && (!op.inference.month || !op.before || !ACTIVE_STATUSES.includes(op.before.status)
      || op.before.clinical_target_date || op.before.clinical_target_month || op.before.notice_enabled
      || op.before.source_key !== op.record.source_key || op.before.source_kind !== KIND || op.before.source_namespace !== ACCOUNT)) fail('FOLLOWUP_RECONCILIATION_BACKFILL_INVALID');
    if (op.action === 'create') approvedClinic(op.record, { ...op.decision, action: 'apply' }, op.guard, prepared.source_files);
  }
}

function createExecutor({ db, journal, now = () => new Date(), captureIdentity, verifyOperation, getDatabaseIdentity }) {
  const service = createPatientFollowUpService({ db, now, noticeService: { supported: false, decorate: async (_rows, items) => items } });
  async function apply({ prepared, approvedHash, actorId = null }) {
    verifyPrepared(prepared, approvedHash);
    if (actorId !== null && !positive(actorId)) fail('FOLLOWUP_IMPORT_ACTOR_INVALID');
    if (!captureIdentity) fail('FOLLOWUP_IDENTITY_READER_REQUIRED');
    if (typeof verifyOperation !== 'function') fail('FOLLOWUP_SOURCE_VERIFIER_REQUIRED');
    if (typeof getDatabaseIdentity !== 'function') fail('FOLLOWUP_DATABASE_IDENTITY_READER_REQUIRED');
    const assertDatabase = async transaction => {
      const identity = await getDatabaseIdentity({ transaction });
      validateDatabaseIdentity(identity);
      if (hash(identity) !== hash(prepared.database_identity)) fail('FOLLOWUP_DATABASE_IDENTITY_CHANGED');
    };
    await assertDatabase(null);
    const patientIds = [...new Set(prepared.operations.map(o => o.patient_id))].sort((a, b) => a - b);
    const results = [];
    for (const patientId of patientIds) {
      const ops = prepared.operations.filter(o => o.patient_id === patientId).sort((a, b) => a.record.source_key.localeCompare(b.record.source_key));
      const result = await db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
        await assertDatabase(transaction);
        const p = await db.Paciente.findByPk(patientId, { transaction, lock: transaction.LOCK.UPDATE });
        if (!p) fail('FOLLOWUP_PATIENT_MISSING');
        const live = await captureIdentity({ patientId, sourceIds: ops.map(o => o.record.source_contact_id), transaction });
        const guard = patientGuard(live, patientId);
        if (hash(guard) !== hash(ops[0].guard)) fail('FOLLOWUP_PATIENT_GUARD_CHANGED');
        for (const op of ops) { validateIdentity(op.record, live); await verifyOperation(op, live); }
        const outcomes = [];
        for (const op of ops) {
          let row = await db.PatientFollowUp.findOne({ where: { source_key: op.record.source_key }, transaction, lock: transaction.LOCK.UPDATE });
          const metadata = { version: VERSION, prepared_sha256: approvedHash, operation_key: op.operation_key,
            source_key: op.record.source_key, source_files_sha256: hash(prepared.source_files), before_sha256: op.before ? hash(op.before) : null,
            decision: op.decision, inference: op.inference, clinical_target_review_reason: op.clinical_target_review_reason,
            ...(op.record.contact_date_reconciliation ? { source_entry: op.record.contact_date_reconciliation } : {}), automation_policy: 'hold' };
          if (op.record.contact_date_reconciliation && await db.PatientFollowUp.findOne({ where: {
            source_key: { [Op.in]: op.record.contact_date_reconciliation.alias_source_keys } }, transaction, lock: transaction.LOCK.UPDATE })) fail('FOLLOWUP_ALIAS_SOURCE_ALREADY_EXISTS');
          if (row) {
            const receipt = await db.PatientFollowUpRevision.findOne({ where: { follow_up_id: row.id, version_number: row.version_number }, transaction });
            const audit = plain(receipt)?.snapshot?.import_reconciliation;
            if (audit?.prepared_sha256 === approvedHash && audit.operation_key === op.operation_key) {
              if (Number(row.patient_id) !== patientId || Number(row.clinic_id) !== op.clinic_id
                || (row.clinical_target_month || null) !== op.inference.month
                || hash(rowSnapshot(row)) !== hash(rowSnapshot(plain(receipt).snapshot))) fail('FOLLOWUP_REPLAY_STATE_CHANGED');
              outcomes.push({ operation_key: op.operation_key, action: 'preserved_existing', id: row.public_id }); continue;
            }
          }
          if (op.action === 'backfill_month') {
            if (!row || hash(rowSnapshot(row)) !== hash(op.before)) fail('FOLLOWUP_PREIMAGE_CHANGED');
            await row.update({ clinical_target_month: monthOnly(op.inference.month), version_number: Number(row.version_number) + 1, updated_by: actorId }, { transaction });
            await row.reload({ transaction });
            await db.PatientFollowUpRevision.create({ follow_up_id: row.id, version_number: row.version_number, actor_id: actorId,
              change_type: 'import_reconciled', snapshot: { ...plain(row), import_reconciliation: metadata }, created_at: now() }, { transaction });
          } else {
            if (row) fail('FOLLOWUP_SOURCE_CREATED_SINCE_PREPARE');
            const all = await db.PatientFollowUp.findAll({ where: { patient_id: patientId, clinic_id: { [Op.in]: CLINICS }, source_kind: KIND, source_namespace: ACCOUNT }, transaction });
            if (all.some(f => norm(f.clinical_notes) === norm(op.record.clinical_notes))) fail('FOLLOWUP_BODY_CREATED_SINCE_PREPARE');
            approvedClinic(op.record, { ...op.decision, action: 'apply' }, guard, prepared.source_files);
            const payload = normalizeValues({ operational_reason: op.record.operational_reason, clinical_notes: op.record.clinical_notes,
              status: op.record.source_status, contact_due_date: op.record.contact_due_date,
              clinical_target_date: null, clinical_target_month: op.inference.month }, { creating: true, imported: true });
            const created = await service.create({ clinicId: op.clinic_id, patientIdentifier: String(patientId), actorId, payload,
              includeClinical: true, transaction, importRevisionMetadata: metadata,
              importedSource: { kind: KIND, namespace: ACCOUNT, reference: op.record.source_reference, date: op.record.contact_due_date, date_semantics: 'contact_due' } });
            row = await db.PatientFollowUp.findOne({ where: { public_id: created.item.id }, transaction });
          }
          outcomes.push({ operation_key: op.operation_key, action: op.action, id: row.public_id });
        }
        const afterIdentity = await captureIdentity({ patientId, sourceIds: ops.map(o => o.record.source_contact_id), transaction });
        if (hash(patientGuard(afterIdentity, patientId)) !== hash(guard)) fail('FOLLOWUP_PATIENT_GUARD_CHANGED');
        for (const op of ops) validateIdentity(op.record, afterIdentity);
        if (journal) await journal.append({ event: 'prepared_patient', patient_id: patientId, prepared_sha256: approvedHash,
          actor_id: actorId, operations: ops.map(o => o.operation_key), before: ops.map(o => o.before), at: now().toISOString() });
        return { patient_id: patientId, outcomes };
      });
      if (journal) await journal.append({ event: 'committed_patient', prepared_sha256: approvedHash, ...result, at: now().toISOString() });
      results.push(result);
    }
    return { patients: results.length, outcomes: results.flatMap(r => r.outcomes) };
  }
  return { apply };
}

module.exports = { VERSION, validateDatabaseIdentity, inferTargetMonth, intervalTreatmentMonth, clinicalArea, normalizedRecord, rowSnapshot, patientGuard, validateIdentity, approvedClinic, prepare, verifyPrepared, createExecutor };
