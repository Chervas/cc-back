#!/usr/bin/env node
'use strict';
// Explicit additive release for the reviewed clinical/Nutrition cut, from dev.
// No application bootstrap, data copying, backfill, worker or provider execution.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {Sequelize}=require('sequelize');
const {hash}=require('../lib/cliniccloud-import/adapter');
const {databaseOptions}=require('../lib/cliniccloud-import/operator-database');
const {parseArgs,writePrivateJson}=require('../lib/cliniccloud-import/io');
const {privateJson}=require('./cliniccloud-import-appointments-apply');
const {validateBackup}=require('./cliniccloud-import-contacts-apply');
const {newJournal}=require('./program-commercial-schema-release');
const foundation=require('./clinical-workspace-schema-release');
const ROOT='/home/ubuntu/wt/back-dev',VERSION='clinical-nutrition-schema/1';
const MIGRATIONS=Object.freeze([...foundation.MIGRATIONS,'20261021021500-nutrition-episode-reference.js','20261021090000-clinical-episode-templates.js']);
const TEMPLATE_TABLES=['ClinicalEpisodeTemplates','ClinicalEpisodeTemplateVersions'];
const NEW_TABLES=[...foundation.NEW_TABLES,...TEMPLATE_TABLES];
const PARENTS=[...foundation.PARENTS,'PatientNutritionMeasurements'];
const TABLES=[...PARENTS,...NEW_TABLES];
const NEW_COLUMNS={AppointmentClinicalReports:['title','occurred_at','template_key','rich_document','material_refs','creation_key','creation_payload_hash','template_snapshot'],AppointmentClinicalReportRevisions:['mutation_key','request_hash'],PatientNutritionMeasurements:['episode_id']};
const NEW_INDEXES=['clinical_episodes_creation_uq','clinical_episodes_patient_date_idx','clinical_episode_revision_mutation_uq','nutrition_measurement_episode'];
const NUTRITION_FK_INDEX='PatientNutritionMeasurements_episode_id_foreign_idx';
const fail=code=>{throw Error(code);};
function source(clean=false){
 if(process.cwd()!==ROOT||path.resolve(__dirname,'../..')!==ROOT||execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim()!=='dev')fail('CLINICAL_RELEASE_DEV_SOURCE_REQUIRED');
 const dirty=Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim());
 if(clean&&dirty)fail('CLINICAL_RELEASE_COMMITTED_SOURCE_REQUIRED');
 return{commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty,migrations:MIGRATIONS.map(name=>({name,sha256:hash(fs.readFileSync(path.join(ROOT,'migrations',name)))}))};
}
function assertTarget(target,config){
 if(!['dev','crm'].includes(target)||!['127.0.0.1','localhost','::1'].includes(config.host)||config.port!==3306
   ||config.database!==(target==='dev'?'clinicaclick_dev_isolated':'clinicaclick'))fail('CLINICAL_RELEASE_LOCAL_EXPLICIT_TARGET_REQUIRED');
}
async function capture(sql,target,config){
 const query=async(text,replacements)=>(await sql.query(text,{replacements}))[0];
 const [identity]=await query('SELECT DATABASE() database_name,CURRENT_USER() database_user,@@hostname server_name,@@port server_port');
 if(identity.database_name!==config.database||String(identity.database_user).split('@')[0]!==config.user||Number(identity.server_port)!==3306)fail('CLINICAL_RELEASE_DATABASE_IDENTITY_INVALID');
 if(target==='dev'){
  const [anchor]=await query("SELECT EXISTS(SELECT 1 FROM Clinicas WHERE id_clinica=1 AND nombre_clinica='Clinica ficticia DEV') ok");
  if(!Number(anchor.ok))fail('CLINICAL_RELEASE_FICTIONAL_ANCHOR_REQUIRED');
 }
 const tables=await query('SELECT TABLE_NAME,ENGINE,TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (:tables) ORDER BY TABLE_NAME',{tables:TABLES});
 if(PARENTS.some(name=>!tables.some(row=>row.TABLE_NAME===name&&row.ENGINE==='InnoDB')))fail('CLINICAL_RELEASE_PREREQUISITE_MISSING');
 const columns=await query('SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA,CHARACTER_SET_NAME,COLLATION_NAME,GENERATION_EXPRESSION,ORDINAL_POSITION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (:tables) ORDER BY TABLE_NAME,ORDINAL_POSITION',{tables:TABLES});
 const indexes=await query('SELECT TABLE_NAME,INDEX_NAME,NON_UNIQUE,SEQ_IN_INDEX,COLUMN_NAME,SUB_PART,INDEX_TYPE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (:tables) ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX',{tables:TABLES});
 const foreignKeys=await query('SELECT K.TABLE_NAME,K.COLUMN_NAME,K.CONSTRAINT_NAME,K.REFERENCED_TABLE_NAME,K.REFERENCED_COLUMN_NAME,R.UPDATE_RULE,R.DELETE_RULE FROM information_schema.KEY_COLUMN_USAGE K JOIN information_schema.REFERENTIAL_CONSTRAINTS R ON R.CONSTRAINT_SCHEMA=K.CONSTRAINT_SCHEMA AND R.CONSTRAINT_NAME=K.CONSTRAINT_NAME AND R.TABLE_NAME=K.TABLE_NAME WHERE K.TABLE_SCHEMA=DATABASE() AND K.TABLE_NAME IN (:tables) AND K.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY K.TABLE_NAME,K.CONSTRAINT_NAME,K.ORDINAL_POSITION',{tables:TABLES});
 const triggers=await query('SELECT EVENT_OBJECT_TABLE,TRIGGER_NAME,ACTION_TIMING,EVENT_MANIPULATION,ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE IN (:tables) ORDER BY EVENT_OBJECT_TABLE,TRIGGER_NAME',{tables:TABLES});
 if(triggers.some(row=>['SequelizeMeta',...NEW_TABLES].includes(row.EVENT_OBJECT_TABLE)))fail('CLINICAL_RELEASE_UNEXPECTED_TRIGGER');
 const metadata=await query('SELECT name FROM SequelizeMeta ORDER BY name');
 return{database_name:identity.database_name,identity_sha256:hash(identity),server_sha256:hash(identity.server_name),tables,columns,indexes,foreignKeys,triggers,metadata_names:metadata.map(row=>row.name)};
}
const col=(s,t,n)=>s.columns.find(c=>c.TABLE_NAME===t&&c.COLUMN_NAME===n);
function verifyTemplates(s,registered=true){
 const expected={ClinicalEpisodeTemplates:['id','public_id','clinic_id','current_version','creation_key','creation_hash','created_by','updated_by','created_at','updated_at'],ClinicalEpisodeTemplateVersions:['id','template_id','version_number','snapshot','sha256','actor_id','created_at']};
 for(const [t,cols]of Object.entries(expected))if(!s.tables.some(r=>r.TABLE_NAME===t&&r.ENGINE==='InnoDB')||hash(s.columns.filter(c=>c.TABLE_NAME===t).map(c=>c.COLUMN_NAME).sort())!==hash([...cols].sort()))fail('CLINICAL_RELEASE_TEMPLATE_COLUMNS_INVALID');
 for(const [t,n,type]of [['AppointmentClinicalReports','template_snapshot','json'],['ClinicalEpisodeTemplateVersions','snapshot','json'],['ClinicalEpisodeTemplates','current_version','int unsigned'],['ClinicalEpisodeTemplateVersions','template_id','bigint unsigned']])if(col(s,t,n)?.COLUMN_TYPE!==type)fail('CLINICAL_RELEASE_TEMPLATE_TYPES_INVALID');
 if(col(s,'AppointmentClinicalReports','template_snapshot')?.IS_NULLABLE!=='YES'||col(s,'AppointmentClinicalReports','template_snapshot')?.COLUMN_DEFAULT!==null)fail('CLINICAL_RELEASE_TEMPLATE_SNAPSHOT_INVALID');
 const unique=s.indexes.filter(r=>r.TABLE_NAME==='ClinicalEpisodeTemplateVersions'&&r.INDEX_NAME==='clinical_template_revision_once');
 if(hash(unique.map(r=>[r.COLUMN_NAME,r.NON_UNIQUE]))!==hash([['template_id',0],['version_number',0]]))fail('CLINICAL_RELEASE_TEMPLATE_UNIQUENESS_INVALID');
 for(const [t,c,rt,rc]of [['ClinicalEpisodeTemplates','clinic_id','Clinicas','id_clinica'],['ClinicalEpisodeTemplateVersions','template_id','ClinicalEpisodeTemplates','id']])if(!s.foreignKeys.some(r=>r.TABLE_NAME===t&&r.COLUMN_NAME===c&&r.REFERENCED_TABLE_NAME===rt&&r.REFERENCED_COLUMN_NAME===rc&&r.DELETE_RULE==='RESTRICT'))fail('CLINICAL_RELEASE_TEMPLATE_OWNER_INVALID');
 if(s.metadata_names.includes(MIGRATIONS[3])!==registered)fail('CLINICAL_RELEASE_TEMPLATE_METADATA_INVALID');
}
function verifyNutrition(s,registered=true){
 const c=col(s,'PatientNutritionMeasurements','episode_id');
 if(c?.COLUMN_TYPE!=='varchar(36)'||c.IS_NULLABLE!=='YES'||c.COLUMN_DEFAULT!==null||!s.foreignKeys.some(r=>r.TABLE_NAME==='PatientNutritionMeasurements'&&r.COLUMN_NAME==='episode_id'&&r.REFERENCED_TABLE_NAME==='AppointmentClinicalReports'&&r.REFERENCED_COLUMN_NAME==='public_id'&&r.DELETE_RULE==='RESTRICT'&&r.UPDATE_RULE==='RESTRICT'))fail('CLINICAL_RELEASE_NUTRITION_OWNER_INVALID');
 const ix=s.indexes.filter(r=>r.TABLE_NAME==='PatientNutritionMeasurements'&&r.INDEX_NAME==='nutrition_measurement_episode');
 if(hash(ix.map(r=>r.COLUMN_NAME))!==hash(['clinic_id','patient_id','episode_id','measured_at']))fail('CLINICAL_RELEASE_NUTRITION_INDEX_INVALID');
 const fkIndex=s.indexes.filter(r=>r.TABLE_NAME==='PatientNutritionMeasurements'&&r.INDEX_NAME===NUTRITION_FK_INDEX);
 if(fkIndex.length!==1||fkIndex[0].COLUMN_NAME!=='episode_id'||Number(fkIndex[0].NON_UNIQUE)!==1||Number(fkIndex[0].SEQ_IN_INDEX)!==1||fkIndex[0].INDEX_TYPE!=='BTREE')fail('CLINICAL_RELEASE_NUTRITION_FK_INDEX_INVALID');
 if(s.metadata_names.includes(MIGRATIONS[2])!==registered)fail('CLINICAL_RELEASE_NUTRITION_METADATA_INVALID');
}
function pending(state){
 const f=foundation.MIGRATIONS.map(n=>state.metadata_names.includes(n));
 if(f.some(Boolean)&&!f.every(Boolean))fail('CLINICAL_RELEASE_PARTIAL_FOUNDATION');
 if(f.every(Boolean))foundation.verifySchema(state);
 else if(state.tables.some(t=>foundation.NEW_TABLES.includes(t.TABLE_NAME))||Object.entries(NEW_COLUMNS).some(([t,cols])=>cols.filter(n=>!['template_snapshot','episode_id'].includes(n)).some(n=>col(state,t,n))))fail('CLINICAL_RELEASE_UNREGISTERED_FOUNDATION');
 if(state.metadata_names.includes(MIGRATIONS[2]))verifyNutrition(state);else if(col(state,'PatientNutritionMeasurements','episode_id'))fail('CLINICAL_RELEASE_UNREGISTERED_NUTRITION');
 if(state.metadata_names.includes(MIGRATIONS[3]))verifyTemplates(state);else if(TEMPLATE_TABLES.some(t=>state.tables.some(r=>r.TABLE_NAME===t))||col(state,'AppointmentClinicalReports','template_snapshot'))fail('CLINICAL_RELEASE_UNREGISTERED_TEMPLATES');
 return MIGRATIONS.filter(n=>!state.metadata_names.includes(n));
}
function verifyAfter(before,after,names,registered=true){
 const newTables=after.tables.filter(t=>!before.tables.some(b=>b.TABLE_NAME===t.TABLE_NAME)).map(t=>t.TABLE_NAME);
 if(newTables.some(t=>!NEW_TABLES.includes(t))||before.identity_sha256!==after.identity_sha256)fail('CLINICAL_RELEASE_UNEXPECTED_SCHEMA_CHANGE');
 const oldColumn=r=>before.columns.some(b=>b.TABLE_NAME===r.TABLE_NAME&&b.COLUMN_NAME===r.COLUMN_NAME);
 if(after.columns.some(r=>!newTables.includes(r.TABLE_NAME)&&!oldColumn(r)&&!NEW_COLUMNS[r.TABLE_NAME]?.includes(r.COLUMN_NAME)))fail('CLINICAL_RELEASE_UNEXPECTED_COLUMN');
 const retained=after.columns.filter(oldColumn).map(r=>r.TABLE_NAME==='AppointmentClinicalReports'&&r.COLUMN_NAME==='appointment_id'?{...r,IS_NULLABLE:col(before,r.TABLE_NAME,r.COLUMN_NAME).IS_NULLABLE}:r);
 const oldIndexes=after.indexes.filter(r=>!newTables.includes(r.TABLE_NAME)
  &&!(r.TABLE_NAME==='PatientNutritionMeasurements'&&r.INDEX_NAME===NUTRITION_FK_INDEX&&r.COLUMN_NAME==='episode_id'&&!col(before,'PatientNutritionMeasurements','episode_id'))
  &&(!NEW_INDEXES.includes(r.INDEX_NAME)||before.indexes.some(b=>b.TABLE_NAME===r.TABLE_NAME&&b.INDEX_NAME===r.INDEX_NAME)));
 const oldForeignKeys=after.foreignKeys.filter(r=>!newTables.includes(r.TABLE_NAME)&&!(r.TABLE_NAME==='PatientNutritionMeasurements'&&r.COLUMN_NAME==='episode_id'&&!col(before,'PatientNutritionMeasurements','episode_id')));
 if(hash(after.tables.filter(t=>!newTables.includes(t.TABLE_NAME)))!==hash(before.tables)||hash(retained)!==hash(before.columns)||hash(oldIndexes)!==hash(before.indexes)||hash(oldForeignKeys)!==hash(before.foreignKeys)||hash(after.triggers)!==hash(before.triggers))fail('CLINICAL_RELEASE_EXISTING_METADATA_CHANGED');
 const expected=[...before.metadata_names,...(registered?names:[])].sort();
 if(hash([...after.metadata_names].sort())!==hash(expected))fail('CLINICAL_RELEASE_UNRELATED_MIGRATION_CHANGED');
 // The foundation validator checks both registry entries together.
 const checked={...after,metadata_names:registered?after.metadata_names:[...after.metadata_names,...names]};
 foundation.verifySchema(checked);verifyNutrition(checked);verifyTemplates(checked);
}
function assertStopped(target,command=execFileSync){
 if(target==='dev')return foundation.assertStopped(command);
 const processes=JSON.parse(command('pm2',['jlist'],{encoding:'utf8',maxBuffer:4*1024*1024}));
 const api=processes.filter(p=>p.name==='pm2-back-staging');
 if(api.length!==1||api[0].pm2_env.status!=='stopped'||api[0].pid)fail('CLINICAL_RELEASE_STOP_CRM_API_FIRST');
 const listening=command('ss',['-H','-ltn'],{encoding:'utf8'});
 if(listening.split('\n').some(line=>/\S+:3001\s/.test(line)))fail('CLINICAL_RELEASE_CRM_PORT_STILL_LISTENING');
}
function validatePlan(plan,info,target,state,fresh=true){
 if(plan?.version!==VERSION||plan.target!==target||plan.source_commit!==info.commit||hash(plan.migrations)!==hash(info.migrations)||!Number.isFinite(Date.parse(plan.generated_at))||Date.parse(plan.generated_at)>Date.now()||fresh&&Date.now()-Date.parse(plan.generated_at)>7200000||hash(plan.pending)!==hash(pending(plan.before))||!plan.pending.length)fail('CLINICAL_RELEASE_PLAN_INVALID');
 if(state&&hash(state)!==hash(plan.before))fail('CLINICAL_RELEASE_PLAN_DRIFT');
}
function validateBackupManifest(b,plan){
 if(b.version!=='cliniccloud-operator-backup/1'||b.database_target!==plan.target||b.database_name!==plan.before.database_name||hash(b.server_name)!==plan.before.server_sha256||!b.full_gzip_verified||!b.dump_completion_verified||!PARENTS.every(t=>b.tables?.includes(t))||!Number.isFinite(Date.parse(b.generated_at))||Date.parse(b.generated_at)>Date.now()||Date.now()-Date.parse(b.generated_at)>7200000)fail('CLINICAL_RELEASE_FRESH_TARGET_BACKUP_REQUIRED');
}
async function run(args){
 const o=parseArgs(args,['--mode','--target','--private-output','--plan','--approved-plan-sha256','--backup-manifest','--private-journal']),mode=o['--mode'],target=o['--target'];
 if(!['inspect','prepare','apply','verify'].includes(mode)||!['dev','crm'].includes(target))fail('CLINICAL_RELEASE_EXPLICIT_TARGET_MODE_REQUIRED');
 const info=source(mode!=='inspect'),config=databaseOptions(target);assertTarget(target,config);
 const sql=new Sequelize(config.database,config.user,config.password,{host:config.host,port:config.port,dialect:'mysql',dialectOptions:{...(config.ssl?{ssl:config.ssl}:{}),dateStrings:true},timezone:'+00:00',logging:false,pool:{min:0,max:1,idle:1000,acquire:15000}});
 let journal,locked=false;
 const lockName=target==='dev'?'clinicaclick_dev_schema_release':'clinicaclick_crm_schema_release';
 try{
  await sql.query('SET SESSION lock_wait_timeout=10');await sql.query('SET SESSION innodb_lock_wait_timeout=5');
  if(mode!=='apply'){
   if(!o['--private-output'])fail('CLINICAL_RELEASE_PRIVATE_OUTPUT_REQUIRED');
   await sql.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');let state;
   try{state=await capture(sql,target,config);}finally{await sql.query('ROLLBACK');}
   if(mode==='verify'){const p=privateJson(o['--plan']);validatePlan(p,info,target,null,false);verifyAfter(p.before,state,p.pending);}
   const names=mode==='verify'?[]:pending(state);
   if(mode==='prepare'&&!names.length)fail('CLINICAL_RELEASE_NOTHING_PENDING');
   const plan={version:VERSION,target,status:mode,source_commit:info.commit,migrations:info.migrations,pending:names,generated_at:new Date().toISOString(),before:state,metadata_only:true};
   writePrivateJson(o['--private-output'],plan);return{target,status:mode,source_commit:info.commit,pending:names,plan_sha256:hash(plan),metadata_only:true};
  }
  const p=privateJson(o['--plan']),backup=privateJson(o['--backup-manifest']);validatePlan(p,info,target);
  if(o['--approved-plan-sha256']!==hash(p))fail('CLINICAL_RELEASE_APPROVED_PLAN_HASH_REQUIRED');
  validateBackupManifest(backup,p);await validateBackup(o['--backup-manifest']);assertStopped(target);
  if(!o['--private-journal']||fs.existsSync(o['--private-journal']))fail('CLINICAL_RELEASE_NEW_JOURNAL_REQUIRED');
  const [[lock]]=await sql.query('SELECT GET_LOCK(:name,0) acquired',{replacements:{name:lockName}});if(Number(lock.acquired)!==1)fail('CLINICAL_RELEASE_OTHER_OPERATOR_ACTIVE');locked=true;
  const before=await capture(sql,target,config);validatePlan(p,info,target,before);
  journal=newJournal(o['--private-journal'],hash(p));await journal.append({phase:'before_ddl',target,source_commit:info.commit,migrations:p.pending,backup_manifest_sha256:hash(backup)});
  for(const name of p.pending){const m=info.migrations.find(m=>m.name===name);if(!m||hash(fs.readFileSync(path.join(ROOT,'migrations',name)))!==m.sha256)fail('CLINICAL_RELEASE_MIGRATION_BYTES_CHANGED');await require(path.join(ROOT,'migrations',name)).up(sql.getQueryInterface(),Sequelize);await journal.append({phase:'ddl_completed',migration:name,sha256:m.sha256});}
  verifyAfter(before,await capture(sql,target,config),p.pending,false);
  await sql.transaction(async transaction=>{
   for(const name of p.pending)await sql.query('INSERT INTO SequelizeMeta(name) VALUES (:name)',{replacements:{name},transaction});
  });
  const after=await capture(sql,target,config);verifyAfter(before,after,p.pending);await journal.append({phase:'verified',schema_sha256:hash(after),business_dml_executed:false,configuration_changed:false});
  return{target,status:'applied_verified',source_commit:info.commit,migrations:p.pending,metadata_only:true};
 }catch(error){if(journal)await journal.append({phase:'failed_preserve_additive_schema',instruction:'Keep affected API stopped. Inspect journal and schema. Repair forward; no down, blind retry or global restore over later writes.'});throw error;}
 finally{try{if(locked)await sql.query('SELECT RELEASE_LOCK(:name)',{replacements:{name:lockName}});}finally{journal?.close();await sql.close();}}
}
if(require.main===module)run(process.argv.slice(2)).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(/^CLINICAL_(RELEASE|SCHEMA)_[A-Z_]+$/.test(e.message)?e.message:'CLINICAL_RELEASE_FAILED_INSPECT_PRIVATE_EVIDENCE');process.exitCode=1;});
module.exports={VERSION,MIGRATIONS,assertTarget,pending,verifyNutrition,verifyTemplates,verifyAfter,assertStopped,validatePlan,validateBackupManifest,capture,source,run};
