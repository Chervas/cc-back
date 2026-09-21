'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {phoneKey,validateContactAlias}=require('../../lib/cliniccloud-import/contact-aliases');
const source=()=>({source_contact_id:'456',fields:{name:'Persona',surname:'Ficticia Ejemplo',phone:'+34 600 000 001',national_id:'',birth_date:''}});
const patient=()=>({id_paciente:9,clinica_id:72,nombre:'Persona',apellidos:'Ficticia Ejemplo',telefono_movil:'600000001',telefono_secundario:null,dni:null,fecha_nacimiento:null});
const live=()=>({patients:[patient()],source_links:[{paciente_id:9,source_contact_id:'123'}]});
test('new external alias preserves an older identity, without merging or replacing names',()=>{
 const s=source(),l=live(),before=JSON.stringify(l);const result=validateContactAlias(s,9,l);
 assert.equal(result.already_linked,false);assert.equal(result.field_key,'cliniccloud_contact_alias_456');assert.equal(JSON.stringify(l),before);
});
test('phone normalization never truncates arbitrary international numbers',()=>{
 assert.equal(phoneKey('0034 600 000 001'),'600000001');assert.equal(phoneKey('+1 600 000 001'),'1600000001');
 assert.notEqual(phoneKey('+1 600 000 001'),phoneKey('600000001'));
});
test('one shared phone with another name is not a match and does not invalidate a unique corroborated name',()=>{
 const l=live();l.patients.push({...patient(),id_paciente:10,nombre:'Otra persona'});assert.equal(validateContactAlias(source(),9,l).patient.id_paciente,9);
 assert.throws(()=>validateContactAlias(source(),10,l),/NOT_UNIQUE/);
});
test('same full name and phone in two local files stops instead of choosing one',()=>{
 const l=live();l.patients.push({...patient(),id_paciente:10});assert.throws(()=>validateContactAlias(source(),9,l),/NOT_UNIQUE/);
});
test('matching just phone or just name does not establish patient identity',()=>{
 const l=live();l.patients[0].apellidos='Otro apellido';assert.throws(()=>validateContactAlias(source(),9,l),/NOT_UNIQUE/);
 const l2=live();l2.patients[0].telefono_movil='600000002';assert.throws(()=>validateContactAlias(source(),9,l2),/NOT_UNIQUE/);
});
test('document or birth date contradiction blocks an otherwise matching identity',()=>{
 const s=source(),l=live();s.fields.national_id='123A';l.patients[0].dni='987B';assert.throws(()=>validateContactAlias(s,9,l),/DOCUMENT_CONFLICT/);
 s.fields.national_id='';s.fields.birth_date='1980-01-01';l.patients[0].fecha_nacimiento='1981-01-01';assert.throws(()=>validateContactAlias(s,9,l),/BIRTH_DATE_CONFLICT/);
});
test('an external ID belonging to another local file cannot be reassigned',()=>{
 const l=live();l.source_links.push({paciente_id:10,source_contact_id:'456'});assert.throws(()=>validateContactAlias(source(),9,l),/ALREADY_OWNED/);
});
test('existing same alias is recognized for replay, including repeated provenance rows',()=>{
 const l=live();l.source_links.push({paciente_id:9,source_contact_id:'456'},{paciente_id:9,source_contact_id:'456'});assert.equal(validateContactAlias(source(),9,l).already_linked,true);
});

