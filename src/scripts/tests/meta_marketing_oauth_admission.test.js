'use strict';

const test=require('node:test'),assert=require('node:assert/strict');
const {Op}=require('sequelize');
const C=require('../../services/metaMarketingOAuth.contract');
const B=require('../../../services/integrations-broker/src/meta-marketing-oauth-contract');
const A=require('../../../services/integrations-broker/src/meta-marketing-admission-contract');
const {createAdmission}=require('../../services/metaMarketingAdmission.service');
const {loadDiscoverySource}=require('./fixtures/business_profile_discovery.fixture');
const order=require('../../services/metaMarketingTransactionOrder.service');
const blocks=require('../../services/metaScopeBlock.service');

// Actual scope, tombstone and transaction-order code; all storage and external
// effects are closed fixtures. A write, audit or provider call fails the test.
function fixture({scopeKey='clinic:71',admitted=false,flowState,foreign=false,tombstones=[],allowed=true,sessionError,blockError,recovery=false,prepareSlot}={}){
  const events=[],effects=[],now=new Date('2030-01-01T00:00:00Z');
  const transaction={LOCK:{UPDATE:'QA_UPDATE'}};
  let inTransaction=false, revoked=false;
  const actor={scopeKey,actorId:501,sessionRef:'00000000-0000-4000-8000-000000000001',sessionExpiresAt:new Date(+now+3600000)};
  const clinicIds=scopeKey.startsWith('group:')?[71,72]:[71];
  const reject=name=>()=>{effects.push(name);throw Error('UNEXPECTED_EFFECT_'+name);};
  const flow=flowState?{flow_id:'00000000-0000-4000-8000-000000000002',scope_key:scopeKey,app_id:'123',
    actor_user_id:foreign?502:actor.actorId,state:flowState,clinic_ids:JSON.stringify(clinicIds),expires_at:new Date(+now+600000)}:null;
  const candidate={scope_key:scopeKey,connection_ref:'connection:fictitious',asset_ref:'meta-enroll:'+scopeKey,app_id:'123',
    clinic_ids:JSON.stringify(clinicIds),scopes:JSON.stringify(['ads_read','public_profile']),
    redirect_uri:'https://qa.invalid/oauth/meta/marketing/callback',expires_at:new Date(+now+86400000),state:'active'};
  let slot=admitted?candidate:null;
  const checkTx=options=>{assert.equal(options.transaction,transaction);assert.equal(options.lock,transaction.LOCK.UPDATE);};
  const models={
    sequelize:{transaction:async(options,work)=>{
      assert.equal(options.isolationLevel,'REPEATABLE READ');events.push('transaction');inTransaction=true;
      try{return await work(transaction);}finally{inTransaction=false;}
    }},
    Clinica:{findAll:async options=>{checkTx(options);events.push('clinics');return clinicIds.map(id_clinica=>({id_clinica}));},
      findByPk:async(_id,options)=>{checkTx(options);events.push('clinic_parent');return {grupoClinicaId:91};}},
    UsuarioClinica:{findAll:reject('membership_outside_acl')},
    MetaScopeBlock:{findOne:async options=>{checkTx(options);events.push('tombstones');if(blockError)throw blockError;
      return options.where.scope_key[Op.in].some(key=>tombstones.includes(key))?{scope_key:'PRIVATE_BLOCK_KEY'}:null;}},
    MetaMarketingOAuthSlot:{findByPk:async(key,options)=>{assert.equal(key,scopeKey);checkTx(options);events.push('slot');return slot;},
      create:async(row,options)=>{assert.equal(options.transaction,transaction);assert.equal(slot,null);events.push('slot_created');slot=row;}},
    MetaMarketingOAuthRequest:{findOne:async()=>flow,findByPk:async()=>flow,create:reject('flow_create'),update:reject('flow_update')},
    MetaMarketingEnrollmentRequest:{findOne:async()=>null,create:reject('enrollment_create')},
    MetaMarketingBrokerRevocation:{
      findAll:async options=>{checkTx(options);events.push('revocations');return [];},
      findOne:async options=>{checkTx(options);return revoked?{tuple_hash:'f'.repeat(64)}:null;}
    }
  };
  const scopeModule=loadDiscoverySource('services/metaMarketingOAuthScope.service.js',{
    './metaMarketingOAuth.contract':C,'./metaScopeBlock.service':blocks,
    './metaMarketingLegacyRecovery.service':{createRecovery:()=>({inspectPrepared:async()=>{events.push('recovery');return recovery?{immutableDigest:'f'.repeat(64)}:null;}})},
    '../lib/marketingScopeAccess':{hasMarketingClinicScopeAccess:async input=>{events.push('acl');assert.equal(input.access,'write');return allowed;}}
  });
  const module=loadDiscoverySource('services/metaMarketingOAuth.service.js',{
    'node:crypto':require('node:crypto'),sequelize:require('sequelize'),'./metaMarketingOAuth.contract':C,
    '../../services/integrations-broker/src/meta-marketing-oauth-contract':B,
    '../../services/integrations-broker/src/meta-marketing-discovery-contract':{},
    '../../services/platform-audit/src/meta-oauth-event':{fromFlow:reject('audit_event')},
    '../../services/platform-audit/src/meta-discovery-event':{fromDiscovery:reject('discovery_event')},
    './metaMarketingOAuthScope.service':scopeModule,'./metaMarketingTransactionOrder.service':order,
    './platformAudit.repository':{createRepository:()=>({health:reject('audit_health'),append:reject('audit_append')})},
    './metaMarketingEnrollmentReview.service':{createReview:()=>reject('assignment_review')}
  });
  const sessions={verifyNormalReference:async(_reference,options)=>{assert.equal(Object.hasOwn(options,'requireEmail'),false);checkTx({...options,lock:transaction.LOCK.UPDATE});events.push('session');if(sessionError)throw sessionError;}};
  const admission=prepareSlot?{enabled:()=>true,async prepare(snapshot){
    assert.equal(inTransaction,false);
    events.push('prepare');
    await prepareSlot({snapshot,clinicIds,tombstones,revoke:()=>{revoked=true;},deny:()=>{allowed=false;}});
    return candidate;
  }}:null;
  const service=module.createService({models,sessions,client:{execute:reject('broker')},now:()=>now,enabled:()=>true,admission});
  return {actor,service,events,effects,transaction,safe:module.safe,scope:scopeModule.createScope({models,sessions,now:()=>now})};
}
const json=value=>JSON.parse(JSON.stringify(value));
async function errorCode(work,code,status){await assert.rejects(work,error=>error.code===code&&error.httpStatus===status);}

