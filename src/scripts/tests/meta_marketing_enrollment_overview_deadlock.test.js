'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {createRequire}=require('node:module');
require('./fixtures/security_offline_runtime.cjs');
const SRC=require.resolve('../../services/metaMarketingEnrollment.service');
const actual=createRequire(SRC);
const C=actual('./metaMarketingEnrollment.contract'),Order=actual('./metaMarketingTransactionOrder.service');
const UUID=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const deadlock=()=>new (actual('sequelize').DatabaseError)(Object.assign(Error('FICTITIOUS_SQL_PRIVATE'),{code:'ER_LOCK_DEADLOCK',errno:1213,sqlState:'40001',sql:'FICTITIOUS_SQL_PRIVATE'}));
const timeout=()=>Object.assign(Error('FICTITIOUS_SQL_PRIVATE'),{name:'SequelizeDatabaseError',original:{code:'ER_LOCK_WAIT_TIMEOUT',errno:1205}});
function fixture({failures=1,at='committed',errorFactory=deadlock,mutate,denyOnRetry=false}={}){
  const now=new Date('2030-01-01T00:00:00Z'),input={scopeKey:'clinic:77',actorId:225,sessionRef:UUID(3),sessionExpiresAt:new Date(+now+3600000)};
  const row={enrollment_id:UUID(1),flow_id:UUID(2),scope_key:input.scopeKey,actor_user_id:225,session_ref:input.sessionRef,session_expires_at:new Date(+input.sessionExpiresAt),
    prepare_request_id:UUID(4),activate_request_id:UUID(5),revoke_request_id:UUID(6),scope_digest:'a'.repeat(64),flow_digest:'b'.repeat(64),candidate_digest:'c'.repeat(64),assignment_digest:'d'.repeat(64),
    connection_ref:'meta-auto-fiction77',app_id:'101',meta_user_id:'201',meta_connection_id:303,clinic_ids:'[77]',assets:JSON.stringify(C.assets([{assetRef:'meta-ad_account:301',kind:'ad_account',id:'301',parentPageId:null}])),
    mapping_ids:'[401]',state:'active',selection_digest:'e'.repeat(64),requested_at:now,updated_at:now,next_attempt_at:now,prepared_at:now,activated_at:now,revoked_at:null,
    attempts:0,last_error:null,lease_token:null,lease_until:null};
  C.request(row);
  const flow={flow_id:row.flow_id,scope_key:row.scope_key,app_id:row.app_id};
  const state={transactions:[],events:[],auth:0,work:0,failures:0,provider:0,writes:0};
  const authorize=async(value,transaction)=>{
    state.auth++;state.events.push(['auth',transaction.id,value.scopeKey,value.actorId,value.sessionRef,+value.sessionExpiresAt]);
    assert.equal(value.scopeKey,'clinic:77');assert.equal(value.actorId,225);assert.equal(value.sessionRef,UUID(3));assert.equal(+value.sessionExpiresAt,+now+3600000);
    if(denyOnRetry&&state.failures)throw Object.assign(Error('revoked'),{code:'meta_oauth_session_required',httpStatus:401});
  };
  function failAt(options,point){
    if(at!==point||state.failures>=failures)return;
    state.failures++;if(mutate)mutate(input);
    const error=errorFactory();
    // Exact Sequelize mysql/query.js effect of errno1213 before DatabaseError escapes.
    if(error.original?.errno===1213){options.transaction.finished='rollback';state.events.push(['dialectRollback',options.transaction.id]);}
    throw error;
  }
  const models={sequelize:{transaction:async(options,work)=>{
    assert.equal(options.isolationLevel,'REPEATABLE READ');
    const transaction={id:state.transactions.length+1,LOCK:{UPDATE:'UPDATE'},finished:null};state.transactions.push(transaction);state.events.push(['begin',transaction.id]);
    try{const result=await work(transaction);if(transaction.finished)throw Error('Transaction cannot be committed because it has been finished with state: '+transaction.finished);
      transaction.finished='commit';state.events.push(['commit',transaction.id]);return result;
    }catch(error){if(!transaction.finished)transaction.finished='rollback';state.events.push(['rejected',transaction.id,error.original?.code||error.code||error.name]);throw error;}
  }},
    MetaMarketingEnrollmentRequest:{findOne:async()=>({...row}),findByPk:async(id,options)=>{assert.equal(id,row.enrollment_id);failAt(options,'current');return {...row};}},
    MetaMarketingOAuthRequest:{findOne:async()=>({...flow}),findByPk:async()=>({...flow})},MetaMarketingBusinessHandover:{findByPk:async()=>null},
  };
  const module={exports:{}};
  const closedRequire=name=>{
    if(name==='./metaMarketingOAuthScope.service')return {createScope:()=>({authorize})};
    if(name==='./metaMarketingEnrollmentAuthority.service')return {createAuthority:()=>({})};
    if(name==='./metaMarketingEnrollmentBinding.service')return {createBindings:()=>({committed:async(_id,transaction)=>{state.work++;failAt({transaction},'committed');return {business:null};}})};
    if(name==='./metaMarketingActiveInventory.service')return {createActiveInventory:()=>({describe:async()=>({mode:'active'})})};
    if(/models(?:\/index)?$|dotenv|app\.js/.test(name))throw Error('FORBIDDEN_RUNTIME_DEPENDENCY');
    return actual(name);
  };
  vm.runInNewContext(fs.readFileSync(SRC,'utf8'),{module,exports:module.exports,require:closedRequire,process:{env:{}},structuredClone,console,JSON,Date},{filename:SRC});
  const service=module.exports.createService({models,sessions:{},client:{execute:async()=>{state.provider++;throw Error('NO_PROVIDER');}},now:()=>now,enabled:()=>true,discoveryEnabled:()=>true});
  return {service,input,state,safe:module.exports.safe};
}
for(const at of ['current','committed'])test('one actual overview retries a rolled-back SQL deadlock at '+at+' and reauthorizes',async()=>{
  const f=fixture({at}),result=await f.service.overview(f.input);
  assert.equal(result.selection.connected,true);assert.equal(result.discovery.mode,'active');assert.equal(f.state.failures,1);assert.equal(f.state.auth,at==='current'?3:4);
  assert.equal(f.state.transactions.length,4);assert(f.state.transactions.every(tx=>tx.finished));assert.equal(f.state.transactions[1].finished,'rollback');
  assert.equal(f.state.transactions[3].finished,'commit');assert.equal(f.state.provider,0);assert.equal(f.state.writes,0);
});
test('a second typed deadlock propagates unchanged after exactly two complete attempts',async()=>{
  const f=fixture({failures:2});await assert.rejects(f.service.overview(f.input),error=>error.name==='SequelizeDatabaseError'&&error.original.code==='ER_LOCK_DEADLOCK');
  assert.equal(f.state.failures,2);assert.equal(f.state.auth,4);assert.equal(f.state.transactions.length,4);assert.equal(f.state.provider,0);
});
test('own session revoked between attempts is denied before a second enrollment read',async()=>{
  const f=fixture({denyOnRetry:true});await assert.rejects(f.service.overview(f.input),{code:'meta_oauth_session_required',httpStatus:401});
  assert.equal(f.state.auth,3);assert.equal(f.state.work,1);assert.equal(f.state.transactions.length,3);assert.equal(f.state.provider,0);
});
test('caller mutation cannot change original scope actor session or expiry on retry',async()=>{
  const f=fixture({mutate:input=>{input.scopeKey='clinic:88';input.actorId=999;input.sessionRef=UUID(99);input.sessionExpiresAt.setFullYear(2040);}});
  const result=await f.service.overview(f.input);assert.equal(result.selection.connected,true);assert.equal(f.state.auth,4);assert.equal(f.state.provider,0);
});
test('SQL lock-wait timeout retains the existing attention DTO and never doubles its latency',async()=>{
  const f=fixture({errorFactory:timeout});const result=await f.service.overview(f.input);
  assert.equal(result.selection.connected,false);assert.equal(result.selection.attentionRequired,true);assert.equal(f.state.auth,2);assert.equal(f.state.work,1);assert.equal(f.state.provider,0);
});
for(const errorFactory of [()=>Object.assign(Error('provider'),{code:'rate_limited',httpStatus:429}),()=>Object.assign(Error('validation'),{code:'meta_enrollment_scope_changed',httpStatus:409}),()=>Object.assign(Error('availability'),{code:'meta_enrollment_unavailable',httpStatus:503}),()=>Object.assign(Error('not-a-Sequelize-error'),{code:'ER_LOCK_DEADLOCK',errno:1213})])test('unrelated validation provider availability and untyped SQL-looking errors do not retry: '+errorFactory().message,async()=>{
  const f=fixture({errorFactory});const result=await f.service.overview(f.input);assert.equal(result.selection.connected,false);assert.equal(result.selection.attentionRequired,true);assert.equal(f.state.auth,2);assert.equal(f.state.work,1);assert.equal(f.state.provider,0);
});
test('HTTP permission denial from committed stays fail closed and is never retried',async()=>{
  const f=fixture({errorFactory:()=>Object.assign(Error('denied'),{code:'meta_oauth_scope_forbidden',httpStatus:403})});
  await assert.rejects(f.service.overview(f.input),{httpStatus:403});assert.equal(f.state.auth,2);assert.equal(f.state.work,1);assert.equal(f.state.provider,0);
});
async function httpOverview(f){
  const routeFile=require.resolve('../../routes/metaMarketingEnrollment.routes'),ractual=createRequire(routeFile),module={exports:{}};
  vm.runInNewContext(fs.readFileSync(routeFile,'utf8'),{module,exports:module.exports,Object,Date,process,require:name=>{
    if(name==='../services/metaMarketingEnrollment.service')return {safe:f.safe};
    if(name==='../services/accessSession.service')return {bearer:value=>{assert.equal(value,'Bearer FICTITIOUS');return 'FICTITIOUS';}};
    if(/models(?:\/index)?$|dotenv/.test(name))throw Error('FORBIDDEN_ROUTE_RUNTIME');return ractual(name);
  }},{filename:routeFile});
  const router=module.exports.createRouter({service:f.service,sessions:{verify:async()=>({userId:225,sessionVersion:1,jti:UUID(3),exp:+f.input.sessionExpiresAt/1000})}});
  const get=router.stack.find(layer=>layer.route?.path==='/enrollment'&&layer.route.methods.get).route.stack[0].handle;
  const result={status:200,headers:{}};const response={set:(k,v)=>{result.headers[k]=v;return response;},status:value=>{result.status=value;return response;},json:value=>{result.body=value;return response;}};
  await get({headers:{authorization:'Bearer FICTITIOUS'},query:{clinic_id:'77'},body:{},params:{}},response);return result;
}
test('actual HTTP GET handler keeps a fresh connected DTO after one typed SQL rollback',async()=>{
  const f=fixture(),result=await httpOverview(f);assert.equal(result.status,200);assert.equal(result.body.selection.connected,true);assert.equal(result.headers['Cache-Control'],'private, no-store');assert.equal(f.state.provider,0);
});
test('actual HTTP handler retains generic503 after bounded exhausted deadlock attempts',async()=>{
  const f=fixture({failures:2}),result=await httpOverview(f);assert.equal(result.status,503);assert.deepEqual(JSON.parse(JSON.stringify(result.body)),{success:false,error:'meta_enrollment_unavailable'});assert.equal(f.state.failures,2);assert.equal(f.state.provider,0);
});
