'use strict';

// These are the reviewed BS import rules, not a live assignment writer. Each
// result is included in the private plan with its source-row evidence.
const { normalizedRecord, validateIdentity, clinicalArea, intervalTreatmentMonth } = require('./followup-reconciliation');

function buildClinicDecision({ input, live, evidence, administrativeOverride = null, administrativeScope = null }) {
  const record = normalizedRecord(input);
  const unresolved = reason => ({ source_key: record.source_key, action: 'review', reason });
  const review = reason => {
    const eligible = ['FOLLOWUP_CLINIC_NOT_UNAMBIGUOUS','NO_PRIOR_DOCUMENTED_TREATMENT','FOLLOWUP_MENTIONS_BOTH_CLINICAL_AREAS'].includes(reason);
    if (eligible && administrativeOverride?.source_keys.includes(record.source_key)
      && (guard?.primary_clinic_id === 66 || guard?.memberships.includes(66))) {
      return { source_key: record.source_key, action: 'apply', clinic_id: 66,
        rule: 'user_override_capilar_20261118', evidence: [], administrative_authorization: administrativeOverride.proof };
    }
    return unresolved(reason);
  };
  let guard;
  try { guard = validateIdentity(record, live); }
  catch (error) { return review(error.code || 'FOLLOWUP_SOURCE_IDENTITY_CHANGED'); }
  if (record.validation_errors.length) return review(record.validation_errors.join(','));
  const area = clinicalArea(record.clinical_notes);
  if (area.ambiguous) return review('FOLLOWUP_MENTIONS_BOTH_CLINICAL_AREAS');
  const allowedMembership = clinic => guard.primary_clinic_id === clinic || guard.memberships.includes(clinic);
  const choose = (clinic, rule, chosen = []) => allowedMembership(clinic)
    ? { source_key: record.source_key, action: 'apply', clinic_id: clinic, rule, evidence: chosen }
    : review('FOLLOWUP_CLINIC_MEMBERSHIP_REQUIRED');
  if (area.clinic_id) return choose(area.clinic_id, 'explicit_followup_clinical_area');
  const memberClinics = [...new Set([guard.primary_clinic_id, ...guard.memberships])];
  if (memberClinics.length === 1 && memberClinics[0] === 66) return choose(66, 'exclusive_capilar_membership_authorized_20261118');
  const prior = evidence.filter(e => String(e.source_contact_id) === record.source_contact_id
    && e.treatment_date && e.treatment_date <= record.contact_due_date && !e.payment_reversed);
  const uniqueClinic = rows => {
    const clinics = [...new Set(rows.map(e => e.clinic_id))];
    return clinics.length === 1 && [66,72].includes(clinics[0]) ? clinics[0] : null;
  };
  const paid = prior.filter(e => e.paid_evidence === true), paidClinic = uniqueClinic(paid);
  if (paidClinic) return choose(paidClinic, 'documented_paid_treatment_scope', paid);
  const priorClinic = uniqueClinic(prior);
  if (priorClinic) return choose(priorClinic, 'single_prior_documented_clinic', prior);
  const interval = intervalTreatmentMonth(record);
  const matching = interval ? prior.filter(e => e.treatment_date.slice(0,7) === interval.month) : [];
  const intervalClinic = uniqueClinic(matching);
  if (intervalClinic) return choose(intervalClinic, 'interval_matched_documented_treatment', matching);
  if (memberClinics.length === 1 && memberClinics[0] === 72 && administrativeScope) {
    return { source_key: record.source_key, action: 'apply', clinic_id: 72,
      rule: 'exclusive_medical_membership_authorized_20261118', evidence: [], administrative_authorization: administrativeScope };
  }
  return review(prior.length ? 'FOLLOWUP_CLINIC_NOT_UNAMBIGUOUS' : 'NO_PRIOR_DOCUMENTED_TREATMENT');
}

module.exports = { buildClinicDecision };
