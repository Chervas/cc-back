#!/usr/bin/env node
'use strict';
// Allowlisted operator for the two reviewed additive Dental migrations, from dev.
// No application bootstrap, fixture data, provider, configuration or restart.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {Sequelize}=require('sequelize'),{hash}=require('../lib/cliniccloud-import/adapter');
const {databaseOptions}=require('../lib/cliniccloud-import/operator-database');
const {parseArgs,writePrivateJson}=require('../lib/cliniccloud-import/io');
const {privateJson}=require('./cliniccloud-import-appointments-apply'),{validateBackup}=require('./cliniccloud-import-contacts-apply');
const {newJournal}=require('./program-commercial-schema-release');
const foundation=require('./clinical-workspace-schema-release'),previous=require('./clinical-forms-schema-release');
const ROOT='/home/ubuntu/wt/back-dev',VERSION='dental-schema/1';
const DATABASES=Object.freeze({dev:'clinicaclick_dev_isolated',crm:'clinicaclick'});
const MIGRATIONS=Object.freeze(['20261021220000-dental-clinical-plans.js','20261021220500-dental-supporting-tools.js']);
const PREREQUISITES=Object.freeze([...previous.PREREQUISITES,...previous.MIGRATIONS]);
const PARENTS=Object.freeze(['Clinicas','Pacientes','CitasPacientes','EconomicBudgets','AppointmentClinicalReports','ClinicalEpisodeAppointments','ClinicalPrivateAssets','SequelizeMeta']);
const CORE_TABLES=Object.freeze(['DentalPlans','DentalPlanRevisions']);
const TOOL_TABLES=Object.freeze(['DentalSupportingTools','DentalSupportingToolsRevisions']);
const NEW_TABLES=Object.freeze([...CORE_TABLES,...TOOL_TABLES]);
const TABLES=[...PARENTS,...NEW_TABLES];
const EXPECTED={
 DentalPlans:{id:'bigint unsigned',public_id:'varchar(36)',clinic_id:'int',patient_id:'int',budget_id:'bigint unsigned',version_number:'int unsigned',status:'varchar(20)',state:'json',creation_key:'varchar(64)',creation_hash:'varchar(64)',created_by:'int',updated_by:'int',created_at:'datetime',updated_at:'datetime'},
 DentalPlanRevisions:{id:'bigint unsigned',plan_id:'bigint unsigned',version_number:'int unsigned',snapshot:'json',sha256:'varchar(64)',command:'varchar(40)',mutation_key:'varchar(64)',request_hash:'varchar(64)',actor_id:'int',created_at:'datetime'},
 DentalSupportingTools:{id:'bigint unsigned',public_id:'varchar(36)',plan_id:'bigint unsigned',clinic_id:'int',patient_id:'int',version_number:'int unsigned',state:'json',created_by:'int',updated_by:'int',created_at:'datetime',updated_at:'datetime'},
 DentalSupportingToolsRevisions:{id:'bigint unsigned',tool_id:'bigint unsigned',version_number:'int unsigned',snapshot:'json',command_key:'varchar(120)',command_hash:'varchar(64)',command_type:'varchar(40)',actor_id:'int',created_at:'datetime'},
};
const FOREIGN_KEYS=[['DentalPlans','clinic_id','Clinicas','id_clinica'],['DentalPlans','patient_id','Pacientes','id_paciente'],['DentalPlans','budget_id','EconomicBudgets','id'],['DentalPlanRevisions','plan_id','DentalPlans','id'],['DentalSupportingTools','plan_id','DentalPlans','id'],['DentalSupportingTools','clinic_id','Clinicas','id_clinica'],['DentalSupportingTools','patient_id','Pacientes','id_paciente'],['DentalSupportingToolsRevisions','tool_id','DentalSupportingTools','id']];
const INDEXES={
 DentalPlans:[['PRIMARY',['id'],true],['public_id',['public_id'],true],['creation_key',['creation_key'],true],['dental_plan_patient_date',['clinic_id','patient_id','updated_at'],false]],
 DentalPlanRevisions:[['PRIMARY',['id'],true],['dental_plan_revision_once',['plan_id','version_number'],true],['dental_plan_command_once',['plan_id','mutation_key'],true]],
 DentalSupportingTools:[['PRIMARY',['id'],true],['public_id',['public_id'],true],['dental_tools_plan_once',['plan_id'],true]],
 DentalSupportingToolsRevisions:[['PRIMARY',['id'],true],['dental_tools_revision_once',['tool_id','version_number'],true],['dental_tools_command_once',['tool_id','command_key'],true]],
};
const fail=code=>{throw Error(code);};
const col=(state,table,name)=>state.columns.find(row=>row.TABLE_NAME===table&&row.COLUMN_NAME===name);
function source(clean=false){
 if(process.cwd()!==ROOT||path.resolve(__dirname,'../..')!==ROOT||execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim()!=='dev')fail('DENTAL_SCHEMA_DEV_SOURCE_REQUIRED');
 const dirty=Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim());if(clean&&dirty)fail('DENTAL_SCHEMA_COMMITTED_SOURCE_REQUIRED');
 return{commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty,migrations:MIGRATIONS.map(name=>({name,sha256:hash(fs.readFileSync(path.join(ROOT,'migrations',name)))}))};
}
function assertTarget(target,config){
 if(!Object.hasOwn(DATABASES,target)||!['127.0.0.1','localhost','::1'].includes(config.host)||config.port!==3306||config.database!==DATABASES[target]
  ||typeof config.user!=='string'||!config.user.trim()||(target==='dev'?config.user!=='cc_dev_api':config.user==='cc_dev_api'))fail('DENTAL_SCHEMA_LOCAL_EXPLICIT_TARGET_REQUIRED');
}
function lockNameForTarget(target){if(!Object.hasOwn(DATABASES,target))fail('DENTAL_SCHEMA_LOCAL_EXPLICIT_TARGET_REQUIRED');return `clinicaclick_${target}_schema_release`;}
async function capture(sql,target,config){
 assertTarget(target,config);
 const query=async(text,replacements)=>(await sql.query(text,{replacements}))[0];
 const [identity]=await query('SELECT DATABASE() database_name,CURRENT_USER() database_user,@@hostname server_name,@@port server_port');
 if(identity.database_name!==config.database||String(identity.database_user).split('@')[0]!==config.user||Number(identity.server_port)!==3306)fail('DENTAL_SCHEMA_DATABASE_IDENTITY_INVALID');
 if(target==='dev'){const [anchor]=await query("SELECT EXISTS(SELECT 1 FROM Clinicas WHERE id_clinica=1 AND nombre_clinica='Clinica ficticia DEV') ok");if(!Number(anchor.ok))fail('DENTAL_SCHEMA_FICTIONAL_ANCHOR_REQUIRED');}
 return captureMetadata(sql,identity);
}
// Factored metadata reader for an owned, socket-only QA instance. Runtime run()
// always calls capture(), which checks target, authenticated identity and anchor.
async function captureMetadata(sql,identity){
 const query=async(text,replacements)=>(await sql.query(text,{replacements}))[0];
 const tables=await query('SELECT TABLE_NAME,ENGINE,TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (:tables) ORDER BY TABLE_NAME',{tables:TABLES});
 if(PARENTS.some(name=>!tables.some(row=>row.TABLE_NAME===name&&row.ENGINE==='InnoDB')))fail('DENTAL_SCHEMA_PREREQUISITE_MISSING');
 const columns=await query('SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA,CHARACTER_SET_NAME,COLLATION_NAME,GENERATION_EXPRESSION,ORDINAL_POSITION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (:tables) ORDER BY TABLE_NAME,ORDINAL_POSITION',{tables:TABLES});
 const indexes=await query('SELECT TABLE_NAME,INDEX_NAME,NON_UNIQUE,SEQ_IN_INDEX,COLUMN_NAME,SUB_PART,INDEX_TYPE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (:tables) ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX',{tables:TABLES});
 const foreignKeys=await query('SELECT K.TABLE_NAME,K.COLUMN_NAME,K.CONSTRAINT_NAME,K.REFERENCED_TABLE_NAME,K.REFERENCED_COLUMN_NAME,R.UPDATE_RULE,R.DELETE_RULE FROM information_schema.KEY_COLUMN_USAGE K JOIN information_schema.REFERENTIAL_CONSTRAINTS R ON R.CONSTRAINT_SCHEMA=K.CONSTRAINT_SCHEMA AND R.CONSTRAINT_NAME=K.CONSTRAINT_NAME AND R.TABLE_NAME=K.TABLE_NAME WHERE K.TABLE_SCHEMA=DATABASE() AND K.TABLE_NAME IN (:tables) AND K.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY K.TABLE_NAME,K.CONSTRAINT_NAME,K.ORDINAL_POSITION',{tables:TABLES});
 const triggers=await query('SELECT EVENT_OBJECT_TABLE,TRIGGER_NAME,ACTION_TIMING,EVENT_MANIPULATION,ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE IN (:tables) ORDER BY EVENT_OBJECT_TABLE,TRIGGER_NAME',{tables:TABLES});
 if(triggers.some(row=>['SequelizeMeta',...NEW_TABLES].includes(row.EVENT_OBJECT_TABLE)))fail('DENTAL_SCHEMA_UNEXPECTED_TRIGGER');
 const metadata=await query('SELECT name FROM SequelizeMeta ORDER BY name');
 return{database_name:identity.database_name,identity_sha256:hash(identity),server_sha256:hash(identity.server_name),tables,columns,indexes,foreignKeys,triggers,metadata_names:metadata.map(row=>row.name)};
}
function verifySchema(state,tables=NEW_TABLES){
 for(const table of tables){
  const fields=EXPECTED[table];
  if(!fields||!state.tables.some(row=>row.TABLE_NAME===table&&row.ENGINE==='InnoDB')||hash(state.columns.filter(row=>row.TABLE_NAME===table).map(row=>row.COLUMN_NAME).sort())!==hash(Object.keys(fields).sort()))fail('DENTAL_SCHEMA_COLUMNS_INVALID');
  for(const [name,type]of Object.entries(fields)){const c=col(state,table,name),nullable=table==='DentalPlans'&&name==='budget_id';if(c.COLUMN_TYPE!==type||c.IS_NULLABLE!==(nullable?'YES':'NO')||c.COLUMN_DEFAULT!==null||c.EXTRA!==(name==='id'?'auto_increment':'')||c.GENERATION_EXPRESSION)fail('DENTAL_SCHEMA_COLUMN_TYPE_INVALID');}
  const indexes=new Map();for(const row of state.indexes.filter(row=>row.TABLE_NAME===table)){if(row.INDEX_TYPE!=='BTREE'||row.SUB_PART!==null)fail('DENTAL_SCHEMA_INDEX_INVALID');if(!indexes.has(row.INDEX_NAME))indexes.set(row.INDEX_NAME,[]);indexes.get(row.INDEX_NAME).push(row);}
  const matched=new Set();for(const [name,fields,unique]of INDEXES[table]){const rows=indexes.get(name);if(!rows||hash(rows.map(row=>[row.COLUMN_NAME,Number(row.NON_UNIQUE),Number(row.SEQ_IN_INDEX)]))!==hash(fields.map((field,i)=>[field,unique?0:1,i+1])))fail('DENTAL_SCHEMA_INDEX_INVALID');matched.add(name);}
  const extras=new Set();for(const [name,rows]of indexes){if(matched.has(name))continue;const row=rows[0];if(rows.length!==1||Number(row.NON_UNIQUE)!==1||Number(row.SEQ_IN_INDEX)!==1||!FOREIGN_KEYS.some(([t,c])=>t===table&&c===row.COLUMN_NAME)||extras.has(row.COLUMN_NAME))fail('DENTAL_SCHEMA_INDEX_INVALID');extras.add(row.COLUMN_NAME);}
 }
 const keys=state.foreignKeys.filter(row=>tables.includes(row.TABLE_NAME)),expected=FOREIGN_KEYS.filter(([table])=>tables.includes(table));
 if(keys.length!==expected.length)fail('DENTAL_SCHEMA_FOREIGN_KEY_INVALID');
 for(const [table,column,parent,key]of expected)if(!keys.some(row=>row.TABLE_NAME===table&&row.COLUMN_NAME===column&&row.REFERENCED_TABLE_NAME===parent&&row.REFERENCED_COLUMN_NAME===key&&row.DELETE_RULE==='RESTRICT'&&['RESTRICT','NO ACTION'].includes(row.UPDATE_RULE)))fail('DENTAL_SCHEMA_FOREIGN_KEY_INVALID');
}
function prerequisites(state){if(PREREQUISITES.some(name=>!state.metadata_names.includes(name)))fail('DENTAL_SCHEMA_PRIOR_CLINICAL_MIGRATIONS_REQUIRED');}
function pending(state){
 prerequisites(state);const flags=MIGRATIONS.map(name=>state.metadata_names.includes(name));
 if(flags[1]&&!flags[0])fail('DENTAL_SCHEMA_MIGRATION_ORDER_INVALID');
 for(const [index,tables]of [CORE_TABLES,TOOL_TABLES].entries()){
  if(flags[index])verifySchema(state,tables);
  else if(state.tables.some(row=>tables.includes(row.TABLE_NAME)))fail('DENTAL_SCHEMA_UNREGISTERED_TABLES');
 }
 return MIGRATIONS.filter(name=>!state.metadata_names.includes(name));
}
function verifyAfter(before,after,names,registered=true){
 if(hash(names)!==hash(pending(before)))fail('DENTAL_SCHEMA_UNREVIEWED_MIGRATIONS');
 if(before.identity_sha256!==after.identity_sha256||before.database_name!==after.database_name||before.server_sha256!==after.server_sha256)fail('DENTAL_SCHEMA_DATABASE_IDENTITY_CHANGED');
 const addedTables=after.tables.filter(row=>!before.tables.some(old=>old.TABLE_NAME===row.TABLE_NAME)).map(row=>row.TABLE_NAME);
 if(addedTables.some(name=>!NEW_TABLES.includes(name))||hash(after.tables.filter(row=>!addedTables.includes(row.TABLE_NAME)))!==hash(before.tables))fail('DENTAL_SCHEMA_EXISTING_TABLE_CHANGED');
 if(hash(after.columns.filter(row=>!addedTables.includes(row.TABLE_NAME)))!==hash(before.columns)||hash(after.indexes.filter(row=>!addedTables.includes(row.TABLE_NAME)))!==hash(before.indexes)||hash(after.foreignKeys.filter(row=>!addedTables.includes(row.TABLE_NAME)))!==hash(before.foreignKeys)||hash(after.triggers)!==hash(before.triggers))fail('DENTAL_SCHEMA_EXISTING_METADATA_CHANGED');
 if(hash([...after.metadata_names].sort())!==hash([...before.metadata_names,...(registered?names:[])].sort()))fail('DENTAL_SCHEMA_UNRELATED_MIGRATION_CHANGED');
 prerequisites(after);verifySchema(after);
}
function assertStopped(target,command=execFileSync){
 if(!Object.hasOwn(DATABASES,target))fail('DENTAL_SCHEMA_LOCAL_EXPLICIT_TARGET_REQUIRED');
 if(target==='dev')return foundation.assertStopped(command);
 const processes=JSON.parse(command('pm2',['jlist'],{encoding:'utf8',maxBuffer:4*1024*1024}));
 const api=processes.filter(item=>item.name==='pm2-back-staging');
 if(api.length!==1||api[0].pm2_env?.status!=='stopped'||api[0].pid)fail('DENTAL_SCHEMA_STOP_CRM_API_FIRST');
 const listening=command('ss',['-H','-ltn'],{encoding:'utf8'});
 if(listening.split('\n').some(line=>/\S+:3001\s/.test(line)))fail('DENTAL_SCHEMA_CRM_PORT_STILL_LISTENING');
}
function validatePlan(plan,info,target,state,fresh=true){
 if(plan?.version!==VERSION||!Object.hasOwn(DATABASES,target)||plan.target!==target||plan.before?.database_name!==DATABASES[target]||plan.source_commit!==info.commit||hash(plan.migrations)!==hash(info.migrations)||!Number.isFinite(Date.parse(plan.generated_at))||Date.parse(plan.generated_at)>Date.now()||fresh&&Date.now()-Date.parse(plan.generated_at)>7200000||hash(plan.pending)!==hash(pending(plan.before))||!plan.pending.length)fail('DENTAL_SCHEMA_PLAN_INVALID');
 if(state&&hash(state)!==hash(plan.before))fail('DENTAL_SCHEMA_PLAN_DRIFT');
}
function validateBackupManifest(backup,plan){if(backup.version!=='cliniccloud-operator-backup/1'||!Object.hasOwn(DATABASES,plan.target)||backup.database_target!==plan.target||backup.database_name!==DATABASES[plan.target]||backup.database_name!==plan.before.database_name||hash(backup.server_name)!==plan.before.server_sha256||!backup.full_gzip_verified||!backup.dump_completion_verified||!plan.before.tables.every(table=>backup.tables?.includes(table.TABLE_NAME))||!Number.isFinite(Date.parse(backup.generated_at))||Date.parse(backup.generated_at)>Date.now()||Date.now()-Date.parse(backup.generated_at)>7200000)fail('DENTAL_SCHEMA_FRESH_TARGET_BACKUP_REQUIRED');}
async function run(args){
 const o=parseArgs(args,['--mode','--target','--private-output','--plan','--approved-plan-sha256','--backup-manifest','--private-journal']),mode=o['--mode'],target=o['--target'];
 if(!['inspect','prepare','apply','verify'].includes(mode)||!Object.hasOwn(DATABASES,target))fail('DENTAL_SCHEMA_EXPLICIT_TARGET_MODE_REQUIRED');
 const info=source(mode!=='inspect'),config=databaseOptions(target);assertTarget(target,config);
 // Keep the sole SQL session alive: its advisory lock must survive idle gaps.
 const sql=new Sequelize(config.database,config.user,config.password,{host:config.host,port:config.port,dialect:'mysql',dialectOptions:{...(config.ssl?{ssl:config.ssl}:{}),dateStrings:true},timezone:'+00:00',logging:false,pool:{min:1,max:1,idle:1000,acquire:15000}});
 let journal,locked=false;const lockName=lockNameForTarget(target);
 try{
  await sql.query('SET SESSION lock_wait_timeout=10');await sql.query('SET SESSION innodb_lock_wait_timeout=5');
  if(mode!=='apply'){
   if(!o['--private-output'])fail('DENTAL_SCHEMA_PRIVATE_OUTPUT_REQUIRED');await sql.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');let state;
   try{state=await capture(sql,target,config);}finally{await sql.query('ROLLBACK');}
   if(mode==='verify'){const plan=privateJson(o['--plan']);validatePlan(plan,info,target,null,false);verifyAfter(plan.before,state,plan.pending);}
   const names=mode==='verify'?[]:pending(state);if(mode==='prepare'&&!names.length)fail('DENTAL_SCHEMA_NOTHING_PENDING');
   const plan={version:VERSION,target,status:mode,source_commit:info.commit,migrations:info.migrations,pending:names,generated_at:new Date().toISOString(),before:state,metadata_only:true};
   writePrivateJson(o['--private-output'],plan);return{target,status:mode,source_commit:info.commit,pending:names,plan_sha256:hash(plan),metadata_only:true};
  }
  const plan=privateJson(o['--plan']),backup=privateJson(o['--backup-manifest']);validatePlan(plan,info,target);
  if(o['--approved-plan-sha256']!==hash(plan))fail('DENTAL_SCHEMA_APPROVED_PLAN_HASH_REQUIRED');validateBackupManifest(backup,plan);await validateBackup(o['--backup-manifest']);assertStopped(target);
  if(!o['--private-journal']||fs.existsSync(o['--private-journal']))fail('DENTAL_SCHEMA_NEW_JOURNAL_REQUIRED');
  const [[lock]]=await sql.query('SELECT GET_LOCK(:name,0) acquired',{replacements:{name:lockName}});if(Number(lock.acquired)!==1)fail('DENTAL_SCHEMA_OTHER_OPERATOR_ACTIVE');locked=true;assertStopped(target);
  const before=await capture(sql,target,config);validatePlan(plan,info,target,before);journal=newJournal(o['--private-journal'],hash(plan));
  await journal.append({phase:'before_ddl',target,source_commit:info.commit,migrations:plan.pending,backup_manifest_sha256:hash(backup)});
  for(const name of plan.pending){assertStopped(target);const m=info.migrations.find(item=>item.name===name);if(!m||hash(fs.readFileSync(path.join(ROOT,'migrations',name)))!==m.sha256)fail('DENTAL_SCHEMA_MIGRATION_BYTES_CHANGED');await journal.append({phase:'ddl_intent',migration:name,sha256:m.sha256});await require(path.join(ROOT,'migrations',name)).up(sql.getQueryInterface(),Sequelize);await journal.append({phase:'ddl_completed',migration:name,sha256:m.sha256});}
  verifyAfter(before,await capture(sql,target,config),plan.pending,false);
  await sql.transaction(async transaction=>{for(const name of plan.pending)await sql.query('INSERT INTO SequelizeMeta(name) VALUES (:name)',{replacements:{name},transaction});});
  const after=await capture(sql,target,config);verifyAfter(before,after,plan.pending);await journal.append({phase:'verified',schema_sha256:hash(after),business_dml_executed:false,configuration_changed:false});return{target,status:'applied_verified',source_commit:info.commit,migrations:plan.pending,metadata_only:true};
 }catch(error){if(journal)await journal.append({phase:'failed_preserve_additive_schema',instruction:'Keep API stopped. Inspect journal and metadata; repair forward. No down, blind retry or global restore.'});throw error;}
 finally{try{if(locked)await sql.query('SELECT RELEASE_LOCK(:name)',{replacements:{name:lockName}});}finally{journal?.close();await sql.close();}}
}
if(require.main===module)run(process.argv.slice(2)).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(/^DENTAL_SCHEMA_[A-Z_]+$/.test(error.message)?error.message:'DENTAL_SCHEMA_FAILED_INSPECT_PRIVATE_EVIDENCE');process.exitCode=1;});
module.exports={VERSION,MIGRATIONS,PREREQUISITES,PARENTS,NEW_TABLES,CORE_TABLES,TOOL_TABLES,EXPECTED,INDEXES,FOREIGN_KEYS,source,assertTarget,lockNameForTarget,capture,captureMetadata,verifySchema,pending,verifyAfter,assertStopped,validatePlan,validateBackupManifest,run};
