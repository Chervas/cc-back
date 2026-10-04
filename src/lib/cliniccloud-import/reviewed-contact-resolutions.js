'use strict';

// Operator-only source exceptions. No HTTP inputs, demographic guesses, clinical
// equivalence, ledger writes or mutation of the original source are supported.
const { hash, dateOnly, norm, localToUtc } = require('./adapter');
const VERSION = 'cliniccloud-reviewed-contact-resolutions/1';
const ROLE = 'reviewed_contact_resolutions';
const KINDS = Object.freeze(['zero_concept_contact_parent_scope', 'invalid_birth_date_omission', 'primary_clinic_from_observed_agenda']);
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[1-9]\d*$/;
const fail = code => { throw Error(code); };
const requireThat = (value, code) => { if (!value) fail(code); };
const cleanText = (value, max) => typeof value === 'string' && value.trim().length >= 3 && value === value.trim() && value.length <= max && !/[\u0000-\u001f]/.test(value);
const same = (a, b, code) => requireThat(hash(a) === hash(b), code);
const exactKeys=(object,keys,code)=>same(Object.keys(object||{}).sort(),[...keys].sort(),code);
const selectedFile = file => ({ role: file.role, name: file.name, sha256: file.sha256 });

function originalContact(sources, id) {
  const rows = sources.contacts.rows.filter(row => String(row.values.IDCONTACTO) === id);
  requireThat(rows.length === 1, 'REVIEWED_CONTACT_SOURCE_NOT_UNIQUE');
  return rows[0];
}

function originalHistory(sources, id) {
  const rows = sources.live_histories?.data?.patients?.filter(row => String(row.contact_id) === id) || [];
  requireThat(rows.length === 1 && Array.isArray(rows[0].rows) && rows[0].rows.length > 0, 'REVIEWED_CONTACT_HISTORY_REQUIRED');
  const patient = rows[0];
  requireThat(new Set(patient.rows.map(row => String(row.idCita))).size === patient.rows.length
    && patient.rows.every(row => String(row.idContacto) === id && Number(row.agenda?.idEmpresa) === 5880), 'REVIEWED_CONTACT_HISTORY_SCOPE_INVALID');
  return patient;
}

function appointmentFrom(patient, expected, id) {
  const rows = patient.rows.filter(row => String(row.idCita) === expected.source_appointment_id);
  requireThat(rows.length === 1, 'REVIEWED_CONTACT_PARENT_NOT_UNIQUE');
  const row = rows[0];
  requireThat(String(row.idContacto) === id && Number(row.agenda?.idEmpresa) === 5880
    && expected.company_id === 5880 && hash(row) === expected.parent_sha256, 'REVIEWED_CONTACT_PARENT_CHANGED');
  return row;
}

