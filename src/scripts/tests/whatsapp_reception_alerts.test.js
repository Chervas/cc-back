'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {collect}=require('../../lib/whatsappReceptionAlerts');
const now=Date.now(),bindings=[{clinicId:2,sendEnabled:true}];
const snapshot={version:1,observedAt:now,clinics:[{clinicId:2,blockingReview:4,unscopedBlockingReview:0,blockingContactKeys:['a'.repeat(64)],oldestPendingAt:null}]};
test('scoped identity warnings reach the email event even without a critical clinic-wide outage',async()=>{
 const alerts=await collect({snapshot,bindings,now,query:async sql=>[sql.includes('FROM Clinicas')?[{id_clinica:2,nombre_clinica:'Ficticia'}]:[]]});
 assert.equal(alerts.length,1);assert.equal(alerts[0].eventKey,'whatsapp.reception_attention');
 assert.equal(alerts[0].payload.severity,'warning');assert.match(alerts[0].payload.detail,/Ficticia/);
 assert.doesNotMatch(JSON.stringify(alerts),/a{64}/);
});
test('a native wait with a durable reply is reported independently of broker health',async()=>{
 const alerts=await collect({snapshot:{...snapshot,clinics:[{clinicId:2,blockingReview:0,oldestPendingAt:null}]},bindings,now,
 query:async sql=>[sql.includes('FROM Clinicas')?[{id_clinica:2,nombre_clinica:'Ficticia'}]:[{id:12,clinic_id:2}]]});
 assert.equal(alerts.length,1);assert.deepEqual(alerts[0].metadata.waiting_execution_ids,[12]);
});
test('stale heartbeat names the monitoring outage without presenting clinics as patient replies',async()=>{
 const stale={...snapshot,observedAt:now-3600000};
 const alerts=await collect({snapshot:stale,bindings,now,
  query:async sql=>[sql.includes('FROM Clinicas')?[{id_clinica:2,nombre_clinica:'Ficticia'}]:[]]});
 assert.equal(alerts[0].payload.severity,'critical');
 assert.match(alerts[0].payload.title,/no se actualiza/i);
 assert.match(alerts[0].payload.detail,/control de recepción no se actualiza/);
 assert.match(alerts[0].payload.detail,/No hay respuestas ya registradas pendientes/);
 assert.doesNotMatch(alerts[0].payload.detail,/incidencias de recepción/);
});
test('fresh backlog is reported as events pending import or review',async()=>{
 const delayed={...snapshot,clinics:[{clinicId:2,blockingReview:0,oldestPendingAt:now-300000}]};
 const alerts=await collect({snapshot:delayed,bindings,now,
  query:async sql=>[sql.includes('FROM Clinicas')?[{id_clinica:2,nombre_clinica:'Ficticia'}]:[]]});
 assert.match(alerts[0].payload.detail,/eventos de WhatsApp pendientes de importar o revisar/);
 assert.match(alerts[0].payload.detail,/evento pendiente más antiguo es del/);
});
test('storage capacity warns independently before a full inbox rejects Meta webhooks',async()=>{
 const clean={...snapshot,clinics:[{clinicId:2,blockingReview:0,oldestPendingAt:null}],
  capacity:{rows:800,bytes:100,maxRows:1000,maxBytes:1000,auditPending:0,maxAuditBacklog:100}};
 const query=async()=>[[]];
 const warning=await collect({snapshot:clean,bindings,now,query});
 assert.equal(warning.length,1);assert.equal(warning[0].eventKey,'whatsapp.inbox_capacity_warning');
 assert.equal(warning[0].payload.severity,'warning');assert.match(warning[0].payload.detail,/800\/1000 recibos/);
 assert.equal((await collect({snapshot:clean,bindings:[],now,query:async()=>{throw Error('unexpected query')}}))[0].eventKey,
  'whatsapp.inbox_capacity_warning');
 const critical=await collect({snapshot:{...clean,capacity:{...clean.capacity,auditPending:91}},bindings,now,query});
 assert.equal(critical[0].payload.severity,'critical');
 assert.equal(critical[0].eventKey,'whatsapp.inbox_capacity_critical');
 assert.deepEqual(await collect({snapshot:{...clean,observedAt:now-3600000},bindings,now,
  query:async sql=>[sql.includes('FROM Clinicas')?[{id_clinica:2,nombre_clinica:'Ficticia'}]:[]]})
  .then(alerts=>alerts.map(a=>a.eventKey)),['whatsapp.reception_attention']);
});
test('archive delay warns without patient content and does not mask a healthy clinical importer',async()=>{
 const clean={...snapshot,clinics:[{clinicId:2,blockingReview:0,oldestPendingAt:null}],
  archive:{pending:3,oldestAt:now-121000}};
 const alerts=await collect({snapshot:clean,bindings,now,query:async()=>[[]]});
 assert.equal(alerts.length,1);
 assert.equal(alerts[0].eventKey,'whatsapp.inbox_archive_delayed');
 assert.equal(alerts[0].payload.severity,'critical');
 assert.equal(alerts[0].metadata.pending,3);
  assert.doesNotMatch(JSON.stringify(alerts),/phone|contact|content/);
  assert.deepEqual(await collect({snapshot:{...clean,archive:{pending:0,oldestAt:null}},bindings,now,query:async()=>[[]]}),[]);
  const tagging=await collect({snapshot:{...clean,archive:{pending:0,oldestAt:null,
    untaggedImported:2,oldestUntaggedAt:now-121000}},bindings,now,query:async()=>[[]]});
  assert.equal(tagging[0].eventKey,'whatsapp.inbox_archive_delayed');
  assert.equal(tagging[0].metadata.untagged_imported,2);
  const progressing={...clean,archive:{...clean.archive,lastArchivedAt:now-1000}};
  assert.deepEqual(await collect({snapshot:progressing,bindings,now,query:async()=>[[]]}),[]);
  const stopped={...progressing,archive:{...progressing.archive,lastArchivedAt:now-121000}};
  assert.equal((await collect({snapshot:stopped,bindings,now,query:async()=>[[]]}))[0].eventKey,
    'whatsapp.inbox_archive_delayed');
  const retrying={...progressing,archive:{...progressing.archive,failedArchive:1}};
  const retryAlert=(await collect({snapshot:retrying,bindings,now,query:async()=>[[]]}))[0];
  assert.equal(retryAlert.eventKey,'whatsapp.inbox_archive_delayed');
  assert.match(retryAlert.payload.detail,/1 recibo requiere/);
});
test('unconfigured environments do not inspect or notify clinical reception',async()=>{
 assert.deepEqual(await collect({snapshot:null,bindings:[],query:async()=>{throw Error('unexpected query')}}),[]);
});

