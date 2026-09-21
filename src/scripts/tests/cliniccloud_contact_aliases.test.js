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
