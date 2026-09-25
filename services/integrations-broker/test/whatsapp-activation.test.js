'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {fixture}=require('./whatsapp-onboarding-fixture.cjs');
const {createWhatsappActivation}=require('../src/whatsapp-activation');
const {createActivationReader}=require('../src/whatsapp-activation-reader');
const A=require('../src/whatsapp-activation-contract');
const {ACCOUNT,SECRET_KEY}=require('../src/google-main');
async function setup(t,{legacyCaller=false}={}){
  const f=fixture(t,{customer:{selectionOnly:true}}),flow=await f.begin();await f.finish(flow);
  const state={calls:[],subscribed:false,registerError:null,afterRegister:null,profile:{id:'401',status:'PENDING',
    platform_type:'NOT_APPLICABLE',is_on_biz_app:false,code_verification_status:'VERIFIED',quality_rating:'UNKNOWN',
    display_phone_number:'+34000000000',verified_name:'Fictitious QA'}};
  const make=()=>createWhatsappActivation({store:f.current.store,filename:f.filename,policy:f.policy,client:f.aws,
    accountId:ACCOUNT,kmsKeyArn:SECRET_KEY,now:f.now,pinFactory:()=>async(options,fn)=>fn(Buffer.from('123456')),
    http:async r=>{
      state.calls.push(r.action);
      if(r.action==='profile')return {...state.profile};
      if(r.action==='register_phone'){
        if(state.registerError)throw state.registerError;
        state.profile={...state.profile,status:'CONNECTED',platform_type:'CLOUD_API'};
        if(state.afterRegister)await state.afterRegister();return {success:true};
      }
      if(r.action==='subscribe'){state.subscribed=true;return {success:true};}
      if(r.action==='subscriptions')return {data:state.subscribed?[{whatsapp_business_api_data:{id:'101'}}]:[]};
      return f.http(r);
    }});
  let engine=make();
  const executeFlow=(selected,operation=A.ACTIVATE,changes={})=>engine.operations[operation].execute({request:f.command(operation,
    {flowId:selected.flowId,scopeDigest:selected.payload.scopeDigest,clinicSetDigest:selected.payload.clinicSetDigest,
      ...(operation===A.ACTIVATE?{assetId:991}:{}),...changes}),principal:f.policy.principals[0],binding:f.binding,policy:legacyCaller?undefined:f.policy});
  const execute=(operation=A.ACTIVATE,changes={})=>executeFlow(flow,operation,changes);
  return {f,flow,state,execute,executeFlow,async prepare(){return execute(A.PROFILE)},restart(){f.restart();engine=make();},
    row:()=>f.current.store.db.prepare('SELECT * FROM whatsapp_activations WHERE flow_id=?').get(flow.flowId)};
}
test('Cloud registration completes subscription and exposes only exact activated clinic grants after restart',async t=>{
  const f=await setup(t);await f.prepare();
  const reader=createActivationReader(f.f.filename);t.after(()=>reader.close());
  assert.deepEqual(reader.definitions(),[]);assert.deepEqual(reader.scopes('101'),[]);
  const result=await f.execute();assert.equal(result.data.state,'active');assert.equal(result.data.assetId,991);
  assert.deepEqual(reader.scopes('101'),[{phoneId:'401',wabaId:'301',clinicIds:[71,72]}]);
  assert.equal(reader.definitions()[0].enabled,true);assert.throws(()=>reader.scopes('999'),/scope_denied/);
  const policy={connections:[],grants:[]};const request={connectionRef:A.connectionRef(f.flow.flowId),tenantRef:'clinic:71',assetRef:'wa-phone:401',operation:'meta.whatsapp.authorized.send.v1'};
  const C=require('../src/whatsapp-authorized-contract');request.operation=C.SEND;
  assert.equal(reader.resolve(request,{id:'staging:whatsapp'},policy,f.f.current.store).grants.length,1);
  const profileRequest={...request,operation:require('../src/whatsapp-authorized-profile').READ};
  assert.equal(reader.resolve(profileRequest,{id:'staging:whatsapp'},policy,f.f.current.store).grants.length,1);
  assert.equal(reader.resolve(request,{id:'dev:whatsapp'},policy,f.f.current.store),policy);
  assert.throws(()=>reader.resolve({...request,tenantRef:'clinic:73'},{id:'staging:whatsapp'},policy,f.f.current.store),/scope_denied/);
  f.restart();await f.execute();assert.equal(f.state.calls.filter(v=>v==='register_phone').length,1);
  assert.equal(f.state.calls.filter(v=>v==='subscribe').length,1);
  assert(!JSON.stringify(result).includes('123456'));
});
test('already connected coexistence never registers or changes its PIN',async t=>{
  const f=await setup(t);Object.assign(f.state.profile,{status:'CONNECTED',platform_type:'CLOUD_API',is_on_biz_app:true});
  await f.prepare();assert.equal((await f.execute()).data.state,'active');assert(!f.state.calls.includes('register_phone'));
});
test('a lost registration response is reconciled from Meta without repeating registration',async t=>{
  const f=await setup(t);await f.prepare();f.state.afterRegister=()=>{throw Error('LOST_RESPONSE')};
  await assert.rejects(f.execute(),/secret_unavailable/);assert.equal(f.row().state,'registration_uncertain');
  f.restart();assert.equal((await f.execute()).data.state,'active');assert.equal(f.state.calls.filter(v=>v==='register_phone').length,1);
});
test('unknown registration outcome remains pending, captures replies and never blindly retries',async t=>{
  const f=await setup(t);await f.prepare();f.state.registerError=Error('TIMEOUT');
  await assert.rejects(f.execute(),/secret_unavailable/);assert.equal((await f.execute()).data.state,'provider_pending');
  assert.equal(f.state.calls.filter(v=>v==='register_phone').length,1);
  const reader=createActivationReader(f.f.filename);t.after(()=>reader.close());assert.equal(reader.definitions().length,0);assert.equal(reader.scopes('101').length,1);
});
test('scope changes, wrong assets and revoked scopes cannot reuse a receipt',async t=>{
  const f=await setup(t);await f.prepare();await assert.rejects(f.execute(A.ACTIVATE,{scopeDigest:'0'.repeat(64)}),/scope_denied/);
  await f.execute();await assert.rejects(f.execute(A.ACTIVATE,{assetId:992}),/idempotency_conflict/);
  f.f.current.store.db.prepare('INSERT INTO whatsapp_onboarding_scope_blocks VALUES (?,?,?,?)').run('clinic:72',f.f.binding.connectionRef,f.flow.flowId,f.f.now());
  await assert.rejects(f.execute(),/asset_revoked/);
});
test('connected on-premise and unfinished Business App numbers are never automatically registered',async t=>{
  for(const profile of [{status:'CONNECTED',platform_type:'NOT_APPLICABLE'},{status:'PENDING',is_on_biz_app:true}]){
    const f=await setup(t);Object.assign(f.state.profile,profile);await f.prepare();assert.equal((await f.execute()).data.state,'registration_required');assert(!f.state.calls.includes('register_phone'));assert(!f.state.calls.includes('subscribe'));
  }
});

