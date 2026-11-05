'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const I = require('../src/whatsapp-image'); const C = require('../src/whatsapp-authorized-contract');
const { createWhatsappAuthorizedOperations } = require('../src/whatsapp-authorized-operations');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII=', 'base64');
const image = () => ({ base64: png.toString('base64'), mime_type: 'image/png', sha256: createHash('sha256').update(png).digest('hex'), caption: 'Synthetic photo' });
test('typed image bytes accept JPEG/PNG with exact hash and reject URLs, malformed data, forged MIME and oversized files', () => {
  assert.deepEqual(I.decode(image()), png);
  for (const change of [{mime_type:'image/svg+xml'}, {mime_type:'image/jpeg'}, {sha256:'0'.repeat(64)}, {base64:'bad?='}, {link:'https://other.invalid/image'}, {caption:'x'.repeat(1025)}, {base64:'A'.repeat(Math.ceil(I.MAX_BYTES/3)*4+4)}])
    assert.throws(() => I.decode({...image(),...change}), {code:'invalid_request'});
  assert.throws(() => C.validateMessage({messaging_product:'whatsapp',to:'34000000123',type:'image',image:{id:'401'}}),{code:'invalid_request'});
  assert.throws(() => C.validateMessage({messaging_product:'whatsapp',to:'34000000123',type:'image',image:image()},{provider:true}),{code:'invalid_request'});
});
test('one in-memory upload precedes one send; receipt never contains bytes and revocation is checked between calls', async () => {
  const calls=[]; let active=true;
  const registry={assert:()=>{if(!active)throw Object.assign(Error('asset_revoked'),{code:'asset_revoked'});return{definition:{phoneId:'401',authorizationId:'a'}};},authorize:()=>{}};
  const operations=createWhatsappAuthorizedOperations({registry,secrets:{proof:()=> 'a'.repeat(64)},store:{connectionState:()=> 'active'},
    http:async request=>{calls.push(structuredClone({...request,token:undefined,signal:undefined}));return request.action==='media_upload'?{id:'501'}:{messages:[{id:'wamid.SYNTHETIC'}]};}});
  const payload={authorizationId:'a1234567-1234-4234-8234-123456789abc',phoneId:'401',message:{messaging_product:'whatsapp',to:'34000000123',type:'image',image:image()}};
  registry.assert=()=>{if(!active)throw Object.assign(Error('asset_revoked'),{code:'asset_revoked'});return{definition:{phoneId:'401',authorizationId:payload.authorizationId}};};
  const result=await operations[C.SEND].execute({payload,binding:{connectionRef:'qa'},secret:Buffer.from('FICTITIOUS'),assertActive:()=>{}});
  assert.deepEqual(calls.map(v=>v.action),['media_upload','send']);
  assert.deepEqual(calls[1].json.image,{id:'501',caption:'Synthetic photo'});
  assert(!JSON.stringify(result).includes(image().base64)); assert.equal(result.media.id,'501'); assert.equal(result.media.sha256,image().sha256);
  calls.length=0;
  const revoked=createWhatsappAuthorizedOperations({registry,secrets:{proof:()=> 'a'.repeat(64)},store:{connectionState:()=> 'active'},
    http:async request=>{calls.push(request.action);active=false;return{id:'501'};}});
  await assert.rejects(revoked[C.SEND].execute({payload,binding:{connectionRef:'qa'},secret:Buffer.from('FICTITIOUS'),assertActive:()=>{}}),{code:'asset_revoked'});
  assert.deepEqual(calls,['media_upload']);
});
