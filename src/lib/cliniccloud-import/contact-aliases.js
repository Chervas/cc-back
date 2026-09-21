'use strict';
const { hash, norm, dateOnly } = require('./adapter');
const { instant } = require('./appointments-apply');
const { phoneKey: reviewedContactPhoneKey } = require('./new-patients-apply');
const phoneKey = value => {
  const digits=String(value||'').replace(/\D/g,'');
  const key=/^0034\d{9}$/.test(digits)?digits.slice(4):/^34\d{9}$/.test(digits)?digits.slice(2):digits;
  return /^\d{9,15}$/.test(key)?key:'';
};
const fullName = fields => norm(`${fields.name||''} ${fields.surname||''}`);
// Intake sometimes stores the second given name at the beginning of surname.
// This only recognizes an exact boundary shift, not initials, nicknames,
// omitted given names or fuzzy spelling. Native-visit corroboration and unique
// source/local phones remain mandatory in the only caller below.
function corroboratedGivenName(sourceFields, patient) {
  const sourceName=norm(sourceFields.name),localName=norm(patient.nombre);
  if(sourceName===localName) return true;
  const sourceTokens=sourceName.split(' '),localTokens=localName.split(' ');
  if(sourceTokens.length<2||sourceTokens.some(token=>!/^\p{L}{2,}$/u.test(token))||!localName||localTokens.length>=sourceTokens.length
    ||localTokens.some((token,i)=>token!==sourceTokens[i])) return false;
  const localFull=norm(`${patient.nombre||''} ${patient.apellidos||''}`).split(' ');
  return sourceTokens.every((token,i)=>token===localFull[i]);
}
function corroboratedCandidates(source, patients) {
  const name=fullName(source.fields),phone=phoneKey(source.fields.phone);
  if(!phone||name.split(' ').length<2||name.length<8)return [];
  return patients.filter(p=>fullName({name:p.nombre,surname:p.apellidos})===name
    && [p.telefono_movil,p.telefono_secundario].some(v=>phoneKey(v)===phone));
}
function confirmedIdentityCandidate(source, patientId, live, evidence) {
  if(evidence.kind!=='user_confirmed_identity_pair'||evidence.source_contact_id!==source.source_contact_id
    ||evidence.patient_id!==patientId||!/^[a-f0-9]{64}$/.test(evidence.confirmation_sha256||'')
    ||!String(evidence.confirmation_reference||'').trim()
    ||evidence.source_full_name!==fullName(source.fields)) throw Error('CONTACT_ALIAS_CONFIRMATION_INVALID');
  // Explicit confirmation uses the same exact identity-phone normalization
  // as the contact audit, including recorded eight-digit foreign numbers.
  // Never add a country prefix or compare only the suffix of a longer number.
  const phone=reviewedContactPhoneKey(source.fields.phone);
  const candidates=live.patients.filter(p=>phone&&[p.telefono_movil,p.telefono_secundario].some(v=>reviewedContactPhoneKey(v)===phone)
    &&fullName({name:p.nombre,surname:p.apellidos})===evidence.patient_full_name);
  if(candidates.length!==1||Number(candidates[0].id_paciente)!==patientId) throw Error('CONTACT_ALIAS_CONFIRMED_PAIR_CHANGED');
  // The human confirmation is bounded to the exact pair, not permission for
  // phone-only matching of other relatives. At least the given-name prefix
  // must agree; this covers the explicitly confirmed Dani/Daniel nickname.
  const first=norm(source.fields.name).split(' ')[0],other=norm(candidates[0].nombre).split(' ')[0];
  if(Math.min(first.length,other.length)<4||!(first.startsWith(other)||other.startsWith(first))) throw Error('CONTACT_ALIAS_CONFIRMED_NAME_NOT_CORROBORATED');
  return candidates[0];
}
// Explicit operator review under the owner's partial-name policy, not a
// general fuzzy matcher. A unique phone alone never suffices. Reception may
// have recorded only a prefix of the full name and a trailing initial; a
// fully spelled conflicting token still stops the alias.
function partialIdentityCandidate(source, patientId, live, evidence) {
  if(evidence.kind!=='operator_reviewed_unique_phone_name_prefix'
    ||evidence.source_contact_id!==source.source_contact_id||evidence.patient_id!==patientId
    ||evidence.source_phone_unique!==true||evidence.policy!=='phone_and_clear_partial_name'
    ||evidence.source_full_name!==fullName(source.fields)||!String(evidence.reason||'').trim()
    ||!String(evidence.reviewed_by||'').trim()||!/^[a-f0-9]{64}$/.test(evidence.review_sha256||'')) {
    throw Error('CONTACT_ALIAS_PARTIAL_REVIEW_INVALID');
  }
  const phone=phoneKey(source.fields.phone);
  const candidates=live.patients.filter(p=>phone&&[p.telefono_movil,p.telefono_secundario].some(v=>phoneKey(v)===phone));
  if(candidates.length!==1||Number(candidates[0].id_paciente)!==patientId)throw Error('CONTACT_ALIAS_PARTIAL_PHONE_NOT_UNIQUE');
  const patient=candidates[0],name=fullName({name:patient.nombre,surname:patient.apellidos});
  if(name!==evidence.patient_full_name)throw Error('CONTACT_ALIAS_PARTIAL_NAME_CHANGED');
  const tokens=name.split(' '),sourceTokens=evidence.source_full_name.split(' ');
  if(tokens.length>=3&&/^\p{L}$/u.test(tokens.at(-1)))tokens.pop();
  if(tokens.length<2||tokens[0].length<4||tokens.some(t=>!/^\p{L}{2,}$/u.test(t))
    ||tokens.length>=sourceTokens.length||tokens.some((t,i)=>t!==sourceTokens[i])) {
    throw Error('CONTACT_ALIAS_PARTIAL_NAME_NOT_CORROBORATED');
  }
  return patient;
}
function nativeAppointmentCandidate(source, patientId, live, evidence) {
  const history=evidence?.kind==='unique_phone_given_name_and_observed_history';
  if ((!history&&evidence?.kind !== 'unique_phone_given_name_and_native_first_visit')
    || evidence.source_contact_id !== source.source_contact_id || evidence.source_phone_unique !== true
    || ![66,72].includes(evidence.clinic_id) || !Number.isSafeInteger(evidence.native_appointment_id)
    || !Number.isSafeInteger(evidence.native_created_by) || evidence.native_created_by <= 0
    || !/^[1-9]\d*$/.test(evidence.live_appointment_id || '')
    || !/^[a-f0-9]{64}$/.test(evidence.comparison_sha256 || '')) throw Error('CONTACT_ALIAS_CORROBORATION_INVALID');
  const phone=phoneKey(source.fields.phone),name=norm(source.fields.name);
  const candidates=live.patients.filter(p=>phone && [p.telefono_movil,p.telefono_secundario].some(v=>phoneKey(v)===phone));
  // Unlike the full-name path, a shared phone is never accepted here, even
  // when only one of its owners has this given name. No fuzzy-name matching.
  if(name.length<3||candidates.length!==1||Number(candidates[0].id_paciente)!==patientId
    ||!corroboratedGivenName(source.fields,candidates[0])) throw Error('CONTACT_ALIAS_IDENTITY_NOT_UNIQUE');
  if(history&&(evidence.identity_only!==true||!/^[a-f0-9]{64}$/.test(evidence.source_appointment_sha256||''))) throw Error('CONTACT_ALIAS_CORROBORATION_INVALID');
  const sameStart=(live.native_appointments||[]).filter(a=>Number(a.paciente_id)===patientId
    &&instant(a.inicio)===instant(evidence.start_utc));
  const appointment=sameStart[0];
  if(sameStart.length!==1||Number(appointment.id_cita)!==evidence.native_appointment_id
    ||Number(appointment.clinica_id)!==evidence.clinic_id||Number(appointment.created_by)!==evidence.native_created_by
    ||appointment.source_system!=null||appointment.source_reference!=null||appointment.tipo_cita!=='primera_sin_trat'
    ||!['pendiente','info_enviada','info_confirmada','recordatorio_enviado','confirmada',
      ...(history?['completada','cancelada','no_asistio']:[])].includes(appointment.estado)) throw Error('CONTACT_ALIAS_NATIVE_FIRST_VISIT_NOT_CORROBORATED');
  return {patient:candidates[0],appointment_sha256:hash(appointment)};
}
function validateContactAlias(source, patientId, live, corroboration = null) {
  if(!source||!/^[1-9]\d*$/.test(source.source_contact_id)||!Number.isSafeInteger(patientId)||patientId<=0)throw Error('CONTACT_ALIAS_INPUT_INVALID');
  let patient,appointmentHash;
  if(corroboration?.kind==='operator_reviewed_unique_phone_name_prefix'){
    patient=partialIdentityCandidate(source,patientId,live,corroboration);
  }else if(corroboration?.kind==='user_confirmed_identity_pair'){
    patient=confirmedIdentityCandidate(source,patientId,live,corroboration);
  }else if(corroboration){
    const result=nativeAppointmentCandidate(source,patientId,live,corroboration);
    patient=result.patient;appointmentHash=result.appointment_sha256;
  }else{
    const candidates=corroboratedCandidates(source,live.patients);
    if(candidates.length!==1||Number(candidates[0].id_paciente)!==patientId)throw Error('CONTACT_ALIAS_IDENTITY_NOT_UNIQUE');
    patient=candidates[0];
  }
  if(![66,72].includes(Number(patient.clinica_id)))throw Error('CONTACT_ALIAS_PATIENT_SCOPE_INVALID');
  const sourceDocument=norm(source.fields.national_id).replace(/[ .-]/g,''),localDocument=norm(patient.dni).replace(/[ .-]/g,'');
  if(sourceDocument&&localDocument&&sourceDocument!==localDocument)throw Error('CONTACT_ALIAS_DOCUMENT_CONFLICT');
  const sourceBirth=dateOnly(source.fields.birth_date),localBirth=dateOnly(patient.fecha_nacimiento);
  if(sourceBirth&&localBirth&&sourceBirth!==localBirth)throw Error('CONTACT_ALIAS_BIRTH_DATE_CONFLICT');
  const linked=[...new Set(live.source_links.filter(r=>String(r.source_contact_id)===source.source_contact_id).map(r=>Number(r.paciente_id)))];
  if(linked.some(id=>id!==patientId))throw Error('CONTACT_ALIAS_SOURCE_ALREADY_OWNED');
  return {patient,already_linked:linked.includes(patientId),field_key:`cliniccloud_contact_alias_${source.source_contact_id}`,
    evidence:corroboration ? corroboration.kind : 'unique_full_name_and_phone_without_document_or_birth_conflict',
    ...(appointmentHash ? {native_appointment_sha256:appointmentHash} : {}),before_sha256:hash(patient)};
}
module.exports={phoneKey,corroboratedCandidates,corroboratedGivenName,validateContactAlias};
