'use strict';
const {BrokerError,fail}=require('./errors'),{eventFor}=require('./audit'),{canonical}=require('./canonical');
const C=require('./meta-marketing-oauth-contract'),D=require('./meta-marketing-discovery-contract'),M=require('./meta-marketing-contract'),E=require('./meta-marketing-enrollment-contract');
function createMetaMarketingEnrollment({store,secrets,http,environment,now=()=>Date.now()}){
  const roles=E.roles(environment),running=new Map();let closed=false;
  // One owner and one journal with OAuth. Claims/history survive cancellation.
  store.db.exec(`CREATE TABLE IF NOT EXISTS meta_marketing_enrollments (
    id TEXT PRIMARY KEY,flow TEXT UNIQUE,principal TEXT NOT NULL,tenant TEXT NOT NULL,connection TEXT NOT NULL,scope TEXT NOT NULL,
    config_digest TEXT NOT NULL,scope_digest TEXT,candidate_digest TEXT,selection_digest TEXT,assets TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('prepared','active','revoked')),prepared_at INTEGER,activated_at INTEGER,updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS meta_marketing_enrollment_scope ON meta_marketing_enrollments(connection,scope,state);
    CREATE TABLE IF NOT EXISTS meta_marketing_enrollment_assets (asset TEXT PRIMARY KEY,enrollment TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS meta_marketing_enrollment_claims (asset TEXT PRIMARY KEY,enrollment TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS meta_marketing_revoked_asset ON asset_revocations(asset);`);
  const get=(sql,...args)=>store.db.prepare(sql).get(...args),rowFor=id=>get('SELECT * FROM meta_marketing_enrollments WHERE id=?',id);
  const flowFor=id=>get('SELECT * FROM meta_marketing_oauth_flows WHERE id=?',id);
  const source=(policy,ref)=>{const b=policy.connections.find(v=>v.connectionRef===ref);C.bindingFor(b);return b;};
  const physical=a=>[a.assetRef,...(a.parentPageId?['meta-facebook_page:'+a.parentPageId]:[])];
  const selected=row=>E.assets(JSON.parse(row.assets));
  function owned(request,row){
    if(row&&(row.tenant!==request.tenantRef||row.connection!==request.connectionRef||row.scope!==request.assetRef||row.principal!==roles.gateway))fail('scope_denied');
    return row;
  }
  function currentPrincipal(principal,policy,authority){
    const p=policy.principals.find(v=>v.id===principal.id);
    if(!p?.enabled||C.hash(JSON.stringify([p.id,p.keyId,p.publicKey]))!==authority)fail('scope_denied');return p;
  }
  function flowActive(binding,flow){
    const b=C.bindingFor(binding);
    if(closed)fail('connection_blocked');store.connection(binding.connectionRef,now());
    store.assertAssetActive({tenantRef:'clinic:'+b.clinicIds[0],connectionRef:binding.connectionRef,assetRef:'meta-enroll:'+b.scopeKey});
    if(!flow||flow.state!=='staged'||flow.connection!==binding.connectionRef||flow.tenant!=='clinic:'+b.clinicIds[0]
      ||flow.asset!=='meta-enroll:'+b.scopeKey||flow.principal!==roles.gateway||flow.config_digest!==C.fingerprint(binding)||flow.clinic_digest!==C.clinicDigest(b))fail('scope_denied');
    const metadata=C.metadata(JSON.parse(flow.credential_metadata),binding);
    if([metadata.expiresAt,metadata.dataAccessExpiresAt].some(v=>v!==null&&v<=now()))fail('credential_revoked');
    return metadata;
  }
  function exclusions(assets,id,requireClaims=false){
    const refs=[...new Set(assets.flatMap(physical))],marks=refs.map(()=>'?').join(',');
    if(get(`SELECT 1 FROM asset_revocations WHERE asset IN (${marks}) LIMIT 1`,...refs))fail('asset_revoked');
    const claims=store.db.prepare(`SELECT asset,enrollment FROM meta_marketing_enrollment_claims WHERE asset IN (${marks})`).all(...refs);
    if(claims.some(c=>c.enrollment!==id)||requireClaims&&claims.length!==refs.length)fail('scope_denied');
    if(requireClaims){
      const chosen=assets.map(a=>a.assetRef),rows=store.db.prepare(`SELECT asset,enrollment FROM meta_marketing_enrollment_assets WHERE asset IN (${chosen.map(()=>'?').join(',')})`).all(...chosen);
      if(rows.length!==chosen.length||rows.some(r=>r.enrollment!==id))fail('scope_denied');
    }
  }
  function enrollmentActive(row,binding,{requireActive=false}={}){
    if(!row||row.state==='revoked')fail('asset_revoked');
    if(requireActive&&row.state!=='active')fail('scope_denied');
    const flow=flowFor(row.flow),metadata=flowActive(binding,flow),assets=selected(row);
    if(row.tenant!==flow.tenant||row.connection!==flow.connection||row.scope!==flow.asset||row.principal!==flow.principal
      ||row.config_digest!==C.fingerprint(binding)||row.scope_digest!==flow.scope_digest||row.candidate_digest!==flow.secret_digest
      ||row.selection_digest!==E.selectionDigest(flow,binding,assets))fail('scope_denied');
    exclusions(assets,row.id,true);return {flow,metadata,assets};
  }
  function assetOwner(request,principal,policy){
    const lookup=get('SELECT enrollment FROM meta_marketing_enrollment_assets WHERE asset=?',request.assetRef);
    if(!lookup)fail('scope_denied');const row=rowFor(lookup.enrollment),binding=source(policy,request.connectionRef);
    const b=C.bindingFor(binding);
    if(!row||row.tenant!==request.tenantRef||row.connection!==request.connectionRef||row.principal!==roles.gateway
      ||row.tenant!=='clinic:'+b.clinicIds[0]||row.scope!=='meta-enroll:'+b.scopeKey)fail('scope_denied');
    const asset=selected(row).find(a=>a.assetRef===request.assetRef);if(!asset)fail('scope_denied');
    const control=request.operation===M.REVOKE&&principal.id===roles.assetControl;
    if(!control){
      if(principal.id!==roles.reader||!M.OPERATIONS.includes(request.operation))fail('scope_denied');
      enrollmentActive(row,binding,{requireActive:true});
    }
    return {row,binding,asset,control};
  }
  function resolve(request,principal,policy){
    if(![...M.OPERATIONS,M.REVOKE].includes(request.operation))return policy;
    assetOwner(request,principal,policy);
    return {...policy,grants:[...policy.grants,{principalId:principal.id,tenantRef:request.tenantRef,
      connectionRef:request.connectionRef,assetRef:request.assetRef,operations:[request.operation]}]};
  }
  function receipt(row,binding){
    let accessBlocked=true;try{enrollmentActive(row,binding,{requireActive:true});accessBlocked=false;}catch{}
    return {enrollmentId:row.id,flowId:row.flow,scopeKey:C.bindingFor(binding).scopeKey,scopeDigest:row.scope_digest,
      candidateDigest:row.candidate_digest,selectionDigest:row.selection_digest,clinicSetDigest:C.clinicDigest(C.bindingFor(binding)),
      assets:row.flow?selected(row):[],status:row.state,accessBlocked,preparedAt:row.prepared_at,activatedAt:row.activated_at};
  }
  const stop=predicate=>{for(const task of running.values())if(predicate(task))task.controller.abort();};
  const abortFlow=flowId=>stop(task=>task.flowId===flowId);
  const abortAsset=assetRef=>stop(task=>task.assets.flatMap(physical).includes(assetRef));
  async function execute({request,principal,binding,policy}){
    if(closed)fail('connection_blocked');
    const name=Object.keys(E.OPERATIONS).find(k=>E.OPERATIONS[k]===request.operation),isRead=M.OPERATIONS.includes(request.operation);
    if(!name&&!isRead)fail('operation_denied');
    if(name){E.validators[name](request.payload);E.authorize({request,principal,binding},environment);}else M.validate(request.operation,request.payload);
    const authority=C.hash(JSON.stringify([principal.id,principal.keyId,principal.publicKey])),configDigest=C.fingerprint(binding);
    const commandDigest=C.hash(canonical({operation:request.operation,tenantRef:request.tenantRef,connectionRef:request.connectionRef,assetRef:request.assetRef,payload:request.payload}));
    const event=(action,result,reason)=>eventFor(request,principal,policy,action,result,reason,now());
    function authorityNow(){
      currentPrincipal(principal,policy,authority);
      const fresh=source(policy,request.connectionRef);
      if(C.fingerprint(fresh)!==configDigest)fail('scope_denied');
      require('./auth').authorize(principal,request,isRead?resolve(request,principal,policy):policy);return fresh;
    }
    let row=name?owned(request,rowFor(request.payload.enrollmentId)):assetOwner(request,principal,policy).row;
    if(name==='status'){
      authorityNow();return {requestId:request.requestId,data:row?receipt(row,binding):{enrollmentId:request.payload.enrollmentId,status:'not_found',accessBlocked:true},replayed:false};
    }
    if(name==='revoke'){
      const result=store.transaction(()=>{
        authorityNow();row=owned(request,rowFor(request.payload.enrollmentId));
        const old=get('SELECT * FROM commands WHERE principal=? AND id=?',principal.id,request.requestId);
        if(old){if(old.digest!==commandDigest)fail('idempotency_conflict');if(old.state!=='completed'||!old.result)fail('outcome_unknown');return {...JSON.parse(old.result),replayed:true};}
        if(store.backlog().pending+2>policy.maxBacklog)fail('audit_unavailable');
        store.appendAudit(event('integration.requested','accepted','meta_enrollment_revoke_requested'));
        if(!row)store.db.prepare("INSERT INTO meta_marketing_enrollments(id,principal,tenant,connection,scope,config_digest,assets,state,updated_at) VALUES (?,?,?,?,?,?,'[]','revoked',?)")
          .run(request.payload.enrollmentId,roles.gateway,request.tenantRef,request.connectionRef,request.assetRef,configDigest,now());
        else{
          for(const a of row.flow?selected(row):[])store.db.prepare('INSERT OR IGNORE INTO asset_revocations VALUES (?,?,?,?,?)').run(row.tenant,row.connection,a.assetRef,request.requestId,now());
          store.db.prepare("UPDATE meta_marketing_enrollments SET state='revoked',updated_at=? WHERE id=?").run(now(),row.id);
        }
        row=rowFor(request.payload.enrollmentId);const value={requestId:request.requestId,data:receipt(row,binding),replayed:false};
        store.appendAudit(event('integration.completed','success','meta_enrollment_revoked'));
        store.db.prepare("INSERT INTO commands VALUES (?,?,?,'completed',?,?)").run(principal.id,request.requestId,commandDigest,JSON.stringify(value),now());return value;
      });
      stop(task=>task.enrollmentId===request.payload.enrollmentId);return result;
    }
    const enrollmentId=row?.id||request.payload.enrollmentId,flowId=row?.flow||request.payload.flowId;
    if(running.has(enrollmentId)||running.size>=2)fail('oauth_flow_busy');
    const task={enrollmentId,flowId,assets:row?.flow?selected(row):[],controller:new AbortController()};running.set(enrollmentId,task);
    const signal=task.controller.signal,timer=setTimeout(()=>task.controller.abort(),25000);timer.unref?.();let reserved=false,revision;
    const check=()=>{
      if(signal.aborted)fail('provider_timeout');authorityNow();
      const current=store.connection(binding.connectionRef,now());if(revision!==undefined&&current.revision!==revision)fail('connection_blocked');revision=current.revision;
      const flow=flowFor(flowId),metadata=flowActive(binding,flow);
      if(isRead){const v=assetOwner(request,principal,policy);row=v.row;task.assets=selected(row);return {flow,metadata,assets:task.assets,asset:v.asset};}
      row=owned(request,rowFor(enrollmentId));
      if(row){
        const value=enrollmentActive(row,binding);
        if(row.flow!==flowId)fail('idempotency_conflict');task.assets=value.assets;
      }else if(name==='activate')fail('scope_denied');
      if(name==='prepare'){
        const p=request.payload;
        if(flow.scope_digest!==p.scopeDigest||flow.secret_digest!==p.candidateDigest)fail('scope_denied');
        if(row&&JSON.stringify(selected(row).map(a=>a.assetRef).sort())!==JSON.stringify([...p.assetRefs].sort()))fail('idempotency_conflict');
        if(!row&&get('SELECT 1 FROM meta_marketing_enrollments WHERE flow=?',flowId))fail('scope_denied');
      }else if(row.scope_digest!==request.payload.scopeDigest||row.selection_digest!==request.payload.selectionDigest)fail('idempotency_conflict');
      return {flow,metadata,assets:row?selected(row):[]};
    };
    try{
      let context=check();
      if(store.backlog().pending+2>policy.maxBacklog)fail('audit_unavailable');
      const cached=store.reserve(principal.id,request.requestId,commandDigest,event('integration.requested','accepted','meta_enrollment_'+(name||'read')+'_requested'),policy.maxBacklog,now());
      if(cached){check();if(isRead)fail('outcome_unknown');return {requestId:request.requestId,data:receipt(row,binding),replayed:true};}
      reserved=true;
      // Successful prepare replay uses its immutable selection; activate and every
      // read verify the provider again. No code exchange or Secrets mutation here.
      let assets=context.assets,data;
      if(!row||name==='activate'||isRead){
        data=await secrets.withCandidate(binding,context.flow,context.flow.secret_digest,async borrowed=>{
          context=check();if(JSON.stringify(borrowed.metadata)!==context.flow.credential_metadata)fail('secret_unavailable');
          if(isRead)return http.readCandidate({binding,...borrowed,asset:context.asset,operation:request.operation,signal,authorize:check});
          const inventory=await http.discover({binding,...borrowed,signal,authorize:check});D.checkAssets(inventory,borrowed.metadata);
          const refs=name==='prepare'?request.payload.assetRefs:context.assets.map(a=>a.assetRef);
          const result=E.assets(refs.map(ref=>{const value=inventory.find(a=>a.assetRef===ref);if(!value)fail('scope_denied');return E.identity(value);}));
          if(row&&JSON.stringify(result)!==JSON.stringify(context.assets))fail('scope_denied');
          return result;
        },signal,{requirePending:true});
        if(!isRead)assets=data;
      }
      context=check();if(!isRead)exclusions(assets,enrollmentId);task.assets=assets;
      const response={requestId:request.requestId,data:isRead?data:null,replayed:false};
      store.complete(principal.id,request.requestId,response,event('integration.completed','success','meta_enrollment_'+(name||'read')+'_completed'),{
        persistResult:!isRead,mutate:()=>{
          context=check();if(store.backlog().pending>=policy.maxBacklog)fail('audit_unavailable');
          if(isRead)return;
          exclusions(assets,enrollmentId);
          if(!row){
            const selectionDigest=E.selectionDigest(context.flow,binding,assets);
            store.db.prepare("INSERT INTO meta_marketing_enrollments VALUES (?,?,?,?,?,?,?,?,?,?,?,'prepared',?,NULL,?)")
              .run(enrollmentId,flowId,roles.gateway,request.tenantRef,request.connectionRef,request.assetRef,configDigest,context.flow.scope_digest,context.flow.secret_digest,selectionDigest,JSON.stringify(assets),now(),now());
            for(const a of assets)store.db.prepare('INSERT INTO meta_marketing_enrollment_assets VALUES (?,?)').run(a.assetRef,enrollmentId);
            for(const ref of new Set(assets.flatMap(physical)))store.db.prepare('INSERT INTO meta_marketing_enrollment_claims VALUES (?,?)').run(ref,enrollmentId);
          }
          if(name==='activate')store.db.prepare("UPDATE meta_marketing_enrollments SET state='active',activated_at=COALESCE(activated_at,?),updated_at=? WHERE id=? AND state='prepared'").run(now(),now(),enrollmentId);
          row=rowFor(enrollmentId);response.data=receipt(row,binding);
        },
      });
      return response;
    }catch(error){
      const code=error instanceof BrokerError?error.code:'internal_error';
      if(reserved)try{store.uncertain(principal.id,request.requestId,event('integration.failed','unknown',code));}catch{fail('audit_unavailable');}
      throw new BrokerError(code);
    }finally{clearTimeout(timer);running.delete(enrollmentId);}
  }
  const operations=Object.fromEntries(Object.entries(E.OPERATIONS).map(([name,op])=>[op,{provider:C.PROVIDER,control:'meta_marketing_oauth',validate:E.validators[name],
    authorize:context=>E.authorize(context,environment),execute}]));
  for(const op of M.OPERATIONS)operations[op]={provider:C.PROVIDER,control:'meta_marketing_oauth',validate:payload=>M.validate(op,payload),execute};
  operations[M.REVOKE]={provider:C.PROVIDER,control:'revoke_asset',validate:payload=>M.validate(M.REVOKE,payload),onRevoked:request=>abortAsset(request.assetRef)};
  return {operations,resolve,abortFlow,close(){closed=true;stop(()=>true);}};
}
module.exports={createMetaMarketingEnrollment};
