'use strict';

// Internal measurement only. Never copy this context into advertising payloads.
const LEAD_PATIENT_CONTEXT_TYPE = 'lead_patient_context_v1';
const LEAD_PATIENT_ATTENTION_TYPE = 'lead_patient_attention_v1';
const RELATIONSHIPS = Object.freeze(['new_contact', 'existing_patient', 'possible_patient', 'unknown']);
const REQUEST_KINDS = Object.freeze(['commercial', 'patient_care']);
const plain = value => value?.get ? value.get({ plain: true }) : value;
const positiveId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
function jsonObject(value) {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
function timestamp(value) {
  if (value == null || value === '') return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}
// Database timestamps may have second precision. A tie cannot establish priority.
const before = (value, cutoff) => timestamp(value) !== null && timestamp(cutoff) !== null
  && Math.floor(timestamp(value) / 1000) < Math.floor(timestamp(cutoff) / 1000);
function normalizeContextPhone(value) {
  if (typeof value !== 'string' || !/^(?:\+|00)?[\d\s()./-]+$/.test(value.trim())) return null;
  let digits = value.replace(/\D/g, '');
  if (value.trim().startsWith('00')) digits = digits.slice(2);
  if (digits.length === 9 && !value.trim().startsWith('+') && !value.trim().startsWith('00')) digits = `34${digits}`;
  return /^\d{10,15}$/.test(digits) ? digits : null;
}
function normalizeContextEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return email.length <= 255 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}
function namesConflict(leadName, patient) {
  const words = value => typeof value === 'string' ? value.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^\p{L}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean) : [];
  const lead = words(leadName);
  const patientName = words(`${patient.nombre || ''} ${patient.apellidos || ''}`);
  const placeholder = tokens => !tokens.length || ['sin', 'desconocido', 'paciente', 'contacto'].includes(tokens[0]);
  if (placeholder(lead) || placeholder(patientName)) return false;
  return lead[0] !== patientName[0] || lead.length > 1 && patientName.length > 1 && lead.some(token => !patientName.includes(token));
}
function unknownContext(reason = 'snapshot_missing', capturedAt = null, persisted = false) {
  return { relationship: 'unknown', patient_id: null, clinic_id: null, clinic_name: null,
    same_clinic: null, captured_at: capturedAt, reason, request_kind: 'commercial', persisted };
}
function readContextSnapshot(value) {
  const snapshot = jsonObject(value);
  if (!snapshot || snapshot.version !== 1 || !RELATIONSHIPS.includes(snapshot.relationship)
    || !REQUEST_KINDS.includes(snapshot.request_kind) || typeof snapshot.captured_at !== 'string'
    || timestamp(snapshot.captured_at) === null || typeof snapshot.reason !== 'string'
    || !/^[a-z][a-z0-9_]{0,95}$/.test(snapshot.reason)) return null;
  if (snapshot.relationship === 'existing_patient'
    && (!positiveId(snapshot.patient_id) || !positiveId(snapshot.clinic_id)
      || typeof snapshot.same_clinic !== 'boolean'
      || snapshot.clinic_name !== null && typeof snapshot.clinic_name !== 'string')) return null;
  return { relationship: snapshot.relationship,
    patient_id: snapshot.relationship === 'existing_patient' ? positiveId(snapshot.patient_id) : null,
    clinic_id: snapshot.relationship === 'existing_patient' ? positiveId(snapshot.clinic_id) : null,
    clinic_name: snapshot.relationship === 'existing_patient' ? snapshot.clinic_name : null,
    same_clinic: snapshot.relationship === 'existing_patient' ? snapshot.same_clinic : null,
    captured_at: snapshot.captured_at, reason: snapshot.reason, request_kind: snapshot.request_kind, persisted: true };
}
function readAttentionKind(value) {
  const attention = jsonObject(value);
  return attention?.version === 1 && ['director', 'clinic'].includes(attention.decision)
    && REQUEST_KINDS.includes(attention.request_kind) ? attention.request_kind : null;
}
function attendedBefore(appointment, lead) {
  if (positiveId(appointment.lead_intake_id) === positiveId(lead.id)) return false;
  if (!['ha_acudido', 'en_atencion', 'completada'].includes(appointment.estado)) return false;
  if (!before(appointment.inicio, lead.created_at)) return false;
  const careTimes = ['arrived_at', 'care_started_at', 'care_completed_at'].map(key => appointment[key]).filter(Boolean);
  if (careTimes.length) return careTimes.some(value => before(value, lead.created_at));
  // An old scheduled time alone is not evidence of attendance at lead entry.
  return before(appointment.created_at, lead.created_at) && before(appointment.updated_at, lead.created_at);
}

