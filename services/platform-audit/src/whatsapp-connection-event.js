'use strict';
const {UUID,fail}=require('./event');const {stamp}=require('./view-contract');
const actions=['integration.whatsapp.activate','integration.whatsapp.routing'];
function whatsappConnectionEvent(v){
  const keys=['version','eventId','correlationId','occurredAt','action','stage','outcome','reason','actor','scope','sessionRef','requestRef','assetIds','capturePolicy'];
  const exact=(x,k)=>x&&Object.getPrototypeOf(x)===Object.prototype&&Object.keys(x).length===k.length&&k.every(y=>Object.hasOwn(x,y));
  const id=x=>typeof x==='string'&&/^[1-9][0-9]{0,9}$/.test(x)&&Number(x)<=2147483647;
  if(!exact(v,keys)||!exact(v.actor,['type','id'])||!exact(v.scope,['type','id'])||v.version!==26
    ||![v.eventId,v.correlationId,v.sessionRef,v.requestRef].every(x=>typeof x==='string'&&UUID.test(x))||!stamp(v.occurredAt)
    ||!actions.includes(v.action)||v.stage!=='completed'||v.outcome!=='success'
    ||!(v.action===actions[0]?['catalog_prepared','connection_activated']:['routing_saved']).includes(v.reason)
    ||v.actor.type!=='user'||!id(v.actor.id)||!['clinic','group'].includes(v.scope.type)||!id(v.scope.id)
    ||!Array.isArray(v.assetIds)||v.assetIds.length<1||v.assetIds.length>2||v.assetIds.some((x,i,a)=>!id(x)||i&&Number(a[i-1])>=Number(x))
    ||v.capturePolicy!=='whatsapp-operational-v1')fail();
  return Object.fromEntries(keys.map(k=>[k,Array.isArray(v[k])?[...v[k]]:typeof v[k]==='object'?{...v[k]}:v[k]]));
}
module.exports={whatsappConnectionEvent,actions};
