'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {executionSeal,validateExecution,assertBackupManifest}=require('../eurodent-import-patients');
const {hash}=require('../../lib/cliniccloud-import/adapter');
function fixture(){
  const state={database_name:'clinicaclick',identity_sha256:'identity-real-server-and-user',server_sha256:hash('TESTONLY server'),tables:[{TABLE_NAME:'Pacientes'},{TABLE_NAME:'PatientImportedIdentities'}]},
    backup={version:'cliniccloud-operator-backup/1',database_target:'crm',database_name:'clinicaclick',server_name:'TESTONLY server',full_gzip_verified:true,dump_completion_verified:true,tables:['Pacientes'],generated_at:new Date().toISOString()},
    source={commit:'source-committed',migrations:[{name:'allowlisted-migration',sha256:'sourcebytes'}]},bundle={sha256:'approved-source-bundle'},snapshot={plan:{sha256:'frozen-patient-operations'}};
  const context={target:'crm',clinicId:67,actorId:1,state,backup,source,bundle,snapshot,emptyArchiveTables:['PatientImportedIdentities']};
  const seal=executionSeal(context);return{...context,seal,approvedSha256:seal.sha256};
}
test('execution approval binds database identity, exact schema, actor, source commit/migrations, bundle and backup',()=>{
  const context=fixture();assert.doesNotThrow(()=>validateExecution(context.seal,context));
  for(const mutate of [c=>{c.state.database_name='other';},c=>{c.state.identity_sha256='cloned';},c=>{c.state.server_sha256='other';},c=>{c.state.tables.push({TABLE_NAME:'Unexpected'});},c=>{c.actorId=44;},c=>{c.source.commit='other';},c=>{c.source.migrations[0].sha256='changed';},c=>{c.bundle.sha256='other';},c=>{c.backup.generated_at='2000-01-01';},c=>{c.approvedSha256='different';}]){
    const changed=structuredClone(context);mutate(changed);assert.throws(()=>validateExecution(changed.seal,changed),/PLAN_OR_TARGET_CHANGED/);
  }
  const stale=fixture();stale.seal.generated_at='2000-01-01';assert.throws(()=>validateExecution(stale.seal,stale),/PLAN_OR_TARGET_CHANGED/);
});
test('backup is fresh, verified, local-target/server-bound and covers existing data; only proven empty archive tables may be unbacked',()=>{
  const context=fixture();assert.doesNotThrow(()=>assertBackupManifest(context.backup,context));
  for(const mutate of [c=>{c.backup.server_name='clone';},c=>{c.backup.database_target='dev';},c=>{c.backup.database_name='other';},c=>{c.backup.full_gzip_verified=false;},c=>{c.backup.dump_completion_verified=false;},c=>{c.backup.generated_at='2000-01-01';},c=>{c.backup.tables=[];},c=>{c.emptyArchiveTables.push('Pacientes');}]){
    const changed=structuredClone(context);mutate(changed);assert.throws(()=>assertBackupManifest(changed.backup,changed),/BACKUP_REQUIRED/);
  }
});
