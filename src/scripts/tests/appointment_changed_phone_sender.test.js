'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../../services/flowEngineV2.service'),'utf8');
const start=source.indexOf('\nasync function handleSendWhatsapp('),rest=source.slice(start+1),end=rest.search(/\n(?:async )?function \w+/);
assert(start>0&&end>0);
for(const [mode,entity,isolated] of [['context_patient','appointment',true],['manual_number','appointment',false],['context_lead','appointment',false],['context_patient','conversation',false]])test(`actual appointment sender isolates only the current patient contact: ${mode}/${entity}`,async()=>{
 const calls=[],stop=Error('CANONICAL_REACHED'),context={paciente:{telefono:'+34600000002'}};
 const sandbox={db:{},require:name=>name.includes('reschedule-reason')?{isSilentReschedule:()=>false}:name.includes('appointmentPatientLinks')?{follower:async()=>null}:name.includes('appointment-message-copy')?{acknowledgementForExecution:x=>x}:name.includes('appointmentVisitManaged')?{current:()=>({})}:null,
 isMobileVerificationProtocol:()=>false,isProgramBookingProtocol:()=>false,buildAutomationWhatsappDeliveryKey:()=>null,getPendingResponseSuppression:()=>null,
 parseBool:(v,f)=>v??f,resolveTemplateValue:x=>x,resolveRuntimeTargets:()=>({patient_id:1,lead_id:45,appointment_id:10,clinic_id:72}),backfillRuntimeTargets:async(e,t)=>t,
 toIntOrNull:x=>Number(x)||null,normalizeWhatsappMessageMode:()=> 'manual',normalizeOutsideSendWindowPolicy:()=> 'schedule_next_window',
 computeQuietHoursDelayMs:()=>({delayMs:0}),enrichContextForTemplateResolution:async c=>c,mergeContextPatch:c=>c,resolveMadridDayPartGreeting:()=>'',
 resolveWhatsappLanguageRouting:config=>({enabled:false,config}),resolveWhatsAppRecipient:async()=>({recipient_mode:mode,recipient:'+34600000002'}),
 resolveAutomationCommunicationScope:()=> 'care',marketingOptOutService:{assertAutomationCommunicationAllowed:async()=>{}},cleanString:x=>String(x||''),
 loadConfiguredWhatsappTemplate:async()=>null,resolveConfiguredCatalogFamilyKey:()=>null,
 findCanonicalWhatsappConversation:async args=>{calls.push(args);throw stop;},Date,Number};
 vm.createContext(sandbox);vm.runInContext(rest.slice(0,end),sandbox);
 await assert.rejects(sandbox.handleSendWhatsapp({config:{manual_message_text:'Fictitious text'}},context,{execution:{id:9,trigger_type:'appointment_rescheduled',trigger_entity_type:entity,trigger_entity_id:10}}),e=>e===stop);
 assert.equal(calls.length,1);assert.equal(calls[0].requireExactContact,true);assert.equal(calls[0].isolatePatientContact,isolated);assert.equal(calls[0].leadId,isolated?null:45);
});