function nativeFixture(){
 const s=source(),l=live();s.fields.surname='Nombre abreviado de origen';l.patients[0].apellidos='Apellido de recepción';
 const e={kind:'unique_phone_given_name_and_native_first_visit',source_contact_id:s.source_contact_id,source_phone_unique:true,
  clinic_id:72,native_appointment_id:71,native_created_by:44,start_utc:'2026-09-22T15:45:00.000Z',
  live_appointment_id:'8765',comparison_sha256:'a'.repeat(64)};
 l.native_appointments=[{id_cita:71,paciente_id:9,clinica_id:72,inicio:'2026-09-22 15:45:00',fin:'2026-09-22 15:50:00',
  created_by:44,estado:'info_confirmada',tipo_cita:'primera_sin_trat',source_system:null,source_reference:null}];
 return{s,l,e};
}
test('different intake surname needs explicit exact native-first-visit corroboration; only alias is returned',()=>{
 const {s,l,e}=nativeFixture(),before=JSON.stringify(l);
 assert.throws(()=>validateContactAlias(s,9,l),/NOT_UNIQUE/);
 const result=validateContactAlias(s,9,l,e);
 assert.equal(result.evidence,e.kind);assert.match(result.native_appointment_sha256,/^[a-f0-9]{64}$/);
 assert.equal(JSON.stringify(l),before);
});
test('corroborated visit cannot resolve shared source or local phones, fuzzy given names or another patient',()=>{
 for(const change of [
  ({e})=>e.source_phone_unique=false,
  ({l})=>l.patients.push({...patient(),id_paciente:10,nombre:'Otro nombre'}),
  ({l})=>l.patients[0].nombre='Pers',
  ({l})=>l.native_appointments[0].paciente_id=10,
 ]){const f=nativeFixture();change(f);assert.throws(()=>validateContactAlias(f.s,9,f.l,f.e));}
});
test('native evidence rejects changed time, clinic, creator, type, status, source or ambiguous same start',()=>{
 for(const patch of [{inicio:'2026-09-22 15:46:00'},{clinica_id:66},{created_by:45},{tipo_cita:'continuacion'},
  {estado:'cancelada'},{estado:'completada'},{estado:'unknown'},{source_system:'cliniccloud'},{source_reference:'import:1'},{id_cita:72}]){
  const {s,l,e}=nativeFixture();Object.assign(l.native_appointments[0],patch);
  assert.throws(()=>validateContactAlias(s,9,l,e),/NATIVE_FIRST_VISIT_NOT_CORROBORATED/);
 }
 const {s,l,e}=nativeFixture();l.native_appointments.push({...l.native_appointments[0],id_cita:72});
 assert.throws(()=>validateContactAlias(s,9,l,e),/NATIVE_FIRST_VISIT_NOT_CORROBORATED/);
});
test('native evidence never overrides document, birth or external ownership contradictions',()=>{
 for(const change of [
  ({s,l})=>{s.fields.national_id='123';l.patients[0].dni='456';},
  ({s,l})=>{s.fields.birth_date='1990-01-01';l.patients[0].fecha_nacimiento='1991-01-01';},
  ({l})=>l.source_links.push({paciente_id:10,source_contact_id:'456'}),
 ]){const f=nativeFixture();change(f);assert.throws(()=>validateContactAlias(f.s,9,f.l,f.e),/CONFLICT|ALREADY_OWNED/);}
});
test('native evidence is stable on replay but records any appointment change for CAS',()=>{
 const {s,l,e}=nativeFixture(),before=validateContactAlias(s,9,l,e);
 l.source_links.push({paciente_id:9,source_contact_id:'456'});
 assert.equal(validateContactAlias(s,9,l,e).already_linked,true);
 assert.equal(validateContactAlias(s,9,l,e).native_appointment_sha256,before.native_appointment_sha256);
 l.native_appointments[0].fin='2026-09-22 16:00:00';
 assert.notEqual(validateContactAlias(s,9,l,e).native_appointment_sha256,before.native_appointment_sha256);
});
test('a reviewed observed-history identity can use a completed or cancelled first visit without changing its state',()=>{
 for(const status of ['completada','cancelada','no_asistio']){
  const {s,l,e}=nativeFixture();l.native_appointments[0].estado=status;
  assert.throws(()=>validateContactAlias(s,9,l,e),/NOT_CORROBORATED/);
  Object.assign(e,{kind:'unique_phone_given_name_and_observed_history',identity_only:true,source_appointment_sha256:'f'.repeat(64)});
  const before=JSON.stringify(l);assert.equal(validateContactAlias(s,9,l,e).patient.id_paciente,9);assert.equal(JSON.stringify(l),before);
  e.identity_only=false;assert.throws(()=>validateContactAlias(s,9,l,e),/CORROBORATION_INVALID/);
 }
});
test('an exact compound given-name boundary shift needs the same unique-phone and native-visit proof',()=>{
 const {s,l,e}=nativeFixture();s.fields.name='Ana María';s.fields.surname='Ejemplo';
 l.patients[0].nombre='Ana';l.patients[0].apellidos='Maria Ejemplo Captación';
 assert.throws(()=>validateContactAlias(s,9,l),/NOT_UNIQUE/);
 const before=JSON.stringify(l);assert.equal(validateContactAlias(s,9,l,e).patient.id_paciente,9);
 assert.equal(JSON.stringify(l),before);
 l.patients.push({...patient(),id_paciente:10});
 assert.throws(()=>validateContactAlias(s,9,l,e),/NOT_UNIQUE/);
});
test('compound-name handling does not permit fuzzy names, initials, omitted tokens or changed native evidence',()=>{
 for(const [first,last] of [['Ana','M Ejemplo'],['Anita','Maria Ejemplo'],['Ana','Marina Ejemplo'],['Maria','Ana Ejemplo'],['Ana','Ejemplo']]){
  const {s,l,e}=nativeFixture();s.fields.name='Ana María';Object.assign(l.patients[0],{nombre:first,apellidos:last});
  assert.throws(()=>validateContactAlias(s,9,l,e),/NOT_UNIQUE/);
 }
 const {s,l,e}=nativeFixture();s.fields.name='Ana María';Object.assign(l.patients[0],{nombre:'Ana',apellidos:'Maria Ejemplo'});
 l.native_appointments[0].inicio='2026-09-22 15:46:00';
 assert.throws(()=>validateContactAlias(s,9,l,e),/NOT_CORROBORATED/);
 const initial=nativeFixture();initial.s.fields.name='A B';Object.assign(initial.l.patients[0],{nombre:'A',apellidos:'B Ejemplo'});
 assert.throws(()=>validateContactAlias(initial.s,9,initial.l,initial.e),/NOT_UNIQUE/);
});
