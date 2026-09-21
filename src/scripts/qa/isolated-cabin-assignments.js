#!/usr/bin/env node
'use strict';
// Real SQL, synthetic identities and rooms, one outer transaction rolled back.
const assert=require('node:assert/strict');
const {connectOperatorDatabase,databaseOptions}=require('../../lib/cliniccloud-import/operator-database');
const {sourceReference}=require('../../lib/cliniccloud-import/week-appointments');
const {operationFor,preparePackage,executeAssignments}=require('../../lib/cliniccloud-import/cabin-assignments');
const {createCabinStore}=require('../../lib/cliniccloud-import/cabin-assignments-store');
async function main(){
 assert.equal(process.env.QA_ISOLATED_CLINICAL_WRITES,'bs-startup-isolated-20260920');
 assert.equal(databaseOptions('dev').database,'clinicaclick_dev_isolated');
 const c=await connectOperatorDatabase('dev');
 try{
  await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');await c.beginTransaction();
  assert.equal((await c.query('SELECT id_clinica FROM Clinicas WHERE id_clinica IN (66,72)'))[0].length,0);
  assert.equal((await c.query('SELECT id_grupo FROM GruposClinicas WHERE id_grupo=29'))[0].length,0);
  await c.query("INSERT INTO GruposClinicas (id_grupo,nombre_grupo) VALUES (29,'QA ficticia transaccional cabinas')");
  await c.query("INSERT INTO Clinicas (id_clinica,nombre_clinica,grupoClinicaId) VALUES (66,'QA ficticia capilar',29),(72,'QA ficticia medical',29)");
  const rooms=[];
  for(const clinic of [72,66]){
   const [r]=await c.query("INSERT INTO Instalaciones (clinica_id,nombre,tipo,descripcion,capacidad,activo,created_at,updated_at) VALUES (?,'C7 · Ficticia','consulta','Mapa físico documental BS 2026. C7. QA sintética',1,0,UTC_TIMESTAMP(),UTC_TIMESTAMP())",[clinic]);
   rooms.push((await c.query('SELECT * FROM Instalaciones WHERE id=?',[r.insertId]))[0][0]);
  }
  await c.query('INSERT INTO InstallationPhysicalAliases (installation_id,canonical_installation_id,group_id,created_at,updated_at) VALUES (?,?,29,UTC_TIMESTAMP(),UTC_TIMESTAMP())',[rooms[1].id,rooms[0].id]);
  const fixtures=[];
  for(let index=0;index<2;index++){
   const room=rooms[index],contact=String(99001+index);
   const [p]=await c.query("INSERT INTO Pacientes (public_id,nombre,apellidos,clinica_id) VALUES (?,'Ficticio','QA transaccional cabina',?)",[`pac_cabin_qa_20260921_${index}`,room.clinica_id]);
   await c.query("INSERT INTO PatientCustomFields (paciente_id,clinica_id,field_key,value,source,source_column,created_at,updated_at) VALUES (?,?,'cliniccloud_source_contact_id',?,'cliniccloud','idContacto',UTC_TIMESTAMP(),UTC_TIMESTAMP())",[p.insertId,room.clinica_id,contact]);
   const source={source_contact_id:contact,start_local:'2026-09-22T12:00:00',end_local:'2026-09-22T12:30:00',start_utc:'2026-09-22T10:00:00.000Z',end_utc:'2026-09-22T10:30:00.000Z',agenda_key:'QA',service_key:'Consulta ficticia',status:'pendiente',details:'Nota ficticia'};
   const baseline=Object.fromEntries(['source_contact_id','start_local','end_local','agenda_key','service_key','status'].map(k=>[k,source[k]]));
   const metadata={source_contact_id:contact,cliniccloud_delta:{source:baseline},notification_suppression:{appointment_details:true,day_before:true,same_day:true},cliniccloud_reconciliation:{automation_policy:'hold'}};
   const [a]=await c.query("INSERT INTO CitasPacientes (clinica_id,paciente_id,nota,estado,inicio,fin,source_system,source_reference,import_metadata,created_at,updated_at) VALUES (?,?,'Nota ficticia','pendiente','2026-09-22 10:00:00','2026-09-22 10:30:00','cliniccloud',?,?,UTC_TIMESTAMP(),UTC_TIMESTAMP())",[room.clinica_id,p.insertId,sourceReference(source),JSON.stringify(metadata)]);
   const before=(await c.query('SELECT * FROM CitasPacientes WHERE id_cita=?',[a.insertId]))[0][0];
   const operation=operationFor({before,source,cabin:room,catalogRow:{clinic_id:room.clinica_id,kind:'treatment',installation_resolution:[{confirmed_id:room.id}],source_catalog_key:'a'.repeat(64),provenance:{sheet:'QA',source_row:1}},reason:'Synthetic QA placement'});
   fixtures.push(preparePackage({operations:[operation],catalogPlanHash:'c'.repeat(64),sourcePlanHash:'d'.repeat(64),reviewedBy:'QA operator'}));
  }
  const adapter={query:(sql,args)=>sql==='SET TRANSACTION ISOLATION LEVEL READ COMMITTED'?Promise.resolve([[]]):c.query(sql,args),beginTransaction:()=>c.query('SAVEPOINT qa_cabin'),commit:()=>c.query('RELEASE SAVEPOINT qa_cabin'),rollback:()=>c.query('ROLLBACK TO SAVEPOINT qa_cabin')};
  const store=await createCabinStore(adapter,{readOnly:false}),journal={append:async()=>{}};
  assert.equal((await executeAssignments({pkg:fixtures[0],store,journal})).assigned,1);
  assert.equal((await executeAssignments({pkg:fixtures[0],store,journal})).replayed,1);
  assert.equal((await executeAssignments({pkg:fixtures[1],store,journal})).deferred,1);
  await c.query("UPDATE CitasPacientes SET nota='Later human edit' WHERE id_cita=?",[fixtures[1].operations[0].appointment_id]);
  await assert.rejects(executeAssignments({pkg:fixtures[1],store,journal}),/APPOINTMENT_CHANGED/);
  const [saved]=await c.query('SELECT instalacion_id,import_metadata FROM CitasPacientes WHERE id_cita=?',[fixtures[0].operations[0].appointment_id]);
  assert.equal(saved[0].instalacion_id,rooms[0].id);assert.equal(saved[0].import_metadata.notification_suppression.day_before,true);
  console.log(JSON.stringify({ok:true,sql_assignments_verified:1,sql_replay_verified:true,shared_cabin_overlap_deferred:true,later_edit_protected:true,all_fixtures_rolled_back:true}));
 }finally{await c.rollback();await c.end();}
}
main().catch(e=>{console.error(JSON.stringify({ok:false,error:e.message}));process.exitCode=1;});
