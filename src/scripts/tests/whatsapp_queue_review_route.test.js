'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('review controller requires platform administrator and preserves service failures',async()=>{
 const s=fs.readFileSync(require.resolve('../../controllers/whatsapp.controller'),'utf8'),start=s.indexOf('exports.resolveCompliancePausedQueue ='),end=s.indexOf('\nexports.',start+1),a=s.indexOf('function assertAdmin('),z=s.indexOf('\nfunction ',a+1);
 let calls=0;const c={exports:{},ADMIN_USER_IDS:[1],console:{error(){}},whatsappDeliveryGovernanceService:{resolvePausedQueue:async()=>{calls++;return{success:true,queue_id:9,decision:'authorized'};}}};vm.runInNewContext(s.slice(a,z)+'\n'+s.slice(start,end),c);
 const response=()=>({status(n){this.code=n;return this;},json(b){this.body=b;return this;}});
 let res=response();await c.exports.resolveCompliancePausedQueue({userData:{userId:2},params:{listId:9},body:{decision:'authorized'}},res);assert.equal(res.code,403);assert.equal(calls,0);
 res=response();await c.exports.resolveCompliancePausedQueue({userData:{userId:1},params:{listId:9},body:{decision:'authorized'}},res);assert.equal(res.body.success,true);assert.equal(calls,1);
 c.whatsappDeliveryGovernanceService.resolvePausedQueue=async()=>{throw Object.assign(Error('delivery_queue_not_pending_review'),{status:409});};res=response();await c.exports.resolveCompliancePausedQueue({userData:{userId:1},params:{listId:9},body:{decision:'authorized'}},res);assert.equal(res.code,409);assert.equal(res.body.error,'delivery_queue_not_pending_review');
});
test('queue snapshot origin and label resolve without querying or changing current sender',async()=>{
 const s=fs.readFileSync(require.resolve('../../services/whatsappDeliveryGovernance.service'),'utf8'),a=s.indexOf('async function resolveQueueSender('),b=s.indexOf('\nasync function ',a+1),c={module:{exports:{}},clean:v=>String(v??'').trim(),safeObject:v=>v&&typeof v==='object'?v:{}};
 vm.runInNewContext(s.slice(a,b)+'\nmodule.exports=resolveQueueSender;',c);const sender=await c.module.exports({}, {sender_snapshot:{origin_id:501,label:'+34 600 000 000',phone_number_id:'FICTITIOUS_PHONE'}});
 assert.equal(sender.asset_id,501);assert.equal(sender.phone,'+34 600 000 000');assert.equal(sender.source,'dispatch_snapshot');
});
