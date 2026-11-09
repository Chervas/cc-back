'use strict';

const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
require('node:net').Socket.prototype.connect=()=>{throw Error('OFFLINE_NETWORK_FORBIDDEN');};
const modelFile=require.resolve('../../../models');
require.cache[modelFile]={id:modelFile,filename:modelFile,loaded:true,
  exports:new Proxy({},{get(){throw Error('REAL_MODELS_FORBIDDEN_IN_AVAILABILITY_FIXTURE');}})};
const {createService,configurationFrom}=require('../../services/metaMarketingBusiness.service');
const DISABLED={enabled:false,authorizationMode:null,canBegin:false,current:null,pending:null};

function fixture(scopeKey,{active=false,allowed=true}={}){
  const at=new Date('2030-01-01T12:00:00Z'),clinics=scopeKey==='group:28'?[1,70]:scopeKey==='group:29'?[66,72]:[95];
  const input={scopeKey,actorId:225,sessionRef:randomUUID(),sessionExpiresAt:new Date(+at+3600000)};
  const flow={flow_id:randomUUID(),scope_key:scopeKey,app_id:'401'},enrollment={enrollment_id:randomUUID(),...flow,state:'active'};
  const state={allowed,verified:true,transactions:0,authorizations:0,enrollmentReads:0,journalReads:0,assetReads:0,brokerCalls:0};
  const env={META_MARKETING_BUSINESS_SCOPE_MODES:'{"group:28":"BISU"}',META_MARKETING_BUSINESS_CONFIG_ID:'501',
    META_MARKETING_BUSINESS_GRAPH_VERSION:'v24.0',META_MARKETING_BUSINESS_PERMISSION_PROFILE:'paid-leads-v2'};
  const models={
    sequelize:{transaction:async(options,work)=>{
      assert.equal(options.isolationLevel,'REPEATABLE READ');state.transactions++;
      const transaction={LOCK:{UPDATE:'UPDATE'}};try{return await work(transaction);}finally{transaction.finished=true;}
    }},
    Clinica:{findAll:async options=>{
      assert.equal(options.lock,options.transaction.LOCK.UPDATE);
      assert.deepEqual(options.where,scopeKey.startsWith('group:')?{grupoClinicaId:Number(scopeKey.slice(6))}:{id_clinica:95});
      return clinics.map(id_clinica=>({id_clinica}));
    }},
    UsuarioClinica:{findAll:async()=>state.allowed?clinics.map(id_clinica=>({id_clinica})):[]},
    MetaMarketingEnrollmentRequest:{findOne:async()=>{state.enrollmentReads++;return active?{...enrollment}:null;},
      findByPk:async id=>{assert.equal(id,enrollment.enrollment_id);return {...enrollment};}},
    MetaMarketingOAuthRequest:{findOne:async()=>active?{...flow}:null,findByPk:async()=>({...flow})},
    MetaMarketingBusinessHandover:{findByPk:async()=>null,findOne:async()=>{state.journalReads++;return null;}},
    MetaMarketingBrokerBinding:{findAll:async()=>{state.assetReads++;assert.fail('Unconfigured scopes must not inspect asset authority');}},
    PlatformAuditEvent:{},
  };
  const sessions={verifyReference:async(value,options)=>{
    state.authorizations++;assert.equal(value.userId,225);assert.equal(options.requireEmail,true);
    if(!state.verified)throw Object.assign(Error('email'),{code:'auth_email_verification_required'});
  }};
  const service=createService({models,sessions,now:()=>at,enabled:()=>true,configuration:key=>configurationFrom(env,key),
    audit:{health:async()=>assert.fail('No audit writes'),append:async()=>assert.fail('No audit writes')},drain:{},
    client:{execute:async()=>{state.brokerCalls++;assert.fail('No broker/provider I/O');}}});
  return {service,input,state};
}

for(const scopeKey of ['clinic:95','group:29'])test(`global Business gate keeps unconfigured active USER ${scopeKey} on the ordinary UI`,async()=>{
  const f=fixture(scopeKey,{active:true});
  assert.deepEqual(await f.service.overview(f.input),DISABLED);
  assert.equal(f.state.authorizations,2,'preauthorization and fresh main authorization remain mandatory');
  assert.equal(f.state.journalReads,0);assert.equal(f.state.assetReads,0);assert.equal(f.state.brokerCalls,0);
});

test('configured group28 exposes the BISU panel while requiring an active connection before begin',async()=>{
  const f=fixture('group:28');
  assert.deepEqual(await f.service.overview(f.input),{enabled:true,authorizationMode:'BISU',canBegin:false,current:null,pending:null});
  assert.equal(f.state.authorizations,2);assert.equal(f.state.brokerCalls,0);
});

test('unconfigured scopes retain current session/email and entire-scope WRITE guards',async()=>{
  for(const scopeKey of ['clinic:95','group:29'])for(const denial of ['allowed','verified']){
    const f=fixture(scopeKey,{active:true});f.state[denial]=false;
    await assert.rejects(f.service.overview(f.input),{code:denial==='allowed'?'meta_oauth_scope_forbidden':'auth_email_verification_required'});
    assert.equal(f.state.enrollmentReads,0);assert.equal(f.state.journalReads,0);assert.equal(f.state.brokerCalls,0);
  }
});
