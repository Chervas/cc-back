'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {pendingReply}=require('../../lib/whatsappPendingReply');
const now=Date.now(),binding={clinicId:2,phoneId:'123',wabaId:'456',sendEnabled:true};
const message={id:9,conversation_id:3,direction:'inbound',message_type:'text',sent_at:new Date(now-5000),
 metadata:{historical:false,passive_recovery:true,provider_type:'text',phone_number_id:'123',waba_id:'456',
 wamid:'wamid.SYNTHETIC',inbox_receipt:'a1234567-1234-4234-8234-123456789abc'}};
async function check(row=message,changes={}) {
 return pendingReply({clinicId:2,anchor:{listened_output:{conversation_id:3,at:new Date(now-172800000).toISOString()}},
 bindings:[binding],snapshot:{},now,query:async(sql,opts)=>{
 assert.match(sql,/a.status<>'completed'/);assert.match(sql,/c.clinic_id=:clinicId/);
 assert.equal(opts.replacements.conversationId,3);return [Array.isArray(row)?row:[row]];},...changes});
}
test('durable unclaimed and queued replies prevent silence without dispatching anything',async()=>{
 assert.equal(await check(),9);
 assert.equal(await check({...message,metadata:{...message.metadata,fresh_inbound_dispatched_at:new Date().toISOString()}}),9);
 assert.equal(message.metadata.fresh_inbound_dispatched_at,undefined);
});
test('a recovered reply holds the timeout for human review without becoming dispatchable',async()=>{
 const recovered={...message,metadata:{...message.metadata,recovery_without_automation:true}};
 assert.deepEqual(await check(recovered),{kind:'recovered',messageId:9});
 assert.deepEqual(await check(recovered,{snapshot:{recoveryNotBefore:new Date(now-1000).toISOString()},
  bindings:[{...binding,messageNotBefore:new Date(now-1000).toISOString()}]}),{kind:'recovered',messageId:9});
 assert.equal(recovered.metadata.recovery_without_automation,true);
 assert.equal(await check([{...recovered,id:10},message]),9);
});
test('historical recovery, another sender and out-of-window replies do not own this wait',async()=>{
 for(const patch of [{historical:true},{phone_number_id:'999'},{waba_id:'999'}])
 assert.equal(await check({...message,metadata:{...message.metadata,...patch}}),null);
 assert.equal(await check({...message,metadata:{...message.metadata,historical:true,recovery_without_automation:true}}),null);
 assert.equal(await check(message,{waitingMeta:{wait_starts_at:new Date(now).toISOString()}}),null);
});
test('a reply older than the dispatch limit needs review, never a false silence decision',async()=>{
 assert.equal(await check({...message,sent_at:new Date(now-90000000)}),9);
});
test('audio still being transcribed holds the native wait without changing the message',async()=>{
 const row={...message,message_type:'audio',metadata:{...message.metadata,provider_type:'audio',media:{id:'synthetic'},audio_transcription:{status:'pending'}}};
 assert.equal(await check(row),9);assert.equal(row.metadata.audio_transcription.status,'pending');
});
