'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const cut=require('../eurodent-archive-schema-release');
const {hash}=require('../../lib/cliniccloud-import/adapter');

test('schema operator only admits explicit local target identities and its additive cohort',()=>{
  assert.deepEqual(cut.MIGRATIONS,['20261022143000-patient-imported-source-archive.js']);
  const dev={host:'127.0.0.1',port:3306,database:'clinicaclick_dev_isolated',user:'cc_dev_api'};
  const crm={...dev,database:'clinicaclick',user:'crm-operator'};
  assert.doesNotThrow(()=>cut.assertTarget('dev',dev));assert.doesNotThrow(()=>cut.assertTarget('crm',crm));
  for(const [target,config] of [['dev',crm],['crm',dev],['staging',crm],['dev',{...dev,host:'remote'}],['crm',{...crm,port:3307}],['crm',{...crm,user:''}]])assert.throws(()=>cut.assertTarget(target,config),/LOCAL_EXPLICIT_TARGET/);
  assert.equal(cut.lockNameForTarget('crm'),'clinicaclick_crm_schema_release');
  assert.equal(cut.lockNameForTarget('dev'),'clinicaclick_dev_schema_release');
});

test('full backup binds fresh source database, server, completed dump and every captured table',()=>{
  for(const target of ['dev','crm']){
    const database=target==='crm'?'clinicaclick':'clinicaclick_dev_isolated';
    const plan={target,before:{database_name:database,server_sha256:hash('TESTONLY'),tables:[{TABLE_NAME:'Pacientes'},{TABLE_NAME:'UnrelatedQA'}]}};
    const backup={version:'cliniccloud-operator-backup/1',database_target:target,database_name:database,server_name:'TESTONLY',full_gzip_verified:true,dump_completion_verified:true,tables:['Pacientes','UnrelatedQA'],generated_at:new Date().toISOString()};
    assert.doesNotThrow(()=>cut.validateBackupManifest(backup,plan));
    for(const patch of [{database_target:'wrong'},{database_name:'wrong'},{server_name:'wrong'},{tables:['Pacientes']},{full_gzip_verified:false},{dump_completion_verified:false},{generated_at:'2020-01-01'},{generated_at:new Date(Date.now()+60000).toISOString()}])assert.throws(()=>cut.validateBackupManifest({...backup,...patch},plan),/FRESH_TARGET_BACKUP/);
  }
});

test('stopped-state verification never mutates processes or admits another target',()=>{
  const calls=[];
  assert.doesNotThrow(()=>cut.assertStopped('dev',(command,args)=>{calls.push([command,args]);return'inactive\n';}));
  assert.equal(calls.length,2);assert(calls.every(([command,args])=>command==='systemctl'&&args[0]==='show'));
  assert.throws(()=>cut.assertStopped('dev',()=> 'active\n'),/STOP_DEV_WRITERS/);
  const stopped={name:'pm2-back-staging',pid:0,pm2_env:{status:'stopped'}};
  const command=(items=[stopped],ports='')=>(name)=>name==='pm2'?JSON.stringify(items):ports;
  assert.doesNotThrow(()=>cut.assertStopped('crm',command()));
  for(const items of [[],[stopped,stopped],[{...stopped,pid:123}],[{...stopped,pm2_env:{status:'online'}}]])assert.throws(()=>cut.assertStopped('crm',command(items)),/STOP_CRM_API/);
  assert.throws(()=>cut.assertStopped('crm',command(undefined,'LISTEN 0 511 127.0.0.1:3001 0.0.0.0:*\n')),/PORT_STILL_LISTENING/);
});
