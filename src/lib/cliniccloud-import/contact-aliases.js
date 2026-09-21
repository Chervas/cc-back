'use strict';
const { hash, norm, dateOnly } = require('./adapter');
const phoneKey = value => {
  const digits=String(value||'').replace(/\D/g,'');
  const key=/^0034\d{9}$/.test(digits)?digits.slice(4):/^34\d{9}$/.test(digits)?digits.slice(2):digits;
  return /^\d{9,15}$/.test(key)?key:'';
};
const fullName = fields => norm(`${fields.name||''} ${fields.surname||''}`);
function corroboratedCandidates(source, patients) {
  const name=fullName(source.fields),phone=phoneKey(source.fields.phone);
  if(!phone||name.split(' ').length<2||name.length<8)return [];
  return patients.filter(p=>fullName({name:p.nombre,surname:p.apellidos})===name
    && [p.telefono_movil,p.telefono_secundario].some(v=>phoneKey(v)===phone));
}
function validateContactAlias(source, patientId, live) {
  if(!source||!/^[1-9]\d*$/.test(source.source_contact_id)||!Number.isSafeInteger(patientId)||patientId<=0)throw Error('CONTACT_ALIAS_INPUT_INVALID');
  const candidates=corroboratedCandidates(source,live.patients);
  if(candidates.length!==1||Number(candidates[0].id_paciente)!==patientId)throw Error('CONTACT_ALIAS_IDENTITY_NOT_UNIQUE');
  const patient=candidates[0];
  if(![66,72].includes(Number(patient.clinica_id)))throw Error('CONTACT_ALIAS_PATIENT_SCOPE_INVALID');
  const sourceDocument=norm(source.fields.national_id).replace(/[ .-]/g,''),localDocument=norm(patient.dni).replace(/[ .-]/g,'');
  if(sourceDocument&&localDocument&&sourceDocument!==localDocument)throw Error('CONTACT_ALIAS_DOCUMENT_CONFLICT');
  const sourceBirth=dateOnly(source.fields.birth_date),localBirth=dateOnly(patient.fecha_nacimiento);
  if(sourceBirth&&localBirth&&sourceBirth!==localBirth)throw Error('CONTACT_ALIAS_BIRTH_DATE_CONFLICT');
  const linked=[...new Set(live.source_links.filter(r=>String(r.source_contact_id)===source.source_contact_id).map(r=>Number(r.paciente_id)))];
  if(linked.some(id=>id!==patientId))throw Error('CONTACT_ALIAS_SOURCE_ALREADY_OWNED');
  return {patient,already_linked:linked.includes(patientId),field_key:`cliniccloud_contact_alias_${source.source_contact_id}`,
    evidence:'unique_full_name_and_phone_without_document_or_birth_conflict',before_sha256:hash(patient)};
}
module.exports={phoneKey,corroboratedCandidates,validateContactAlias};
