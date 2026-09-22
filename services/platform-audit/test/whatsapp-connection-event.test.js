'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {pack,unpack,keyFor}=require('../src/event');
test('WhatsApp completion and routing audit binds authenticated actor and numeric assets without provider secrets',()=>{
  const v={version:26,eventId:randomUUID(),correlationId:randomUUID(),occurredAt:new Date().toISOString(),action:'integration.whatsapp.activate',
    stage:'completed',outcome:'success',reason:'connection_activated',actor:{type:'user',id:'501'},scope:{type:'group',id:'9'},
    sessionRef:randomUUID(),requestRef:randomUUID(),assetIds:['991'],capturePolicy:'whatsapp-operational-v1'};
  const packed=pack(v);assert.equal(unpack(packed).digest,packed.digest);assert(keyFor(packed).startsWith('app/platform/v26/'));
  pack({...v,action:'integration.whatsapp.routing',reason:'routing_saved',assetIds:['990','991']});
  for(const changed of [{token:'FORBIDDEN'},{pin:'123456'},{reason:'arbitrary'},{sessionRef:null},{assetIds:['991','991']},{actor:{type:'user',id:null}},
    {action:'integration.whatsapp.routing',reason:'connection_activated'}])assert.throws(()=>pack({...v,...changed}),/audit_event_invalid/);
});
