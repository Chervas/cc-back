'use strict';
// Owner-only empty-slot preparation. No provider call, token, asset enrollment,
// reader grant or modification of a pre-existing static connection occurs here.
const {randomUUID}=require('node:crypto');
const C=require('./meta-marketing-oauth-contract'),P=require('./meta-marketing-admission-contract');
const D=require('./meta-marketing-discovery-contract');
const E=require('./meta-marketing-enrollment-contract');
const A=require('./meta-marketing-ads-contract');
const R=require('./meta-marketing-credential-renewal-contract');
const T=require('./meta-marketing-credential-maintenance-contract');
const L=require('./meta-marketing-leads-contract'),X=require('./meta-marketing-enrolled-asset-access-contract');
const enrollmentOperations=[E.OPERATIONS.prepare,E.OPERATIONS.activate,E.OPERATIONS.status,E.OPERATIONS.revoke,E.OPERATIONS.assets];
const {authenticate}=require('./auth'),{request:validateRequest}=require('./contracts');
const {validatePolicy}=require('./policy'),{canonical}=require('./canonical');
const {eventFor}=require('./audit'),{BrokerError,fail}=require('./errors');
function validateAdmissionPolicy(policy,settings){
  const config=P.validateSettings(settings);if(!config?.enabled)return null;
  const base=structuredClone(validatePolicy(policy));
  const gateway=`gateway:${config.environment}:meta-marketing-oauth`,control=`control:${config.environment}:meta-marketing-oauth`;
  if(!base.principals.some(p=>p.enabled&&p.id===gateway)||!base.principals.some(p=>p.enabled&&p.id===control)
    ||config.adsReadScopeKeys?.length&&!base.principals.some(p=>p.enabled&&p.id===E.roles(config.environment).reader)
    ||base.connections.length+config.maxConnections>64
    ||!base.connections.some(binding=>{const b=C.bindingFor(binding);return b.appId===config.appId&&b.appVersionId===config.appVersionId
      &&b.redirectUri===config.redirectUri&&binding.clientSecretArn===config.clientSecretArn;}))fail('invalid_request');
  if(base.connections.some(binding=>config.scopeKeys.includes(C.bindingFor(binding).scopeKey)
    ||config.scopeKeys.some(scope=>binding.connectionRef===P.connectionRef(scope))))fail('invalid_request');
  return {config,base,gateway,control};
}
function createMetaMarketingAdmission({store,policy,settings,client,now=()=>Date.now(),enrolledAssetAccess,credentialRenewal=false,userHealthScopeKeys=[]}){
  const approved=validateAdmissionPolicy(policy,settings);if(!approved)return null;
  const {config,base,gateway,control}=approved,digest=P.settingsDigest(config);
  if(enrolledAssetAccess!==undefined)X.config(enrolledAssetAccess);
  const leadScopes=(enrolledAssetAccess?.scopeKeys||[]).filter(scope=>config.enrollmentScopeKeys?.includes(scope));
  const leadReader=E.roles(config.environment).reader,leadIngress=L.ingressPrincipal(config.environment);
  if(leadScopes.length&&(!X.REQUIRED_SCOPES.every(scope=>config.scopes.includes(scope))
    ||!leadScopes.every(scope=>config.adsReadScopeKeys?.includes(scope))
    ||![leadReader,leadIngress].every(id=>base.principals.some(p=>p.id===id&&p.enabled))))fail('invalid_request');
  store.db.exec(`CREATE TABLE IF NOT EXISTS meta_marketing_admission_slots (
    scope TEXT PRIMARY KEY,connection TEXT NOT NULL UNIQUE,clinic_ids TEXT NOT NULL,config_digest TEXT NOT NULL,
    version_id TEXT NOT NULL UNIQUE,name TEXT NOT NULL UNIQUE,arn TEXT,state TEXT NOT NULL CHECK(state IN ('preparing','ready')),
    created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS meta_marketing_admission_requests (
    id TEXT PRIMARY KEY,digest TEXT NOT NULL,scope TEXT NOT NULL,created_at INTEGER NOT NULL,completed_at INTEGER);`);
  const rowFor=scope=>store.db.prepare('SELECT * FROM meta_marketing_admission_slots WHERE scope=?').get(scope);
  function checkBlocks(scope,clinicIds){
    const ref=P.connectionRef(scope);
    if(store.db.prepare('SELECT 1 FROM connections WHERE ref=?').get(ref))store.connection(ref,now());
    store.assertAssetActive({tenantRef:'clinic:'+clinicIds[0],connectionRef:ref,assetRef:'meta-enroll:'+scope});
    for(const id of clinicIds)store.assertAssetActive({tenantRef:'clinic:'+id,connectionRef:ref,assetRef:'meta-enroll:clinic:'+id});
  }
  function checkFootprint(scope,clinicIds){
    for(const binding of base.connections){
      const b=C.bindingFor(binding);
      if(b.scopeKey===scope||binding.connectionRef===P.connectionRef(scope)||b.clinicIds.some(id=>clinicIds.includes(id)))fail('scope_denied');
    }
    for(const row of store.db.prepare('SELECT scope,clinic_ids FROM meta_marketing_admission_slots WHERE scope<>?').all(scope)){
      let ids;try{ids=JSON.parse(row.clinic_ids);}catch{fail('scope_denied');}
      if(!Array.isArray(ids)||!ids.length||ids.length>1000||JSON.stringify(ids)!==row.clinic_ids
        ||ids.some((id,i)=>!Number.isSafeInteger(id)||id<1||id>2147483647||i>0&&id<=ids[i-1]||clinicIds.includes(id)))fail('scope_denied');
    }
  }
  function resolveBinding(ref){
    const row=store.db.prepare('SELECT * FROM meta_marketing_admission_slots WHERE connection=?').get(ref);
    return row?P.bindingFromSlot(config,row):null;
  }
  function resolve(request,principal,liveBase){
    // Never rewrite or shadow a static binding, grant, history or fingerprint.
    if(liveBase.connections.some(binding=>binding.connectionRef===request.connectionRef))return liveBase;
    const binding=resolveBinding(request.connectionRef);if(!binding)return liveBase;
    const health = request.operation === T.OPERATIONS.health;
    if (health || Object.values(R.OPERATIONS).includes(request.operation)) {
      const b = C.bindingFor(binding);
      if (!credentialRenewal || !config.enrollmentScopeKeys?.includes(b.scopeKey)) fail('scope_denied');
      if (health) {
        if (!userHealthScopeKeys.includes(b.scopeKey) || principal.id !== control ||
            request.tenantRef !== 'clinic:'+b.clinicIds[0] || request.assetRef !== 'meta-enroll:'+b.scopeKey) fail('scope_denied');
      } else {
        R.authorize({request, principal, binding}, config.environment);
      }
      checkBlocks(b.scopeKey, b.clinicIds);
      checkFootprint(b.scopeKey, b.clinicIds);
      const grant = {principalId: principal.id, tenantRef: request.tenantRef, connectionRef: binding.connectionRef,
        assetRef: request.assetRef, operations: [request.operation]};
      return {...liveBase, connections: [...liveBase.connections, binding], grants: [...liveBase.grants, grant]};
    }
    const social=require('./meta-marketing-social');
    if(social.ops.includes(request.operation)){
      const b=C.bindingFor(binding);
      if(principal.id!==(request.operation===social.verify?leadIngress:leadReader)||!config.enrollmentScopeKeys?.includes(b.scopeKey)
        ||request.tenantRef!=='clinic:'+b.clinicIds[0])fail('scope_denied');
      checkBlocks(b.scopeKey,b.clinicIds);checkFootprint(b.scopeKey,b.clinicIds);
      return {...liveBase,connections:[...liveBase.connections,binding]};
    }
    if(Object.values(L.OPERATIONS).includes(request.operation)){
      const b=C.bindingFor(binding);
      const readerOperations=[L.OPERATIONS.destinations,L.OPERATIONS.form,L.OPERATIONS.pageStatus,L.OPERATIONS.pageEnable,L.OPERATIONS.receiptRead];
      const allowed=principal.id===leadReader&&readerOperations.includes(request.operation)
        ||principal.id===leadIngress&&L.RECEPTION_OPERATIONS.includes(request.operation);
      // This resolves only a source binding. The existing Enrollment resolver
      // still proves the confirmed Page/account, all claims and direct-clinic
      // route before deriving any grant. No historical recovery is admitted.
      if(!allowed||!leadScopes.includes(b.scopeKey)||b.clinicIds.length!==1||b.scopeKey!=='clinic:'+b.clinicIds[0]
        ||request.tenantRef!=='clinic:'+b.clinicIds[0]||!/^meta-facebook_page:[1-9][0-9]{0,29}$/.test(request.assetRef))fail('scope_denied');
      checkBlocks(b.scopeKey,b.clinicIds);checkFootprint(b.scopeKey,b.clinicIds);
      return {...liveBase,connections:[...liveBase.connections,binding]};
    }
    if(Object.values(A.OPERATIONS).includes(request.operation)){
      const b=C.bindingFor(binding);
      // The signed reader gets its admitted binding only. Confirmation,
      // physical claims, credential health and the per-account grant remain
      // the Enrollment resolver's authority, never an admission side effect.
      if(principal.id!==E.roles(config.environment).reader||!config.adsReadScopeKeys?.includes(b.scopeKey)
        ||request.tenantRef!=='clinic:'+b.clinicIds[0]||!/^meta-ad_account:[1-9][0-9]{0,29}$/.test(request.assetRef))fail('scope_denied');
      checkBlocks(b.scopeKey,b.clinicIds);
      return {...liveBase,connections:[...liveBase.connections,binding]};
    }
    if(enrollmentOperations.includes(request.operation))E.authorize({request,principal,binding},config.environment);
    else C.authorize({request,principal,binding});
    if(principal.id!==gateway&&principal.id!==control)fail('scope_denied');
    const discovery=config.discoveryScopeKeys?.includes(binding.metaMarketingOAuth.scopeKey)===true;
    const enrollment=config.enrollmentScopeKeys?.includes(binding.metaMarketingOAuth.scopeKey)===true;
    if(request.operation===D.OPERATION&&discovery
      ||enrollment&&[E.OPERATIONS.prepare,E.OPERATIONS.activate].includes(request.operation)){
      checkBlocks(binding.metaMarketingOAuth.scopeKey,binding.metaMarketingOAuth.clinicIds);
      checkFootprint(binding.metaMarketingOAuth.scopeKey,binding.metaMarketingOAuth.clinicIds);
    }
    const grants=[gateway,control].map(principalId=>({principalId,tenantRef:'clinic:'+binding.metaMarketingOAuth.clinicIds[0],
      connectionRef:binding.connectionRef,assetRef:'meta-enroll:'+binding.metaMarketingOAuth.scopeKey,
      operations:principalId===gateway?[...Object.values(C.OPERATIONS),...(discovery?[D.OPERATION]:[]),...(enrollment?enrollmentOperations:[])]
        :[C.OPERATIONS.status,C.OPERATIONS.abort,...(enrollment?[E.OPERATIONS.status,E.OPERATIONS.revoke]:[])]}));
    return {...liveBase,connections:[...liveBase.connections,binding],grants:[...liveBase.grants,...grants]};
  }
  const ensureSlot=require('./meta-marketing-candidate-slot').candidateSlot(client,'clinicaclick-meta-marketing-admission',config.appId);
  async function prepare(raw,headers){
    if(!Buffer.isBuffer(raw)||raw.length>32768)fail('invalid_request');
    let request;try{request=validateRequest(JSON.parse(raw.toString('utf8')));}catch{fail('invalid_request');}
    const principal=authenticate(raw,headers,request,base,now());
    store.acceptNonce(principal.id,request.nonce,now(),principal.maxPerMinute);
    if(request.operation!==P.OPERATION||principal.id!==gateway)fail('scope_denied');
    const intent=P.validatePreparation(request.payload,now());
    if(!config.scopeKeys.includes(intent.scopeKey)||request.connectionRef!==P.connectionRef(intent.scopeKey)
      ||request.assetRef!=='meta-enroll:'+intent.scopeKey||request.tenantRef!=='clinic:'+intent.clinicIds[0])fail('scope_denied');
    const auditPolicy={...base,grants:[{principalId:principal.id,tenantRef:request.tenantRef,assetRef:request.assetRef,
      connectionRef:request.connectionRef,operations:[P.OPERATION]}]};
    const requestDigest=C.hash(canonical({connectionRef:request.connectionRef,payload:intent}));
    const row=store.transaction(()=>{
      checkBlocks(intent.scopeKey,intent.clinicIds);checkFootprint(intent.scopeKey,intent.clinicIds);
      const prior=store.db.prepare('SELECT * FROM meta_marketing_admission_requests WHERE id=?').get(request.requestId);
      if(prior&&(prior.digest!==requestDigest||prior.scope!==intent.scopeKey))fail('idempotency_conflict');
      let found=rowFor(intent.scopeKey);
      if(found&&(found.config_digest!==digest||found.clinic_ids!==JSON.stringify(intent.clinicIds)))fail('idempotency_conflict');
      if(found&&found.expires_at<=now())fail('connection_blocked');
      if(store.backlog().pending+2>base.maxBacklog)fail('audit_unavailable');
      if(!found){
        if(store.db.prepare('SELECT count(*) n FROM meta_marketing_admission_slots').get().n>=config.maxConnections)fail('rate_limited');
        store.db.prepare("INSERT INTO meta_marketing_admission_slots VALUES (?,?,?,?,?,?,NULL,'preparing',?,?)")
          .run(intent.scopeKey,request.connectionRef,JSON.stringify(intent.clinicIds),digest,randomUUID(),
            P.prefix(config.environment)+intent.scopeKey.replace(':','-')+'/candidate',now(),now()+config.slotTtlMs);
        found=rowFor(intent.scopeKey);
      }
      if(!prior){
        store.db.prepare('INSERT INTO meta_marketing_admission_requests VALUES (?,?,?,?,NULL)').run(request.requestId,requestDigest,intent.scopeKey,now());
        store.appendAudit(eventFor(request,principal,auditPolicy,'integration.requested','accepted','meta_admission_preparation_requested',now()));
      }
      return found;
    });
    const signal=AbortSignal.timeout(15000);
    try{
      const arn=await ensureSlot(row,signal);
      return store.transaction(()=>{
        if(signal.aborted||now()>=intent.expiresAt)fail('oauth_flow_interrupted');
        checkBlocks(intent.scopeKey,intent.clinicIds);checkFootprint(intent.scopeKey,intent.clinicIds);
        if(store.backlog().pending>=base.maxBacklog)fail('audit_unavailable');
        const current=rowFor(intent.scopeKey);
        if(!current||current.version_id!==row.version_id||current.config_digest!==digest||current.clinic_ids!==JSON.stringify(intent.clinicIds)
          ||current.arn&&current.arn!==arn||current.expires_at!==row.expires_at||current.expires_at<=now())fail('idempotency_conflict');
        if(current.state!=='ready'){
          store.db.prepare("UPDATE meta_marketing_admission_slots SET arn=?,state='ready' WHERE scope=?").run(arn,row.scope);
          store.seedConnection(row.connection,{state:'active',expiresAt:row.expires_at});
        }
        const completed=store.db.prepare('SELECT completed_at FROM meta_marketing_admission_requests WHERE id=?').get(request.requestId);
        if(completed.completed_at===null){
          store.appendAudit(eventFor(request,principal,auditPolicy,'integration.completed','success','meta_admission_slot_prepared',now()));
          store.db.prepare('UPDATE meta_marketing_admission_requests SET completed_at=? WHERE id=?').run(now(),request.requestId);
        }
        return {requestId:request.requestId,replayed:completed.completed_at!==null,data:{status:'prepared',connected:false,binding:P.publicBinding(config,rowFor(row.scope))}};
      });
    }catch(error){if(error instanceof BrokerError)throw error;fail('secret_unavailable');}
  }
  return {prepare,resolve,resolveBinding};
}
module.exports={createMetaMarketingAdmission,validateAdmissionPolicy};
