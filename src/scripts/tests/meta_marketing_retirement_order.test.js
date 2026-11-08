'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const modelFile=require.resolve('../../../models');require.cache[modelFile]={id:modelFile,filename:modelFile,loaded:true,exports:{}};
const {withMetaRetirementTransaction}=require('../../services/oauthScopedDisconnect.service');
const block=require('../../services/metaScopeBlock.service');
const UUID='11111111-1111-4111-8111-111111111111';
function fixture(){
  const state={auth:0,main:0,work:0,queries:0,metadata:0,errors:[],override:[],onQuery:null,denyAt:null};
  const models={sequelize:{transaction:async(_options,work)=>{const transaction={LOCK:{UPDATE:'UPDATE'}};try{return await work(transaction);}catch(error){state.errors.push(error.code);throw error;}finally{transaction.finished='closed';}},
    query:async(sql,options)=>{assert.match(sql,/FOR UPDATE NOWAIT$/);assert(options.transaction);state.queries++;return state.onQuery?state.onQuery(sql,options):[[]];}},
    MetaMarketingEnrollmentRequest:{findOne:async()=>{state.metadata++;return null;}},MetaMarketingOAuthRequest:{findOne:async()=>{state.metadata++;return null;}},
    Clinica:{findAll:async options=>{if(options.transaction)assert(options.lock);return[{id_clinica:1,grupoClinicaId:28},{id_clinica:70,grupoClinicaId:28}];}},
    MetaConnectionAssignment:{findAll:async()=>state.override.map(clinicaId=>({clinicaId})),findOne:async()=>null},MetaConnection:{findByPk:async()=>({id:158,credentials_external:false})}};
  const scope={scopeKey:'group:28',assignmentScope:'group',groupId:28};
  const authorize=async transaction=>{assert(transaction);state.auth++;if(state.auth===state.denyAt)throw Object.assign(Error('denied'),{code:'AUTH_DENIED',httpStatus:403});return scope;};
  const work=async context=>{state.work++;assert(context.preparedContext);assert.deepEqual(context.inheritedClinicIds,[1,70].filter(id=>!state.override.includes(id)));return context.inheritedClinicIds;};
  return{state,models,scope,run:()=>withMetaRetirementTransaction({models,scope,connectionId:158,actorId:225,authorize},work)};
}
test('retirement only reconciles NOWAIT at the pre-work current metadata read, once and without replaying work',async()=>{
  const f=fixture();let once=true;f.state.onQuery=()=>{if(once){once=false;throw Object.assign(Error('locked'),{original:{code:'ER_LOCK_NOWAIT'}});}return[[]];};
  assert.deepEqual(await f.run(),[1,70]);assert.equal(f.state.auth,4);assert.equal(f.state.work,1);
  assert.deepEqual(f.state.errors,['meta_marketing_order_changed']);
  for(const code of ['ER_LOCK_DEADLOCK','ER_LOCK_WAIT_TIMEOUT','ETIMEDOUT']){
    const g=fixture();g.state.onQuery=()=>{throw Object.assign(Error('storage'),{code});};
    await assert.rejects(g.run(),{code:code==='ETIMEDOUT'?code:'meta_security_state_unavailable'});assert.equal(g.state.auth,2);assert.equal(g.state.work,0);assert.equal(g.state.queries,1);
  }
});
test('a SQL lock error after work rolls back once and becomes temporary503 without replaying work',async()=>{
  for(const code of ['ER_LOCK_WAIT_TIMEOUT','ER_LOCK_DEADLOCK']){
    const f=fixture();let calls=0,rolledBack=false;
    const transaction=f.models.sequelize.transaction;
    f.models.sequelize.transaction=async(options,work)=>{try{return await transaction(options,work);}catch(error){rolledBack=true;throw error;}};
    await assert.rejects(()=>withMetaRetirementTransaction({models:f.models,scope:f.scope,connectionId:158,actorId:225,authorize:async()=>f.scope},async()=>{calls++;throw Object.assign(Error('private lock detail'),{original:{code}});}),{code:'meta_security_state_unavailable',httpStatus:503});
    assert.equal(rolledBack,true);assert.equal(calls,1);
  }
});
test('even a private locator-change error cannot reconcile after work has begun',async()=>{
  const f=fixture();let calls=0;
  await assert.rejects(()=>withMetaRetirementTransaction({models:f.models,scope:f.scope,connectionId:158,actorId:225,authorize:async()=>f.scope},async()=>{calls++;require('../../services/metaMarketingTransactionOrder.service').changed();}),{code:'meta_security_state_unavailable',httpStatus:503});
  assert.equal(calls,1);
});
test('a newly committed Enrollment missed by the locator closes before work and retries only bounded SQL admission',async()=>{
  const f=fixture();f.state.onQuery=sql=>sql.includes('MetaMarketingEnrollmentRequests')?[[{enrollment_id:UUID,flow_id:UUID,scope_key:'clinic:1',app_id:'101'}]]:[[]];
  await assert.rejects(f.run(),{code:'meta_security_state_unavailable'});assert.equal(f.state.auth,4);assert.equal(f.state.work,0);assert.equal(f.state.queries,4);
});
test('original withdrawal authority is checked before metadata and freshly before NOWAIT/work; clinic overrides retain their old exclusion',async()=>{
  for(const denyAt of [1,2]){const f=fixture();f.state.denyAt=denyAt;await assert.rejects(f.run(),{code:'AUTH_DENIED'});assert.equal(f.state.work,0);assert.equal(f.state.queries,0);if(denyAt===1)assert.equal(f.state.metadata,0);}
  const f=fixture();f.state.override=[70];assert.deepEqual(await f.run(),[1]);assert.equal(f.state.work,1);
});
test('unprepared direct retire/preserve exports fail before any journal or tombstone write',async()=>{
  let writes=0;const transaction={LOCK:{UPDATE:'UPDATE'}},scope={assignmentScope:'clinic',clinicId:95},clinicIds=[95];
  const models={MetaMarketingRecovery:{findAll:async()=>assert.fail('late Recovery lock forbidden')},MetaMarketingBusinessHandover:{findAll:async()=>assert.fail('late H lock forbidden')},MetaScopeBlock:{findOrCreate:async()=>{writes++;}}};
  await assert.rejects(()=>block.preserve({models,transaction,scope,clinicIds,connectionId:158,actorId:225}),{code:'meta_security_state_unavailable'});
  await assert.rejects(()=>require('../../services/metaMarketingLegacyRecovery.service').createRecovery({models}).retireForScope({scope,clinicIds},transaction),{code:'meta_security_state_unavailable'});
  await assert.rejects(()=>require('../../services/metaMarketingBusinessSource.service').createSource({models}).retireForScope({scope,clinicIds},transaction),{code:'meta_security_state_unavailable'});
  assert.equal(writes,0);
});
