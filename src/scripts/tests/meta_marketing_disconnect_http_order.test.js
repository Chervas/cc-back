'use strict';
// Boundary regression: real router, access-session verifier, scope policies and
// retirement orchestration. Models and prefix persistence are closed doubles;
// actual InnoDB ordering is exercised separately by the owned-MySQL fixture.
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),{randomUUID}=require('node:crypto');
const express=require('express'),jwt=require('jsonwebtoken'),sequelize=require('sequelize');
const {loadDiscoverySource,unusedMetaSurfaceDependencies}=require('./fixtures/business_profile_discovery.fixture');
const {connectionForTestServer}=require('./fixtures/campaign_offline_runtime.cjs');
const roles=require('../../lib/role-helpers'),scopeAccess=require('../../lib/oauthMarketingScopeAccess'),shared=require('../../lib/sharedMarketingAssetMutationAccess');
const SECRET='FICTITIOUS_HTTP_WITHDRAWAL_JWT_SECRET',deny=()=>{throw Error('UNEXPECTED_META_DISCONNECT_DEPENDENCY');};
const copy=value=>JSON.parse(JSON.stringify(value));
function matches(row,where={}){return Reflect.ownKeys(where).every(key=>{const expected=where[key];if(key===sequelize.Op.or)return expected.some(value=>matches(row,value));if(key===sequelize.Op.and)return expected.every(value=>matches(row,value));
 if(expected&&typeof expected==='object'&&!Array.isArray(expected)){if(expected[sequelize.Op.in])return expected[sequelize.Op.in].includes(row[key]);throw Error('UNSUPPORTED_CLOSED_QUERY');}return row[key]===expected;});}

