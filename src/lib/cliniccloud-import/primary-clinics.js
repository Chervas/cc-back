'use strict';
const { norm, clean, dateOnly, index, hash } = require('./adapter');
const { choosePrimaryClinic } = require('./planner');
const MEDICAL = 72, CAPILAR = 66;
const medicalTypes = new Set(['90521', '90525', '90530', '90535', '90536', '90540', '90766', '91986', '273010', '275553', '275554', '275740']);
const nutritionServices = new Set(['1001249', '1001254', '1001255', '1001265', '1001278', '1001285', '1001286']);
const money = (value) => { const s = clean(value).replace(/[^\d,.-]/g, ''); return Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s) || 0; };
const values = (r) => r.values || r;
const count = (rows, field) => rows.reduce((sum, r) => { const key = String(r[field] ?? 'none'); sum[key] = (sum[key] || 0) + 1; return sum; }, {});

function serviceClinic(raw) {
  if (!raw) return { clinic_id: null, reason: 'UNKNOWN_SOURCE_SERVICE' };
  const r = values(raw), name = norm(r.nombre), id = clean(r.idServicio), type = clean(r.idTipoServicio);
  if (id === '1076290' || /^BLOQUEO\b/.test(name)) return { clinic_id: null, blocked: true, reason: 'EXPLICIT_BLOCK_SERVICE' };
  if (/(FACIAL.*CAPILAR|CAPILAR.*FACIAL)/.test(name)) return { clinic_id: null, reason: 'FACIAL_OR_CAPILAR_SERVICE_AMBIGUOUS' };
  if (['2951044', '3097652'].includes(id) && name === 'INJERTO CAPILAR') return { clinic_id: CAPILAR, reason: 'EXPLICIT_HAIR_TRANSPLANT_SERVICE' };
  if (nutritionServices.has(id)) return { clinic_id: MEDICAL, reason: 'HISTORIC_NUTRITION_SERVICE_NOT_RENAMED_BLOCK_TYPE' };
  if (type === '260902') return { clinic_id: CAPILAR, reason: 'APPROVED_CAPILAR_SERVICE_TYPE' };
  if (medicalTypes.has(type)) return { clinic_id: MEDICAL, reason: 'APPROVED_MEDICAL_SERVICE_TYPE' };
  return { clinic_id: null, reason: 'UNMAPPED_SERVICE_AREA' };
}

function newAppointmentClinic(raw, types) {
  const r = values(raw), type = norm(r['TIPO SERVICIO']);
  if (type === 'BLOQUEO') return { clinic_id: null, blocked: true, reason: 'EXPLICIT_BLOCK_ROW' };
  const found = new Set();
  for (const row of types) {
    const t = values(row);
    if (!type.includes(norm(t.nombre))) continue;
    if (clean(t.idTipoServicio) === '260902') found.add(CAPILAR);
    else if (medicalTypes.has(clean(t.idTipoServicio))) found.add(MEDICAL);
  }
  if (/(FACIAL.*CAPILAR|CAPILAR.*FACIAL)/.test(norm(r.SERVICIOS))) return { clinic_id: null, reason: 'FACIAL_OR_CAPILAR_SERVICE_AMBIGUOUS' };
  if (norm(r.SERVICIOS) === 'INJERTO CAPILAR') return { clinic_id: CAPILAR, reason: 'EXPLICIT_HAIR_TRANSPLANT_SERVICE' };
  return { clinic_id: found.size === 1 ? [...found][0] : null, reason: found.size === 1 ? 'APPROVED_NEW_SERVICE_TYPE' : found.size ? 'MULTI_CLINIC_APPOINTMENT' : 'UNMAPPED_SERVICE_AREA' };
}

function historicalEvidence({ appointments, concepts, services, coverage }) {
  const byAppointment = index(appointments, (r) => clean(values(r).idCita));
  const byService = new Map(services.map((r) => [clean(values(r).idServicio), r]));
  const evidence = [], excluded = [];
  for (const concept of concepts) {
    const c = values(concept), parents = byAppointment.get(clean(c.idCita)) || [];
    const base = { source_contact_id: clean(c.idContacto), source_appointment_id: clean(c.idCita), source_concept_id: clean(c.idCitaConcepto), treatment_id: clean(c.idServicio), provenance: concept.provenance || null };
    if (parents.length !== 1) { excluded.push({ ...base, reason: 'MISSING_OR_AMBIGUOUS_PARENT_APPOINTMENT' }); continue; }
    const a = values(parents[0]), date = dateOnly(a.fechaIni);
    if (clean(a.idContacto) !== base.source_contact_id) { excluded.push({ ...base, reason: 'CONCEPT_APPOINTMENT_PATIENT_MISMATCH' }); continue; }
    if (!date) { excluded.push({ ...base, reason: 'INVALID_HISTORIC_DATE' }); continue; }
    if (coverage && date >= coverage.start && date <= coverage.end) { excluded.push({ ...base, reason: 'NEW_CSV_AUTHORITATIVE_INTERVAL' }); continue; }
    const classification = serviceClinic(byService.get(base.treatment_id));
    if (['-1', '-2'].includes(clean(a.estado)) || classification.blocked) { excluded.push({ ...base, reason: classification.blocked ? classification.reason : 'CANCELLED_APPOINTMENT' }); continue; }
    const conceptPaid = money(c.pagado), appointmentPaid = money(a.pagado);
    evidence.push({ ...base, treatment_date: date, source: 'historic_concept', clinic_id: classification.clinic_id, classification: classification.reason,
      paid_evidence: conceptPaid > 0 || appointmentPaid > 0, payment_reversed: conceptPaid < 0 || appointmentPaid < 0,
      payment_evidence_kind: conceptPaid > 0 ? 'positive_concept_paid_amount' : appointmentPaid > 0 ? 'positive_appointment_paid_amount' : null });
  }
  return { evidence, excluded };
}