/** Pure classification of bounded, scoped evidence, shared by capture and legacy reads. */
function classifyLeadPatientContext(lead, evidence, { atCreation = false, capturedAt = null } = {}) {
  lead = plain(lead) || {};
  const result = unknownContext('no_prior_evidence', capturedAt);
  const entry = timestamp(lead.created_at);
  if (entry === null || entry > Date.now()) return { ...result, reason: 'entry_time_unavailable' };
  const scope = evidence.scopes.get(positiveId(lead.id));
  if (!scope?.length) return { ...result, reason: 'scope_unavailable' };
  const phone = normalizeContextPhone(lead.telefono);
  const email = normalizeContextEmail(lead.email);
  if (!phone && !email) return { ...result, reason: 'contact_unavailable' };
  if (evidence.truncated) return { ...result, relationship: 'possible_patient', reason: 'candidate_limit' };
  const matches = [];
  for (const patient of evidence.patients) {
    const primary = phone && normalizeContextPhone(patient.telefono_movil) === phone;
    const secondary = phone && normalizeContextPhone(patient.telefono_secundario) === phone;
    const byEmail = email && normalizeContextEmail(patient.email) === email;
    if (!primary && !secondary && !byEmail) continue;
    const coverage = [];
    if (scope.includes(positiveId(patient.clinica_id))) coverage.push({ clinicId: positiveId(patient.clinica_id), since: patient.createdAt });
    for (const link of patient.clinicasVinculadas || []) {
      if (scope.includes(positiveId(link.clinica_id))) coverage.push({ clinicId: positiveId(link.clinica_id), since: link.createdAt });
    }
    if (!coverage.length) continue;
    const attendance = evidence.appointments.filter(row => positiveId(row.paciente_id) === positiveId(patient.id_paciente)
      && scope.includes(positiveId(row.clinica_id)) && attendedBefore(row, lead));
    const prior = coverage.filter(row => before(row.since, lead.created_at));
    const unknownTime = coverage.some(row => timestamp(row.since) === null);
    if (!prior.length && !unknownTime && !attendance.length) continue;
    const shared = evidence.relations.some(row => (positiveId(row.id_paciente) === positiveId(patient.id_paciente)
      || positiveId(row.id_paciente_relacionado) === positiveId(patient.id_paciente))
      && (!row.fecha_inicio || timestamp(row.fecha_inicio) <= entry)
      && (!row.fecha_fin || timestamp(row.fecha_fin) + 86400000 > entry));
    const conflict = phone && normalizeContextPhone(patient.telefono_movil) && !primary
      || email && normalizeContextEmail(patient.email) && !byEmail;
    const clinicId = prior.find(row => row.clinicId === positiveId(lead.clinica_id))?.clinicId
      || attendance.find(row => positiveId(row.clinica_id) === positiveId(lead.clinica_id))?.clinica_id
      || prior[0]?.clinicId || attendance[0]?.clinica_id || coverage[0].clinicId;
    const openAcquisition = (evidence.acquisitions || []).some(row => positiveId(row.patient_id) === positiveId(patient.id_paciente)
      && positiveId(row.lead_id) !== positiveId(lead.id) && scope.includes(positiveId(row.clinic_id))
      && before(row.created_at, lead.created_at));
    matches.push({ patient, clinicId: positiveId(clinicId), shared: !!shared, conflict: !!conflict,
      nameConflict: namesConflict(lead.nombre, patient), openAcquisition,
      secondary: !!secondary && !primary, prior: prior.length > 0, attended: attendance.length > 0 });
  }
  if (!matches.length) return { ...result, relationship: atCreation ? 'new_contact' : 'unknown',
    reason: atCreation ? 'no_prior_patient_at_entry' : 'no_prior_evidence' };
  if (matches.length !== 1) return { ...result, relationship: 'possible_patient', reason: 'ambiguous_contact' };
  const match = matches[0];
  const reason = match.shared ? 'shared_contact' : match.conflict ? 'conflicting_contact'
    : match.nameConflict ? 'conflicting_name' : match.openAcquisition && !match.attended ? 'open_acquisition_record'
    : match.secondary ? 'secondary_contact' : !match.prior && !match.attended ? 'prior_time_unproven'
      : !atCreation && !match.attended ? 'prior_attendance_unproven' : null;
  if (reason) return { ...result, relationship: 'possible_patient', reason };
  return { ...result, relationship: 'existing_patient', patient_id: positiveId(match.patient.id_paciente),
    clinic_id: match.clinicId, clinic_name: evidence.clinics.get(match.clinicId)?.nombre_clinica || null,
    same_clinic: positiveId(lead.clinica_id) ? match.clinicId === positiveId(lead.clinica_id) : false,
    reason: match.attended ? 'prior_attendance' : 'prior_patient_record' };
}

/** MySQL expressions only; callers retain their existing tenant/date/ACL WHERE.
 * Missing legacy snapshots count as unknown, never as new acquisitions. The
 * derived, non-persisted legacy preview is deliberately not a reporting fact.
 */
