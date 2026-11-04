'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {createHash}=require('node:crypto');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
const health=require('../../lib/whatsappInboxHealth');
const {pendingReply}=require('../../lib/whatsappPendingReply');
test('native fresh dispatch isolates unscoped echoes, preserves HOLD and routes expired replies to review',async()=>{
 await withIsolatedCampaignMysql(async({sql,models,report})=>{
  await sql.query('CREATE TABLE Conversations(id INT PRIMARY KEY,clinic_id INT,channel VARCHAR(20),contact_id VARCHAR(30),patient_id INT)');
  await sql.query('CREATE TABLE Messages(id INT PRIMARY KEY,conversation_id INT,direction VARCHAR(20),message_type VARCHAR(20),metadata JSON,sent_at DATETIME(3))');
  await sql.query('CREATE TABLE WhatsappInboxMessageKeys(message_id INT PRIMARY KEY)');
  await sql.query('CREATE TABLE WhatsappInboxImports(receipt VARCHAR(50) PRIMARY KEY,clinic_id INT,phone_id VARCHAR(20))');
  await sql.query('CREATE TABLE AutomationInboundMessageClaims(message_id INT PRIMARY KEY,status VARCHAR(20))');
  await sql.query('CREATE TABLE WhatsappInboxContactKeys(contact_key VARCHAR(64) PRIMARY KEY,conversation_id INT)');
  const now=Date.now(),b={clinicId:71,assetId:4,phoneId:'201',wabaId:'101',sendEnabled:true,authorizationId:'synthetic'};
  const config={bindings:[b],messageNotBefore:new Date(now-172800000).toISOString()};
  const key=createHash('sha256').update(JSON.stringify([71,'201','19995550002'])).digest('hex');
  const category=(name,count)=>({category:name,count,oldestAt:now-86400000,newestAt:now-86400000,errorCodes:[]});
  const snapshot={version:1,observedAt:now,recoveryHold:false,clinics:[{clinicId:71,oldestPendingAt:null,
   blockingReview:18,unscopedBlockingReview:17,blockingContactKeys:[key],
   unscopedReviewSummary:[category('mobile_echoes',8),category('user_identity_unresolved',9)]}]};
  for(let id=1;id<=5;id++) {
   const metadata={historical:false,passive_recovery:true,provider_type:'text',phone_number_id:'201',waba_id:'101',
    wamid:'wamid.SYNTHETIC'+id,inbox_receipt:'a1234567-1234-4234-8234-'+String(id).padStart(12,'0'),
    ...(id===5?{recovery_without_automation:true}:{})};
   await sql.query("INSERT INTO Conversations VALUES(:id,71,'whatsapp',:peer,:patient)",{replacements:{id,peer:'1999555000'+id,patient:id===4?4:null}});
   await sql.query("INSERT INTO Messages VALUES(:id,:id,'inbound','text',:metadata,:at)",{replacements:{id,metadata:JSON.stringify(metadata),at:new Date(now-(id===3?90000000:5000))}});
   await sql.query('INSERT INTO WhatsappInboxMessageKeys VALUES(:id)',{replacements:{id}});
   await sql.query("INSERT INTO WhatsappInboxImports VALUES(:receipt,71,'201')",{replacements:{receipt:metadata.inbox_receipt}});
  }
  models.sequelize=sql;
  models.Message={findByPk:async(id,{transaction,lock})=>{
   const [[row]]=await sql.query('SELECT * FROM Messages WHERE id=:id'+(lock?' FOR UPDATE':''),{replacements:{id},transaction});
   return row&&{...row,update:async({metadata})=>sql.query('UPDATE Messages SET metadata=:metadata WHERE id=:id',{
    replacements:{id,metadata:JSON.stringify(metadata)},transaction})};
  }};
  models.Conversation={findByPk:async(id,{transaction}={})=>(await sql.query('SELECT * FROM Conversations WHERE id=:id',{replacements:{id},transaction}))[0][0]};
  let dispatched=0;
  const sandbox={module:{exports:{}},Date,require:name=>{
   if(name==='../../models')return models;
   if(name==='../lib/whatsappFreshInboundEligibility')return require('../../lib/whatsappFreshInboundEligibility');
   if(name==='../lib/whatsappInboxHealth')return {...health,read:()=>({...snapshot,observedAt:Date.now()})};
   if(name==='../lib/whatsappAuthorizedBrokerClient')return {configuration:()=>config,binding:async()=>b};
   if(name==='../lib/whatsappAppointmentEligibility')return {patientImportHeld:async id=>id===4};
   if(name==='../lib/whatsappImportedReminderRelease'||name==='../lib/whatsappImportedAppointmentOperations')return {permitsReply:async()=>false};
   if(name==='./automationInboundMessage.service')return {enqueueInboundDispatch:async({inboundMessage})=>{
    assert.equal(inboundMessage.id,1);dispatched++;
   }};
   throw Error('unexpected test dependency '+name);
  }};
  vm.createContext(sandbox);vm.runInContext(fs.readFileSync(require.resolve('../../services/whatsappFreshInbound.service'),'utf8'),sandbox);
  const tick=sandbox.module.exports.tick;
  await Promise.all([tick(),tick()]);await tick();assert.equal(dispatched,1);
  const [[marked]]=await sql.query('SELECT COUNT(*) n FROM Messages WHERE JSON_EXTRACT(metadata,\'$.fresh_inbound_dispatched_at\') IS NOT NULL');
  assert.equal(marked.n,1);
  const result=await pendingReply({clinicId:71,anchor:{listened_output:{conversation_id:3,at:config.messageNotBefore}},
   bindings:[b],snapshot,now:Date.now(),query:(...args)=>sql.query(...args)});
  assert.deepEqual(result,{kind:'recovered',messageId:3});
  // No test transport exists: the only observed effect is the native enqueue.
  report.checks.push('real SQL and transaction row locks','concurrent dispatch exactly once','known contact remains held',
   'HOLD preserved','historical recovery not replayed','expired durable response becomes manual review');
 });
});
