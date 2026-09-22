'use strict';
const fs=require('node:fs');
const {DatabaseSync}=require('node:sqlite');
const A=require('./whatsapp-activation-contract');
const E=require('./whatsapp-onboarding-contract');
const C=require('./whatsapp-authorized-contract');
const {validateAuthorization}=require('./whatsapp-authorized-registry');
const {fail}=require('./errors');
function createActivationReader(filename) {
  const stat=fs.statSync(filename);
  if(!stat.isFile()||stat.mode&0o077||fs.realpathSync(filename)!==filename)fail('invalid_request');
  const db=new DatabaseSync(filename,{readOnly:true});db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=2000');
  function rows() {
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='whatsapp_activations'").get())return [];
    const rows=db.prepare('SELECT flow_id,state,asset_id,definition,activated_at FROM whatsapp_activations WHERE asset_id IS NOT NULL LIMIT 1001').all();
    if(rows.length>1000)fail('scope_denied');
    return rows.map(row=>{
      const definition=validateAuthorization(JSON.parse(row.definition));
      if(!A.phases.includes(row.state)||!A.positive(row.asset_id)||definition.authorizationId!==row.flow_id
        ||definition.connectionRef!==A.connectionRef(row.flow_id)||definition.enabled!==false
        ||row.state==='active'&&(!Number.isSafeInteger(row.activated_at)||row.activated_at<=0))fail('scope_denied');
      return {...row,definition};
    });
  }
  return {
    definitions:()=>rows().filter(r=>r.state==='active').map(r=>({...r.definition,enabled:true})),
    scopes:(appId)=>rows().filter(r=>r.state!=='prepared').map(r=>{
      const b=E.bindingFor(r.definition.enrollmentBinding);
      if(!E.id(appId)||b.appId!==appId)fail('scope_denied');
      return {wabaId:r.definition.wabaId,phoneId:r.definition.phoneId,clinicIds:[...b.clinicIds]};
    }),
    resolve(request,principal,policy,store) {
      if(policy.connections.some(b=>b.connectionRef===request.connectionRef))return policy;
      const definition=this.definitions().find(d=>d.connectionRef===request.connectionRef);
      if(!definition||!['staging:whatsapp','control:whatsapp'].includes(principal.id))return policy;
      const b=E.bindingFor(definition.enrollmentBinding);
      const operations=principal.id==='control:whatsapp'?[C.REVOKE]:[C.SEND,...require('./whatsapp-template-management').OPERATIONS,require('./whatsapp-inbound-media').READ];
      if(!b.clinicIds.some(id=>request.tenantRef==='clinic:'+id)||request.assetRef!=='wa-phone:'+definition.phoneId||!operations.includes(request.operation))fail('scope_denied');
      const binding={connectionRef:definition.connectionRef,provider:C.PROVIDER,initialState:'active',expiresAt:definition.expiresAt};
      store.seedConnection(binding.connectionRef,{state:'active',expiresAt:binding.expiresAt});
      return {...policy,connections:[...policy.connections,binding],grants:[...policy.grants,{principalId:principal.id,tenantRef:request.tenantRef,
        connectionRef:binding.connectionRef,assetRef:request.assetRef,operations}]};
    },
    close:()=>db.close(),
  };
}
module.exports={createActivationReader};
