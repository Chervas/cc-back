#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {connectOperatorDatabase,databaseOptions}=require('../lib/cliniccloud-import/operator-database');
const {validateBundle,digest}=require('../lib/eurodent-import/bundle');
const {captureImport,applyImport}=require('../lib/eurodent-import/store');
const schema=require('./eurodent-archive-schema-release');
const {validateBackup}=require('./cliniccloud-import-contacts-apply');
function readPrivate(filename){const p=path.resolve(filename),s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077)||s.size>100*1024*1024)throw Error('EURODENT_PRIVATE_INPUT_REQUIRED');return JSON.parse(fs.readFileSync(p,'utf8'));}
const metadataAdapter=connection=>({query:(sql,options={})=>connection.query({sql,namedPlaceholders:true},options.replacements||{})});
function assertBackupManifest(backup,{target,state,emptyArchiveTables=[]}){
  if(!Array.isArray(emptyArchiveTables)||emptyArchiveTables.some(table=>!schema.NEW_TABLES.includes(table))
    ||backup?.version!=='cliniccloud-operator-backup/1'||backup.database_target!==target||backup.database_name!==state.database_name
    ||require('../lib/cliniccloud-import/adapter').hash(backup.server_name)!==state.server_sha256
    ||!backup.full_gzip_verified||!backup.dump_completion_verified||!Array.isArray(backup.tables)
    ||state.tables.some(table=>!backup.tables.includes(table.TABLE_NAME)&&!emptyArchiveTables.includes(table.TABLE_NAME))
    ||!Number.isFinite(Date.parse(backup.generated_at))||Date.parse(backup.generated_at)>Date.now()||Date.now()-Date.parse(backup.generated_at)>7200000)throw Error('EURODENT_FRESH_EXACT_TARGET_BACKUP_REQUIRED');
}
function executionSeal({target,clinicId,bundle,actorId,source,state,backup,snapshot,emptyArchiveTables}){
  const seal={version:'eurodent_import_execution/1',generated_at:new Date().toISOString(),target,clinicId,actorId,bundleSha256:bundle.sha256,
    source_commit:source.commit,migrations:source.migrations,database_name:state.database_name,database_identity_sha256:state.identity_sha256,
    server_sha256:state.server_sha256,schema_sha256:digest(state),backup_manifest_sha256:digest(backup),empty_archive_tables:emptyArchiveTables,
    store_plan_sha256:snapshot.plan.sha256};
  return {...seal,sha256:digest(seal)};
}
function validateExecution(seal,{target,clinicId,bundle,actorId,source,state,backup,approvedSha256}){
  if(seal?.version!=='eurodent_import_execution/1'||seal.sha256!==approvedSha256||seal.sha256!==digest(Object.fromEntries(Object.entries(seal).filter(([key])=>key!=='sha256')))
    ||seal.target!==target||seal.clinicId!==clinicId||seal.actorId!==actorId||seal.bundleSha256!==bundle.sha256||seal.source_commit!==source.commit||digest(seal.migrations)!==digest(source.migrations)
    ||seal.database_name!==state.database_name||seal.database_identity_sha256!==state.identity_sha256||seal.server_sha256!==state.server_sha256||seal.schema_sha256!==digest(state)
    ||seal.backup_manifest_sha256!==digest(backup)||!Number.isFinite(Date.parse(seal.generated_at))||Date.parse(seal.generated_at)>Date.now()||Date.now()-Date.parse(seal.generated_at)>7200000)throw Error('EURODENT_EXECUTION_PLAN_OR_TARGET_CHANGED');
}
async function run(argv){
  const options={},allowed=new Set(['--target','--clinic','--bundle','--mode','--out','--apply-sha256','--actor','--plan','--backup-manifest']);
  if(argv.length%2)throw Error('EURODENT_ARGUMENTS_INVALID');for(let i=0;i<argv.length;i+=2){if(!allowed.has(argv[i])||Object.hasOwn(options,argv[i]))throw Error('EURODENT_ARGUMENTS_INVALID');options[argv[i]]=argv[i+1];}
  const target=options['--target'],mode=options['--mode'],clinicId=Number(options['--clinic']),actorId=Number(options['--actor']),out=options['--out'];
  if(!['dev','crm'].includes(target)||!['prepare','apply'].includes(mode)||!Number.isSafeInteger(clinicId)||clinicId<=0)throw Error('EURODENT_EXPLICIT_TARGET_REQUIRED');
  if(!Number.isSafeInteger(actorId)||!require('../lib/role-helpers').isGlobalAdmin(actorId))throw Error('EURODENT_GLOBAL_ADMIN_ACTOR_REQUIRED');
  const bundle=validateBundle(readPrivate(options['--bundle'])),backup=readPrivate(options['--backup-manifest']);
  if(target==='dev'&&!bundle.source_instance.startsWith('testonly-'))throw Error('EURODENT_REAL_PATIENTS_FORBIDDEN_IN_DEV');
  if(!out||!path.isAbsolute(out)||!fs.statSync(out).isDirectory()||(fs.statSync(out).mode&0o077))throw Error('EURODENT_PRIVATE_OUTPUT_REQUIRED');
  const write=(name,value)=>{const fd=fs.openSync(path.join(out,name),'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}const dir=fs.openSync(out,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}};
  const source=schema.source(true),config=databaseOptions(target);schema.assertTarget(target,config);
  const connection=await connectOperatorDatabase(target),adapter=metadataAdapter(connection);let locked=false;
  const lockName=schema.lockNameForTarget(target);
  try{
    if(!(await connection.query('SELECT id_usuario FROM Usuarios WHERE id_usuario=?',[actorId]))[0].length)throw Error('EURODENT_ACTOR_NOT_PRESENT');
    let state=await schema.capture(adapter,target,config);schema.verifySchema(state);
    if(!schema.MIGRATIONS.every(name=>state.metadata_names.includes(name)))throw Error('EURODENT_ARCHIVE_MIGRATION_NOT_REGISTERED');
    if(mode==='prepare'){
      await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      const snapshot=await captureImport(connection,{clinicId,bundle});
      const emptyArchiveTables=[];
      for(const table of schema.NEW_TABLES){if(Number((await connection.query(`SELECT COUNT(*) n FROM ${table}`))[0][0].n)===0)emptyArchiveTables.push(table);}
      await connection.rollback();assertBackupManifest(backup,{target,state,emptyArchiveTables});
      const seal=executionSeal({target,clinicId,bundle,actorId,source,state,backup,snapshot,emptyArchiveTables});
      write('eurodent-prepare.json',{target,at:new Date().toISOString(),seal,snapshot});
      return{target,mode,clinicId,patients:bundle.patients.length,sha256:seal.sha256,storePlanSha256:snapshot.plan.sha256,counts:snapshot.plan.counts,operationalEffects:false};
    }
    const prepared=readPrivate(options['--plan']),seal=prepared.seal;
    validateExecution(seal,{target,clinicId,bundle,actorId,source,state,backup,approvedSha256:options['--apply-sha256']});
    assertBackupManifest(backup,{target,state,emptyArchiveTables:seal.empty_archive_tables});await validateBackup(options['--backup-manifest']);schema.assertStopped(target);
    if(Number((await connection.query('SELECT GET_LOCK(?,0) acquired',[lockName]))[0][0].acquired)!==1)throw Error('EURODENT_SHARED_SCHEMA_OPERATOR_BUSY');locked=true;
    schema.assertStopped(target);state=await schema.capture(adapter,target,config);validateExecution(seal,{target,clinicId,bundle,actorId,source:schema.source(true),state,backup,approvedSha256:options['--apply-sha256']});
    for(const table of seal.empty_archive_tables){if(!schema.NEW_TABLES.includes(table)||Number((await connection.query(`SELECT COUNT(*) n FROM ${table}`))[0][0].n)!==0)throw Error('EURODENT_UNBACKED_ARCHIVE_NOT_EMPTY');}
    const result=await applyImport(connection,{clinicId,bundle,actorId,expectedSha256:seal.store_plan_sha256,beforeCommit:async journal=>{
      schema.assertStopped(target);const current=await schema.capture(adapter,target,config);if(digest(current)!==seal.schema_sha256)throw Error('EURODENT_SCHEMA_CHANGED_DURING_IMPORT');
      write('eurodent-before-commit.json',{target,at:new Date().toISOString(),seal,...journal});
    }});
    write('eurodent-committed.json',{target,at:new Date().toISOString(),seal,result});
    return{target,mode,clinicId,created:result.created.length,preserved:result.preserved,records:result.recordCount,messagesSent:0,appointmentsCreated:0,newDebt:0};
  }finally{try{if(locked)await connection.query('SELECT RELEASE_LOCK(?)',[lockName]);}finally{await connection.end();}}
}
if(require.main===module)run(process.argv.slice(2)).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(/^[A-Z_]+$/.test(error.message)?error.message:'EURODENT_IMPORT_REQUIRES_PRIVATE_JOURNAL_REVIEW');process.exitCode=1;});
module.exports={run,readPrivate,assertBackupManifest,executionSeal,validateExecution};
