'use strict';
const assert=require('node:assert/strict'),{DataTypes:D,Sequelize}=require('sequelize');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
const cut=require('../eurodent-archive-schema-release');
withIsolatedCampaignMysql(async({sql,report})=>{
  const q=sql.getQueryInterface();
  for(const table of cut.PARENTS){
    if(table==='SequelizeMeta'){await q.createTable(table,{name:{type:D.STRING,primaryKey:true}});continue;}
    const key=table==='Clinicas'?'id_clinica':table==='Pacientes'?'id_paciente':table==='Usuarios'?'id_usuario':'id';
    await q.createTable(table,{[key]:{type:D.INTEGER,primaryKey:true}});
  }
  await q.createTable('UnrelatedQA',{id:{type:D.INTEGER,primaryKey:true}});
  const [[identity]]=await sql.query('SELECT DATABASE() database_name,CURRENT_USER() database_user,@@hostname server_name,@@port server_port');
  const before=await cut.captureMetadata(sql,identity);assert.deepEqual(cut.pending(before),cut.MIGRATIONS);
  await require('../../../migrations/'+cut.MIGRATIONS[0]).up(q,Sequelize);
  const unregistered=await cut.captureMetadata(sql,identity);
  cut.verifyAfter(before,unregistered,cut.MIGRATIONS,false);
  assert.throws(()=>cut.pending(unregistered),/UNREGISTERED_TABLES/);
  await sql.query('INSERT INTO SequelizeMeta(name) VALUES(:name)',{replacements:{name:cut.MIGRATIONS[0]}});
  const after=await cut.captureMetadata(sql,identity);
  cut.verifyAfter(before,after,cut.MIGRATIONS);assert.deepEqual(cut.pending(after),[]);
  assert.equal(after.tables.filter(t=>cut.NEW_TABLES.includes(t.TABLE_NAME)).length,cut.NEW_TABLES.length);
  report.checks.push('Actual isolated MySQL migration: complete column/default/index/FK checks, ownership composite key, all prior database metadata and registry preserved. Partial/unregistered cohort rejected.');

  for(const mutate of [
    state=>state.columns.find(c=>c.TABLE_NAME==='PatientImportedSourceRecords'&&c.COLUMN_NAME==='record_json').COLUMN_TYPE='text',
    state=>state.columns.find(c=>c.TABLE_NAME==='PatientImportedIdentities'&&c.COLUMN_NAME==='messages_hold').COLUMN_DEFAULT='0',
    state=>{const row=state.foreignKeys.find(f=>f.CONSTRAINT_NAME==='patient_imported_record_identity_owner_fk');row.REFERENCED_COLUMN_NAME='wrong';},
    state=>state.indexes.find(i=>i.INDEX_NAME==='patient_imported_identity_source_unique').NON_UNIQUE=1,
  ]){
    const changed=structuredClone(after);mutate(changed);assert.throws(()=>cut.verifySchema(changed),/EURODENT_SCHEMA_/);
  }
  const changed=structuredClone(after);changed.columns.find(c=>c.TABLE_NAME==='UnrelatedQA').COLUMN_TYPE='bigint';
  assert.throws(()=>cut.verifyAfter(before,changed,cut.MIGRATIONS),/EXISTING_METADATA_CHANGED/);
  const info={commit:'a'.repeat(40),migrations:cut.MIGRATIONS.map(name=>({name,sha256:'b'.repeat(64)}))};
  const plan={version:cut.VERSION,target:'crm',source_commit:info.commit,migrations:info.migrations,pending:cut.MIGRATIONS,before:{...before,database_name:'clinicaclick'},generated_at:new Date().toISOString()};
  assert.doesNotThrow(()=>cut.validatePlan(plan,info,'crm',plan.before));
  assert.throws(()=>cut.validatePlan({...plan,source_commit:'changed'},info,'crm'),/PLAN_INVALID/);
  assert.throws(()=>cut.validatePlan(plan,info,'crm',{...plan.before,indexes:[]}),/PLAN_DRIFT/);
  report.checks.push('Meaningful negative checks reject reduced archive capacity, disabled HOLD default, cross-owner FK drift, lost source uniqueness, unrelated table DDL and stale plan/source metadata.');
}).catch(error=>{console.error(error);process.exitCode=1;});
