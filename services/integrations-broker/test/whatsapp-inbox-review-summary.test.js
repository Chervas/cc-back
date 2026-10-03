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