function newEvidence(appointments, types) {
  const evidence = [], excluded = [];
  for (const row of appointments) {
    const r = values(row), classification = newAppointmentClinic(r, types);
    const base = { source_contact_id: clean(r.IDCONTACTO), source: 'new_csv', source_appointment_id: null, source_concept_id: null,
      treatment_id: norm(r.SERVICIOS) || null, treatment_date: dateOnly(r.FECHA), provenance: row.provenance || null };
    if (classification.blocked || norm(r.ESTADO).startsWith('ANULADA')) { excluded.push({ ...base, reason: classification.blocked ? classification.reason : 'CANCELLED_APPOINTMENT' }); continue; }
    if (!base.treatment_id || !base.treatment_date) { excluded.push({ ...base, reason: 'MISSING_TREATMENT_OR_DATE' }); continue; }
    const paid = money(r['PAGADO CITA']);
    evidence.push({ ...base, clinic_id: classification.clinic_id, classification: classification.reason,
      paid_evidence: norm(r.ESTADO) === 'PAGADA' || paid > 0, payment_reversed: paid < 0,
      payment_evidence_kind: paid > 0 ? 'positive_appointment_paid_amount' : norm(r.ESTADO) === 'PAGADA' ? 'literal_export_state_pagada_not_money' : null });
  }
  return { evidence, excluded };
}

function assignmentPlan({ evidence, patients, memberships = [] }) {
  const bySource = index(evidence, (r) => r.source_contact_id);
  const identities = new Map();
  for (const patient of patients) for (const id of patient.source_contact_ids || []) {
    const key = String(id); if (!identities.has(key)) identities.set(key, []); identities.get(key).push(patient.id);
  }
  const assignments = [];
  for (const patient of patients) {
    const ids = [...new Set((patient.source_contact_ids || []).map(String))];
    if (!ids.length) continue; // Native-only identities cannot be moved by this import.
    const records = ids.flatMap((id) => bySource.get(id) || []);
    const selected = choosePrimaryClinic(records);
    const reasons = selected.reason ? [selected.reason] : [];
    if (ids.some((id) => identities.get(id).length !== 1)) reasons.push('CONFLICTING_EXACT_LOCAL_IDENTITY');
    if (ids.length > 1) reasons.push('MULTIPLE_SOURCE_CONTACTS_ON_LOCAL_PATIENT');
    if (![MEDICAL, CAPILAR].includes(Number(patient.clinic_id))) reasons.push('LOCAL_PRIMARY_OUTSIDE_APPROVED_SCOPE');
    const unknown = records.filter((r) => !r.clinic_id);
    const first = selected.evidence?.[0]?.treatment_date;
    const decisiveUnknown = unknown.filter((r) => !r.payment_reversed && (selected.rule === 'oldest_paid_treatment' ? r.paid_evidence && (!first || r.treatment_date <= first) : r.paid_evidence || !first || r.treatment_date <= first));
    if (decisiveUnknown.length) reasons.push('EARLIER_OR_PAID_TREATMENT_HAS_AMBIGUOUS_CLINIC');
    const clinicIds = [...new Set(records.map((r) => r.clinic_id).filter(Boolean))];
    const existingLinks = memberships.filter((r) => Number(r.paciente_id) === Number(patient.id));
    const requiredLinks = [...new Set([...clinicIds, Number(patient.clinic_id), selected.clinic_id].filter((id) => [MEDICAL, CAPILAR].includes(id)))];
    assignments.push({ local_patient_id: patient.id, source_contact_ids: ids, current_clinic_id: patient.clinic_id,
      proposed_clinic_id: reasons.length ? null : selected.clinic_id,
      action: reasons.length ? 'review' : Number(patient.clinic_id) === selected.clinic_id ? 'preserve_primary' : 'move_primary_candidate',
      reasons, rule: selected.rule, evidence: selected.evidence || [], ambiguous_decisive_evidence: decisiveUnknown,
      evidence_clinic_ids: clinicIds, evidence_count: records.length,
      memberships: { existing: existingLinks, ensure: requiredLinks, add: requiredLinks.filter((id) => !existingLinks.some((r) => Number(r.clinica_id) === id)), remove: [],
        primary_flag_target: reasons.length ? null : selected.clinic_id },
      expected_patient_identity_hash: hash({ id: patient.id, clinic_id: patient.clinic_id, source_contact_ids: ids, memberships: existingLinks }) });
  }
  return { assignments, summary: { source_linked_patients: assignments.length, actions: count(assignments, 'action'), rules: count(assignments, 'rule'),
    proposed_clinics: count(assignments.filter((r) => r.action !== 'review'), 'proposed_clinic_id'),
    move_72_to_66: assignments.filter((r) => r.action === 'move_primary_candidate' && r.current_clinic_id === MEDICAL && r.proposed_clinic_id === CAPILAR).length,
    move_66_to_72: assignments.filter((r) => r.action === 'move_primary_candidate' && r.current_clinic_id === CAPILAR && r.proposed_clinic_id === MEDICAL).length,
    missing_membership_candidates: assignments.filter((r) => r.action !== 'review').reduce((sum, r) => sum + r.memberships.add.length, 0),
    review_reasons: count(assignments.flatMap((r) => r.reasons.map((reason) => ({ reason }))), 'reason'),
    evidence_unlinked_source_contacts: [...bySource.keys()].filter((id) => !identities.has(id)).length } };
}

