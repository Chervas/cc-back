'use strict';
const {randomUUID}=require('node:crypto');
const E=require('./whatsapp-onboarding-contract');
const A=require('./whatsapp-activation-contract');
const C=require('./whatsapp-authorized-contract');
const {fail}=require('./errors');
const {eventFor}=require('./audit');
const {createWhatsappAuthorizedRegistry}=require('./whatsapp-authorized-registry');
const {createWhatsappAuthorizedSecrets}=require('./whatsapp-authorized-secrets');
const {createRegistrationPins}=require('./whatsapp-registration-pin');
function createWhatsappActivation({store,filename,policy,resolveBinding,client,accountId,kmsKeyArn,http,publishCapture=()=>{},now=Date.now,
  registryFactory=createWhatsappAuthorizedRegistry,secretsFactory=createWhatsappAuthorizedSecrets,pinFactory=createRegistrationPins}) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS whatsapp_activations (
    flow_id TEXT PRIMARY KEY,state TEXT NOT NULL,profile TEXT,asset_id INTEGER,definition TEXT NOT NULL,
    pin_version TEXT NOT NULL,started_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,activated_at INTEGER,
    lease_owner TEXT,lease_until INTEGER NOT NULL DEFAULT 0)`);
  const enrollment=ref=>policy.connections.find(b=>b.connectionRef===ref)||resolveBinding?.(ref);
  const row=id=>store.db.prepare('SELECT * FROM whatsapp_activations WHERE flow_id=?').get(id);
  const withPin=pinFactory({client,kmsKeyArn});
  function context(request,principal,binding) {
    A.validate(request.payload,request.operation); E.authorize({request,principal,binding});
    if(principal.id!=='gateway:whatsapp-onboarding')fail('scope_denied');
    const f=store.db.prepare('SELECT * FROM whatsapp_onboarding_flows WHERE id=?').get(request.payload.flowId);
    if(!f||f.state!=='staged'||f.principal!==principal.id||f.connection!==request.connectionRef||f.tenant!==request.tenantRef
      ||f.asset!==request.assetRef||f.scope_digest!==request.payload.scopeDigest||f.clinic_digest!==request.payload.clinicSetDigest
      ||f.config_digest!==E.fingerprint(binding)||!E.id(f.phone_id)||!E.id(f.waba_id)||!/^[a-f0-9]{64}$/.test(f.secret_digest))fail('scope_denied');
    const definition={connectionRef:A.connectionRef(f.id),authorizationId:f.id,enrollmentBinding:binding,
      phoneId:f.phone_id,wabaId:f.waba_id,candidateDigest:f.secret_digest,expiresAt:null,enabled:false};
    return {flow:f,definition,operational:{connectionRef:definition.connectionRef,provider:C.PROVIDER,initialState:'active',expiresAt:null}};
  }
  function projection(saved,ctx) {
    const b=E.bindingFor(ctx.definition.enrollmentBinding);
    return {flowId:ctx.flow.id,connectionRef:ctx.definition.connectionRef,scopeKey:b.scopeKey,clinicIds:[...b.clinicIds],
      phoneId:ctx.flow.phone_id,wabaId:ctx.flow.waba_id,channelRole:ctx.flow.channel_role||'primary',assetId:saved?.asset_id||null,
      state:saved?.state||'prepared',profile:saved?.profile?JSON.parse(saved.profile):null,
      observedAt:saved?.updated_at||null,activatedAt:saved?.activated_at||null};
  }
  async function execute({request,principal,binding,policy:originalPolicy}) {
    const ctx=context(request,principal,binding);
    const registry=registryFactory({filename,authorizations:[ctx.definition],loadEnrollmentBinding:enrollment,now});
    let secrets;const owner=randomUUID();const id=ctx.flow.id;
    const active=()=>{context(request,principal,binding);registry.review(ctx.operational);};
    const record=(reason,outcome='success')=>{
      if(store.backlog().pending>=policy.maxBacklog)fail('audit_unavailable');
      const scoped={...originalPolicy,grants:[{principalId:principal.id,tenantRef:request.tenantRef,assetRef:request.assetRef,
        connectionRef:request.connectionRef,operations:[request.operation]}]};
      store.appendAudit(eventFor(request,principal,scoped,'integration.completed',outcome,reason,now()));
    };
    const update=(state,profile)=>store.transaction(()=>{
      active();const saved=row(id);if(saved.lease_owner!==owner)fail('idempotency_conflict');
      store.db.prepare('UPDATE whatsapp_activations SET state=?,profile=COALESCE(?,profile),updated_at=? WHERE flow_id=?')
        .run(state,profile?JSON.stringify(profile):null,now(),id);
    });
    try {
      active();
      if(request.operation===A.STATUS)return {requestId:request.requestId,data:projection(row(id),ctx),replayed:true};
      const saved=store.transaction(()=>{
        active();let saved=row(id);
        if(!saved){store.db.prepare('INSERT INTO whatsapp_activations(flow_id,state,definition,pin_version,started_at,updated_at) VALUES (?,?,?,?,?,?)')
          .run(id,'prepared',JSON.stringify(ctx.definition),randomUUID(),now(),now());saved=row(id);}
        if(saved.definition!==JSON.stringify(ctx.definition)||saved.asset_id && request.operation===A.ACTIVATE && saved.asset_id!==request.payload.assetId)fail('idempotency_conflict');
        if(saved.lease_until>now())fail('rate_limited');
        if(request.operation===A.ACTIVATE && !saved.profile)fail('invalid_request');
        store.db.prepare('UPDATE whatsapp_activations SET lease_owner=?,lease_until=?,asset_id=COALESCE(asset_id,?) WHERE flow_id=?')
          .run(owner,now()+45000,request.operation===A.ACTIVATE?request.payload.assetId:null,id);
        return row(id);
      });
      if(saved.state==='active')return {requestId:request.requestId,data:projection(saved,ctx),replayed:true};
      const signal=AbortSignal.timeout(26000);
      secrets=secretsFactory({client,accountId,prefix:'/clinicaclick/integrations/prod/',kmsKeyArn,
        registry:{assert:()=>{active();return registry.review(ctx.operational);}},http,verifyProvider:true,now});
      await secrets.withSecret(ctx.operational,async token=>{
        const call=async(action,target,pin)=>{active();const v=await http({action,id:target,token,
          proof:secrets.proof(token,ctx.operational.connectionRef),signal,...(pin===undefined?{}:{pin})});active();return v;};
        let p=A.profile(await call('profile',ctx.flow.phone_id),ctx.flow.phone_id);
        if(request.operation===A.PROFILE){update(saved.state,p);return;}
        if(['BANNED','DELETED','MIGRATED'].includes(p.status)||p.platformType==='ON_PREMISE') {update('registration_required',p);return;}
        // Capture ownership is durable BEFORE subscribing. The local catalog
        // and receive map have already been committed by the gateway caller.
        if(saved.state==='prepared') {update('capture_ready',p);record('whatsapp_activation_started');}
        // Re-publish on recovery too: a crash may have occurred between the
        // durable ownership row and the separate non-secret inbox projection.
        publishCapture(E.bindingFor(binding).appId);
        if(p.status!=='CONNECTED') {
          if(['register_requested','registration_uncertain','provider_pending'].includes(saved.state)) {update('provider_pending',p);return;}
          // A Business App phone must finish its own coexistence flow. Never
          // register it as Cloud-only, deregister it, or reset its existing PIN.
          if(p.isOnBizApp!==false||p.codeVerificationStatus!=='VERIFIED'||p.status!=='PENDING') {update('registration_required',p);return;}
          let registered=false;
          await withPin({binding,flowId:id,phoneId:ctx.flow.phone_id,versionId:saved.pin_version,signal},async pin=>{
            update('register_requested',p);record('whatsapp_registration_requested');
            try {const result=await call('register_phone',ctx.flow.phone_id,pin);if(result.success!==true&&result.success!=='true')fail('provider_failed');registered=true;}
            catch(error){update(error.providerRejected?'registration_required':'registration_uncertain',p);throw error;}
          });
          if(!registered)return;
          p=A.profile(await call('profile',ctx.flow.phone_id),ctx.flow.phone_id);
          if(p.status!=='CONNECTED'||p.platformType!=='CLOUD_API'){update('provider_pending',p);return;}
        }
        if(p.platformType!=='CLOUD_API'){update('registration_required',p);return;}
        const appId=E.bindingFor(binding).appId;
        const subscribed=async()=>{const v=await call('subscriptions',ctx.flow.waba_id);
          if(!Array.isArray(v.data)||v.paging?.next||v.data.some(x=>!E.id(x?.whatsapp_business_api_data?.id)))fail('provider_failed');
          return v.data.some(x=>x.whatsapp_business_api_data.id===appId);};
        update('subscribing',p);
        if(!await subscribed()) {const result=await call('subscribe',ctx.flow.waba_id);if(result.success!==true&&result.success!=='true')fail('provider_failed');}
        if(!await subscribed())fail('provider_failed');
        store.transaction(()=>{active();const current=row(id);if(current.lease_owner!==owner)fail('idempotency_conflict');
          record('whatsapp_activation_completed');
          store.db.prepare("UPDATE whatsapp_activations SET state='active',profile=?,updated_at=?,activated_at=? WHERE flow_id=?")
            .run(JSON.stringify(p),now(),now(),id);});
      },{signal});
      active();return {requestId:request.requestId,data:projection(row(id),ctx),replayed:false};
    } finally {
      secrets?.close();registry.close();
      store.db.prepare('UPDATE whatsapp_activations SET lease_owner=NULL,lease_until=0 WHERE flow_id=? AND lease_owner=?').run(id,owner);
    }
  }
  return {operations:Object.fromEntries(A.OPERATIONS.map(operation=>[operation,{provider:E.PROVIDER,control:'whatsapp_onboarding',
    validate:payload=>A.validate(payload,operation),authorize:({request,principal,binding})=>context(request,principal,binding),execute}]))};
}
module.exports={createWhatsappActivation};
