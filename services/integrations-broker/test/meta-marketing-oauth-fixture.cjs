'use strict';
const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const { randomUUID, randomBytes, generateKeyPairSync } = require('node:crypto'); const { EventEmitter } = require('node:events'); const { PassThrough } = require('node:stream');
const { BrokerStore } = require('../src/store'); const { Broker } = require('../src/broker'); const { signRequest } = require('../src/auth');
const { createMetaMarketingOAuth, createMetaMarketingOAuthOperations } = require('../src/meta-marketing-oauth'); const { createMetaMarketingOAuthSecrets } = require('../src/meta-marketing-oauth-secrets');
const { createMetaMarketingOAuthHttp } = require('../src/meta-marketing-oauth-http'); const C = require('../src/meta-marketing-oauth-contract'); const { ACCOUNT, SECRET_KEY } = require('../src/google-main');
const TOKEN = 'FICTITIOUS_META_OAUTH_TOKEN'; const APP = '0123456789abcdef'.repeat(2);
function fixture(t, { discovery = false, enrollment = false, renewal = false, leads = false, adsManagement = false, business = false, agency = false, migrationDays = 366 } = {}) {
  business=business||agency;
  renewal=renewal||business;leads=leads||business;
  enrollment=enrollment||renewal;
  discovery=discovery||enrollment;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-meta-oauth-qa-')); fs.chmodSync(dir, 0o700);
  const filename = path.join(dir, 'state.sqlite'); const gateway = generateKeyPairSync('ed25519'); const control = generateKeyPairSync('ed25519');
  const reader=enrollment?generateKeyPairSync('ed25519'):null,assetControl=enrollment?generateKeyPairSync('ed25519'):null;
  const prefix = `arn:aws:secretsmanager:eu-west-3:${ACCOUNT}:secret:/clinicaclick/integrations/prod/meta-marketing/staging/`;
  const binding = { connectionRef: 'connection:meta-enroll-qa', provider: C.PROVIDER, initialState: 'active', expiresAt: Date.now() + 86400000,
    secretArn: prefix + 'qa-candidate-abcdef', clientSecretArn: prefix + 'qa-app-abcdef', metaMarketingOAuth: {
      appId: '101', redirectUri: 'https://app.example.invalid/oauth/meta/marketing/callback', appVersionId: 'a'.repeat(32), slotVersionId: 's'.repeat(32),
      scopeKey: 'group:9', clinicIds: [71, 72], scopes: ['public_profile', 'ads_read', 'pages_read_engagement', 'instagram_basic'],
    } };
  if(business)binding.expiresAt=Date.now()+migrationDays*86400000;
  const businessConfig=agency?require('./meta-marketing-agency-fixture.cjs').config():business?{enabled:true,cohort:'meta-marketing-business-v1',configId:'777',graphVersion:'v27.0',providerBusinessId:'901',scopeKeys:['group:9']}:undefined;
  if(discovery)binding.metaMarketingOAuth.scopes.push('pages_show_list');
  if(leads)binding.metaMarketingOAuth.scopes.push('leads_retrieval','pages_manage_ads','pages_manage_metadata');
  if(adsManagement)binding.metaMarketingOAuth.scopes.push('ads_management');
  const leadAds=leads?{enabled:true,cohort:'meta-marketing-lead-ads-v1',verifyTokenRef:{secretArn:prefix+'qa-lead-verify-abcdef',versionId:'v'.repeat(32)},
    pairs:[{pageAssetRef:'meta-facebook_page:401',adAccountAssetRef:'meta-ad_account:301',recipientClinicId:71}]}:undefined;
  const principal = (id, keyId, key) => ({ id, keyId, enabled: true, maxPerMinute: 20, publicKey: key.publicKey.export({ type: 'spki', format: 'pem' }) });
  const grant = { connectionRef: binding.connectionRef, tenantRef: 'clinic:71', assetRef: 'meta-enroll:group:9' };
  const policy = { audience: 'broker:meta-oauth-qa', version: 'meta-oauth-qa-v1', maxBacklog: 100,
    principals: [principal('gateway:staging:meta-marketing-oauth', 'qa-gateway', gateway), principal('control:staging:meta-marketing-oauth', 'qa-control', control)],
    connections: [binding], grants: [{ ...grant, principalId: 'gateway:staging:meta-marketing-oauth', operations: Object.values(C.OPERATIONS) },
      { ...grant, principalId: 'control:staging:meta-marketing-oauth', operations: [C.OPERATIONS.status, C.OPERATIONS.abort] }] };
  if(discovery)policy.grants[0].operations.push(require('../src/meta-marketing-discovery-contract').OPERATION);
  if(enrollment){
    const E=require('../src/meta-marketing-enrollment-contract');
    policy.principals.push(principal('staging:meta-marketing','qa-reader',reader),principal('control:staging:meta-marketing','qa-asset-control',assetControl));
    policy.grants[0].operations.push(...Object.values(E.OPERATIONS));policy.grants[1].operations.push(E.OPERATIONS.status,E.OPERATIONS.revoke);
  }
  if(renewal){const R=require('../src/meta-marketing-credential-renewal-contract');policy.grants[0].operations.push(...Object.values(R.OPERATIONS));policy.grants[1].operations.push(R.OPERATIONS.status,R.OPERATIONS.abort);}
  if(business){const B=require('../src/meta-marketing-business-contract'),T=require('../src/meta-marketing-credential-maintenance-contract');policy.grants[0].operations.push(...Object.values(B.OPERATIONS));policy.grants[1].operations.push(B.OPERATIONS.status,B.OPERATIONS.abort,B.OPERATIONS.drain,...Object.values(T.OPERATIONS));}
  const records = new Map();
  const seed = (arn, version, value) => records.set(arn, new Map([[version, { body: JSON.stringify(value), stages: ['AWSCURRENT'] }]]));
  seed(binding.secretArn, binding.metaMarketingOAuth.slotVersionId, { version: 1, provider: 'meta-marketing-oauth-slot', connectionRef: binding.connectionRef, scopeKey: 'group:9', clinicSetDigest: C.clinicDigest(binding.metaMarketingOAuth), appId: '101' });
  seed(binding.clientSecretArn, binding.metaMarketingOAuth.appVersionId, { version: 1, provider: 'meta-app', appId: '101', appSecret: APP });
  const state = { clock: Date.now(), awsCalls: [], httpCalls: [], codes: 0, puts: 0, heldTokens: [], records,
    beforeAws: null, afterAws: null, beforeCode: null, afterGraph: null, failPut: false, losePut: false };
  const now = () => state.clock;
  const aws = { async send(command, options) {
    state.awsCalls.push(command); await state.beforeAws?.(command, options);
    const name = command.constructor.name; const input = command.input; const versions = records.get(input.SecretId);
    if (!versions) throw Error('FICTITIOUS_MISSING_SECRET'); let result;
    if (name === 'DescribeSecretCommand') result = { ARN: input.SecretId, KmsKeyId: SECRET_KEY, VersionIdsToStages: Object.fromEntries([...versions].map(([id, v]) => [id, [...v.stages]])) };
    else if (name === 'ListSecretVersionIdsCommand') {
      assert.equal(input.IncludeDeprecated, true); assert.equal(input.MaxResults, 100);
      result = { ARN: input.SecretId, Versions: [...versions.keys()].slice(0, 100).map(VersionId => ({ VersionId })), ...(versions.size > 100 ? { NextToken: 'more' } : {}) };
    } else if (name === 'GetSecretValueCommand') {
      const v = versions.get(input.VersionId); if (!v || input.VersionStage && !v.stages.includes(input.VersionStage)) throw Error('FICTITIOUS_MISSING_VERSION');
      result = { ARN: input.SecretId, VersionId: input.VersionId, VersionStages: [...v.stages], SecretString: v.body };
    } else if (name === 'PutSecretValueCommand') {
      state.puts++; assert.notEqual(input.SecretId, binding.clientSecretArn); assert.deepEqual(input.VersionStages, ['AWSPENDING']); assert(C.uuid(input.ClientRequestToken));
      if (state.failPut) throw Error('FICTITIOUS_WRITE_FAILED');
      if (versions.has(input.ClientRequestToken)) assert.equal(versions.get(input.ClientRequestToken).body, input.SecretString);
      else { for (const v of versions.values()) v.stages = v.stages.filter(s => s !== 'AWSPENDING'); versions.set(input.ClientRequestToken, { body: input.SecretString, stages: ['AWSPENDING'] }); }
      if (state.losePut) { state.losePut = false; throw Error('FICTITIOUS_ACK_LOST'); }
      result = { ARN: input.SecretId, VersionId: input.ClientRequestToken, VersionStages: [...versions.get(input.ClientRequestToken).stages] };
    } else if(name==='UpdateSecretVersionStageCommand'){
      assert.equal(input.SecretId,binding.secretArn);assert.match(input.VersionStage,/^CC_META_CREDENTIAL_[a-f0-9]{32}$/);assert.equal(input.RemoveFromVersionId,undefined);
      assert(versions.has(input.MoveToVersionId));assert(![...versions].some(([id,v])=>id!==input.MoveToVersionId&&v.stages.includes(input.VersionStage)));
      const stages=versions.get(input.MoveToVersionId).stages;if(!stages.includes(input.VersionStage))stages.push(input.VersionStage);
      result={ARN:input.SecretId};
    } else assert.fail('Unexpected AWS operation ' + name);
    return state.afterAws ? state.afterAws(command, result) : result;
  } };
  const request = (settings, callback) => {
    const req = new EventEmitter(); let destroyed=false; req.destroy = () => {destroyed=true;}; req.end = () => {
      const url=new URL('https://graph.facebook.com'+settings.path);
      assert.equal(settings.hostname,'graph.facebook.com'); assert.equal(settings.method,'GET');
      const kind=url.pathname.endsWith('/debug_token')?'inspect':url.pathname.endsWith('/adaccounts')?'adaccounts':url.pathname.endsWith('/accounts')?'accounts':
        url.pathname==='/v24.0/act_301'?'asset_ad_account':url.pathname==='/v24.0/501'?'asset_instagram_business':
        url.pathname==='/v24.0/401'?(url.searchParams.get('fields').includes('instagram_business_account')?'asset_instagram_parent':'asset_facebook_page'):url.searchParams.has('code')?'code':'extend';
      state.httpCalls.push({kind}); if(kind==='code')state.codes++;
      queueMicrotask(async()=>{
        try {
          if(kind==='code')await state.beforeCode?.();
          if(destroyed)return;
          let response;
          if(kind==='inspect') {
            assert.equal(settings.headers.authorization,'Bearer 101|'+APP);assert.equal(url.searchParams.get('input_token'),TOKEN);
            response={data:{app_id:'101',user_id:'201',type:'USER',is_valid:true,expires_at:Math.floor(now()/1000)+3600,data_access_expires_at:0,
              scopes:[...binding.metaMarketingOAuth.scopes],granular_scopes:[{scope:'ads_read',target_ids:['301']}]}};
          } else if(['adaccounts','accounts'].includes(kind)) {
            assert.equal(settings.headers.authorization,'Bearer '+TOKEN);assert.match(url.searchParams.get('appsecret_proof'),/^[a-f0-9]{64}$/);
            assert.equal(url.pathname,'/v24.0/201/'+kind);assert.equal(url.searchParams.get('limit'),'100');assert(!url.searchParams.get('fields').includes('access_token'));
            response=kind==='adaccounts'?{data:[{id:'act_301',account_id:'301',name:'Cuenta ficticia',account_status:1,currency:'EUR',timezone_name:'Europe/Madrid'}]}
              :{data:[{id:'401',name:'Página ficticia',instagram_business_account:{id:'501',name:'Instagram ficticio',username:'qa_ficticio'}}]};
            state.lastAfter=url.searchParams.get('after');
          } else if(kind.startsWith('asset_')){
            assert.equal(settings.headers.authorization,'Bearer '+TOKEN);assert.match(url.searchParams.get('appsecret_proof'),/^[a-f0-9]{64}$/);
            response=kind==='asset_ad_account'?{id:'act_301',account_id:'301',name:'Cuenta ficticia',account_status:1,currency:'EUR',timezone_name:'Europe/Madrid'}:
              kind==='asset_facebook_page'?{id:'401',name:'Página ficticia'}:kind==='asset_instagram_business'?{id:'501',name:'Instagram ficticio',username:'qa_ficticio'}:
              {id:'401',instagram_business_account:{id:'501'}};
          } else {
            assert.equal(url.pathname,'/v24.0/oauth/access_token');assert.equal(url.searchParams.get('client_secret'),APP);
            if(kind==='code')assert.equal(url.searchParams.get('redirect_uri'),binding.metaMarketingOAuth.redirectUri);
            else {assert.equal(url.searchParams.get('grant_type'),'fb_exchange_token');assert.equal(url.searchParams.get('fb_exchange_token'),'FICTITIOUS_META_SHORT_TOKEN');}
            response={access_token:kind==='code'?'FICTITIOUS_META_SHORT_TOKEN':TOKEN,token_type:'bearer',expires_in:3600};
          }
          if(state.afterGraph)response=await state.afterGraph(kind,response);
          const res=new PassThrough();res.statusCode=200;res.headers={'content-type':'application/json'};callback(res);res.end(JSON.stringify(response));
        } catch(e) {state.fixtureError=e;req.emit('error',e);}
      });
    };return req;
  };
  const businessTokens=new Map();let latestBusiness=null;
  const businessRequest=(settings,callback)=>{
    const url=new URL('https://graph.facebook.com'+settings.path),bearer=String(settings.headers.authorization||'').replace(/^Bearer /,''),input=url.searchParams.get('input_token');
    const kind=url.pathname.endsWith('/system_user_access_tokens')?'business_manage':url.pathname.endsWith('/me')?'business_me':url.pathname.endsWith('/assigned_ad_accounts')?'business_ads':url.pathname.endsWith('/assigned_pages')?'business_pages':input&&businessTokens.has(input)?'business_debug':url.searchParams.get('code')?.startsWith('FICTITIOUS_BUSINESS_CODE_')?'business_code':businessTokens.has(bearer)&&url.pathname.endsWith('/act_301')?'business_asset':null;
    if(!kind)return request(settings,callback);
    const req=new EventEmitter();let destroyed=false;req.destroy=()=>{destroyed=true;};req.end=body=>queueMicrotask(async()=>{try{
      assert.equal(settings.hostname,'graph.facebook.com');assert.equal(settings.rejectUnauthorized,true);assert.equal(settings.minVersion,'TLSv1.2');
      assert(url.pathname.startsWith('/v27.0/'));state.httpCalls.push({kind});let response,statusCode;
      if(kind==='business_code'){assert.equal(settings.method,'GET');assert.equal(url.searchParams.get('client_secret'),APP);assert.equal(url.searchParams.get('grant_type'),null);state.codes++;
        const token='FICTITIOUS_META_BUSINESS_TOKEN_'+(businessTokens.size+1);businessTokens.set(token,{subjectId:'601',clientBusinessId:'701',expiresAt:Math.floor(now()/1000)+60*86400});latestBusiness=token;response={access_token:token,token_type:'bearer',expires_in:60*86400};
      }else if(kind==='business_manage'){
        assert.equal(settings.method,'POST');const params=new URLSearchParams(body.toString());assert.equal(params.get('set_token_expires_in_60_days'),'true');assert.equal(params.get('scope'),require('../src/meta-marketing-business-contract').SCOPES.join(','));assert.equal(params.get('asset'),'301,401');assert.equal(params.get('system_user_id'),null);assert.match(params.get('appsecret_proof'),/^[a-f0-9]{64}$/);assert(businessTokens.has(bearer));
        state.manages=(state.manages||0)+(params.get('fetch_only')==='true'?0:1);state.fetches=(state.fetches||0)+(params.get('fetch_only')==='true'?1:0);
        if(params.get('fetch_only')==='false'&&state.manageRateLimitOnce){state.manageRateLimitOnce=false;response={error:{code:4}};statusCode=429;}
        else if(params.get('fetch_only')==='false'){const token='FICTITIOUS_META_BUSINESS_TOKEN_'+(businessTokens.size+1);businessTokens.set(token,{...businessTokens.get(bearer),expiresAt:Math.floor(now()/1000)+60*86400});latestBusiness=token;}
        response??={access_token:latestBusiness};
      }else if(kind==='business_debug'){assert.equal(settings.headers.authorization,'Bearer 101|'+APP);const value=businessTokens.get(input);response={data:{app_id:'101',user_id:value.subjectId,type:'SYSTEM_USER',is_valid:true,expires_at:value.expiresAt,data_access_expires_at:0,scopes:[...require('../src/meta-marketing-business-contract').SCOPES],granular_scopes:[{scope:'ads_read',target_ids:['301']}]}};
      }else if(kind==='business_me'){const value=businessTokens.get(bearer);assert(value);assert.equal(url.searchParams.get('fields'),'client_business_id');response={id:value.subjectId,client_business_id:value.clientBusinessId};
      }else if(kind==='business_ads')response={data:[{id:'act_301',account_id:'301',name:'Cuenta ficticia',account_status:1,currency:'EUR',timezone_name:'Europe/Madrid'}]};
      else if(kind==='business_pages')response={data:[{id:'401',name:'Página ficticia'}]};
      else response={id:'act_301',account_id:'301',name:'Cuenta ficticia',account_status:1,currency:'EUR',timezone_name:'Europe/Madrid'};
      if(state.afterGraph)response=await state.afterGraph(kind,response);
      if(destroyed)return;const res=new PassThrough();res.statusCode=statusCode||state.businessStatus||200;res.headers={'content-type':'application/json'};callback(res);res.end(JSON.stringify(response));
    }catch(error){req.emit('error',error);}});return req;
  };
  const chosenRequest=agency?require('./meta-marketing-agency-fixture.cjs').request({state,now,binding,fallback:request,appSecret:APP}):business?businessRequest:request;
  const http=createMetaMarketingOAuthHttp({request:chosenRequest,now});
  const secrets = createMetaMarketingOAuthSecrets({ client: aws, accountId: ACCOUNT, prefix: '/clinicaclick/integrations/prod/meta-marketing/staging/', kmsKeyArn: SECRET_KEY });
  const stores = []; const engines = [];
  function make(target = new BrokerStore(filename), chosenPolicy = policy) {
    stores.push(target);let enroll,renewer,businessOwner,maintenance;
    const activeHttp=agency?createMetaMarketingOAuthHttp({request:chosenRequest,now,agencyBootstrap:require('../src/meta-marketing-agency-bootstrap').createAgencyBootstrap({store:target,policy:chosenPolicy,now})}):http;
    const engine = createMetaMarketingOAuth({ store: target, policy: chosenPolicy, secrets, http:activeHttp, now, assetDiscovery:discovery,onAbort:id=>enroll?.abortFlow(id) }); engines.push(engine);
    const epochs=renewal?require('../src/meta-marketing-credential-epochs').createMetaMarketingCredentialEpochs({store:target,now}):null;
    if(enrollment){enroll=require('../src/meta-marketing-enrollment').createMetaMarketingEnrollment({store:target,secrets,http:activeHttp,environment:'staging',now,...(businessConfig?{businessConfig}:{}),...(epochs?{credentialEpochs:epochs}:{}),...(leadAds?{leadAds,leadsHttp:{read:()=>assert.fail('FICTITIOUS_LEAD_RPC_NOT_EXPECTED')}}:{})});engines.push(enroll);}
    if(renewal){renewer=require('../src/meta-marketing-credential-renewal').createMetaMarketingCredentialRenewal({store:target,epochs,enrollment:enroll,oauth:engine,secrets,http:activeHttp,environment:'staging',now});engines.push(renewer);}
    if(business){businessOwner=require('../src/meta-marketing-business').createMetaMarketingBusiness({store:target,epochs,enrollment:enroll,oauth:engine,secrets,http:activeHttp,environment:'staging',config:businessConfig,now});maintenance=require('../src/meta-marketing-credential-maintenance').createMetaMarketingCredentialMaintenance({store:target,epochs,enrollment:enroll,secrets,http:activeHttp,businessHttp:require('../src/meta-marketing-business-issuer-http').createIssuerHttp({request:chosenRequest,now}),environment:'staging',config:businessConfig,now});engines.push(businessOwner,maintenance);}
    if(business)target.setConnectionAuthorityResolver(ref=>enroll.connectionAuthority(ref,chosenPolicy));
    return { store: target, engine,enrollment:enroll,renewal:renewer,businessOwner,maintenance,epochs, broker: new Broker({ store: target, policy: chosenPolicy, secrets,policyResolver:enroll,
      operations: {...createMetaMarketingOAuthOperations(engine,{assetDiscovery:discovery}),...enroll?.operations,...renewer?.operations,...businessOwner?.operations,...maintenance?.operations}, now }) };
  }
  let current = make();
  const command = (operation, payload, overrides = {}) => ({ requestId: randomUUID(), ...grant, operation, payload, ...overrides });
  const signed = (value, isControl = false) => {
    const pair=isControl==='reader'?['qa-reader',reader]:isControl==='assetControl'?['qa-asset-control',assetControl]:isControl?['qa-control',control]:['qa-gateway',gateway];
    return signRequest(value, { keyId:pair[0],privateKey:pair[1].privateKey,audience:policy.audience,now:now() });
  };
  const execute = (operation, payload, overrides = {}, isControl = false, instance = current) => { const s = signed(command(operation, payload, overrides), isControl); return instance.broker.execute(s.raw, s.headers); };
  const begin = async (overrides = {}, instance = current) => {
    const flowId = randomUUID(); const payload = { state: randomBytes(32).toString('base64url'), expiresAt: now() + 600000,
      scopeDigest: C.hash('fictitious-group-snapshot'), clinicSetDigest: C.clinicDigest(binding.metaMarketingOAuth), ...overrides };
    const result = await execute(C.OPERATIONS.begin, payload, { requestId: flowId }, false, instance); return { flowId, payload, result, code: 'FICTITIOUS_META_CODE_' + flowId };
  };
  const finish = (flow, changes = {}, instance = current) => execute(C.OPERATIONS.finish, { flowId: flow.flowId, state: flow.payload.state, code: flow.code, ...changes }, {}, false, instance);
  const status = (flow, instance = current) => execute(C.OPERATIONS.status, { flowId: flow.flowId }, {}, false, instance);
  const abort = (flow, instance = current, isControl = false) => execute(C.OPERATIONS.abort, { flowId: flow.flowId }, {}, isControl, instance);
  const snapshot = (instance = current) => JSON.stringify(['meta_marketing_oauth_flows','audit_outbox','commands']
    .map(table=>instance.store.db.prepare('SELECT * FROM '+table).all()));
  const config={cohort:C.COHORT,enabled:true,environment:'staging',listenAddress:'127.0.0.1',port:19093,
    stateFile:path.join(dir,'runtime.sqlite'),tlsCertFile:path.join(dir,'tls.crt'),tlsKeyFile:path.join(dir,'tls.key'),policy};
  if(discovery)config.assetDiscovery=true;
  if(enrollment)config.assetEnrollment=true;
  if(renewal)config.credentialRenewal=true;
  if(leadAds)config.leadAds=leadAds;
  if(businessConfig)config[agency?'agencySystemUser':'businessLogin']=businessConfig;
  t.after(() => { for (const engine of engines) engine.close(); for (const store of stores) try { store.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, filename, binding, policy, state, records, secrets, aws, http, request:chosenRequest, config,businessTokens,businessConfig, now, make, command, signed, execute,
    begin, finish, status, abort, snapshot, gateway, control,reader,assetControl, get current() { return current; }, restart() { current.enrollment?.close();current.engine.close(); current.store.close(); current = make(); return current; } };
}
module.exports = { fixture, TOKEN, APP };
