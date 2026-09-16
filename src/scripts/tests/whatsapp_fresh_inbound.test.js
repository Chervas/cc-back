'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {eligible}=require('../../lib/whatsappFreshInboundEligibility');
const now=Date.parse('2026-09-15T18:00Z'),cut='2026-09-15T17:00:00Z';
const b={clinicId:2,phoneId:'123',wabaId:'456',sendEnabled:true},c={id:3,clinic_id:2,channel:'whatsapp'};
const message=()=>({direction:'inbound',message_type:'text',conversation_id:3,sent_at:'2026-09-15T17:55Z',metadata:{passive_recovery:true,historical:false,provider_type:'text',phone_number_id:'123',waba_id:'456',wamid:'wamid.SYNTHETIC',inbox_receipt:'a1234567-1234-4234-8234-123456789abc'}});
test('audio waits for transcription; historical recovery never replays automations',()=>{
 const m=message();m.message_type='text';Object.assign(m.metadata,{provider_type:'audio',media:{kind:'audio',id:'999'}});
 assert.equal(eligible(m,c,b,cut,now),false);m.metadata.audio_transcription={status:'success'};assert.equal(eligible(m,c,b,cut,now),true);
 m.metadata.media_recovered_without_automation=true;assert.equal(eligible(m,c,b,cut,now),false);
 delete m.metadata.media_recovered_without_automation;m.metadata.historical=true;assert.equal(eligible(m,c,b,cut,now),false);
});
test('fresh text and button replies from exact active scopes can resume existing automations',()=>{
  for(const type of ['text','button','interactive']){const m=message();m.metadata.provider_type=type;assert.equal(eligible(m,c,b,cut,now),true);}
});
test('history, pre-cutoff replies, echoes, replayed or unproven messages never dispatch',()=>{
  for(const change of [{historical:true},{historical:undefined},{passive_recovery:false},{fresh_inbound_dispatched_at:cut},{inbox_receipt:''},{phone_number_id:'789'},{waba_id:'789'},{provider_type:'reaction'},{wamid:''}]){const m=message();Object.assign(m.metadata,change);assert.equal(eligible(m,c,b,cut,now),false);}
  for(const change of [{direction:'outbound'},{sent_at:'2026-09-15T16:59Z'},{sent_at:'2026-09-15T18:10Z'},{message_type:'event'},{conversation_id:4}]){assert.equal(eligible({...message(),...change},c,b,cut,now),false);}
  assert.equal(eligible(message(),c,{...b,sendEnabled:false},cut,now),false);assert.equal(eligible(message(),{...c,clinic_id:9},b,cut,now),false);
});
test('a newly connected number never automates replies from before its own cutover',()=>{
  const recent={...b,messageNotBefore:'2026-09-15T17:56:00Z'};
  assert.equal(eligible(message(),c,recent,cut,now),false);
  assert.equal(eligible({...message(),sent_at:'2026-09-15T17:57:00Z'},c,recent,cut,now),true);
  assert.equal(eligible(message(),c,b,cut,now),true);
  assert.equal(eligible({...message(),sent_at:'2026-09-15T16:59:00Z'},c,{...b,messageNotBefore:'2026-09-14T00:00:00Z'},cut,now),false);
});
