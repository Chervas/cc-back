'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{randomUUID}=require('node:crypto');
const C=require('../../services/metaMarketingEnrollment.contract'),F=require('../../services/metaMarketingEffectiveCredential.service');
function fixture(){
 const clock=Date.parse('2030-01-01T12:00:00Z'),now=()=>new Date(clock),hash='a'.repeat(64),id=randomUUID(),oldVersion=randomUUID(),version=randomUUID();
 const selected=C.assets([{assetRef:'meta-ad_account:301',kind:'ad_account',id:'301',parentPageId:null},{assetRef:'meta-facebook_page:401',kind:'facebook_page',id:'401',parentPageId:null}]);
 const row={enrollment_id:id,flow_id:oldVersion,session_ref:randomUUID(),prepare_request_id:randomUUID(),activate_request_id:randomUUID(),revoke_request_id:randomUUID(),
  scope_key:'clinic:95',connection_ref:'fictitious-connection',scope_digest:hash,flow_digest:hash,candidate_digest:hash,assignment_digest:hash,
  meta_user_id:'201',app_id:'101',clinic_ids:'[95]',assets:JSON.stringify(selected),mapping_ids:'[409,410]',meta_connection_id:172,actor_user_id:225,
  session_expires_at:new Date(clock-86400000),requested_at:now(),updated_at:now(),next_attempt_at:now(),prepared_at:now(),activated_at:now(),revoked_at:null,
  lease_token:null,lease_until:null,attempts:0,state:'active',selection_digest:hash,last_error:null};
 const effective={epoch:2,versionId:version,digest:'b'.repeat(64),metadata:{appId:'101',subjectId:'201',tokenType:'USER',scopes:['ads_read','pages_read_engagement','pages_show_list'],
  granularScopes:[],expiresAt:clock+86400000,dataAccessExpiresAt:null}};
 const input={scopeKey:'clinic:95',actorId:225,sessionRef:randomUUID(),sessionExpiresAt:new Date(clock+3600000)};
 const state={valid:true,mfa:true,write:true,withdrawn:false,enabled:true,calls:[],audits:[],afterIo:null,patch:null,originalSessionChecks:0};
 const transaction={LOCK:{UPDATE:'UPDATE'}},models={sequelize:{transaction:async(_options,work)=>(work||_options)(transaction)},
  MetaMarketingEnrollmentRequest:{findByPk:async key=>key===id?{...row}:null},MetaMarketingOAuthRequest:{findByPk:async key=>{assert.equal(key,oldVersion);return {flow_id:oldVersion};}}};
 const authorize=async actor=>{
  if(actor.sessionRef===row.session_ref){state.originalSessionChecks++;assert.fail('Historical login must never authorize active inventory');}
  if(!state.valid)C.fail('meta_oauth_session_required',401);if(!state.mfa)C.fail('auth_email_verification_required',403);
  if(!state.write||actor.scopeKey!=='clinic:95'||actor.actorId!==225)C.fail('meta_oauth_scope_forbidden',403);
 };
 const source=path.resolve(__dirname,'../../services/metaMarketingActiveInventory.service.js'),loaded=new Module(source,module);loaded.filename=source;loaded.paths=Module._nodeModulePaths(path.dirname(source));
 const original=loaded.require.bind(loaded);loaded.require=name=>{
  if(name==='./metaMarketingOAuthScope.service')return {createScope:()=>({authorize})};
  if(name==='./metaMarketingTransactionOrder.service')return {pinInput:value=>({...value}),createOrder:()=>({enrollment:async(actor,key,work)=>{await authorize(actor);return work({transaction,enrollment:key===id&&actor.scopeKey===row.scope_key?row:null});}})};
  if(name==='./metaMarketingEnrollmentBinding.service')return {createBindings:()=>({committed:async()=>{if(state.withdrawn)C.fail('meta_enrollment_asset_revoked',409);return {digest:hash};}})};
  if(name==='./metaMarketingEffectiveCredential.service')return {...F,createEffectiveCredentials:()=>({resolve:async(_row,_flow,_transaction,options)=>{assert.equal(options,undefined);return structuredClone(effective);}})};
  return original(name);
 };loaded._compile(fs.readFileSync(source,'utf8'),source);
 const client={execute:async command=>{
  state.calls.push(command);assert.equal(command.operation,C.E.OPERATIONS.assets);assert.equal(command.payload.expectedEpoch,2);assert.equal(command.payload.expectedVersionId,version);
  assert.notEqual(command.payload.expectedVersionId,oldVersion);assert.equal(command.payload.expectedCandidateDigest,'b'.repeat(64));assert.equal(command.assetRef,'meta-enroll:clinic:95');
  const assets=selected.map(a=>({...a,name:'Fictitious '+a.kind,...(a.kind==='ad_account'?{accountStatus:1,currency:'EUR',timezone:'Europe/Madrid'}:{})}));
  const p=command.payload,data={enrollmentId:id,scopeKey:row.scope_key,scopeDigest:p.scopeDigest,selectionDigest:p.selectionDigest,clinicSetDigest:p.clinicSetDigest,assetSetDigest:p.assetSetDigest,
   epoch:2,versionId:version,digest:'b'.repeat(64),observedAt:clock,expiresAt:clock+300000,availableKinds:['ad_account','facebook_page'],assets};
  await state.afterIo?.();Object.assign(data,state.patch);return {requestId:command.requestId,replayed:false,data};
 }};
 const service=loaded.exports.createActiveInventory({models,sessions:{},client,now,enabled:()=>state.enabled,audit:{health:async()=>({pending:0,oldestAgeSeconds:0}),append:async event=>state.audits.push(event)}});
 return {service,input,state,row,effective,transaction,id};
}
test('active inventory uses current MFA actor and epoch2 despite expired original authorization; no writes or pending authority',async()=>{
 const f=fixture(),view=await f.service.describe(f.input,f.row,f.transaction);assert.deepEqual(view,{mode:'active',enrollmentId:f.id,epoch:2,versionId:f.effective.versionId});
 const result=await f.service.assets(f.input,f.id);assert.equal(result.mode,'active');assert.equal(result.inventory.assets.length,2);assert.equal(result.inventory.epoch,2);
 assert.equal(f.state.originalSessionChecks,0);assert.deepEqual(f.state.audits.map(v=>[v.version,v.actor.id,v.epoch,v.reason]),[[32,'225',2,'inventory_requested'],[32,'225',2,'inventory_verified']]);
 assert.equal(result.assignmentReview,undefined);assert.equal(result.inventory.flowId,undefined);
});
test('current expired login remains401, MFA/WRITE/foreign scope remain403, withdrawn and inactive grants remain closed before Owner',async t=>{
 for(const [name,change,status]of[['expired',f=>{f.state.valid=false;},401],['mfa',f=>{f.state.mfa=false;},403],['write',f=>{f.state.write=false;},403],['scope',f=>{f.input.scopeKey='clinic:66';},403],['withdrawn',f=>{f.state.withdrawn=true;},409],['inactive',f=>{f.row.state='revoke_pending';},409]])await t.test(name,async()=>{
  const f=fixture();change(f);await assert.rejects(f.service.assets(f.input,f.id),e=>e.httpStatus===status);assert.equal(f.state.calls.length,0);
 });
});
test('a changed epoch, withdrawal or current permission during I/O discards the whole result',async t=>{
 for(const [name,change,status]of[['epoch',f=>{f.effective.epoch=3;f.effective.versionId=randomUUID();},409],['shorter deadline',f=>{f.effective.metadata.expiresAt=Date.parse('2030-01-01T12:01:00Z');},409],['withdrawn',f=>{f.state.withdrawn=true;},409],['write',f=>{f.state.write=false;},403]])await t.test(name,async()=>{
  const f=fixture();f.state.afterIo=()=>change(f);await assert.rejects(f.service.assets(f.input,f.id),e=>e.httpStatus===status);
  assert.equal(f.state.calls.length,1);assert.equal(f.state.audits.some(v=>v.reason==='inventory_verified'),false);
 });
});
test('response rejects wrong pin, stale observation, wider TTL and any non-granted asset',async t=>{
 for(const patch of [{epoch:1},{versionId:randomUUID()},{observedAt:1},{expiresAt:Date.parse('2031-01-01')},{assets:[]}])await t.test(JSON.stringify(patch),async()=>{
  const f=fixture();f.state.patch=patch;await assert.rejects(f.service.assets(f.input,f.id),{code:'broker_response_invalid',httpStatus:503});
  assert.equal(f.state.audits.some(v=>v.reason==='inventory_verified'),false);
 });
});