test('activation audit uses its configured policy with the deployed legacy control caller',async t=>{
  const f=await setup(t,{legacyCaller:true});await f.prepare();assert.equal((await f.execute()).data.state,'active');
  const events=f.f.current.store.db.prepare('SELECT event FROM audit_outbox').all().map(r=>JSON.parse(r.event));
  assert(events.some(e=>e.reason==='whatsapp_activation_completed'&&e.operation===A.ACTIVATE));
});
test('reauthorizing the exact same phone atomically supersedes the prior credential',async t=>{
  const f=await setup(t);await f.prepare();await f.execute();
  const replacement=await f.f.begin();await f.f.finish(replacement);
  await f.executeFlow(replacement,A.PROFILE);const result=await f.executeFlow(replacement);
  assert.equal(result.data.state,'active');assert.equal(result.data.assetId,991);
  const rows=f.f.current.store.db.prepare('SELECT flow_id,state,asset_id FROM whatsapp_activations ORDER BY started_at').all();
  assert.deepEqual(rows.map(row=>[row.flow_id,row.state,row.asset_id]),[[f.flow.flowId,'superseded',991],[replacement.flowId,'active',991]]);
  const reader=createActivationReader(f.f.filename);t.after(()=>reader.close());
  assert.deepEqual(reader.definitions().map(value=>value.authorizationId),[replacement.flowId]);
  assert.deepEqual(reader.scopes('101'),[{phoneId:'401',wabaId:'301',clinicIds:[71,72]}]);
  await assert.rejects(f.execute(A.STATUS),/asset_revoked/);
});
