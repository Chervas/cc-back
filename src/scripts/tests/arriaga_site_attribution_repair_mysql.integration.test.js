'use strict';
const assert=require('node:assert/strict'),S=require('sequelize');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
const {fixture,snapshot}=require('./fixtures/arriaga_site_repair.fixture');
withIsolatedCampaignMysql(async({sql,models:db,report})=>{
 const D=S.DataTypes;
 function define(name,fields){return db[name]=sql.define(name,Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,v&&v.type?{...v}:v])),{tableName:name,timestamps:false});}
 const id=()=>({type:D.INTEGER,primaryKey:true,autoIncrement:true}),integer=D.INTEGER,str=D.STRING(255),date=D.DATE;
 define('Clinicas',{id_clinica:id(),nombre_clinica:str,grupoClinicaId:integer});
 define('Pacientes',{id_paciente:id(),public_id:str,clinica_id:integer,numero_historia:str,historia_scope:str,updatedAt:date});
 define('PacienteClinicas',{id:id(),paciente_id:integer,clinica_id:integer,es_principal:integer,createdAt:date,updatedAt:date});
 define('ImportedClinicalCatalogs',{id:id(),clinic_id:integer,source_system:str,source_instance:str,bundle_sha256:str});
 define('PatientImportedIdentities',{id:id(),catalog_id:integer,patient_id:integer,clinic_id:integer,source_system:str,source_instance:str,source_patient_id:str,bundle_sha256:str,messages_hold:integer});
 define('PatientImportedSourceRecords',{id:id(),identity_id:integer,patient_id:integer,clinic_id:integer,source_key:str,source_database:str,source_table:str,category:str,record_date:D.DATEONLY,row_sha256:str,database_sha256:str,bundle_sha256:str,record_json:D.TEXT('medium'),imported_at:date});
 define('PatientOperationalEvents',{id:id(),patient_id:integer,clinic_id:integer,actor_user_id:integer,event_type:str,source:str,metadata:D.JSON,occurred_at:date,created_at:date});
 define('CitasPacientes',{id_cita:id(),paciente_id:integer,clinica_id:integer});
 define('Conversations',{id:id(),patient_id:integer,clinic_id:integer});
 await sql.sync({force:true});
 const {bundle,repair}=fixture(),seed=snapshot(bundle);
 await db.Clinicas.bulkCreate(seed.clinics);await db.Pacientes.bulkCreate(seed.patients);await db.PacienteClinicas.bulkCreate(seed.memberships);
 await db.ImportedClinicalCatalogs.bulkCreate(seed.catalogs);await db.PatientImportedIdentities.bulkCreate(seed.identities);await db.PatientImportedSourceRecords.bulkCreate(seed.records);
 await db.CitasPacientes.create({id_cita:1,paciente_id:90004,clinica_id:70});await db.Conversations.create({id:1,patient_id:90003,clinic_id:70});
 const raw=await sql.connectionManager.getConnection(),c=raw.promise();
 try{
  let before=await repair.capture(c,bundle),plan=repair.planRepair(bundle,before);
  assert.equal(plan.recordCorrections.length,3);assert.equal(plan.summary.primaryChanges,2);assert.equal(plan.summary.memberships70Retained,2);
  report.checks.push('canonical source and current SQL produce the unique-AJU cohort; native care blocks primary changes while historical messages only retain secondary membership');
  await assert.rejects(repair.applyRepair(c,{bundle,plan,beforeCommit:async()=>{throw Error('TESTONLY_ABORT_BEFORE_COMMIT');}}),/TESTONLY_ABORT_BEFORE_COMMIT/);
  assert.equal(repair.hash(await repair.capture(c,bundle)),repair.hash(before));
  report.checks.push('failure immediately before commit rolls back source rows, primary clinic, memberships and append-only audit together');
  await c.query('UPDATE PatientImportedSourceRecords SET record_json=CONCAT(record_json,?) WHERE id=2',[' ']);
  await assert.rejects(repair.applyRepair(c,{bundle,plan}));
  await c.query('UPDATE PatientImportedSourceRecords SET record_json=? WHERE id=2',[before.records.find(r=>r.id===2).record_json]);
  assert.equal(repair.hash(await repair.capture(c,bundle)),repair.hash(before));
  report.checks.push('source drift after review refuses all writes and does not overwrite the changed row');
  const result=await repair.applyRepair(c,{bundle,plan});assert.equal(result.status,'applied');
  const after=await repair.capture(c,bundle);assert.equal(after.events.length,3);assert.equal(after.identities.length,6);assert(after.identities.every(i=>i.messages_hold===1));
  assert.equal(after.patients.find(p=>p.id_paciente===90002).clinica_id,1);assert.equal(after.memberships.filter(m=>m.paciente_id===90002&&m.clinica_id===70).length,0);
  assert.equal(after.patients.find(p=>p.id_paciente===90003).clinica_id,1);assert.equal(after.memberships.find(m=>m.paciente_id===90003&&m.clinica_id===70).es_principal,0);
  assert.equal(after.patients.find(p=>p.id_paciente===90004).clinica_id,70);assert.equal(after.memberships.find(m=>m.paciente_id===90004&&m.clinica_id===70).es_principal,1);
  for(const r of plan.recordCorrections){const got=after.records.find(x=>x.id===r.sourceRecordId);assert.equal(got.row_sha256,r.before.row_sha256);assert.equal(got.source_key,r.before.source_key);assert.equal(got.record_date.toISOString?.().slice(0,10)||got.record_date,r.before.record_date.toISOString?.().slice(0,10)||r.before.record_date);assert.equal(got.clinic_id,1);}
  report.checks.push('materialized correction retains row IDs, original hashes, dates and identities; real Arenal care and historical conversation access remain intact');
  const replay=await repair.applyRepair(c,{bundle,plan});assert.equal(replay.status,'already_applied');assert.equal(replay.writes,0);assert.equal((await repair.capture(c,bundle)).events.length,3);
  const secondPlan=repair.planRepair(bundle,await repair.capture(c,bundle));assert.equal(secondPlan.recordCorrections.length,0);assert.equal(secondPlan.summary.primaryChanges,0);
  report.checks.push('same-plan replay and a fresh post-correction plan are idempotent, require matching audit and never duplicate corrections');
  await c.query('UPDATE PatientImportedIdentities SET messages_hold=0 WHERE id=1');
  await assert.rejects(repair.applyRepair(c,{bundle,plan}));
  assert.equal((await c.query('SELECT messages_hold FROM PatientImportedIdentities WHERE id=1'))[0][0].messages_hold,0);
  report.checks.push('post-commit changes to identity/HOLD authority fail verification without resetting the legitimate later state');
 }finally{await sql.connectionManager.releaseConnection(raw);}
}).catch(error=>{console.error(error);process.exitCode=1;});
