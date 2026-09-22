'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');const {enqueue}=require('../../services/whatsappActivationTemplates.service');
test('activation dispatches one scoped template command to the business worker in the same transaction',async()=>{
 const transaction={},models={JobRequest:{},sequelize:{}},activation={authorization_id:'00000000-0000-4000-8000-000000000001',state:'active',scope_type:'clinic',scope_id:58,waba_id:'301'};let calls=0;
 await enqueue({activation,actor:{userId:1},transaction,models},{environment:{RUNTIME_ROLE:'gateway',JOB_RUNTIME_NAMESPACE:'gateway'},enqueueUnique:async(input,options)=>{
  calls++;assert.equal(input.type,'whatsapp_template_create');assert.equal(input.payload.__runtime_namespace,'staging');assert.equal(input.payload.clinicId,58);assert.equal(input.payload.groupId,null);assert.equal(options.transaction,transaction);assert.equal(options.JobRequestModel,models.JobRequest);assert.equal(input.dedupeScope,'whatsapp-activation:'+activation.authorization_id);assert(options.activeStatuses.includes('completed'));assert(options.activeStatuses.includes('cancelled'));assert(!Object.hasOwn(input.payload,'accessToken'));return {created:true};}});
 await enqueue({activation:{...activation,state:'prepared'},actor:{userId:1},transaction,models},{enqueueUnique:()=>assert.fail('inactive phone queued work')});assert.equal(calls,1);
 await assert.rejects(enqueue({activation,actor:{userId:1},transaction,models},{environment:{RUNTIME_ROLE:'gateway',AUTOMATIONS_V2_FALLBACK_RUNTIME_NAMESPACE:'gateway'},enqueueUnique:()=>assert.fail('gateway cannot execute templates')}),/runtime_invalid/);
});