test('initial GET reports admission required and POST rejects without writes or identifiers',async()=>{
  for(const scopeKey of ['clinic:71','group:5']){
    const f=fixture({scopeKey});
    assert.deepEqual(json(await f.service.status(f.actor)),{enabled:true,available:false,status:'none',admission:{state:'required'}});
    await errorCode(()=>f.service.begin(f.actor),'meta_oauth_admission_required',409);
    assert.equal(f.safe({code:'meta_oauth_admission_required'}),'meta_oauth_admission_required');
    assert.deepEqual(f.effects,[]);
    assert(f.events.indexOf('acl')<f.events.indexOf('slot'));
    assert(f.events.indexOf('slot')<f.events.indexOf('tombstones'));
  }
});

test('initial GET and POST distinguish all inherited Meta tombstones from missing admission',async()=>{
  for(const [scopeKey,key] of [['clinic:71','clinic:71'],['clinic:71','meta:clinic:71'],['clinic:71','group:91'],['clinic:71','meta:group:91'],
    ['group:5','group:5'],['group:5','meta:group:5'],['group:5','clinic:72'],['group:5','meta:clinic:72']]){
    const f=fixture({scopeKey,tombstones:[key]});
    await errorCode(()=>f.service.status(f.actor),'meta_oauth_scope_blocked',409);
    await errorCode(()=>f.service.begin(f.actor),'meta_oauth_scope_blocked',409);
    assert.deepEqual(f.effects,[]);
  }
});

test('failed tombstone read fails closed and authority is checked before admission metadata',async()=>{
  const unavailable=fixture({blockError:Error('PRIVATE_STORAGE_DETAIL')});
  for(const method of ['status','begin'])await errorCode(()=>unavailable.service[method](unavailable.actor),'meta_security_state_unavailable',503);
  assert.equal(unavailable.safe({code:'meta_security_state_unavailable'}),'meta_oauth_unavailable');
  for(const options of [{allowed:false},{sessionError:{code:'auth_invalid',status:401}}]){
    const f=fixture(options);
    for(const method of ['status','begin'])await errorCode(()=>f.service[method](f.actor),options.allowed===false?'meta_oauth_scope_forbidden':'meta_oauth_session_required',options.allowed===false?403:401);
    assert.equal(f.events.includes('slot'),false);assert.equal(f.events.includes('tombstones'),false);assert.deepEqual(f.effects,[]);
  }
});

