'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {reviewSummary}=require('../src/whatsapp-inbox-review');
const raw=changes=>Buffer.from(JSON.stringify({object:'whatsapp_business_account',entry:[{id:'synthetic',changes}]}));
test('review diagnostic projection never returns content, identifiers or phones',()=>{
 const event={field:'messages',value:{messages:[{from:'34000000001',text:{body:'PRIVATE_SYNTHETIC'}}]}};
 assert.deepEqual(reviewSummary(raw([event])),{category:'incoming_messages',errorCodes:[]});
 assert.deepEqual(reviewSummary(raw([{field:'smb_message_echoes',value:{message_echoes:[{to:'34000000001'}]}}])),
  {category:'mobile_echoes',errorCodes:[]});
 assert.deepEqual(reviewSummary(raw([{field:'messages',value:{statuses:[{errors:[{code:131042,message:'PRIVATE_SYNTHETIC'}]}]}}])),
  {category:'delivery_updates',errorCodes:[131042]});
 assert.deepEqual(reviewSummary(raw([{field:'messages',value:{errors:[{code:131042},{code:'PRIVATE_SYNTHETIC'}]}}])),
  {category:'provider_errors',errorCodes:[131042]});
 assert.equal(reviewSummary(raw([event,{field:'history',value:{}}])).category,'mixed');
 assert.equal(reviewSummary(Buffer.from('not-json')).category,'unknown');
 assert.equal(reviewSummary(raw([{field:'unknown_future',value:{}}])).category,'unknown');
});
test('signed BSUID-only envelopes are identified without guessing a phone or returning the identifier',()=>{
 const value={messaging_product:'whatsapp',metadata:{phone_number_id:'123456789012345'},
  contacts:[{user_id:'ES.SyntheticUser',profile:{name:'PRIVATE_SYNTHETIC'}}],
  messages:[{from_user_id:'ES.SyntheticUser',id:'wamid.synthetic',timestamp:'1791801000',type:'text',text:{body:'PRIVATE_SYNTHETIC'}}]};
 const summary=reviewSummary(raw([{field:'messages',value}]));
 assert.deepEqual(summary,{category:'user_identity_unresolved',errorCodes:[]});
 assert(!JSON.stringify(summary).includes('Synthetic'));
 for(const alter of [v=>v.messages[0].from_user_id='malformed',v=>v.contacts=[],
  v=>v.contacts.push(v.contacts[0]),v=>v.contacts[0].wa_id='34000000001',v=>v.messages[0].from='bad',
  v=>v.messages[0].id='invalid',v=>v.messages[0].timestamp='bad',v=>v.metadata.phone_number_id='bad']) {
  const v=structuredClone(value);alter(v);
  assert.equal(reviewSummary(raw([{field:'messages',value:v}])).category,'incoming_messages');
 }
 const mixed=structuredClone(value);mixed.statuses=[{status:'read'}];
 assert.equal(reviewSummary(raw([{field:'messages',value:mixed}])).category,'mixed');
});