function alertPlan({ alerts, patients, assignments, memberships = [] }) {
  const bySource = new Map();
  for (const p of patients) for (const source of p.source_contact_ids || []) { const key = String(source); if (!bySource.has(key)) bySource.set(key, []); bySource.get(key).push(p); }
  const byPatient = new Map(assignments.map((r) => [Number(r.local_patient_id), r]));
  const rows = alerts.map((row) => {
    const reasons = [...row.validation_errors];
    if (row.kind === 'general_alert') return { source: row, action: 'preserve_general_history', reasons: ['NOT_PATIENT_FOLLOWUP'] };
    const matches = bySource.get(String(row.source_contact_id)) || [];
    const patient = matches.length === 1 ? matches[0] : null;
    if (!patient) reasons.push(matches.length ? 'AMBIGUOUS_EXACT_LOCAL_IDENTITY' : 'NO_EXISTING_PATIENT_IDENTITY');
    if (patient && !(patient.source_history_numbers || []).map(String).includes(String(row.history_number))) reasons.push('LOCAL_HISTORY_NUM_NOT_CONFIRMED');
    const assignment = patient && byPatient.get(Number(patient.id));
    const body = norm(row.body);
    const hair = /\b(CAPILAR|DUTASTERIDE|ALOPECIA|TRICOSCOPIA|FOTORREGENERADOR)\b/.test(body);
    const medical = /\b(FACIAL|CORPORAL|BOTOX|NUTRICION|GASTRICO|GASTRICA|BYPASS|MASTOPEXIA|BLEFAROPLASTIA)\b/.test(body);
    let clinic = null, clinicRule = null;
    if (hair !== medical) { clinic = hair ? CAPILAR : MEDICAL; clinicRule = 'explicit_followup_clinical_area'; }
    else if (!hair && assignment?.action !== 'review' && assignment?.evidence_clinic_ids.length === 1) { clinic = assignment.evidence_clinic_ids[0]; clinicRule = 'single_evidenced_clinic_in_patient_history'; }
    if (!clinic) reasons.push('FOLLOWUP_CLINIC_NOT_UNAMBIGUOUS');
    const hasMembership = patient && clinic && (Number(patient.clinic_id) === clinic || memberships.some((m) => Number(m.paciente_id) === Number(patient.id) && Number(m.clinica_id) === clinic));
    const needsMembership = clinic && patient && !hasMembership;
    return { provenance: row.provenance, source_external_id: row.source_external_id, history_number: row.history_number, source_contact_id: row.source_contact_id,
      local_patient_id: patient?.id || null, clinic_id: clinic, clinic_rule: clinicRule,
      action: reasons.length ? 'review' : needsMembership ? 'ready_after_membership' : 'ready_existing_identity', reasons,
      payload: { patient_id: patient?.id || null, clinic_id: clinic, status: row.status, source_kind: 'cliniccloud', source_date_semantics: 'contact_due',
        source_date: row.contact_due_at?.slice(0, 10) || null, contact_due_date: row.contact_due_at?.slice(0, 10) || null, clinical_target_date: null,
        operational_reason: 'Seguimiento importado de ClinicCloud', clinical_notes: row.body, source_external_id: row.source_external_id },
      source_contact_due_at: row.contact_due_at, requires_membership: !!needsMembership, automation_policy: 'hold', occupies_agenda: false };
  });
  return { rows, summary: { total: rows.length, actions: count(rows, 'action'), ready_by_clinic: count(rows.filter((r) => r.action === 'ready_existing_identity'), 'clinic_id'),
    ready_by_status: count(rows.filter((r) => r.action === 'ready_existing_identity').map((r) => ({ status: r.payload.status })), 'status'),
    review_reasons: count(rows.flatMap((r) => r.reasons.map((reason) => ({ reason }))), 'reason') } };
}

module.exports = { serviceClinic, newAppointmentClinic, historicalEvidence, newEvidence, assignmentPlan, alertPlan };