test('admitted scope output and its existing recovery exception remain unchanged',async()=>{
  for(const options of [{admitted:true},{admitted:true,recovery:true,tombstones:['meta:clinic:71']}]){
    const f=fixture(options);
    assert.deepEqual(json(await f.service.status(f.actor)),{enabled:true,available:true,status:'none'});
    assert.deepEqual(f.effects,[]);
  }
  const blocked=fixture({admitted:true,tombstones:['meta:clinic:71']});
  await errorCode(()=>blocked.service.status(blocked.actor),'meta_oauth_scope_blocked',409);
});

test('historical flows without slots keep their exact projection and legacy POST error',async()=>{
  for(const state of ['awaiting','cancel_pending','cancelled','staged']){
    const f=fixture({flowState:state,tombstones:['meta:clinic:71']});
    assert.deepEqual(json(await f.service.status(f.actor)),{enabled:true,available:false,requestId:'00000000-0000-4000-8000-000000000002',
      status:state,connected:false,expiresAt:'2030-01-01T00:10:00.000Z',pending:!['staged','cancelled','interrupted'].includes(state),
      clinicCount:1,cancellationConfirmed:state==='cancelled',candidateReady:state==='staged',canListAssets:false});
    await errorCode(()=>f.service.begin(f.actor),'meta_oauth_unconfigured',503);
    assert.equal(f.events.includes('tombstones'),false);assert.deepEqual(f.effects,[]);
  }
  const busy=fixture({flowState:'awaiting',foreign:true});
  assert.deepEqual(json(await busy.service.status(busy.actor)),{enabled:true,available:false,status:'busy'});
});

test('scope capture without initial-journal proof retains its existing missing-slot behavior',async()=>{
  const f=fixture({tombstones:['meta:clinic:71']});
  // No call site may infer a fresh admission from an omitted history marker.
  assert.equal((await f.scope.capture(f.actor,f.transaction)).slot,null);
  assert.equal(f.events.includes('tombstones'),false);
  assert.deepEqual(f.effects,[]);
});

test('initial slot is prepared outside SQL and recorded only after fresh authorization',async()=>{
  const f=fixture({prepareSlot:({snapshot})=>{
    assert.equal(snapshot.scopeKey,'clinic:71');
    assert.deepEqual([...snapshot.clinicIds],[71]);
  }});
  assert.deepEqual(json(await f.service.status(f.actor)),{enabled:true,available:true,status:'none'});
  assert(!f.events.includes('prepare'));
  // The closed fixture deliberately stops ordinary OAuth at its audit guard.
  await assert.rejects(()=>f.service.begin(f.actor),/UNEXPECTED_EFFECT_audit_event/);
  assert(f.events.indexOf('prepare')<f.events.indexOf('slot_created'));
  assert(f.events.slice(f.events.indexOf('prepare')+1,f.events.indexOf('slot_created')).includes('acl'));
  await assert.rejects(()=>f.service.begin(f.actor),/UNEXPECTED_EFFECT_audit_event/);
  assert.equal(f.events.filter(x=>x==='prepare').length,1);
  assert.equal(f.events.filter(x=>x==='slot_created').length,1);
});

test('scope membership, revocation or lost access during preparation defeats insertion',async()=>{
  for(const [prepareSlot,code,status] of [
    [({clinicIds})=>{clinicIds.push(73);},'meta_oauth_scope_changed',409],
    [({tombstones})=>{tombstones.push('clinic:72');},'meta_oauth_scope_blocked',409],
    [({revoke})=>revoke(),'meta_oauth_scope_blocked',409],
    [({deny})=>deny(),'meta_oauth_scope_forbidden',403]
  ]){
    const f=fixture({scopeKey:'group:5',prepareSlot});
    await errorCode(()=>f.service.begin(f.actor),code,status);
    assert(!f.events.includes('slot_created'));assert.deepEqual(f.effects,[]);
  }
});

