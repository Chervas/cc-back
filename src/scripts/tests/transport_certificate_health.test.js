'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {readHealth}=require('../../lib/transportCertificateHealth');
const now=Date.parse('2026-09-17T18:00:00Z');
const healthy={version:1,checkedAt:new Date(now).toISOString(),certificates:['gateway','staging'].map(id=>({id,status:'healthy',expiresAt:'2026-10-15T04:04:15Z'}))};
function options(value=healthy){return {enabled:true,serversEnabled:false,now,read:()=>JSON.stringify(value),stat:()=>({isFile:()=>true,isSymbolicLink:()=>false,uid:0,mode:0o640,size:512})};}
test('healthy certificates do not generate alerts; disabled monitor does not read files',()=>{
  assert.deepEqual(readHealth(options()),[]);assert.deepEqual(readHealth({enabled:false,read:()=>{throw Error('must_not_read');}}),[]);
});
test('renewal failure yields a readable alert limited to the affected component',()=>{
  const value=structuredClone(healthy);value.certificates[0]={id:'gateway',status:'failed',reason:'not_output_verbatim'};
  const [alert]=readHealth(options(value));assert.equal(alert.entity_id,'gateway');assert.match(alert.detail,/conserva el certificado anterior/);
  assert(!alert.detail.includes('not_output_verbatim'));assert.equal(alert.measured,1);
});
test('stale, future, missing and unsafe status files alert instead of reporting health',()=>{
  for(const offset of [-37*3600000,120000]){const value={...healthy,checkedAt:new Date(now+offset).toISOString()};assert.equal(readHealth(options(value))[0].entity_id,'maintenance');}
  const o=options();o.read=()=>{throw Error('FILE_PATH_MUST_NOT_LEAK');};assert.equal(readHealth(o)[0].entity_id,'maintenance');
  for(const overrides of [{uid:1000},{mode:0o666},{size:20000},{isSymbolicLink:()=>true}]){
    const o=options();const base=o.stat();o.stat=()=>({...base,...overrides});assert.equal(readHealth(o)[0].entity_id,'maintenance');
  }
});
test('expiring and missing certificate validity alert, preserving healthy peers',()=>{
  for(const expiresAt of ['2026-09-20T00:00:00Z','bad']){
    const value=structuredClone(healthy);value.certificates[1].expiresAt=expiresAt;const result=readHealth(options(value));
    assert.equal(result.length,1);assert.equal(result[0].entity_id,'staging');
  }
});
test('certificate failure reaches configurable notifications once and never offers a pause',async()=>{
  const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
  const rows=new Map(),notifications=[];
  const disabled=Object.fromEntries(['whatsapp_template_sends','whatsapp_template_creation','ai_requests','ai_cost','ai_unpriced'].map(key=>[key,{enabled:false}]));
  const failed=structuredClone(healthy);failed.certificates[0].status='failed';
  let health=readHealth(options(failed));
  const db={SecurityMonitoringSetting:{findOrCreate:async()=>[{rules:disabled}]},
    SecurityMonitoringAlert:{findOrCreate:async({where,defaults})=>{
      if(rows.has(where.dedupe_key))return [rows.get(where.dedupe_key),false];
      const row={...defaults,id:1,update:async value=>Object.assign(row,value)};rows.set(where.dedupe_key,row);return [row,true];
    }}};
  const context={module:{exports:{}},Date,Number,Set,Buffer,require:key=>{
    if(key==='../../models')return db;
    if(key==='../lib/role-helpers')return {isGlobalAdmin:()=>true};
    if(key==='../lib/transportCertificateHealth')return {readHealth:()=>health};
    if(key==='./systemNotifications.service')return {queueNotification:async value=>notifications.push(value)};
    throw Error('Unexpected dependency: '+key);
  }};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../services/securityMonitoring.service.js'),'utf8'),context);
  const service=context.module.exports;
  assert.equal((await service.scan()).alerts,1);assert.equal((await service.scan()).alerts,0);
  assert.equal(notifications.length,1);assert.equal(notifications[0].eventKey,'security.activity_detected');
  assert.equal(notifications[0].metadata.link,'/ajustes?panel=jobs-monitoring&tab=security');
  assert.match(notifications[0].payload.detail,/certificado/);
  await assert.rejects(service.setPaused({entity_type:'transport_certificate',entity_id:'gateway',paused:true,reason:'QA'},1),{code:'security_target_invalid'});
  health=[];assert.equal((await service.scan()).alerts,0);assert.equal(notifications.length,1);
});
test('server status requires every configured identity and alerts independently of clients',()=>{
  const ids=['maintenance-client','publisher','authorized','onboarding','inbox','audit-writer','audit-reader'];
  const servers={...healthy,expectedIds:ids,certificates:ids.map(id=>({...healthy.certificates[0],id}))};
  const o={...options(),serversEnabled:true,read:file=>JSON.stringify(file.endsWith('/servers.json')?servers:healthy)};
  assert.deepEqual(readHealth(o),[]);
  servers.certificates[2].status='failed';
  const alert=readHealth(o)[0];assert.equal(alert.entity_id,'authorized');assert.match(alert.label,/Envíos/);
  assert.match(alert.detail,/no pausa/);assert(!alert.detail.includes('Se conserva'));
  servers.certificates.pop();assert.equal(readHealth(o)[0].entity_id,'server-maintenance');
  servers.expectedIds=['maintenance-client','publisher'];servers.certificates=servers.certificates.slice(0,2);
  assert.equal(readHealth(o)[0].entity_id,'server-maintenance');
});
test('enrolled AI and email identities are healthy or alert individually; foreign identities remain invalid',()=>{
  const ids=['maintenance-client','publisher','authorized','onboarding','inbox','ai-staging','bedrock-staging','email-staging','email-dev'];
  const servers={...healthy,expectedIds:ids,certificates:ids.map(id=>({...healthy.certificates[0],id}))};
  const o={...options(),enabled:false,serversEnabled:true,read:()=>JSON.stringify(servers)};
  assert.deepEqual(readHealth(o),[]);
  for(const id of ids.slice(5)){
    const row=servers.certificates.find(c=>c.id===id);row.status='failed';
    const alerts=readHealth(o);assert.equal(alerts.length,1);assert.equal(alerts[0].entity_id,id);
    assert.match(alerts[0].detail,/no pausa/);row.status='healthy';
  }
  servers.expectedIds.push('foreign-runtime');servers.certificates.push({...healthy.certificates[0],id:'foreign-runtime'});
  assert.equal(readHealth(o)[0].entity_id,'server-maintenance');
});
