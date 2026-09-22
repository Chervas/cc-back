'use strict';
const {randomUUID}=require('node:crypto');
async function append({db,audit,actor,scope,requestId,assetIds,action,reason,transaction,now=new Date()}){
  const repo=audit||require('./platformAudit.repository').createRepository(db.PlatformAuditEvent);
  const health=await repo.health(now,{includeUnresolved:false,transaction});
  if(health.pending>=10000||health.oldestAgeSeconds>=3600)throw Object.assign(Error('audit_unavailable'),{code:'audit_unavailable'});
  await repo.append({version:26,eventId:randomUUID(),correlationId:randomUUID(),occurredAt:now.toISOString(),action,
    stage:'completed',outcome:'success',reason,actor:{type:'user',id:String(actor.userId)},scope:{type:scope.type,id:String(scope.id)},
    sessionRef:actor.sessionRef,requestRef:requestId,assetIds:[...new Set(assetIds)].sort((a,b)=>a-b).map(String),capturePolicy:'whatsapp-operational-v1'},{transaction});
}
module.exports={append};
