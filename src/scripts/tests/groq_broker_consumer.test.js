'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
function consumer({paused=false,failure=false}={}) {
 const file=path.join(__dirname,'../../services/groqAudio.service.js'),local=createRequire(file),events=[],calls=[];
 const reference={requestId:'fictitious-request',url:'https://fictitious.invalid/audio'};
 const dependencies={
  axios:{post(){throw Error('unexpected_direct_provider_call');}},
  './aiBroker.service':{enabled:()=>true,async execute(provider,useCase,body,options){calls.push({provider,useCase,body,options});if(failure)throw Object.assign(Error('provider_failed'),{code:'provider_failed'});return{data:{text:' Mensaje ficticio de prueba. ',duration:2.5}};}},
  './securityMonitoring.service':{async assertAiAllowed(useCase){assert.equal(useCase,'whatsapp_audio');events.push('pause_checked');if(paused)throw Object.assign(Error('ai_function_manually_paused'),{code:'ai_function_manually_paused'});}},
  './aiFileTransfer.service':{async withTransfer(input,action){assert.equal(events[0],'pause_checked');assert(Buffer.isBuffer(input.buffer));events.push('issued');try{return await action(reference);}finally{events.push('released');}}},
  './aiUsageTelemetry.service':{async recordProviderResponse(value){assert.equal(value.response.duration,2.5);events.push('usage_recorded');},async recordProviderFailure(){events.push('failure_recorded');}},
 };
 const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(file,'utf8'),{module,exports:module.exports,require:key=>dependencies[key]||local(key),Buffer,FormData,Blob,process:{env:{GROQ_API_KEY:'FICTITIOUS_FORBIDDEN_LEGACY_KEY',GROQ_STT_MODEL:'whisper-large-v3-turbo',GROQ_STT_TIMEOUT_MS:'30000'}}});
 return {service:module.exports,events,calls,reference};
}
const audio={buffer:Buffer.from('FICTITIOUS_AUDIO_BYTES'),mimeType:'audio/ogg; codecs=opus',fileName:'test.ogg'};
test('Groq broker preserves result and model while the provider downloads audio directly',async()=>{
 const {service,calls,events,reference}=consumer();assert(service.isConfigured());
 const result=await service.transcribeAudioBuffer(audio);
 assert.deepEqual(JSON.parse(JSON.stringify(result)),{provider:'groq',model:'whisper-large-v3-turbo',text:'Mensaje ficticio de prueba.'});
 assert.equal(calls.length,1);assert.equal(calls[0].body.fileRef,reference);assert.equal(calls[0].options.requestId,reference.requestId);assert.equal(calls[0].options.timeoutMs,30000);assert.equal(calls[0].body.response_format,'verbose_json');
 assert(!JSON.stringify(calls).includes('FICTITIOUS_AUDIO_BYTES'));assert(!JSON.stringify(calls).includes('FICTITIOUS_FORBIDDEN_LEGACY_KEY'));
 assert.deepEqual(events,['pause_checked','issued','released','usage_recorded']);
});
test('Groq failure revokes the file permission without trying the local key',async()=>{
 const {service,events,calls}=consumer({failure:true});await assert.rejects(service.transcribeAudioBuffer(audio),{code:'provider_failed'});assert.equal(calls.length,1);assert.deepEqual(events,['pause_checked','issued','released','failure_recorded']);
});
test('Manual audio pause prevents temporary permissions and provider calls',async()=>{
 const {service,events,calls}=consumer({paused:true});await assert.rejects(service.transcribeAudioBuffer(audio),{code:'ai_function_manually_paused'});assert.deepEqual(calls,[]);assert.deepEqual(events,['pause_checked']);
});