async function fixture(t,{mode='enforce',method='password',userId=99,external=false,foreignShare=false,allowed=[71,72],beforeMain=null,temporary=false,lockErrorAtWrite=null}={}){
 const sec=Math.floor(Date.now()/1000),sessionId=randomUUID(),user={id_usuario:userId,email_usuario:'withdrawal-review@example.invalid',password_usuario:'FICTITIOUS_CREDENTIAL_HASH',estado_cuenta:'activo',es_provisional:false};
 const state={events:[],verifications:[],tokens:0,metadata:0,work:0,preserved:0,transactions:0,allowed:[...allowed],external:Number(external),foreignShare,temporary,sessionState:'active',user,method,
 data:{assignments:[{id:1,scopeKey:'group:5',assignmentScope:'group',clinicaId:null,grupoClinicaId:5,metaConnectionId:9,status:'active'},{id:2,scopeKey:'clinic:72',assignmentScope:'clinic',clinicaId:72,grupoClinicaId:null,metaConnectionId:10,status:'active'}],
 mappings:[{id:11,assetType:'facebook_page',metaAssetId:'401',metaConnectionId:9,assignmentScope:'group',clinicaId:null,grupoClinicaId:5,isActive:true},{id:12,assetType:'facebook_page',metaAssetId:'402',metaConnectionId:10,assignmentScope:'clinic',clinicaId:72,grupoClinicaId:null,isActive:true}],tombstones:[]},
 whatsapp:{connection:10,number:'FICTITIOUS_OTHER_SCOPE_NUMBER',authorization:'FICTITIOUS_WA_PRIVATE_PLACEHOLDER'}};
 let storedCredentialBinding;const emailChallengeId=randomUUID(),trustedDeviceId=randomUUID();
 const clinics=[{id_clinica:71,grupoClinicaId:5},{id_clinica:72,grupoClinicaId:5},{id_clinica:73,grupoClinicaId:6}],data=options=>options?.transaction?.draft||state.data;
 const models={};
 models.sequelize={transaction:async(options,work)=>{if(typeof options==='function'){work=options;options={};}state.transactions++;if(state.transactions===2&&beforeMain)await beforeMain(state);
  const transaction={LOCK:{UPDATE:'UPDATE'},draft:copy(state.data),number:state.transactions};state.events.push('tx:'+transaction.number);
  try{const value=await work(transaction);state.data=transaction.draft;transaction.finished='commit';return value;}catch(error){transaction.finished='rollback';throw error;}},
 query:async(statement,options)=>{assert.match(statement,/^SELECT s\.\*, u\.password_usuario/);assert.equal(options.replacements.userId,userId);assert.equal(options.replacements.id,sessionId);if(options.transaction){assert.match(statement,/FOR UPDATE$/);state.events.push('session');}
  return [[{session_id:sessionId,user_id:userId,state:state.sessionState,issued_at:new Date((sec-60)*1000),expires_at:new Date((sec+600)*1000),absolute_expires_at:new Date((sec+3600)*1000),credential_binding:storedCredentialBinding,
   password_usuario:user.password_usuario,email_usuario:user.email_usuario,estado_cuenta:user.estado_cuenta,es_provisional:user.es_provisional,authentication_method:method,
   ...(method==='password_email'||method==='password_trusted_device'?{email_verified_at:new Date((sec-120)*1000),email_challenge_id:method==='password_email'?emailChallengeId:null,trusted_device_id:method==='password_trusted_device'?trustedDeviceId:null}:{})}]];}};
 models.Usuario={findByPk:async(id,options={})=>{assert.equal(id,userId);if(options.transaction){state.events.push('user');assert.equal(options.lock,'UPDATE');}return {...user};}};
 models.UsuarioClinica={findAll:async options=>{assert.equal(options.where.id_usuario,userId);assert(options.where.rol_clinica[sequelize.Op.in].includes('agencia'));if(options.transaction){assert.equal(options.lock,'UPDATE');state.events.push('memberships');}
  return state.allowed.filter(id=>options.where.id_clinica[sequelize.Op.in].includes(id)).map(id=>({id_clinica:id}));}};
 models.Clinica={findByPk:async(id,options={})=>{if(options.transaction){assert.equal(options.lock,'UPDATE');state.events.push('clinic');}return clinics.find(row=>row.id_clinica===id)||null;},findAll:async options=>{if(options.transaction){assert.equal(options.lock,'UPDATE');state.events.push('clinics');}return clinics.filter(row=>matches(row,options.where)).map(row=>({...row}));}};
 models.MetaConnection={findByPk:async(id,options={})=>{assert.equal(id,9);assert(options.attributes.every(key=>['id','credentials_external'].includes(key)),'The route must never borrow token fields');return {id:9,credentials_external:state.external};}};
 models.MetaConnectionAssignment={findAll:async options=>data(options).assignments.filter(row=>matches(row,options.where)).map(row=>({...row})),findByPk:async(id,options)=>data(options).assignments.find(row=>row.id===id)||null,
 findOne:async options=>data(options).assignments.find(row=>matches(row,options.where))||null,upsert:async(values,options)=>{state.work++;const row=data(options).assignments.find(row=>row.scopeKey===values.scopeKey);Object.assign(row,values);state.events.push('assignment-write');}};
 models.ClinicMetaAsset={findAll:async options=>data(options).mappings.filter(row=>matches(row,options.where)).map(row=>({...row,update:async(patch,{transaction})=>{state.work++;Object.assign(transaction.draft.mappings.find(item=>item.id===row.id),patch);state.events.push('mapping-write');
  if(lockErrorAtWrite)throw Object.assign(Error('FICTITIOUS_PRIVATE_DATABASE_DETAIL'),{original:{code:lockErrorAtWrite}});}}))};
 models.GroupAssetClinicAssignment={findAll:async()=>state.foreignShare?[{id:91,assetType:'meta.facebook_page',assetId:11,clinicaId:999,grupoClinicaId:99}]:[]};models.GrupoClinica={findAll:async()=>[]};
 const ordering=require('../../services/metaMarketingTransactionOrder.service'),prepared=new WeakMap();
 const block={prepareRetirement:async({scope,clinicIds})=>{state.events.push('prepare');return {scopeKey:scope.scopeKey,clinicIds:[...clinicIds]};},lockRetirement:async(context,transaction)=>{state.events.push('prefix');assert(transaction);prepared.set(context,transaction);},
 validateRetirement:async(context,transaction)=>{state.events.push('validate');assert.equal(prepared.get(context),transaction);if(state.temporary)throw Object.assign(Error('FICTITIOUS_PRIVATE_DATABASE_DETAIL'),{code:'meta_security_state_unavailable',httpStatus:503});},
 preserve:async({scope,clinicIds,transaction,preparedContext})=>{assert.equal(prepared.get(preparedContext),transaction);assert.equal(preparedContext.scopeKey,scope.scopeKey);assert.deepEqual([...clinicIds],preparedContext.clinicIds);state.preserved++;state.events.push('preserve');transaction.draft.tombstones.push(scope.scopeKey,...clinicIds.map(id=>'clinic:'+id));}};
 const blockedEmails={isBlockedAuthEmail:()=>false};
 const adminCredentials=loadDiscoverySource('lib/adminCredentialSession.js',{'node:crypto':require('node:crypto'),jsonwebtoken:jwt,'./role-helpers':roles,'./blocked-auth-emails':blockedEmails});
 const sessionModule=loadDiscoverySource('services/accessSession.service.js',{'node:crypto':require('node:crypto'),jsonwebtoken:jwt,sequelize,'../lib/blocked-auth-emails':blockedEmails,'../lib/role-helpers':roles,'../lib/adminCredentialSession':adminCredentials,
  '../../services/platform-audit/src/event':{UUID:/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/},'./delegatedSession.service':{isDelegatedToken:()=>false}});
 const config={mode,ttl:43200,secret:SECRET,emailMfaMode:method==='password'?'off':'enforce'};
 const sessionService=sessionModule.createService({models,config:()=>config,delegatedSessions:{hasReference:async()=>false},trustedDevices:{verifySession:async()=>{state.events.push('trusted-device');}},audit:{append:deny}});
 storedCredentialBinding=sessionService.credentialBinding(user);
 const sessions={...sessionService,bearer:sessionModule.bearer,settings:()=>config,verifyReference:async(reference,options)=>{state.verifications.push({...options,transaction:!!options.transaction});assert.equal(options.requireEmail,false);return sessionService.verifyReference(reference,options);}};
 const claims={userId,email:user.email_usuario,iat:sec-60,exp:sec+600,...(mode==='legacy'?adminCredentials.claims(user,SECRET):{type:'cc_access',iss:'clinicaclick',aud:'clinicaclick-platform',sessionVersion:1,jti:sessionId,...(method==='password'?{}:{amr:method==='password_email'?['pwd','email']:['pwd','trusted_device'],emailVerifiedAt:sec-120})})};
 const token=jwt.sign(claims,SECRET,{algorithm:'HS256'}),auth=loadDiscoverySource('routes/auth.middleware.js',{'../services/accessSession.service':sessions});
 const market=loadDiscoverySource('lib/marketingScopeAccess.js',{sequelize,'../../models':models,'./role-helpers':roles});
 const resolver=loadDiscoverySource('services/scopeConnectionResolver.service.js',{sequelize,'../../models':models});
 const resolveMetaConnectionForScope=async options=>{state.metadata++;assert.equal(options.metadataOnly,true);const scope=resolver.buildSharedConnectionScope(await resolver.normalizeScope(options));return {connection:{id:9,expiresAt:new Date(0)},assignment:copy(state.data.assignments.find(row=>row.scopeKey===scope.scopeKey)),scope};};
 const disconnect=loadDiscoverySource('services/oauthScopedDisconnect.service.js',{sequelize,'../../models':models,'../lib/sharedMarketingAssetMutationAccess':shared,'./metaScopeBlock.service':block,'./metaMarketingTransactionOrder.service':ordering});
 const revocation=loadDiscoverySource('services/metaMarketingRevocation.service.js',{'node:crypto':require('node:crypto'),sequelize,'./metaMarketingRevocation.contract':require('../../services/metaMarketingRevocation.contract'),'./metaMarketingBrokerScope.service':{},'../../services/platform-audit/src/meta-disconnect-event':{},'./platformAudit.repository':{createRepository:deny}});
 const router=loadDiscoverySource('routes/oauth.routes.js',{...unusedMetaSurfaceDependencies(),express,sequelize,'../../models':models,'./auth.middleware':auth,'../services/accessSession.service':sessions,
  '../lib/marketingScopeAccess':market,'../lib/oauthMarketingScopeAccess':scopeAccess,'../services/scopeConnectionResolver.service':{...resolver,resolveMetaConnectionForScope},'../services/oauthScopedDisconnect.service':disconnect,'../services/metaMarketingRevocation.service':revocation,'../lib/adminCredentialSession':adminCredentials},
  {env:{AUTH_EMAIL_MFA_MODE:config.emailMfaMode,META_MARKETING_BUSINESS_ENABLED:'false',META_MARKETING_CREDENTIAL_RENEWAL_ENABLED:'false',META_MARKETING_REVOCATION_ENABLED:'false'}});
 const app=express();app.use('/oauth',router);const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const agent=new http.Agent({keepAlive:false});agent.createConnection=connectionForTestServer(server);
 t.after(()=>new Promise(resolve=>{agent.destroy();server.close(resolve);server.closeAllConnections();}));
 const request=(authenticated=true,path='?assignment_scope=group&group_id=5')=>new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,agent,method:'DELETE',path:'/oauth/meta/disconnect'+path,headers:authenticated?{authorization:'Bearer '+token}:{}},res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>{assert(!body.includes(SECRET)&&!body.includes(token)&&!body.includes('FICTITIOUS_PRIVATE_DATABASE_DETAIL'));resolve({status:res.statusCode,body:JSON.parse(body)});});});req.on('error',reject);req.end();});
 return {state,request};
}

