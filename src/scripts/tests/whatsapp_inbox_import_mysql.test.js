'use strict';
const test=require('node:test'); const assert=require('node:assert/strict'); const {randomUUID}=require('node:crypto');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
const {SCHEMA,importLease}=require('../../lib/whatsappInboxImport');
test('passive importer commits complete batches once, preserves contacts, rolls back conflicts and never executes business jobs',async()=>{
 await withIsolatedCampaignMysql(async({sql,report})=>{
  await sql.query('CREATE TABLE Clinicas(id_clinica INT PRIMARY KEY)');await sql.query('INSERT INTO Clinicas VALUES(71),(72)');
  await sql.query("CREATE TABLE Conversations(id INT PRIMARY KEY AUTO_INCREMENT,clinic_id INT,channel VARCHAR(20),contact_id VARCHAR(32),unread_count INT,last_message_at DATETIME(3),last_inbound_at DATETIME(3),createdAt DATETIME(3),updatedAt DATETIME(3))");
  await sql.query("CREATE TABLE Messages(id INT PRIMARY KEY AUTO_INCREMENT,conversation_id INT,direction VARCHAR(20),content TEXT,message_type VARCHAR(20),status VARCHAR(20),metadata JSON,sent_at DATETIME(3),createdAt DATETIME(3),updatedAt DATETIME(3))");
  for(const ddl of SCHEMA)await sql.query(ddl);
  const rawConnection=await sql.connectionManager.getConnection();const c=rawConnection.promise();
  const scope={clinicId:71,wabaId:'101',phoneId:'201'};
  const m=(id,from,body='synthetic cancellation for review')=>({id:'wamid.'+id,from,timestamp:'1789430400',type:'text',text:{body}});
  const lease=(messages,changes)=>({receipt:randomUUID(),lease:randomUUID(),automaticActionsAllowed:false,raw:Buffer.from(JSON.stringify({object:'whatsapp_business_account',entry:[{id:'101',changes:changes||[{field:'messages',value:{messaging_product:'whatsapp',metadata:{phone_number_id:'201'},messages}}]}]}))});
  try{
   const first=lease([m('one','19995550101'),m('two','19995550102')]); const saved=await importLease(c,first,scope);
   assert.equal((await importLease(c,first,scope)).importReceipt,saved.importReceipt);
   await importLease(c,lease([m('one','19995550101')]),scope);
   const [[count]]=await sql.query('SELECT COUNT(*) n,SUM(unread_count) unread FROM Conversations');assert.equal(count.n,2);assert.equal(Number(count.unread),2);
   assert.equal((await sql.query('SELECT COUNT(*) n FROM Messages'))[0][0].n,2);
   await assert.rejects(importLease(c,lease([m('three','19995550103'),m('one','19995550101','conflicting content')]),scope),/review_required/);
   assert.equal((await sql.query('SELECT COUNT(*) n FROM Messages'))[0][0].n,2);
   assert.equal((await sql.query('SELECT COUNT(*) n FROM Conversations'))[0][0].n,2);
   await assert.rejects(importLease(c,first,{...scope,clinicId:72}),/review_required/);
   const history=[{field:'history',value:{messaging_product:'whatsapp',metadata:{phone_number_id:'201'},history:[{threads:[{id:'19995550101',messages:[m('one','19995550101'),{...m('out','19995559999','synthetic clinic reply'),to:'19995550101'}]}]}]}}];
   await importLease(c,lease(null,history),scope);
   await importLease(c,lease(null,[{field:'messages',value:{messaging_product:'whatsapp',metadata:{phone_number_id:'201'},statuses:[{id:'wamid.out',status:'read'}]}}]),scope);
   await importLease(c,lease(null,[{field:'messages',value:{messaging_product:'whatsapp',metadata:{phone_number_id:'201'},statuses:[{id:'wamid.out',status:'sent'}]}}]),scope);
   assert.equal((await sql.query("SELECT status FROM Messages WHERE direction='outbound'"))[0][0].status,'read');
   await assert.rejects(importLease(c,lease([m('new','19995550109')],[{field:'messages',value:{messaging_product:'whatsapp',metadata:{phone_number_id:'999'},messages:[m('new','19995550109')]}}]),scope),/review_required/);
   await sql.query('DELETE FROM Messages WHERE id=1'); await importLease(c,lease([m('one','19995550101')]),scope);
   assert.equal((await sql.query('SELECT COUNT(*) n FROM Messages'))[0][0].n,2);
   report.checks.push('batch two contacts','receipt replay','WAMID replay across batches/history','atomic conflict rollback','clinic/phone isolation','monotonic statuses','deleted message tombstone');
   await importLease(c,lease([{...m('audio','19995550101'),type:'audio',audio:{id:'501',mime_type:'audio/ogg',voice:true}}]),scope);
   const [[audio]]=await sql.query("SELECT message_type,metadata FROM Messages WHERE JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.provider_type'))='audio'");
   assert.equal(audio.message_type,'text'); // Ordinary bubble keeps playback controls.
   assert.equal(audio.metadata.media.id,'501');assert.equal(audio.metadata.media.playable,true);
   await importLease(c,lease(null,[{field:'messages',value:{messaging_product:'whatsapp',metadata:{phone_number_id:'201'},statuses:[{id:'wamid.out',status:'failed',errors:[{code:131026,title:'Message undeliverable'}]}]}}]),scope);
   assert.equal((await sql.query("SELECT status FROM Messages WHERE direction='outbound'"))[0][0].status,'read');
   await sql.query("UPDATE Messages SET status='sent' WHERE direction='outbound'");
   await importLease(c,lease(null,[{field:'messages',value:{messaging_product:'whatsapp',metadata:{phone_number_id:'201'},statuses:[{id:'wamid.out',status:'failed',errors:[{code:131026,title:'Message undeliverable'}]}]}}]),scope);
   const [[failed]]=await sql.query("SELECT status,metadata FROM Messages WHERE direction='outbound'");assert.equal(failed.status,'failed');assert.equal(failed.metadata.wa_error[0].code,131026);
  }finally{await sql.connectionManager.releaseConnection(rawConnection);}
 });
});
