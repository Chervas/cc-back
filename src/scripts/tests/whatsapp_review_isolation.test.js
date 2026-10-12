'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
require('./fixtures/campaign_offline_runtime.cjs');
const {createHash}=require('node:crypto');
const health=require('../../lib/whatsappInboxHealth');
const {decide}=require('../../lib/whatsappAppointmentTimeout');
const {reviewContacts}=require('../../../services/integrations-broker/src/whatsapp-inbox-review');
const now=Date.parse('2026-09-29T08:00:00Z');
const hash=peer=>createHash('sha256').update(JSON.stringify([72,'201',peer])).digest('hex');
function snapshot(){return {version:1,observedAt:now,recoveryHold:false,clinics:[{clinicId:72,oldestPendingAt:null,blockingReview:4,
 unscopedBlockingReview:0,blockingContactKeys:[hash('19995550101')]}]};}
test('signed-event attribution contains only contact hashes; mixed, unknown and malformed events stay unscoped',()=>{
 const scope=[{clinicIds:[72],phoneId:'201',wabaId:'101'}];
 const body={object:'whatsapp_business_account',entry:[{id:'101',changes:[{field:'messages',value:{messaging_product:'whatsapp',metadata:{phone_number_id:'201'},messages:[{from:'19995550101',type:'text',text:{body:'SYNTHETIC'}}]}}]}]};
 assert.deepEqual(reviewContacts(Buffer.from(JSON.stringify(body)),scope),[{clinicId:72,contactKey:hash('19995550101')}]);
 for(const change of [b=>b.entry[0].changes[0].field='history',b=>b.entry[0].changes[0].value.messages[0].from='invalid',
  b=>b.entry[0].changes[0].value.statuses=[{status:'read'}],b=>b.entry[0].changes.push({field:'account_update',value:{}})]){
  const b=structuredClone(body);change(b);assert.equal(reviewContacts(Buffer.from(JSON.stringify(b)),scope),null);
 }
 assert.equal(reviewContacts(Buffer.from('invalid'),scope),null);
});
test('health publishing preserves total reviews and falls back conservatively for legacy or malformed isolation metadata',()=>{
 const writes=[];const sandbox={module:{exports:{}},require:name=>name==='node:fs'?{writeFileSync:(_p,text)=>writes.push(JSON.parse(text)),chmodSync:()=>{},renameSync:()=>{}}:require(name)};
 vm.createContext(sandbox);vm.runInContext(fs.readFileSync(require.resolve('../../lib/whatsappInboxHealth'),'utf8'),sandbox);
 const scopes=[{clinicIds:[72],phoneId:'201',wabaId:'101'}];
 for(const isolation of [undefined,{version:1,scopedReviews:4,contacts:[{clinicId:72,contactKey:hash('19995550101')}]},{version:1,scopedReviews:5,contacts:[]}]){
  const s=sandbox.module.exports.publish({observedAt:now,groups:[{scopes:['101:201'],oldestPendingAt:null,blockingReview:4,review:2,reviewIsolation:isolation}]},scopes);
  assert.equal(s.clinics[0].blockingReview,4);assert.equal(s.clinics[0].unscopedBlockingReview,isolation?.scopedReviews===4?0:4);
 }
 assert.equal(writes.length,3);
 const capacity={rows:80,bytes:1024,maxRows:100,maxBytes:2048,auditPending:2,maxAuditBacklog:10};
 const measured=sandbox.module.exports.publish({observedAt:now,groups:[],capacity},scopes);
 assert.deepEqual(JSON.parse(JSON.stringify(measured.capacity)),capacity);
 assert.throws(()=>sandbox.module.exports.publish({observedAt:now,groups:[],capacity:{...capacity,maxRows:0}},scopes),
  /inbox_health_capacity_invalid/);
 assert.equal(writes.length,4);
});
test('known-contact review affects only that contact, including old aliases after its current phone changes',async()=>{
 const s=snapshot(),bindings=[{clinicId:72,phoneId:'201'}];
 const conversation={id:7,clinic_id:72,channel:'whatsapp',contact_id:'+19995550202'};
 let calls=0;
 const query=async(sql,{replacements})=>{calls++;assert.match(sql,/k.contact_key IN \(:reviewKeys\)/);assert.equal(replacements.clinicId,72);return [[]]};
 const healthy=await health.forConversation(s,conversation,bindings,query,{now});
 assert.equal(healthy.readyForReplies,true);assert.equal(healthy.readyForTimeout,true);assert.equal(calls,1);
 const oldAlias=await health.forConversation(s,conversation,bindings,async()=>[[{contact_key:hash('19995550101')}]],{now});
 assert.equal(oldAlias.readyForReplies,false);assert.equal(oldAlias.readyForTimeout,false);
 const samePhone=await health.forConversation(s,{...conversation,contact_id:'19995550101'},bindings,query,{now});assert.equal(samePhone.healthy,false);
 const legacy=structuredClone(s);delete legacy.clinics[0].unscopedBlockingReview;
 assert.equal((await health.forConversation(legacy,conversation,bindings,query,{now})).healthy,false);
 assert.equal(health.state(s,72,now).healthy,false); // Monitoring still exposes unresolved reviews.
 assert.equal(health.issues(s,[72],now)[0].severity,'warning');
});
test('no-response decisions keep outage, unknown-review, expired-appointment and duplicate-recovery protections',async()=>{
 const appointment={id_cita:1,clinica_id:72,inicio:'2026-09-29T15:00:00Z',estado:'info_enviada'};
 const input={now,execution:{clinic_id:72,trigger_entity_id:1,wait_until:new Date(now),waiting_meta:{}},context:{appointment},nextNode:{type:'action/send_whatsapp'},
  loadAppointment:async()=>appointment,hasAskedToday:async()=>false};
 const knownKeys={contactKeys:[hash('19995550202')]};
 const s=snapshot();const normal=health.state(s,72,now,knownKeys);
 assert.equal((await decide({...input,receptionState:normal})).action,'continue');
 for(const alter of [s=>s.recoveryHold=true,s=>s.observedAt=now-90001,s=>s.clinics[0].unscopedBlockingReview=1,s=>s.clinics[0].oldestPendingAt=now-1000]){
  const bad=structuredClone(s);alter(bad);assert.equal((await decide({...input,receptionState:health.state(bad,72,now,knownKeys)})).action,'wait');
 }
 const recovered={...input,execution:{...input.execution,waiting_meta:{inbox_held_since:new Date(now-3600000).toISOString()}},receptionState:normal};
 assert.equal((await decide({...recovered,hasAskedToday:async()=>true})).action,'stop');
 assert.equal((await decide({...recovered,loadAppointment:async()=>({...appointment,inicio:'2026-09-28T15:00:00Z'})})).action,'stop');
});
test('BSUID review permits only verified-phone replies and never silence actions',async()=>{
 const s=snapshot();s.clinics[0].blockingReview=2;s.clinics[0].unscopedBlockingReview=2;s.clinics[0].blockingContactKeys=[];
 s.clinics[0].reviewSummary=[{category:'user_identity_unresolved',count:2,oldestAt:now,newestAt:now,errorCodes:[]}];
 const c={id:7,clinic_id:72,channel:'whatsapp',contact_id:'19995550202'},b=[{clinicId:72,phoneId:'201'}];
 const scoped=await health.forConversation(s,c,b,async()=>[[]],{now});
 assert.equal(scoped.readyForReplies,true);assert.equal(scoped.healthy,false);assert.equal(scoped.readyForTimeout,false);
 assert.equal(health.state(s,72,now).readyForReplies,false);
 for(const alter of [x=>x.recoveryHold=true,x=>x.observedAt=now-90001,
  x=>x.clinics[0].reviewSummary[0].category='incoming_messages',x=>x.clinics[0].reviewSummary[0].count=1,
  x=>x.clinics[0].reviewSummary[0].count=3]) {
  const bad=structuredClone(s);alter(bad);
  assert.notEqual((await health.forConversation(bad,c,b,async()=>[[]],{now})).readyForReplies,true);
 }
 for(const [conversation,bindings] of [[{...c,contact_id:'ES.SyntheticUser'},b],[c,[]],
  [{...c,channel:'instagram'},b],[{...c,clinic_id:35},b]]) {
  assert.notEqual((await health.forConversation(s,conversation,bindings,async()=>[[]],{now})).readyForReplies,true);
 }
 const blocked=structuredClone(s);blocked.clinics[0].blockingReview=3;blocked.clinics[0].blockingContactKeys=[hash(c.contact_id)];
 blocked.clinics[0].reviewSummary.push({category:'incoming_messages',count:1,oldestAt:now,newestAt:now,errorCodes:[]});
 assert.equal((await health.forConversation(blocked,c,b,async()=>[[]],{now})).readyForReplies,false);
});
