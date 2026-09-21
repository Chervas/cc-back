'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validateRoster,aliasEmail,assertActivationIdentity,activateEntry}=require('../../lib/cliniccloud-import/staff-activation');
const entry={id:120,expected_name:'QA profesional',name:'QA profesional',alias:'qa-doctor',clinics:[66],role:'Doctores'};
const plan=()=>({version:1,target:'crm',group_id:29,mailbox:'owner@example.com',staff:[{...entry}]});
test('bounded roster, individual aliases, no arbitrary roles or clinics',()=>{
  assert.equal(validateRoster(plan()).staff.length,1);assert.equal(aliasEmail('owner@example.com','doctor'),'owner+bs-doctor@example.com');
  for(const patch of [{id:1},{clinics:[99]},{role:'propietario'},{alias:'bad@target.example'},{clinics:[66,66]}]){const p=plan();Object.assign(p.staff[0],patch);assert.throws(()=>validateRoster(p));}
  const p=plan();p.staff.push({...entry,id:121});assert.throws(()=>validateRoster(p));
});
test('does not activate an existing real account or change an identity outside BS',()=>{
  const user={id_usuario:120,nombre:entry.expected_name,es_provisional:1,estado_cuenta:'activo'};
  const memberships=[{id_clinica:66,rol_clinica:'personaldeclinica'}];
  assertActivationIdentity(entry,user,memberships,[66,72]);
  for(const patch of [{es_provisional:0},{nombre:'different'},{estado_cuenta:'disabled'}])assert.throws(()=>assertActivationIdentity(entry,{...user,...patch},memberships,[66,72]));
  assert.throws(()=>assertActivationIdentity(entry,user,[...memberships,{id_clinica:99,rol_clinica:'propietario'}],[66,72]));
});
test('SQL activation keeps the same professional identity and previous ownership, never issues a login token or writes a schedule',async()=>{
  const calls=[],values={...entry,email:'owner+bs-doctor@example.com',password_hash:'testhash'};
  const c={query:async(sql,args)=>{calls.push({sql,args});if(sql.startsWith('SELECT * FROM Usuarios'))return [[{id_usuario:120,nombre:entry.expected_name,es_provisional:1,estado_cuenta:'activo'}]];
    if(sql.startsWith('SELECT * FROM UsuarioClinica'))return [[{id_usuario:120,id_clinica:66,rol_clinica:'propietario',subrol_clinica:null}]];
    if(sql.startsWith('SELECT * FROM DoctorClinicas'))return [[{id:9}]];
    if(sql.startsWith('SELECT id_usuario'))return [[{id_usuario:120,email_usuario:values.email,password_usuario:values.password_hash,es_provisional:0,estado_cuenta:'activo'}]];
    return [{affectedRows:1}];}};
  const result=await activateEntry(c,values,{actorId:1,allowedClinics:[66,72]});assert.equal(result.id,120);
  assert.equal(calls.find(c=>c.sql.startsWith('UPDATE UsuarioClinica')).args[0],'propietario');
  assert(!calls.some(c=>/AccessSession|AuthEmail|DoctorHorario|CitaPaciente/.test(c.sql)));
});
