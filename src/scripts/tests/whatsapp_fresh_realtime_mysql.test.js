'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
const {createRealtimeDispatcher}=require('../../services/whatsappFreshRealtime.service');
test('fresh view notifications survive bus failure, isolate phones and never replay business actions',async()=>{
 await withIsolatedCampaignMysql(async({sql,report})=>{
  await sql.query('CREATE TABLE Conversations(id INT PRIMARY KEY,clinic_id INT,channel VARCHAR(20))');
  await sql.query("CREATE TABLE Messages(id INT PRIMARY KEY,conversation_id INT,direction VARCHAR(20),content TEXT,message_type VARCHAR(20),status VARCHAR(20),metadata JSON,sent_at DATETIME(3),createdAt DATETIME(3),updatedAt DATETIME(3))");
  await sql.query("INSERT INTO Conversations VALUES(1,71,'whatsapp'),(2,72,'whatsapp')");
  const add=async(id,conversation,phone,metadata={},at='2026-09-15 18:00:00')=>sql.query("INSERT INTO Messages VALUES(:id,:conversation,'inbound','FICTITIOUS_PRIVATE_TEXT','text','sent',:metadata,:at,:at,:at)",{replacements:{id,conversation,at,metadata:JSON.stringify({phone_number_id:phone,...metadata})}});
  await add(1,1,'201');await add(2,2,'201');await add(3,1,'202');await add(4,1,'201',{},'2026-09-14 18:00:00');
  await add(5,1,'201',{historical:true});await add(6,1,'201',{qa_cleanup:true});
  await add(7,1,'201',{import_hold:true}); // Reception remains visible even while automatic replies are held.
  const config={bindings:[{clinicId:71,phoneId:'201',sendEnabled:false}],messageNotBefore:'2026-09-15T17:00:00Z'};
  const events=[];let fail=true,drift=false;
  const dispatch=createRealtimeDispatcher({database:()=>sql,configuration:()=>drift?{...config,bindings:[]}:config,publish:async(...args)=>{if(fail)throw Error('redis_down');events.push(args);return 1;}});
  await assert.rejects(dispatch(),/redis_down/);
  assert.equal((await sql.query("SELECT COUNT(*) n FROM Messages WHERE JSON_EXTRACT(metadata,'$.fresh_realtime_status') IS NOT NULL"))[0][0].n,0);
  fail=false;assert.equal((await dispatch()).notified,2);assert.deepEqual(events.map(e=>e[1].id),[1,7]);
  assert(events.every(e=>e[0]==='message:created'&&e[2][0]==='clinic:71'&&!Object.hasOwn(e[1],'content')&&!Object.hasOwn(e[1],'resume_text')));
  assert.equal((await dispatch()).notified,0);
  await sql.query("INSERT INTO Messages VALUES(8,1,'outbound','FICTITIOUS_PRIVATE_REPLY','text','sent',:metadata,'2026-09-15 18:01:00','2026-09-15 18:01:00','2026-09-15 18:01:00')",{replacements:{metadata:JSON.stringify({phone_number_id:'201',source_event:'smb_message_echoes',coexistence:{source_event:'smb_message_echoes'}})}});
  const reconciliations=[];
  const deliveryReconciliations=[];
  const humanReplyDispatch=createRealtimeDispatcher({database:()=>sql,configuration:()=>config,publish:async(...args)=>{events.push(args);return 1;},reconcileHumanReply:async input=>{reconciliations.push(input);return{reconciled:true,notifications_updated:1,automation_state_completed:true};},reconcileDeliveryStatus:async input=>{deliveryReconciliations.push(input);return{reconciled:true,status:input.status};}});
  assert.deepEqual(await humanReplyDispatch(),{notified:1,human_replies_reconciled:1,delivery_statuses_reconciled:1});
  assert.deepEqual(reconciliations,[{clinicId:71,conversationId:1,messageId:8}]);
  assert.deepEqual(deliveryReconciliations,[{clinicId:71,messageId:8,status:'sent'}]);
  const [[humanReply]]=await sql.query('SELECT metadata FROM Messages WHERE id=8');
  assert.ok(humanReply.metadata.fresh_human_reply_reconciled_at);assert.equal(humanReply.metadata.fresh_human_reply_reconciliation.automation_state_completed,true);
  assert.deepEqual(await humanReplyDispatch(),{notified:0,human_replies_reconciled:0,delivery_statuses_reconciled:0});
  await sql.query("UPDATE Messages SET metadata=JSON_SET(metadata,'$.fresh_realtime_status','media_updated') WHERE id=1");
  assert.equal((await dispatch()).notified,1);
  assert.equal(events.at(-1)[0],'message:updated');
  assert.equal((await dispatch()).notified,0);
  await sql.query("UPDATE Messages SET status='read' WHERE id=1");await dispatch();assert.equal(events.at(-1)[0],'message:updated');assert.equal(events.at(-1)[1].status,'read');
  assert.equal((await sql.query("SELECT updatedAt FROM Messages WHERE id=1"))[0][0].updatedAt.toISOString(),'2026-09-15T18:00:00.000Z');
  // Delivery races preserve a newer database status for another notification.
  await sql.query("UPDATE Messages SET status='delivered' WHERE id=1");
  const racing=createRealtimeDispatcher({database:()=>sql,configuration:()=>config,publish:async()=>{await sql.query("UPDATE Messages SET status='read' WHERE id=1");return 1;}});
  await racing();assert.equal((await dispatch()).notified,0); // Existing read notification is already authoritative.
  let reads=0;const changed=createRealtimeDispatcher({database:()=>sql,configuration:()=>++reads>1?{...config,bindings:[]}:config,publish:async()=>{throw Error('must_not_publish')}});
  await sql.query("UPDATE Messages SET status='delivered' WHERE id=1");await assert.rejects(changed(),/scope_changed/);
  report.checks.push('Redis failure preserves notification','exact clinic and phone','history and cutoff excluded','import holds do not hide reception','created/read notifications','mobile echo reconciliation after commit','no message text or automation trigger','configuration race','updatedAt preserved');
 });
});
