'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {prepareConfirmedIdentity}=require('../../lib/cliniccloud-import/contact-alias-evidence');
const {validateContactAlias}=require('../../lib/cliniccloud-import/contact-aliases');
function fixture(){
 const source={source_contact_id:'8001',fields:{name:'Daniel',surname:'Ejemplo PV',phone:'+34 600000001',national_id:'',birth_date:''}};
 const link={source_contact_id:'8001',patient_id:9,confirmed_identity:true};
 const confirmation={version:1,source:'user_conversation',confirmation_reference:'test-message-only',answer:'Confirmo esa correspondencia',confirmed_at:new Date().toISOString(),pairs:[{source_contact_id:'8001',patient_id:9,source_full_name:'Daniel Ejemplo PV',patient_full_name:'Dani Captación'}]};
 const live={patients:[{id_paciente:9,clinica_id:72,nombre:'Dani',apellidos:'Captación',telefono_movil:'600000001',dni:null,fecha_nacimiento:null},{id_paciente:10,clinica_id:72,nombre:'Otra',apellidos:'Persona',telefono_movil:'600000001'}],source_links:[]};
 return {source,link,confirmation,live};
}
test('an explicit pair confirmation disambiguates a shared family phone without merging patients',()=>{
 const f=fixture(),before=JSON.stringify(f.live),e=prepareConfirmedIdentity(f);
 assert.throws(()=>validateContactAlias(f.source,9,f.live),/NOT_UNIQUE/);
 const result=validateContactAlias(f.source,9,f.live,e);
 assert.equal(result.patient.id_paciente,9);assert.equal(result.evidence,'user_confirmed_identity_pair');
 assert.equal(result.native_appointment_sha256,undefined);assert.equal(JSON.stringify(f.live),before);
 f.live.source_links.push({paciente_id:9,source_contact_id:'8001'});
 assert.equal(validateContactAlias(f.source,9,f.live,e).already_linked,true);
});
test('confirmation cannot be borrowed for another source, local patient or changed names/phone',()=>{
 for(const change of [
  f=>f.source.source_contact_id='8002',f=>f.link.patient_id=10,
  f=>f.source.fields.surname='Otra persona',f=>f.live.patients[0].apellidos='Changed',
  f=>f.live.patients[0].telefono_movil='600000002',
 ]){const f=fixture(),e=prepareConfirmedIdentity(f);change(f);assert.throws(()=>validateContactAlias(f.source,f.link.patient_id,f.live,e));}
});
test('duplicate exact local identities and conflicting clinical identifiers still stop confirmed pairs',()=>{
 for(const change of [
  f=>f.live.patients.push({...f.live.patients[0],id_paciente:11}),
  f=>{f.source.fields.national_id='111A';f.live.patients[0].dni='222B';},
  f=>{f.source.fields.birth_date='1990-01-01';f.live.patients[0].fecha_nacimiento='1991-01-01';},
  f=>f.live.source_links.push({paciente_id:10,source_contact_id:'8001'}),
 ]){const f=fixture(),e=prepareConfirmedIdentity(f);change(f);assert.throws(()=>validateContactAlias(f.source,9,f.live,e));}
});
test('even explicit confirmation requires matching phone and a meaningful given-name prefix',()=>{
 const f=fixture();f.live.patients[0].nombre='Alex';f.confirmation.pairs[0].patient_full_name='Alex Captación';
 const e=prepareConfirmedIdentity(f);assert.throws(()=>validateContactAlias(f.source,9,f.live,e),/NAME_NOT_CORROBORATED/);
});
test('missing, expired, future, duplicated or mixed confirmation is rejected before SQL',()=>{
 for(const change of [
  f=>f.link.confirmed_identity=false,f=>f.link.native_history_visit={},
  f=>f.confirmation.source='automatic_guess',f=>f.confirmation.answer='',
  f=>f.confirmation.confirmed_at=new Date(Date.now()-7200001).toISOString(),
  f=>f.confirmation.confirmed_at=new Date(Date.now()+60000).toISOString(),
  f=>f.confirmation.pairs.push({...f.confirmation.pairs[0]}),
  f=>f.confirmation.pairs[0].patient_id=10,
  f=>f.confirmation.pairs[0].source_full_name='Another patient',
 ]){const f=fixture();change(f);assert.throws(()=>prepareConfirmedIdentity(f));}
});