function leadPatientContextSql({ leadAlias = 'LeadIntake' } = {}) {
  if (typeof leadAlias !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(leadAlias)) throw Error('invalid_lead_alias');
  const field = (expression, key) => `JSON_UNQUOTE(JSON_EXTRACT(${expression}, '$.${key}'))`;
  const audit = '`lpc_snapshot`.`attribution_steps`';
  const storedSnapshot = `JSON_EXTRACT(${audit}, '$.${LEAD_PATIENT_CONTEXT_TYPE}')`;
  const selectSnapshot = expression => `(SELECT ${expression} FROM \`LeadAttributionAudits\` AS \`lpc_snapshot\` WHERE \`lpc_snapshot\`.\`lead_intake_id\` = \`${leadAlias}\`.\`id\` AND ${field(audit, 'type')} = '${LEAD_PATIENT_CONTEXT_TYPE}' ORDER BY \`lpc_snapshot\`.\`id\` ASC LIMIT 1)`;
  const snapshot = selectSnapshot(storedSnapshot);
  const persisted = `EXISTS (SELECT 1 FROM \`LeadAttributionAudits\` AS \`lpc_snapshot\` WHERE \`lpc_snapshot\`.\`lead_intake_id\` = \`${leadAlias}\`.\`id\` AND ${field(audit, 'type')} = '${LEAD_PATIENT_CONTEXT_TYPE}')`;
  const valid = `JSON_TYPE(JSON_EXTRACT(${storedSnapshot}, '$.version')) = 'INTEGER' AND ${field(storedSnapshot, 'version')} = '1' AND ${field(storedSnapshot, 'relationship')} IN ('new_contact','existing_patient','possible_patient','unknown') AND ${field(storedSnapshot, 'request_kind')} IN ('commercial','patient_care') AND ${field(storedSnapshot, 'reason')} REGEXP '^[a-z][a-z0-9_]{0,95}$' AND JSON_TYPE(JSON_EXTRACT(${storedSnapshot}, '$.captured_at')) = 'STRING' AND ${field(storedSnapshot, 'captured_at')} REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' AND (${field(storedSnapshot, 'relationship')} <> 'existing_patient' OR (${field(storedSnapshot, 'patient_id')} REGEXP '^[1-9][0-9]*$' AND ${field(storedSnapshot, 'clinic_id')} REGEXP '^[1-9][0-9]*$' AND JSON_TYPE(JSON_EXTRACT(${storedSnapshot}, '$.same_clinic')) = 'BOOLEAN'))`;
  const relationship = `COALESCE(${selectSnapshot(`CASE WHEN ${valid} THEN ${field(storedSnapshot, 'relationship')} ELSE 'unknown' END`)}, 'unknown')`;
  const attentionAudit = '`lpc_attention`.`attribution_steps`';
  const attention = `JSON_EXTRACT(${attentionAudit}, '$.${LEAD_PATIENT_ATTENTION_TYPE}')`;
  const attentionKind = `(SELECT ${field(attention, 'request_kind')} FROM \`LeadAttributionAudits\` AS \`lpc_attention\` WHERE \`lpc_attention\`.\`lead_intake_id\` = \`${leadAlias}\`.\`id\` AND ${field(attentionAudit, 'type')} = '${LEAD_PATIENT_ATTENTION_TYPE}' AND JSON_TYPE(JSON_EXTRACT(${attention}, '$.version')) = 'INTEGER' AND ${field(attention, 'version')} = '1' AND ${field(attention, 'decision')} IN ('director','clinic') AND ${field(attention, 'request_kind')} IN ('commercial','patient_care') AND (JSON_EXTRACT(${attention}, '$.clinic_id') IS NULL OR JSON_TYPE(JSON_EXTRACT(${attention}, '$.clinic_id')) = 'NULL' OR ${field(attention, 'clinic_id')} = CAST(\`${leadAlias}\`.\`clinica_id\` AS CHAR)) ORDER BY \`lpc_attention\`.\`id\` DESC LIMIT 1)`;
  const request_kind = `COALESCE(${attentionKind}, ${selectSnapshot(`CASE WHEN ${valid} THEN ${field(storedSnapshot, 'request_kind')} ELSE 'commercial' END`)}, 'commercial')`;
  return { snapshot, persisted, relationship, request_kind, attention_kind: attentionKind };
}

module.exports = { LEAD_PATIENT_CONTEXT_TYPE, LEAD_PATIENT_ATTENTION_TYPE, RELATIONSHIPS, REQUEST_KINDS,
  plain, positiveId, jsonObject, timestamp, before, normalizeContextPhone, normalizeContextEmail,
  unknownContext, readContextSnapshot, readAttentionKind, attendedBefore, namesConflict, classifyLeadPatientContext, leadPatientContextSql };
