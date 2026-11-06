'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../../services/flowEngineV2.service'),'utf8');
const start=source.indexOf('\nasync function materializeFailedAutomationWhatsappMessage('),rest=source.slice(start+1);
const end=rest.search(/\n(?:async )?function \w+/);assert(start>0&&end>0);
test('actual failed-send materializer requests a passive exact owned lookup, never repairs the recipient identity',async()=>{
 const calls=[],sandbox={buildAutomationWhatsappDeliveryKey:()=>null,resolveRuntimeTargets:()=>({clinic_id:35,patient_id:1}),
  backfillRuntimeTargets:async(e,t)=>t,enrichContextForTemplateResolution:async c=>c,
  resolveWhatsAppRecipient:async()=>({recipient:'+34600000001'}),toIntOrNull:x=>Number(x)||null,
  findCanonicalWhatsappConversation:async args=>{calls.push(args);return null},Date,Number};
 vm.createContext(sandbox);vm.runInContext(rest.slice(0,end),sandbox);
 assert.equal(await sandbox.materializeFailedAutomationWhatsappMessage({node:{id:'n5'},context:{},execution:{id:1},errorMessage:'Fictitious identity conflict'}),null);
 assert.equal(calls.length,1);assert.equal(calls[0].readOnly,true);assert.equal(calls[0].requireExactContact,true);
 assert.equal(calls[0].createIfMissing,false);assert.equal(calls[0].lastMessageAt,undefined);assert.equal(calls[0].patientId,1);
});
