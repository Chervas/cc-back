#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {connectOperatorDatabase}=require('../../lib/cliniccloud-import/operator-database');
const {activateEntry}=require('../../lib/cliniccloud-import/staff-activation');
async function main(){
  assert.equal(process.env.QA_ISOLATED_CLINICAL_WRITES,'bs-startup-isolated-20260920');
  const c=await connectOperatorDatabase('dev'),marker='qa-staff-'+randomUUID();
  try{
    const [[database]]=await c.query('SELECT DATABASE() AS name');assert.equal(database.name,'clinicaclick_dev_isolated');
    const [[clinic]]=await c.query('SELECT nombre_clinica FROM Clinicas WHERE id_clinica=1');assert.equal(clinic.nombre_clinica,'Clinica ficticia DEV');
    await c.beginTransaction();
    const [created]=await c.query("INSERT INTO Usuarios(nombre,email_usuario,es_provisional,estado_cuenta,createdAt,updatedAt) VALUES (?,?,1,'activo',UTC_TIMESTAMP(),UTC_TIMESTAMP())",[marker,marker+'@example.invalid']);
    const id=Number(created.insertId);
    await c.query("INSERT INTO UsuarioClinica(id_usuario,id_clinica,rol_clinica,subrol_clinica,estado_invitacion,createdAt,updatedAt) VALUES (?,1,'personaldeclinica','Doctores','pendiente',UTC_TIMESTAMP(),UTC_TIMESTAMP())",[id]);
    const entry={id,name:marker,expected_name:marker,email:marker+'+enabled@example.invalid',password_hash:await require('bcryptjs').hash('QA synthetic password only',12),role:'Doctores',clinics:[1]};
    const result=await activateEntry(c,entry,{actorId:1,allowedClinics:[1]});assert.equal(result.id,id);
    const [[member]]=await c.query('SELECT estado_invitacion,subrol_clinica FROM UsuarioClinica WHERE id_usuario=? AND id_clinica=1',[id]);assert.equal(member.estado_invitacion,'aceptada');assert.equal(member.subrol_clinica,'Doctores');
    const [[professional]]=await c.query('SELECT activo,recibe_citas FROM DoctorClinicas WHERE doctor_id=? AND clinica_id=1',[id]);assert.equal(professional.activo,1);assert.equal(professional.recibe_citas,1);
    await assert.rejects(activateEntry(c,entry,{actorId:1,allowedClinics:[1]}),{message:'STAFF_NOT_MATCHING_PROVISIONAL'});
    const fresh=await activateEntry(c,{...entry,id:null,name:marker+' new',email:marker+'+new@example.invalid'},{actorId:1,allowedClinics:[1]});assert(fresh.id!==id);
    await c.rollback();const [[after]]=await c.query('SELECT COUNT(*) n FROM Usuarios WHERE nombre LIKE ?',[marker+'%']);assert.equal(after.n,0);
    console.log(JSON.stringify({status:'passed',database:'isolated-dev',persistedRows:0,checks:['activate-provisional-same-id','accepted-membership','bookable-professional','active-account-protected','new-user','full-rollback']}));
  }finally{await c.rollback().catch(()=>{});await c.end();}
}
main().catch(e=>{console.error(e.code||e.name,e.name==='AssertionError'?e.message:'Review isolated staff activation');process.exitCode=1;});