// Exercise the same replacement parser as Sequelize.query. A mysql2-only
// diagnostic used a different formatter and failed to reveal the '<:until' bug.
test('production Sequelize parser replaces every parameter in reception SQL',async()=>{
 const {Sequelize}=require('sequelize');
 const {injectReplacements}=require('sequelize/lib/utils/sql');
 const sqlEngine=new Sequelize('synthetic','synthetic','synthetic',{dialect:'mysql',logging:false});
 let queries=0;
 const alerts=await collect({snapshot,bindings,now,query:async(sql,options)=>{
  const rendered=injectReplacements(sql,sqlEngine.dialect,options.replacements);
  assert.doesNotMatch(rendered,/:[a-zA-Z][a-zA-Z0-9_]*/);
  if(sql.includes('FlowExecutionsV2'))assert.match(rendered,/wait_until\s*<\s*'\d{4}-\d{2}-\d{2}/);
  queries++;
  return [sql.includes('FROM Clinicas')?[{id_clinica:2,nombre_clinica:'Ficticia'}]:[]];
 }});
 assert.equal(queries,3);assert.equal(alerts[0].payload.severity,'warning');
});
test('stale WABA template notices are reported without patient data', async () => {
 const clean={...snapshot,clinics:[{clinicId:2,blockingReview:0,oldestPendingAt:null}]};
 const alerts=await collect({snapshot:clean,bindings,now,query:async sql=>[
  sql.includes('WhatsappInboxAdminSync')?[{pending:3}]:[]]});
 assert.equal(alerts.length,1);
 assert.equal(alerts[0].eventKey,'whatsapp.template_reconciliation_delayed');
 assert.equal(alerts[0].metadata.pending,3);
 assert.doesNotMatch(JSON.stringify(alerts),/phone|contact|content/);
});
test('query failure retains a safe diagnostic code without SQL or error details',()=>{
 const {unavailable}=require('../../lib/whatsappReceptionAlerts');
 const alert=unavailable({original:{code:'ER_PARSE_ERROR'},sql:'private SQL',message:'private details'});
 assert.equal(alert.metadata.check_error_code,'ER_PARSE_ERROR');
 assert.equal(alert.payload.severity,'critical');
 assert.doesNotMatch(JSON.stringify(alert),/private/);
 assert.equal(unavailable({code:'private secret'}).metadata.check_error_code,'CHECK_FAILED');
});