for(const settings of [{mode:'legacy',method:'password'},{mode:'enforce',method:'password'},{mode:'enforce',method:'password_email'},{mode:'enforce',method:'password_trusted_device'}])test(`actual DELETE accepts ${settings.mode}/${settings.method} withdrawal with gates off and an expired provider credential, preserving clinic overrides`,async t=>{
 const {state,request}=await fixture(t,settings),wa=copy(state.whatsapp),override=copy(state.data.mappings[1]);assert.equal((await request(false)).status,401);assert.equal(state.metadata,0);
 const response=await request();assert.equal(response.status,200);assert.equal(response.body.success,true);assert.equal(state.data.assignments[0].status,'disconnected');assert.equal(state.data.assignments[1].status,'active');assert.equal(state.data.mappings[0].isActive,false);assert.deepEqual(state.data.mappings[1],override);assert.deepEqual(state.whatsapp,wa);
 assert.deepEqual(state.data.tombstones,['group:5','clinic:71']);assert.equal(state.preserved,1);assert.equal(state.tokens,0);
 const prefix=state.events.indexOf('prefix'),fresh=state.events.lastIndexOf(settings.mode==='legacy'?'memberships':'session'),validate=state.events.indexOf('validate'),write=state.events.indexOf('mapping-write');assert(prefix>=0&&fresh>prefix&&validate>fresh&&write>validate);
 if(settings.mode==='enforce')assert.equal(state.verifications.length,2);else assert.equal(state.verifications.length,0);
});

