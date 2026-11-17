'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{randomUUID}=require('node:crypto');
const C=require('../../services/metaMarketingOAuth.contract');
function fixture(){
 const input={scopeKey:'clinic:95',actorId:225,sessionRef:randomUUID(),sessionExpiresAt:new Date('2030-01-02T00:00:00Z')};
 const row={flow_id:randomUUID(),scope_key:input.scopeKey,actor_user_id:225,session_ref:randomUUID(),state:'staged'};
 const state={currentValid:true,linked:null,originalChecks:0,currentChecks:0,ownerCalls:0,expireCurrentDuringOriginal:false};
 const tx={LOCK:{UPDATE:'UPDATE'}};
 const scope={authorize:async()=>{state.currentChecks++;if(!state.currentValid)C.fail('meta_oauth_session_required',401);},
  revalidate:async original=>{assert.equal(original.session_ref,row.session_ref);state.originalChecks++;if(state.expireCurrentDuringOriginal)state.currentValid=false;C.fail('meta_oauth_session_required',401);}};
 const models={MetaMarketingOAuthRequest:{findByPk:async()=>row},MetaMarketingEnrollmentRequest:{findOne:async()=>state.linked}};
 const filename=path.resolve(__dirname,'../../services/metaMarketingOAuth.service.js'),loaded=new Module(filename,module);loaded.filename=filename;loaded.paths=Module._nodeModulePaths(path.dirname(filename));
 const actual=loaded.require.bind(loaded);loaded.require=name=>{
  if(name==='./metaMarketingOAuthScope.service')return {createScope:()=>scope};
  if(name==='./metaMarketingTransactionOrder.service')return {pinInput:value=>({...value}),createOrder:()=>({flow:async(actor,_id,work)=>{await scope.authorize(actor);return work({transaction:tx});}})};
  if(name==='./platformAudit.repository')return {createRepository:()=>({health:async()=>({pending:0,oldestAgeSeconds:0}),append:async()=>assert.fail('Denied inventory must not reach provider/audit attempt')})};
  if(name==='./metaMarketingEnrollmentReview.service')return {createReview:()=>()=>assert.fail('No pending assignment review')};
  return actual(name);
 };loaded._compile(fs.readFileSync(filename,'utf8'),filename);
 const service=loaded.exports.createService({models,sessions:{},enabled:()=>true,discoveryEnabled:()=>true,client:{execute:async()=>{state.ownerCalls++;assert.fail('No Owner access');}}});
 return {input,row,state,service};
}
test('expired pending authorization returns domain409 while the current logged-in session remains valid',async()=>{
 const f=fixture();await assert.rejects(f.service.assets(f.input,f.row.flow_id),{code:'meta_oauth_authorization_expired',httpStatus:409});
 assert.equal(f.state.originalChecks,1);assert(f.state.currentChecks>=3);assert.equal(f.state.currentValid,true);assert.equal(f.state.ownerCalls,0);
});
test('current invalid session and a current expiry during historical verification retain genuine401',async()=>{
 for(const during of [false,true]){
  const f=fixture();if(during)f.state.expireCurrentDuringOriginal=true;else f.state.currentValid=false;
  await assert.rejects(f.service.assets(f.input,f.row.flow_id),{code:'meta_oauth_session_required',httpStatus:401});assert.equal(f.state.ownerCalls,0);
 }
});
test('active or retired enrollment cannot rediscover through its old pending OAuth flow or session',async()=>{
 for(const state of ['active','revoke_pending','revoked','superseded']){
  const f=fixture();f.state.linked={state};await assert.rejects(f.service.assets(f.input,f.row.flow_id),{code:'meta_oauth_inventory_not_pending',httpStatus:409});
  assert.equal(f.state.originalChecks,0);assert.equal(f.state.ownerCalls,0);
 }
});
test('pending discovery preserves its original actor binding',async()=>{
 const f=fixture();f.row.actor_user_id=44;await assert.rejects(f.service.assets(f.input,f.row.flow_id),{code:'meta_oauth_scope_forbidden',httpStatus:403});
 assert.equal(f.state.originalChecks,0);assert.equal(f.state.ownerCalls,0);
});