test('the admission client accepts only an exact receipt for an empty candidate in its requested scope',async()=>{
  const now=new Date('2030-01-01T00:00:00Z');
  const scopeKey='group:5',clinicIds=[71,72];
  const snapshot={scopeKey,clinicIds,scopeDigest:C.hash(JSON.stringify([scopeKey,clinicIds])),sessionExpiresAt:new Date(+now+60000)};
  const config={META_MARKETING_OAUTH_SELF_SERVICE_ENABLED:'true',META_MARKETING_OAUTH_SELF_SERVICE_SCOPES:scopeKey};
  const binding={scopeKey,clinicIds,connectionRef:A.connectionRef(scopeKey),assetRef:'meta-enroll:'+scopeKey,
    appId:'123',scopes:['ads_read','public_profile'],redirectUri:'https://qa.invalid/oauth/meta/marketing/callback',expiresAt:+now+86400000};
  let calls=0;
  const service=(env,mutate=()=>{})=>createAdmission({env,now:()=>now,client:{async execute(command,budget){
    calls++;
    assert.equal(command.operation,A.OPERATION);
    assert.equal(command.tenantRef,'clinic:71');
    assert.equal(command.assetRef,'meta-enroll:'+scopeKey);
    assert.equal(command.connectionRef,binding.connectionRef);
    assert.equal(command.payload.expiresAt,+snapshot.sessionExpiresAt);
    assert.equal(command.payload.clinicSetDigest,C.hash(JSON.stringify(clinicIds)));
    assert.equal(budget.timeoutMs,30000);
    const receipt={requestId:command.requestId,replayed:false,data:{status:'prepared',connected:false,binding:structuredClone(binding)}};
    mutate(receipt);return receipt;
  }}});
  await errorCode(()=>service({}).prepare(snapshot),'meta_oauth_admission_required',409);
  assert.equal(calls,0);
  const slot=await service(config).prepare(snapshot);
  assert.equal(slot.connection_ref,binding.connectionRef);
  assert.equal(slot.clinic_ids,'[71,72]');
  assert.deepEqual(slot.expires_at,new Date(binding.expiresAt));
  for(const mutate of [
    r=>{r.data.connected=true;},r=>{r.data.binding.secretArn='UNEXPECTED';},
    r=>{r.data.binding.clinicIds=[71,73];},r=>{r.data.binding.expiresAt=+now;},
    r=>{r.requestId='UNRELATED';}
  ])await errorCode(()=>service(config,mutate).prepare(snapshot),'broker_response_invalid',503);
});

test('existing authoritative GET/POST router exposes only the typed admission or blocked contract',async()=>{
  async function request(f,method){
    const routes=new Map(),router={};
    for(const verb of ['get','post','delete'])router[verb]=(path,handler)=>routes.set(verb+path,handler);
    const sessions={verify:async token=>{assert.equal(token,'FICTITIOUS_TOKEN');return {sessionVersion:1,jti:f.actor.sessionRef,
      userId:f.actor.actorId,exp:+f.actor.sessionExpiresAt/1000};}};
    const module=loadDiscoverySource('routes/metaMarketingOAuth.routes.js',{
      express:{Router:()=>router},'../services/metaMarketingOAuth.contract':C,
      '../services/metaMarketingOAuth.service':{safe:f.safe},
      '../services/accessSession.service':{bearer:header=>{assert.equal(header,'Bearer FICTITIOUS_TOKEN');return 'FICTITIOUS_TOKEN';}}
    });
    module.createRouter({service:f.service,sessions,returnOrigin:'https://qa.invalid'});
    const [kind,id]=f.actor.scopeKey.split(':'),response={status:200};
    const res={set:()=>{},status:status=>{response.status=status;return res;},json:body=>{response.body=json(body);}};
    await routes.get(method+'/authorization')({headers:{authorization:'Bearer FICTITIOUS_TOKEN'},params:{},
      query:{assignment_scope:kind,[kind==='group'?'group_id':'clinic_id']:id}},res);
    return response;
  }
  const initial=fixture();
  assert.deepEqual(await request(initial,'get'),{status:200,body:{enabled:true,available:false,status:'none',admission:{state:'required'}}});
  assert.deepEqual(await request(initial,'post'),{status:409,body:{success:false,error:'meta_oauth_admission_required'}});
  const blocked=fixture({tombstones:['meta:clinic:71']});
  for(const method of ['get','post'])assert.deepEqual(await request(blocked,method),{status:409,body:{success:false,error:'meta_oauth_scope_blocked'}});
  const unavailable=fixture({blockError:Error('PRIVATE_STORAGE_DETAIL')});
  assert.deepEqual(await request(unavailable,'get'),{status:503,body:{success:false,error:'meta_oauth_unavailable'}});
  const historical=fixture({flowState:'cancelled'});
  assert.deepEqual(await request(historical,'post'),{status:503,body:{success:false,error:'meta_oauth_unconfigured'}});
  for(const f of [initial,blocked,unavailable,historical])assert.deepEqual(f.effects,[]);
});