test('whole-group WRITE remains required even when a clinic has its own connection override',async t=>{
 const {state,request}=await fixture(t,{allowed:[71]});assert.equal((await request()).status,403);assert.equal(state.metadata,0);assert.equal(state.work,0);assert.equal(state.preserved,0);
});
test('session revocation after preparation is 401 and cannot mutate mappings, assignments or tombstones',async t=>{
 const {state,request}=await fixture(t,{beforeMain:value=>{value.sessionState='revoked';}}),before=copy(state.data);const response=await request();assert.equal(response.status,401);assert.equal(state.work,0);assert.equal(state.preserved,0);assert.deepEqual(state.data,before);
});
test('legacy global-admin credential recheck rejects a changed password without adding managed-session or email-MFA requirements',async t=>{
 const {state,request}=await fixture(t,{mode:'legacy',userId:44,beforeMain:value=>{value.user.password_usuario='FICTITIOUS_REPLACED_HASH';}}),before=copy(state.data);assert.equal((await request()).status,401);assert.deepEqual(state.data,before);assert.equal(state.work,0);
});
test('a managed credential change after preparation invalidates the stored session binding before withdrawal',async t=>{
 const {state,request}=await fixture(t,{beforeMain:value=>{value.user.password_usuario='FICTITIOUS_REPLACED_HASH';}}),before=copy(state.data);const response=await request();assert.equal(response.status,401);assert.equal(response.body.code,'auth_invalid');assert.deepEqual(state.data,before);assert.equal(state.work,0);
});
test('permission withdrawal during preparation is rechecked inside the main transaction',async t=>{
 const {state,request}=await fixture(t,{beforeMain:value=>{value.allowed=[71];}}),before=copy(state.data);assert.equal((await request()).status,403);assert.deepEqual(state.data,before);assert.equal(state.work,0);assert.equal(state.preserved,0);
});
test('external broker credentials retain the existing scoped-revocation 409 both before and after preparation',async t=>{
 for(const options of [{external:true},{beforeMain:value=>{value.external=1;}}]){const {state,request}=await fixture(t,options),before=copy(state.data);const response=await request();assert.equal(response.status,409);assert.equal(response.body.error,'meta_marketing_scoped_revocation_required');assert.deepEqual(state.data,before);assert.equal(state.work,0);assert.equal(state.preserved,0);}
});
test('temporary prefix validation failure is a sanitized 503 and commits no withdrawal',async t=>{
 const {state,request}=await fixture(t,{temporary:true}),before=copy(state.data);const response=await request();assert.equal(response.status,503);assert.equal(response.body.code,'meta_security_state_unavailable');assert.match(response.body.error,/Vuelve a intentarlo/);assert.deepEqual(state.data,before);assert.equal(state.work,0);assert.equal(state.preserved,0);
});
test('a changed assignment cannot be reused after the one bounded SQL-only reconciliation',async t=>{
 const {state,request}=await fixture(t,{beforeMain:value=>{value.data.assignments[0].metaConnectionId=10;}});const response=await request();assert.equal(response.status,503);assert.equal(response.body.code,'meta_security_state_unavailable');assert.equal(state.transactions,4);assert.equal(state.work,0);assert.equal(state.preserved,0);assert(state.data.mappings.every(row=>row.isActive));assert.deepEqual(state.data.tombstones,[]);
});
test('shared assets outside the requested group remain a 409 and the transaction rolls back',async t=>{
 const {state,request}=await fixture(t,{foreignShare:true}),before=copy(state.data);const response=await request();assert.equal(response.status,409);assert.equal(response.body.error,'scope_disconnect_shared_asset_conflict');assert.deepEqual(state.data,before);assert.equal(state.work,0);assert.equal(state.preserved,0);
});
for(const code of ['ER_LOCK_WAIT_TIMEOUT','ER_LOCK_DEADLOCK'])test(`${code} after withdrawal work rolls back and returns 503 without replaying work or changing channels`,async t=>{
 const {state,request}=await fixture(t,{lockErrorAtWrite:code}),before=copy(state.data),whatsapp=copy(state.whatsapp);const response=await request();
 assert.equal(response.status,503);assert.equal(response.body.code,'meta_security_state_unavailable');assert.deepEqual(state.data,before);assert.deepEqual(state.whatsapp,whatsapp);
 assert.equal(state.transactions,2);assert.equal(state.work,1);assert.equal(state.preserved,1);assert.equal(state.events.filter(value=>value==='mapping-write').length,1);assert.equal(state.events.includes('assignment-write'),false);assert.equal(state.tokens,0);
});