function validateDecision(sources, decision) {
  requireThat(decision && KINDS.includes(decision.kind) && ID.test(decision.source_contact_id || '')
    && HASH.test(decision.source_contact_row_sha256 || '') && ID.test(String(decision.history_number || ''))
    && Number.isSafeInteger(decision.reviewer_user_id) && decision.reviewer_user_id > 0
    && cleanText(decision.reviewed_by, 255) && cleanText(decision.reason, 500)
    && decision.expected && typeof decision.expected === 'object' && !Array.isArray(decision.expected), 'REVIEWED_CONTACT_DECISION_INVALID');
  exactKeys(decision,['kind','source_contact_id','source_contact_row_sha256','history_number','history_sha256','reviewer_user_id','reviewed_by','reason','expected'],'REVIEWED_CONTACT_DECISION_FIELDS_INVALID');
  const record = originalContact(sources, decision.source_contact_id), raw = record.values;
  requireThat(hash(raw) === decision.source_contact_row_sha256 && String(raw.NUM) === String(decision.history_number), 'REVIEWED_CONTACT_SOURCE_CHANGED');
  const patient = originalHistory(sources, decision.source_contact_id), expected = decision.expected;
  requireThat(HASH.test(decision.history_sha256 || '') && hash(patient) === decision.history_sha256, 'REVIEWED_CONTACT_UNFILTERED_HISTORY_CHANGED');
  if (decision.kind === 'invalid_birth_date_omission') {
    exactKeys(expected,['raw_birth_date','normalized_birth_date','source_creation_local','canonical_birth_date','age_status','later_demographic_review_required'],'REVIEWED_CONTACT_BIRTH_EXPECTATION_FIELDS_INVALID');
    const created = require('./new-patients-apply').sourceCreated(raw, { start: '1900-01-01', end: '2999-12-31' });
    const birth = dateOnly(raw['F. NACIMIENTO']);
    requireThat(birth && birth > created.local.slice(0, 10) && expected.raw_birth_date === raw['F. NACIMIENTO']
      && expected.normalized_birth_date === birth && expected.source_creation_local === created.local
      && expected.canonical_birth_date === null && expected.age_status === 'unknown'
      && expected.later_demographic_review_required === true, 'REVIEWED_CONTACT_BIRTH_OMISSION_EXPECTATION_INVALID');
    return;
  }
  requireThat(ID.test(expected.source_appointment_id || '') && HASH.test(expected.parent_sha256 || ''), 'REVIEWED_CONTACT_PARENT_EXPECTATION_REQUIRED');
  const appointment = appointmentFrom(patient, expected, decision.source_contact_id);
  if (decision.kind === 'zero_concept_contact_parent_scope') {
    exactKeys(expected,['source_appointment_id','parent_sha256','company_id','concept_contact_id','parent_contact_id','source_concept_id','concept_sha256'],'REVIEWED_CONTACT_ZERO_EXPECTATION_FIELDS_INVALID');
    requireThat(expected.concept_contact_id === '0' && expected.parent_contact_id === decision.source_contact_id
      && ID.test(expected.source_concept_id || '') && HASH.test(expected.concept_sha256 || ''), 'REVIEWED_CONTACT_ZERO_SCOPE_EXPECTATION_INVALID');
    const concepts = (appointment.conceptos || []).filter(row => String(row.idCitaConcepto) === expected.source_concept_id);
    requireThat(concepts.length === 1 && String(concepts[0].idContacto) === '0'
      && String(concepts[0].idCita) === expected.source_appointment_id && hash(concepts[0]) === expected.concept_sha256, 'REVIEWED_CONTACT_ZERO_SCOPE_CHANGED');
    return;
  }
  const mapping = expected.agenda_mapping;
  exactKeys(expected,['source_appointment_id','parent_sha256','company_id','clinic_id','source_state','agenda_id','agenda_name','performed_local','ambiguous_service_id','agenda_mapping'],'REVIEWED_CONTACT_AGENDA_EXPECTATION_FIELDS_INVALID');
  exactKeys(mapping,['kind','clinic_id','company_id','agenda_id','agenda_name','anchor_mapping_sha256'],'REVIEWED_CONTACT_MAPPING_FIELDS_INVALID');
  requireThat(expected.clinic_id === 66 && expected.source_state === 1 && Number(appointment.estado) === 1
    && Number(expected.agenda_id) === Number(appointment.agenda.idAgenda) && Number(appointment.idAgenda) === Number(expected.agenda_id)
    && expected.agenda_name === 'CAPILARES' && norm(appointment.agenda.nombre) === 'CAPILARES'
    && expected.performed_local === String(appointment.marcaRealizada || '').replace(' ', 'T')
    && localToUtc(expected.performed_local) && expected.performed_local.slice(0, 10) === dateOnly(appointment.fechaIni)
    && ID.test(expected.ambiguous_service_id || '') && Array.isArray(appointment.conceptos) && appointment.conceptos.length > 0
    && appointment.conceptos.every(row => String(row.idContacto) === decision.source_contact_id && String(row.idCita) === expected.source_appointment_id
      && String(row.idServicio) === expected.ambiguous_service_id)
    && mapping?.kind === 'reviewed_administrative_agenda_mapping' && mapping.clinic_id === 66 && mapping.company_id === 5880
    && Number(mapping.agenda_id) === Number(expected.agenda_id) && mapping.agenda_name === 'CAPILARES'
    && mapping.anchor_mapping_sha256===hash({company_id:5880,agenda_id:Number(appointment.agenda.idAgenda),agenda_name:'CAPILARES',
      clinic_id:66,anchor_sha256:hash(appointment),administrative_only:true}), 'REVIEWED_CONTACT_ADMINISTRATIVE_AGENDA_EXPECTATION_INVALID');
}

