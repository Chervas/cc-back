'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const vm = require('node:vm');
const image = require('../../lib/quickchat-image');
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII=';
const body=()=>({message_type:'image',message:'Synthetic photo',attachmentRequestId:'a1234567-1234-4234-8234-123456789abc',attachment:{base64:png,mime_type:'image/png'}});
function fixture({access=true,open=true,existing=null,unknown=false}={}){
  const calls={queue:0,send:0,rows:[],rollback:0,commit:0};
  const conversation={id:71,clinic_id:123,channel:'whatsapp',contact_id:'34000000123',save:async()=>{}};
  const transaction={LOCK:{UPDATE:'UPDATE'},commit:async()=>{calls.commit++;transaction.finished='commit';},rollback:async()=>{calls.rollback++;transaction.finished='rollback';}};
  const metadata=[];
  const context={exports:{},console,Buffer,Op:{and:Symbol('and')},
    require:name=>{if(name==='../lib/quickchat-image')return image;if(name==='../services/temporaryPatientDirection.service')return{observeConversation:async()=>{}};throw Error('Forbidden module '+name);},
    db:{sequelize:{transaction:async()=>transaction,where:()=>({}),json:()=>({})}},
    Conversation:{findByPk:async()=>conversation}, Message:{findOne:async()=>existing,create:async values=>{calls.rows.push(structuredClone(values));return{...values,id:77,save:async()=>{}};}},
    getUserClinics:async()=>({clinicIds:[123]}),ensureAccess:()=>access,ensureQuickChatConversationReadAccess:async()=>{},sendQuickChatCategoryForbidden:()=>{},
    findCanonicalWhatsappConversation:async()=>null,getIO:()=>null,
    patientDirectionService:{resolveOutboundPolicy:async()=>({clinicConfig:{authorizedBroker:{},phoneNumberId:'401'}})},isWhatsappRoutingConfigAvailable:()=>true,
    resolveWhatsappServiceWindow:async()=>({open}),
    whatsappService:{normalizePhoneNumber:v=>v,assertRecipientCanReceive:async()=>{},checkOutboundLimit:async()=>({}),sendMessage:async input=>{calls.send++;metadata.push(input);if(unknown)throw Object.assign(Error('unknown'),{code:'whatsapp_delivery_unknown',delivery_unknown:true});return{messages:[{id:'wamid.SYNTHETIC'}],media:{id:'501',mime_type:'image/png',sha256:input.image.sha256}};}},
    queues:{outboundWhatsApp:{add:async()=>{calls.queue++;}}},markBufferedResponseExecutionsForHumanReply:async()=>{},
    completeAutomationStateAfterHumanReplyForConversation:async()=>({}),resolveAutomationAttentionForConversation:async()=>({}),process:{env:{}}};
  const source=fs.readFileSync(require.resolve('../../controllers/conversation.controller'),'utf8');
  vm.runInNewContext(source.slice(source.indexOf('exports.postMessage ='),source.indexOf('exports.sendScheduledMessageNow =')),context);
  const req={params:{id:'71'},userData:{userId:1},body:body(),rawBody:Buffer.from('fictitious request'),quickChatImageUpload:true};
  const res={statusCode:200,status(n){this.statusCode=n;return this;},json(data){this.body=data;return this;}};
  return{calls,req,res,run:()=>context.exports.postMessage(req,res)};
}
test('manual photo sends once from memory, retains only receipt metadata and wipes request buffers',async()=>{
  const f=fixture();await f.run();assert.equal(f.res.statusCode,200);assert.equal(f.calls.send,1);assert.equal(f.calls.queue,0);
  assert.equal(f.res.body.message.message_type,'image');assert.equal(f.res.body.message.metadata.media.id,'501');
  assert(!JSON.stringify(f.calls.rows).includes(png));assert.equal(f.req.body.attachment.base64,'');assert(f.req.rawBody.every(v=>v===0));
});
test('foreign clinic and closed sender window never send or queue a photo',async()=>{
  for(const options of [{access:false},{open:false}]){const f=fixture(options);await f.run();assert([400,403].includes(f.res.statusCode));assert.equal(f.calls.send,0);assert.equal(f.calls.queue,0);assert.equal(f.calls.rows.length,0);}
});
test('an existing request identity returns its message without a second dispatch',async()=>{
  const parsed=image.parse(body());const existing={id:77,sender_id:1,content:parsed.caption,status:'sent',metadata:image.metadata(parsed)};
  const f=fixture({existing});await f.run();assert.equal(f.res.statusCode,200);assert.equal(f.res.body.replayed,true);assert.equal(f.calls.send,0);assert.equal(f.calls.rows.length,0);
});
test('uncertain delivery is retained without image bytes, retry queue or another provider call',async()=>{
  const f=fixture({unknown:true});await f.run();assert.equal(f.res.statusCode,502);assert.equal(f.calls.send,1);assert.equal(f.calls.queue,0);assert.equal(f.res.body.message.metadata.delivery_unknown,true);assert(!JSON.stringify(f.res.body).includes(png));
});
test('reading a sent photo streams the broker receipt without calling legacy media or writing an asset',async()=>{
  const parsed=image.parse(body()),bytes=Buffer.from('FICTITIOUS_MEDIA');let reads=0;
  const row={id:77,conversation_id:71,direction:'outbound',message_type:'image',metadata:{...image.metadata(parsed),transport_origin:'clinicaclick',media:{...image.metadata(parsed).media,id:'501'}}};
  const context={exports:{},console,Buffer,Message:{findByPk:async()=>row},Conversation:{findByPk:async()=>({id:71,clinic_id:123})},
    getUserClinics:async()=>({clinicIds:[123]}),ensureAccess:()=>true,ensureQuickChatConversationReadAccess:async()=>{},
    STREAMABLE_MEDIA_KINDS:new Set(['image']),INLINE_MEDIA_KINDS:new Set(['image']),
    normalizeMediaMimeType:v=>v,getDefaultMimeTypeForKind:()=> 'image/png',extensionForMediaMimeType:()=> 'png',
    whatsappService:{getClinicConfig:()=>{throw Error('Legacy token forbidden');}},
    require:name=>{if(name==='../lib/quickchat-image')return image;if(name==='../lib/whatsappAuthorizedBrokerClient')return{configuration:()=>({}),media:async id=>{assert.equal(id,77);reads++;return{buffer:bytes,contentType:'image/png'};}};throw Error('Forbidden module '+name);},
  };
  const source=fs.readFileSync(require.resolve('../../controllers/conversation.controller'),'utf8');
  vm.runInNewContext(source.slice(source.indexOf('exports.streamMessageMedia ='),source.indexOf('exports.getConversationByPatient =')),context);
  const res={statusCode:200,status(n){this.statusCode=n;return this;},set(headers){this.headers=headers;},send(value){this.body=value;return this;},json(value){this.body=value;return this;}};
  await context.exports.streamMessageMedia({userData:{userId:1},params:{messageId:77}},res);
  assert.equal(res.statusCode,200);assert.equal(reads,1);assert.equal(res.headers['Cache-Control'],'no-store');assert.equal(res.body,bytes);
});
