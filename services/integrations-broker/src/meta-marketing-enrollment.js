'use strict';
const K=require('./meta-marketing-credential-shape'),B=require('./meta-marketing-business-issuer');
const {BrokerError,fail}=require('./errors'),{eventFor}=require('./audit'),{canonical}=require('./canonical');
const C=require('./meta-marketing-oauth-contract'),D=require('./meta-marketing-discovery-contract'),M=require('./meta-marketing-contract'),E=require('./meta-marketing-enrollment-contract');
const A=require('./meta-marketing-ads-contract'),X=require('./meta-marketing-enrolled-asset-access-contract');
const L=require('./meta-marketing-leads-contract'),{timingSafeEqual}=require('node:crypto');
function createMetaMarketingEnrollment({store,secrets,http,environment,now=()=>Date.now(),adsRead,adsHttp,leadAds,leadsHttp,credentialEpochs,businessConfig,enrolledAssetAccess}){
  if(adsRead!==undefined){A.config(adsRead);if(typeof adsHttp?.read!=='function')fail('invalid_request');}
  if(leadAds!==undefined){L.config(leadAds);if(typeof leadsHttp?.read!=='function'||typeof secrets?.withLeadVerification!=='function')fail('invalid_request');}
  if(enrolledAssetAccess!==undefined){X.config(enrolledAssetAccess);if(!adsRead||!leadAds)fail('invalid_request');}
  const leadReceipts=leadAds?require('./meta-marketing-leads-receipts').createMetaMarketingLeadReceipts({store,now}):null;
  const adsOperation=operation=>Object.values(A.OPERATIONS).includes(operation);
  const leadOperation=operation=>Object.values(L.OPERATIONS).includes(operation);
  const validateRead=(operation,payload)=>leadOperation(operation)?L.validate(operation,payload):adsOperation(operation)?A.validate(operation,payload):M.validate(operation,payload);
  const roles=E.roles(environment),running=new Map();let closed=false,checkingProviderAuthority=false;
  // One owner and one journal with OAuth. Claims/history survive cancellation.
  store.db.exec(`CREATE TABLE IF NOT EXISTS meta_marketing_enrollments (
    id TEXT PRIMARY KEY,flow TEXT UNIQUE,principal TEXT NOT NULL,tenant TEXT NOT NULL,connection TEXT NOT NULL,scope TEXT NOT NULL,
    config_digest TEXT NOT NULL,scope_digest TEXT,candidate_digest TEXT,selection_digest TEXT,assets TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('prepared','active','revoked')),prepared_at INTEGER,activated_at INTEGER,updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS meta_marketing_enrollment_scope ON meta_marketing_enrollments(connection,scope,state);
    CREATE TABLE IF NOT EXISTS meta_marketing_enrollment_assets (asset TEXT PRIMARY KEY,enrollment TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS meta_marketing_enrollment_claims (asset TEXT PRIMARY KEY,enrollment TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS meta_marketing_revoked_asset ON asset_revocations(asset);`);
  if(businessConfig){B.config(businessConfig);store.db.exec(`CREATE TABLE IF NOT EXISTS meta_marketing_enrollment_successions(old_enrollment TEXT PRIMARY KEY,new_enrollment TEXT NOT NULL UNIQUE,handover TEXT NOT NULL,receipt_refs TEXT NOT NULL,activated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS meta_marketing_business_receipt_lineage(receipt TEXT NOT NULL,new_enrollment TEXT NOT NULL,handover TEXT NOT NULL,old_enrollment TEXT NOT NULL,PRIMARY KEY(receipt,new_enrollment));
    CREATE TABLE IF NOT EXISTS meta_marketing_business_barriers(enrollment TEXT PRIMARY KEY,handover TEXT NOT NULL,state TEXT NOT NULL,receipt_refs TEXT NOT NULL,receipt_digest TEXT NOT NULL,updated_at INTEGER NOT NULL);`);}
  const get=(sql,...args)=>store.db.prepare(sql).get(...args),rowFor=id=>get('SELECT * FROM meta_marketing_enrollments WHERE id=?',id);
  const flowFor=id=>get('SELECT * FROM meta_marketing_oauth_flows WHERE id=?',id);
  const source=(policy,ref)=>{const b=policy.connections.find(v=>v.connectionRef===ref);K.bindingFor(b);return b;};
  const physical=a=>[a.assetRef,...(a.parentPageId?['meta-facebook_page:'+a.parentPageId]:[])];
  const selected=row=>E.assets(JSON.parse(row.assets));
  const succession=id=>businessConfig?get('SELECT * FROM meta_marketing_enrollment_successions WHERE old_enrollment=?',id):null;
  function grantBinding(row,binding){const f=row?.flow&&flowFor(row.flow),m=f?.credential_metadata&&JSON.parse(f.credential_metadata);if(m?.tokenType!=='SYSTEM_USER')return B.baseBinding(binding);return B.forCredential(B.baseBinding(binding),businessConfig,m,selected(row));}
  function barrier(row){return businessConfig?get("SELECT * FROM meta_marketing_business_barriers WHERE enrollment=? AND state='closed'",row.id):null;}
  function settledDuplicate(row,context,digest,event){if(!businessConfig)return false;const next=get('SELECT * FROM meta_marketing_business_receipt_lineage WHERE receipt=? AND new_enrollment=?',row.id,context.enrollment);return !!next&&row.app===context.app&&row.tenant===context.tenant&&row.connection===context.connection&&row.page===context.page&&row.account===context.account&&row.recipient_clinic===context.recipientClinicId&&row.form===event.form_id&&row.ad===event.ad_id&&row.body_digest===digest;}
  function owned(request,row){
    if(row&&(row.tenant!==request.tenantRef||row.connection!==request.connectionRef||row.scope!==request.assetRef||row.principal!==roles.gateway))fail('scope_denied');
    return row;
  }
  function currentPrincipal(principal,policy,authority){
    const p=policy.principals.find(v=>v.id===principal.id);
    if(!p?.enabled||C.hash(JSON.stringify([p.id,p.keyId,p.publicKey]))!==authority)fail('scope_denied');return p;
  }
  function flowActive(binding,flow,{allowExpired=false}={}){
    const b=K.bindingFor(binding);
    if(closed)fail('connection_blocked');if(!checkingProviderAuthority)store.connection(binding.connectionRef,now());
    store.assertAssetActive({tenantRef:'clinic:'+b.clinicIds[0],connectionRef:binding.connectionRef,assetRef:'meta-enroll:'+b.scopeKey});
    if(!flow||flow.state!=='staged'||flow.connection!==binding.connectionRef||flow.tenant!=='clinic:'+b.clinicIds[0]
      ||flow.asset!=='meta-enroll:'+b.scopeKey||flow.principal!==roles.gateway||flow.config_digest!==K.fingerprint(binding)||flow.clinic_digest!==C.clinicDigest(b))fail('scope_denied');
    const metadata=K.metadata(JSON.parse(flow.credential_metadata),binding);
    if(!allowExpired&&[metadata.expiresAt,metadata.dataAccessExpiresAt].some(v=>v!==null&&v<=now()))fail('credential_revoked');
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
  function enrollmentActive(row,binding,{requireActive=false,allowExpired=false}={}){
    if(!row||row.state==='revoked')fail('asset_revoked');if(succession(row.id))fail('connection_blocked');
    if(requireActive&&row.state!=='active')fail('scope_denied');
    const flow=flowFor(row.flow),originalMetadata=flowActive(binding,flow,{allowExpired:allowExpired||!!credentialEpochs}),assets=selected(row);
    if(row.tenant!==flow.tenant||row.connection!==flow.connection||row.scope!==flow.asset||row.principal!==flow.principal
      ||row.config_digest!==K.fingerprint(binding)||row.scope_digest!==flow.scope_digest||row.candidate_digest!==flow.secret_digest
      ||row.selection_digest!==E.selectionDigest(flow,binding,assets))fail('scope_denied');
    exclusions(assets,row.id,true);
    const credential=credentialEpochs?credentialEpochs.current(row,binding):null,metadata=credential?.metadata||originalMetadata;
    if(!allowExpired&&[metadata.expiresAt,metadata.dataAccessExpiresAt].some(v=>v!==null&&v<=now()))fail('credential_revoked');
    return {flow:credential?.flow||flow,metadata,assets,credential};
  }
  // The initial slot deadline remains immutable. Only a completed, locally
  // journalled business handover can supply the separate normal grant authority.
  // This synchronous proof deliberately ignores credential *expiry*, while all
  // ordinary reads still run enrollmentActive without allowExpired below.
  function providerLifecycleAuthority(connectionRef,base,enrollmentId=null){
    if(closed||checkingProviderAuthority||!businessConfig||!credentialEpochs)return false;
    try{
      C.bindingFor(base);if(base.connectionRef!==connectionRef)return false;
      const connection=get('SELECT * FROM connections WHERE ref=?',connectionRef);
      if(!connection||connection.state!=='active'||connection.expires_at!==base.expiresAt||!Number.isSafeInteger(connection.revision)||connection.revision<1)return false;
      const rows=store.db.prepare("SELECT e.* FROM meta_marketing_enrollments e WHERE e.connection=? AND e.state='active' AND NOT EXISTS (SELECT 1 FROM meta_marketing_enrollment_successions s WHERE s.old_enrollment=e.id)").all(connectionRef);
      if(rows.length!==1||enrollmentId!==null&&rows[0].id!==enrollmentId)return false;
      const row=rows[0],binding=grantBinding(row,base);if(!K.business(binding))return false;
      const handover=get('SELECT * FROM meta_marketing_business_handovers WHERE id=?',row.id),parent=get('SELECT * FROM meta_marketing_enrollment_successions WHERE new_enrollment=?',row.id);
      if(!handover||handover.state!=='active'||handover.id!==row.flow||!parent||parent.handover!==row.id||parent.old_enrollment!==handover.old_enrollment||!Number.isSafeInteger(parent.activated_at)||parent.activated_at<row.activated_at||parent.activated_at>handover.updated_at
        ||handover.principal!==row.principal||handover.tenant!==row.tenant||handover.connection!==row.connection||handover.scope!==row.scope||handover.config_digest!==row.config_digest
        ||handover.scope_digest!==row.scope_digest||handover.candidate_digest!==row.candidate_digest||handover.assets!==row.assets||handover.clinic_digest!==C.clinicDigest(K.bindingFor(binding))||!C.uuid(handover.activation_request))return false;
      const old=rowFor(parent.old_enrollment),flow=flowFor(row.flow),refs=JSON.parse(parent.receipt_refs);
      if(!old||old.state!=='active'||credentialEpochs.grantDigest(old)!==handover.old_grant_digest||JSON.stringify(selected(old))!==row.assets
        ||!Array.isArray(refs)||refs.length>1000||refs.some((v,i)=>!C.uuid(v)||i>0&&v<=refs[i-1])
        ||handover.drain_digest!==require('./meta-marketing-business-contract').drainDigest(row.id,handover.old_grant_digest,refs)
        ||!flow||flow.credential_metadata!==handover.candidate_metadata)return false;
      const command=get('SELECT * FROM commands WHERE principal=? AND id=?',roles.gateway,handover.activation_request),value=command?.result&&JSON.parse(command.result),receipt=value?.data;
      if(command?.state!=='completed'||value.requestId!==handover.activation_request||receipt?.handoverApplied!==true||receipt.status!=='active'||receipt.handoverId!==row.id||receipt.flowId!==row.flow
        ||receipt.newEnrollmentId!==row.id||receipt.oldEnrollmentId!==old.id||receipt.oldGrantDigest!==handover.old_grant_digest||receipt.assetSetDigest!==handover.asset_digest||receipt.assetSetDigest!==require('./meta-marketing-credential-renewal-contract').assetSetDigest(selected(row))
        ||receipt.candidate?.versionId!==row.flow||receipt.candidate.digest!==row.candidate_digest||JSON.stringify(receipt.candidate.metadata)!==flow.credential_metadata
        ||receipt.newEnrollment?.enrollmentId!==row.id||receipt.newEnrollment.flowId!==row.flow||receipt.newEnrollment.selectionDigest!==row.selection_digest||receipt.newEnrollment.scopeDigest!==row.scope_digest
        ||receipt.newEnrollment.candidateDigest!==row.candidate_digest||receipt.newEnrollment.clinicSetDigest!==handover.clinic_digest||JSON.stringify(receipt.newEnrollment.assets)!==row.assets
        ||receipt.newEnrollment.status!=='active'||receipt.newEnrollment.preparedAt!==row.prepared_at||receipt.newEnrollment.activatedAt!==row.activated_at
        ||receipt.drain?.closed!==true||receipt.drain.activeOperations!==0||receipt.drain.receiptSetDigest!==handover.drain_digest||JSON.stringify(receipt.drain.receiptRefs)!==parent.receipt_refs)return false;
      const barrier=get('SELECT * FROM meta_marketing_business_barriers WHERE enrollment=?',old.id);
      if(!barrier||barrier.state!=='closed'||barrier.handover!==row.id||barrier.receipt_refs!==parent.receipt_refs||barrier.receipt_digest!==handover.drain_digest)return false;
      checkingProviderAuthority=true;
      const authority=enrollmentActive(row,binding,{requireActive:true,allowExpired:true});
      const current=authority.credential;if(!current?.retentionStage)return false;
      if(current.epoch>0){
        const journals=[get('SELECT * FROM meta_marketing_credential_renewals WHERE id=?',current.versionId),get('SELECT * FROM meta_marketing_credential_maintenance WHERE id=?',current.versionId)].filter(Boolean);
        if(journals.length!==1)return false;const journal=journals[0];
        if(journal.state!=='active'||journal.enrollment!==row.id||journal.connection!==row.connection||journal.tenant!==row.tenant||journal.scope!==row.scope||journal.expected_epoch+1!==current.epoch
          ||journal.grant_digest!==credentialEpochs.grantDigest(row)||journal.asset_digest!==handover.asset_digest||journal.candidate_digest!==current.digest||journal.candidate_metadata!==current.flow.credential_metadata)return false;
      }
      return true;
    }catch{return false;}finally{checkingProviderAuthority=false;}
  }
  function enrolledAuthority(row,binding,{allowExpired=false,metadata}={}){
    const active=enrollmentActive(row,binding,{requireActive:true,allowExpired});
    const effective=metadata||active.metadata;X.authorize(enrolledAssetAccess,binding,effective);
    const paid=effective.granularScopes.find(value=>value.scope==='ads_management');
    if(paid&&active.assets.some(asset=>asset.kind==='ad_account'&&!paid.targetIds.includes(asset.id)))fail('scope_denied');
    return active;
  }
  function leadPair(row,binding,page,account,options){
    if(!leadAds||page.kind!=='facebook_page'||account?.kind!=='ad_account')fail('scope_denied');
    const fixed=leadAds.pairs.find(p=>p.pageAssetRef===page.assetRef);
    // A reviewed Page route is exclusive, including when its account is denied.
    if(fixed){if(fixed.adAccountAssetRef!==account.assetRef)fail('scope_denied');return fixed;}
    const active=enrolledAuthority(row,binding,options),accounts=active.assets.filter(a=>a.kind==='ad_account');
    if(!active.assets.some(a=>a.assetRef===page.assetRef&&a.kind==='facebook_page')||accounts.length!==1||accounts[0].assetRef!==account.assetRef)fail('scope_denied');
    return {pageAssetRef:page.assetRef,adAccountAssetRef:account.assetRef,recipientClinicId:null};
  }
  function assetOwner(request,principal,policy){
    const lookup=get('SELECT enrollment FROM meta_marketing_enrollment_assets WHERE asset=?',request.assetRef);
    if(!lookup)fail('scope_denied');const row=rowFor(lookup.enrollment),binding=grantBinding(row,source(policy,request.connectionRef));
    const b=K.bindingFor(binding);
    if(!row||row.tenant!==request.tenantRef||row.connection!==request.connectionRef||row.principal!==roles.gateway
      ||row.tenant!=='clinic:'+b.clinicIds[0]||row.scope!=='meta-enroll:'+b.scopeKey)fail('scope_denied');
    const asset=selected(row).find(a=>a.assetRef===request.assetRef);if(!asset)fail('scope_denied');
    const control=request.operation===M.REVOKE&&principal.id===roles.assetControl;
    if(!control){
      const ingress=leadAds&&principal.id===L.ingressPrincipal(environment)&&L.RECEPTION_OPERATIONS.includes(request.operation);
      if(!ingress&&(principal.id!==roles.reader||![...M.OPERATIONS,...Object.values(A.OPERATIONS),...Object.values(L.OPERATIONS)].includes(request.operation)))fail('scope_denied');
      // Metrics are a distinct, explicitly reviewed cohort. Merely adding an
      // operation to source or enrolling an account does not grant these reads.
      if(adsOperation(request.operation)){
        if(!adsRead||asset.kind!=='ad_account'||!b.scopes.includes('ads_read'))fail('scope_denied');
        if(!adsRead.assetRefs.includes(request.assetRef))enrolledAuthority(row,binding);
      }
      enrollmentActive(row,binding,{requireActive:true});
      if(leadOperation(request.operation)){
        L.validate(request.operation,request.payload);
        if(!leadAds||asset.kind!=='facebook_page'||!L.REQUIRED_SCOPES.every(s=>b.scopes.includes(s)))fail('scope_denied');
        const account=selected(row).find(a=>a.assetRef===request.payload.adAccountAssetRef&&a.kind==='ad_account');
        const pair=leadPair(row,binding,asset,account);if(pair.recipientClinicId!=null&&!b.clinicIds.includes(pair.recipientClinicId))fail('scope_denied');
        if(request.operation===L.OPERATIONS.receiptRead)leadReceipts.read(request.payload.receiptRef,leadContext(row,binding,asset,account));
        return {row,binding,asset,account,control};
      }
    }
    return {row,binding,asset,control};
  }
  function resolve(request,principal,policy){
    if(![...M.OPERATIONS,M.REVOKE,...Object.values(A.OPERATIONS),...Object.values(L.OPERATIONS)].includes(request.operation))return policy;
    assetOwner(request,principal,policy);
    return {...policy,grants:[...policy.grants,{principalId:principal.id,tenantRef:request.tenantRef,
      connectionRef:request.connectionRef,assetRef:request.assetRef,operations:[request.operation]}]};
  }
  function receipt(row,binding){
    let accessBlocked=true;try{enrollmentActive(row,binding,{requireActive:true});accessBlocked=false;}catch{}
    return {enrollmentId:row.id,flowId:row.flow,scopeKey:K.bindingFor(binding).scopeKey,scopeDigest:row.scope_digest,
      candidateDigest:row.candidate_digest,selectionDigest:row.selection_digest,clinicSetDigest:C.clinicDigest(K.bindingFor(binding)),
      assets:row.flow?selected(row):[],status:succession(row.id)?'superseded':row.state,accessBlocked,preparedAt:row.prepared_at,activatedAt:row.activated_at};
  }
  const stop=predicate=>{for(const task of running.values())if(predicate(task))task.controller.abort();};
  const abortFlow=flowId=>stop(task=>task.flowId===flowId);
  const abortAsset=assetRef=>stop(task=>task.assets.flatMap(physical).includes(assetRef));
  const leadContext=(row,binding,asset,account)=>{
    const recipientClinicId=leadPair(row,binding,asset,account).recipientClinicId??null;
    return {app:K.bindingFor(binding).appId,subject:JSON.parse(flowFor(row.flow).credential_metadata).subjectId,
      tenant:row.tenant,connection:row.connection,enrollment:row.id,generation:C.hash(JSON.stringify([row.selection_digest,asset.assetRef,account.assetRef,recipientClinicId])),page:asset.id,account:account.id,recipientClinicId};
  };
  async function execute({request,principal,binding,policy}){
    if(closed)fail('connection_blocked');
    const initialRow=E.OPERATIONS.status===request.operation||E.OPERATIONS.revoke===request.operation?rowFor(request.payload.enrollmentId):[...M.OPERATIONS,...Object.values(A.OPERATIONS),...Object.values(L.OPERATIONS)].includes(request.operation)?rowFor(get('SELECT enrollment FROM meta_marketing_enrollment_assets WHERE asset=?',request.assetRef)?.enrollment):null;
    if(initialRow)binding=grantBinding(initialRow,binding);
    const name=Object.keys(E.OPERATIONS).find(k=>E.OPERATIONS[k]===request.operation),isRead=M.OPERATIONS.includes(request.operation)||adsOperation(request.operation)||leadOperation(request.operation);
    if(!name&&!isRead)fail('operation_denied');
    if(name){E.validators[name](request.payload);E.authorize({request,principal,binding},environment);}else validateRead(request.operation,request.payload);
    const authority=C.hash(JSON.stringify([principal.id,principal.keyId,principal.publicKey])),configDigest=K.fingerprint(binding);
    const commandDigest=C.hash(canonical({operation:request.operation,tenantRef:request.tenantRef,connectionRef:request.connectionRef,assetRef:request.assetRef,payload:request.payload}));
    const auditPolicy=leadOperation(request.operation)&&principal.id===L.ingressPrincipal(environment)?resolve(request,principal,policy):policy;
    const event=(action,result,reason)=>eventFor(request,principal,auditPolicy,action,result,reason,now());
    function authorityNow(){
      currentPrincipal(principal,policy,authority);
      const fresh=grantBinding(initialRow,source(policy,request.connectionRef));
      if(K.fingerprint(fresh)!==configDigest)fail('scope_denied');
      require('./auth').authorize(principal,request,isRead?resolve(request,principal,policy):policy);return fresh;
    }
    let row=name?owned(request,rowFor(request.payload.enrollmentId)):assetOwner(request,principal,policy).row;
    if(name==='status'){
      authorityNow();return {requestId:request.requestId,data:row?receipt(row,binding):{enrollmentId:request.payload.enrollmentId,status:'not_found',accessBlocked:true},replayed:false};
    }
    if(name==='revoke'&&row&&succession(row.id)){authorityNow();return {requestId:request.requestId,data:receipt(row,binding),replayed:false};}
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
    let credentialEpoch;
    const check=()=>{
      if(signal.aborted)fail('provider_timeout');authorityNow();
      const current=store.connection(binding.connectionRef,now());if(revision!==undefined&&current.revision!==revision)fail('connection_blocked');revision=current.revision;
      if(isRead){
        const v=assetOwner(request,principal,policy);row=v.row;const active=enrollmentActive(row,binding,{requireActive:true});task.assets=active.assets;
        // HMAC acceptance/challenge do not borrow a user credential. Their
        // stable grant/receipt generation survives a concurrent token renewal.
        if(credentialEpochs&&![L.OPERATIONS.receiptAccept,L.OPERATIONS.challenge].includes(request.operation)){
          if(credentialEpoch!==undefined&&credentialEpoch!==active.credential.epoch)fail('secret_version_changed');credentialEpoch=active.credential.epoch;
        }
        return {...active,assets:task.assets,asset:v.asset,account:v.account};
      }
      const flow=flowFor(flowId),metadata=flowActive(binding,flow);
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
      if(leadOperation(request.operation)&&[L.OPERATIONS.receiptAccept,L.OPERATIONS.challenge].includes(request.operation)){
        if(request.operation===L.OPERATIONS.receiptAccept){
          const raw=Buffer.from(request.payload.rawBase64,'base64');try{data=await secrets.withApplication(binding,appSecret=>{context=check();return leadReceipts.accept({raw,signature:request.payload.signature,appSecret,
            context:leadContext(row,binding,context.asset,context.account),authorize:check,allowNew:()=>!barrier(row),settledDuplicate});},signal);}finally{raw.fill(0);}
        }else data=await secrets.withLeadVerification(binding,leadAds.verifyTokenRef,verifyToken=>{
          check();const supplied=Buffer.from(request.payload.token);try{if(supplied.length!==verifyToken.length||!timingSafeEqual(supplied,verifyToken))fail('invalid_signature');return {challenge:request.payload.challenge};}finally{supplied.fill(0);}
        },signal);
        L.validateResponse(request.operation,data,request.payload);
      }else if(!row||name==='activate'||isRead){
        data=await secrets.withCandidate(binding,context.flow,context.flow.secret_digest,async borrowed=>{
          context=check();if(JSON.stringify(borrowed.metadata)!==context.flow.credential_metadata)fail('secret_unavailable');
          if(isRead){
            if(leadOperation(request.operation))return leadsHttp.read({binding,...borrowed,asset:context.asset,account:context.account,operation:request.operation,payload:request.payload,signal,authorize:check,
              context:{principalId:principal.id,tenantRef:request.tenantRef,policyVersion:policy.version},...(request.operation===L.OPERATIONS.receiptRead?(()=>{const r=leadReceipts.read(request.payload.receiptRef,leadContext(row,binding,context.asset,context.account));return {receipt:r.event,recipientClinicId:r.recipientClinicId};})():{})});
            if(adsOperation(request.operation))return adsHttp.read({binding,...borrowed,asset:context.asset,operation:request.operation,payload:request.payload,signal,authorize:check,
              context:{principalId:principal.id,tenantRef:request.tenantRef,policyVersion:policy.version}});
            return http.readCandidate({binding,...borrowed,asset:context.asset,operation:request.operation,signal,authorize:check});
          }
          const inventory=await http.discover({binding,...borrowed,signal,authorize:check});D.checkAssets(inventory,borrowed.metadata);
          const refs=name==='prepare'?request.payload.assetRefs:context.assets.map(a=>a.assetRef);
          const result=E.assets(refs.map(ref=>{const value=inventory.find(a=>a.assetRef===ref);if(!value)fail('scope_denied');return E.identity(value);}));
          if(row&&JSON.stringify(result)!==JSON.stringify(context.assets))fail('scope_denied');
          return result;
        },signal,context.credential?.retentionStage?{retentionStage:context.credential.retentionStage}:{requirePending:true});
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
      const safe=new BrokerError(code);if(code==='rate_limited'&&Number.isSafeInteger(error.retryAfterMs)&&error.retryAfterMs>0)safe.retryAfterMs=error.retryAfterMs;throw safe;
    }finally{clearTimeout(timer);running.delete(enrollmentId);}
  }
  const operations=Object.fromEntries(Object.entries(E.OPERATIONS).map(([name,op])=>[op,{provider:C.PROVIDER,control:'meta_marketing_oauth',validate:E.validators[name],
    authorize:context=>E.authorize(context,environment),execute}]));
  for(const op of M.OPERATIONS)operations[op]={provider:C.PROVIDER,control:'meta_marketing_oauth',validate:payload=>M.validate(op,payload),execute};
  if(adsRead)for(const op of Object.values(A.OPERATIONS))operations[op]={provider:C.PROVIDER,control:'meta_marketing_oauth',validate:payload=>A.validate(op,payload),execute};
  if(leadAds)for(const op of Object.values(L.OPERATIONS))operations[op]={provider:C.PROVIDER,control:'meta_marketing_oauth',validate:payload=>L.validate(op,payload),persistResult:false,execute};
  operations[M.REVOKE]={provider:C.PROVIDER,control:'revoke_asset',validate:payload=>M.validate(M.REVOKE,payload),onRevoked:request=>abortAsset(request.assetRef)};
  return {operations,resolve,abortFlow,
    providerLifecycleAuthority,
    connectionAuthority(connectionRef,policy){
      const sources=policy.connections.filter(b=>b.connectionRef===connectionRef);
      return sources.length===1&&policy.principals.some(p=>p.id===roles.gateway&&p.enabled===true)&&providerLifecycleAuthority(connectionRef,sources[0]);
    },
    bindingForEnrollment:grantBinding,
    receiptForEnrollment(id,binding){const row=rowFor(id);if(!row)fail('scope_denied');return receipt(row,grantBinding(row,binding));},
    activeOperations(id){return [...running.values()].filter(t=>t.enrollmentId===id).length;},
    commitBusinessHandover({oldEnrollmentId,newEnrollmentId,flow,binding,assets,handoverId,receiptRefs}){
      const old=rowFor(oldEnrollmentId);if(!old||old.state!=='active'||succession(old.id)||rowFor(newEnrollmentId)||!K.business(binding))fail('scope_denied');
      const original=E.assets(JSON.parse(old.assets));if(JSON.stringify(original)!==JSON.stringify(E.assets(assets)))fail('scope_denied');exclusions(original,old.id,true);
      if([...running.values()].some(t=>t.enrollmentId===old.id))fail('oauth_flow_busy');
      const selectionDigest=E.selectionDigest(flow,binding,assets);
      store.db.prepare("INSERT INTO meta_marketing_enrollments VALUES (?,?,?,?,?,?,?,?,?,?,?,'active',?,?,?)").run(newEnrollmentId,flow.id,old.principal,old.tenant,old.connection,old.scope,K.fingerprint(binding),flow.scope_digest,flow.secret_digest,selectionDigest,JSON.stringify(assets),now(),now(),now());
      const chosen=assets.map(a=>a.assetRef),physicalRefs=[...new Set(assets.flatMap(physical))];
      for(const ref of chosen)if(store.db.prepare('UPDATE meta_marketing_enrollment_assets SET enrollment=? WHERE asset=? AND enrollment=?').run(newEnrollmentId,ref,old.id).changes!==1)fail('scope_denied');
      for(const ref of physicalRefs)if(store.db.prepare('UPDATE meta_marketing_enrollment_claims SET enrollment=? WHERE asset=? AND enrollment=?').run(newEnrollmentId,ref,old.id).changes!==1)fail('scope_denied');
      store.db.prepare('INSERT INTO meta_marketing_enrollment_successions VALUES (?,?,?,?,?)').run(old.id,newEnrollmentId,handoverId,JSON.stringify(receiptRefs),now());
      for(const receiptRef of receiptRefs){const receiptRow=get('SELECT * FROM meta_marketing_lead_receipts WHERE id=?',receiptRef);if(!receiptRow||receiptRow.enrollment!==old.id&&!get('SELECT 1 FROM meta_marketing_business_receipt_lineage WHERE receipt=? AND new_enrollment=?',receiptRef,old.id))fail('scope_denied');store.db.prepare('INSERT INTO meta_marketing_business_receipt_lineage VALUES (?,?,?,?)').run(receiptRef,newEnrollmentId,handoverId,old.id);}
      return receipt(rowFor(newEnrollmentId),binding);
    },
    renewalAuthority(enrollmentId,binding){
      if(!credentialEpochs||!C.uuid(enrollmentId))fail('operation_denied');
      const row=rowFor(enrollmentId);if(!row||row.state!=='active'||succession(row.id))fail('scope_denied');binding=grantBinding(row,binding);
      const authority=enrollmentActive(row,binding,{requireActive:true,allowExpired:true});
      return {row,binding,assets:authority.assets,credential:authority.credential};
    },
    assertRenewalCredential(enrollmentId,binding,metadata){
      if(!credentialEpochs||!C.uuid(enrollmentId))fail('operation_denied');
      const row=rowFor(enrollmentId),authority=enrollmentActive(row,grantBinding(row,B.baseBinding(binding)),{requireActive:true,allowExpired:true});
      const candidateBinding=metadata.tokenType==='SYSTEM_USER'?B.forCredential(B.baseBinding(binding),businessConfig,metadata,authority.assets):B.baseBinding(binding);
      K.metadata(metadata,candidateBinding);
      for(const asset of authority.assets.filter(value=>value.kind==='ad_account'))K.assertPaidAttribution(candidateBinding,metadata,asset);
      for(const asset of authority.assets)M.assertAssetCredential(metadata,asset);
      const pairs=(leadAds?.pairs||[]).filter(pair=>authority.assets.some(a=>a.assetRef===pair.pageAssetRef)&&authority.assets.some(a=>a.assetRef===pair.adAccountAssetRef));
      if(X.includes(enrolledAssetAccess,binding)){
        const active=enrolledAuthority(row,grantBinding(row,B.baseBinding(binding)),{allowExpired:true,metadata}),accounts=active.assets.filter(a=>a.kind==='ad_account');
        if(accounts.length===1)for(const page of active.assets.filter(a=>a.kind==='facebook_page'&&!leadAds.pairs.some(p=>p.pageAssetRef===a.assetRef)))pairs.push(leadPair(row,binding,page,accounts[0],{allowExpired:true,metadata}));
      }
      for(const pair of pairs){
        const page=authority.assets.find(a=>a.assetRef===pair.pageAssetRef),account=authority.assets.find(a=>a.assetRef===pair.adAccountAssetRef);
        leadPair(row,binding,page,account,{allowExpired:true,metadata});
        for(const scope of L.REQUIRED_SCOPES){
          if(!metadata.scopes.includes(scope))fail('oauth_credentials_incomplete');
          const granular=metadata.granularScopes.find(value=>value.scope===scope);
          if(granular&&!granular.targetIds.includes(scope==='ads_read'?account.id:page.id))fail('scope_denied');
        }
      }
    },close(){closed=true;stop(()=>true);}};
}
module.exports={createMetaMarketingEnrollment};