function validateReviewedContactResolutions(sources, now = Date.now()) {
  const source = sources[ROLE];
  if (!source) return null;
  const receipt = source.data, { resolutions_sha256, ...body } = receipt || {};
  requireThat(source.file?.role === ROLE && HASH.test(source.file.sha256 || '') && receipt?.version === VERSION
    && receipt.source_account === 'cliniccloud-5880' && HASH.test(resolutions_sha256 || '') && hash(body) === resolutions_sha256,
  'REVIEWED_CONTACT_RESOLUTIONS_INTEGRITY_INVALID');
  exactKeys(receipt,['version','source_account','reviewed_at','expires_at','decisions','source_files','resolutions_sha256'],'REVIEWED_CONTACT_RESOLUTIONS_FIELDS_INVALID');
  const at = Date.parse(receipt.reviewed_at), expires = Date.parse(receipt.expires_at);
  requireThat(Number.isFinite(at) && Number.isFinite(expires) && at <= now && now - at <= 3600000
    && expires > now && expires <= at + 3600000, 'REVIEWED_CONTACT_RESOLUTIONS_EXPIRED');
  const sourceTimes=[sources.live_histories?.data?.captured_at,sources.live_state_labels?.data?.captured_at].map(Date.parse);
  requireThat(sourceTimes.every(time=>Number.isFinite(time)&&time<=now&&now-time<=2*3600000)
    &&expires<=Math.min(...sourceTimes)+2*3600000,'REVIEWED_CONTACT_RESOLUTIONS_SOURCE_LEASE_INVALID');
  requireThat(Array.isArray(receipt.decisions) && receipt.decisions.length === 3
    && new Set(receipt.decisions.map(row => row.source_contact_id)).size === 3
    && hash(receipt.decisions.map(row => row.kind).sort()) === hash([...KINDS].sort()), 'REVIEWED_CONTACT_RESOLUTIONS_EXACT_SCOPE_REQUIRED');
  const files = Object.entries(sources).filter(([role]) => role !== ROLE).map(([, value]) => selectedFile(value.file)).sort((a, b) => a.role.localeCompare(b.role));
  requireThat(files.length === 7 && Array.isArray(receipt.source_files)
    &&hash(files.map(file=>file.role).sort())===hash(['appointments','contacts','historic_contacts','historic_types','historic_services','live_histories','live_state_labels'].sort()), 'REVIEWED_CONTACT_RESOLUTIONS_SOURCE_MANIFEST_REQUIRED');
  same([...receipt.source_files].sort((a, b) => a.role.localeCompare(b.role)), files, 'REVIEWED_CONTACT_RESOLUTIONS_SOURCE_FILES_CHANGED');
  for (const decision of receipt.decisions) validateDecision(sources, decision);
  return receipt;
}

function contactResolution(sources, sourceId, kind = null, now = Date.now()) {
  const review = validateReviewedContactResolutions(sources, now);
  if (!review) return null;
  const decision = review.decisions.find(row => row.source_contact_id === String(sourceId));
  if (!decision || kind && decision.kind !== kind) return null;
  const body = { version: VERSION, ...decision, batch_sha256: review.resolutions_sha256,
    reviewed_at: review.reviewed_at, expires_at: review.expires_at, source_files: review.source_files };
  return { ...body, decision_sha256: hash(body) };
}

function reviewedZeroConceptAllowed(resolution, parent, concept) {
  if (!resolution || resolution.kind !== 'zero_concept_contact_parent_scope') return false;
  const expected = resolution.expected;
  return String(concept.idContacto) === '0' && String(parent.idContacto) === resolution.source_contact_id
    && String(parent.idCita) === expected.source_appointment_id && String(concept.idCita) === expected.source_appointment_id
    && String(concept.idCitaConcepto) === expected.source_concept_id && Number(parent.agenda?.idEmpresa) === 5880
    && hash(parent) === expected.parent_sha256 && hash(concept) === expected.concept_sha256;
}

function storedBirthDateHold(snapshot) {
  const receipt = snapshot?.import?.operator_resolution;
  if (!receipt || receipt.kind !== 'invalid_birth_date_omission') return null;
  const { decision_sha256, ...body } = receipt;
  requireThat(receipt.version === VERSION && HASH.test(decision_sha256 || '') && hash(body) === decision_sha256
    && HASH.test(receipt.batch_sha256 || '') && cleanText(receipt.reviewed_by, 255) && cleanText(receipt.reason, 500)
    && Number.isSafeInteger(receipt.reviewer_user_id) && receipt.reviewer_user_id > 0
    && receipt.source_contact_id === String(snapshot.contact?.idContacto) && String(receipt.history_number) === String(snapshot.contact?.num)
    && receipt.source_contact_row_sha256 === snapshot.provenance?.row_sha256 && receipt.expected?.canonical_birth_date === null
    && receipt.expected.age_status === 'unknown' && receipt.expected.later_demographic_review_required === true
    && receipt.expected.normalized_birth_date === snapshot.fields?.birth_date && snapshot.stored_fields?.birth_date === ''
    && snapshot.import.birth_date_hold?.version===1&&snapshot.import.birth_date_hold.active===true
    && snapshot.import.birth_date_hold.decision_sha256===decision_sha256&&snapshot.import.birth_date_hold.age_status==='unknown'
    && snapshot.import.birth_date_hold.later_demographic_review_required===true
    && snapshot.import.automation_policy === 'hold' && snapshot.import.messages_enabled === false,
  'REVIEWED_CONTACT_STORED_BIRTH_HOLD_INVALID');
  return { field: 'birth_date', source_contact_id: receipt.source_contact_id, reason: 'REVIEWED_INVALID_SOURCE_BIRTH_DATE_HELD',
    decision_sha256, raw_birth_date: receipt.expected.raw_birth_date, normalized_birth_date: receipt.expected.normalized_birth_date,
    canonical_birth_date: null, age_status: 'unknown', later_demographic_review_required: true };
}

function validateOperationResolution(operation){
  const receipt=operation.operator_resolution;
  if(!receipt){requireThat(operation.primary_rule!=='operator_reviewed_observed_agenda','REVIEWED_CONTACT_OPERATION_RECEIPT_REQUIRED');return;}
  const {decision_sha256,...body}=receipt;
  requireThat(receipt.version===VERSION&&KINDS.includes(receipt.kind)&&HASH.test(decision_sha256||'')&&hash(body)===decision_sha256
    &&receipt.source_contact_id===operation.source_contact_id&&String(receipt.history_number)===String(operation.history_number)
    &&receipt.source_contact_row_sha256===operation.provenance?.row_sha256&&cleanText(receipt.reviewed_by,255)
    &&cleanText(receipt.reason,500)&&Number.isSafeInteger(receipt.reviewer_user_id)&&receipt.reviewer_user_id>0,
  'REVIEWED_CONTACT_OPERATION_RECEIPT_INVALID');
  if(receipt.kind==='invalid_birth_date_omission'){
    requireThat(operation.payload.fecha_nacimiento===null&&operation.source_fields.birth_date===receipt.expected.normalized_birth_date,
    'REVIEWED_CONTACT_BIRTH_OMISSION_PAYLOAD_CHANGED');
  }else if(receipt.kind==='primary_clinic_from_observed_agenda'){
    requireThat(operation.payload.clinica_id===66&&operation.primary_rule==='operator_reviewed_observed_agenda'
      &&hash(operation.memberships)===hash([66])&&operation.primary_evidence.length===1
      &&operation.primary_evidence[0].administrative_only===true&&operation.primary_evidence[0].retained_service_ambiguity===true,
    'REVIEWED_CONTACT_ADMINISTRATIVE_PAYLOAD_CHANGED');
  }
}

function assertReviewedOperationsFresh(operations,now=Date.now()){
  for(const operation of operations.filter(row=>row.operator_resolution)){
    const receipt=operation.operator_resolution,at=Date.parse(receipt.reviewed_at),expires=Date.parse(receipt.expires_at);
    requireThat(Number.isFinite(at)&&Number.isFinite(expires)&&at<=now&&now-at<=3600000
      &&expires>now&&expires<=at+3600000,'REVIEWED_CONTACT_RESOLUTIONS_EXPIRED');
  }
}

module.exports = { VERSION, ROLE, KINDS, validateReviewedContactResolutions, contactResolution, reviewedZeroConceptAllowed, storedBirthDateHold, validateOperationResolution, assertReviewedOperationsFresh };
