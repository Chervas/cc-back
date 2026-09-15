'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');const {Op}=require('sequelize');
const S=require('../../services/whatsappAuthorizationState.contract');const {createService}=require('../../services/whatsappAuthorizationListing.service');
function fixture(){
 const now=new Date('2026-09-15T12:00:00.000Z'),key=Buffer.alloc(32,7),viewer={userId:501,sessionRef:randomUUID(),sessionExpiresAt:Math.floor(now.getTime()/1000)+3600};
 const state={clinics:[{id_clinica:19,grupoClinicaId:5},{id_clinica:35,grupoClinicaId:5},{id_clinica:66,grupoClinicaId:29},{id_clinica:72,grupoClinicaId:29}],
  memberships:new Set([19,35,66,72]),blocked:new Set(),sessions:[],brokerCalls:[],queries:[],keys:[],revoked:false,afterBroker:null,onSnapshot:null,snapshots:0,remoteState:'staged',clock:0,rows:[]};
 const bindings=[{scopeKey:'clinic:19',clinicIds:[19],connectionRef:'enrollment:19'},{scopeKey:'clinic:35',clinicIds:[35],connectionRef:'enrollment:35'},
  {scopeKey:'group:29',clinicIds:[66,72],connectionRef:'enrollment:29'}];
 function row(scope,age=0){
  const clinics=state.clinics.filter(c=>scope.type==='clinic'?c.id_clinica===scope.id:c.grupoClinicaId===scope.id);
  const value={request_id:randomUUID(),user_id:901,session_ref:randomUUID(),session_expires_at:new Date(now.getTime()-300000),scope_type:scope.type,scope_id:scope.id,
   original_clinic_ids:clinics.map(c=>c.id_clinica),scope_digest:S.digest(JSON.stringify({scope,clinics:clinics.map(c=>({id:c.id_clinica,groupId:c.grupoClinicaId}))})),
   state:'claimed',created_at:new Date(now.getTime()-900000-age),expires_at:new Date(now.getTime()-600000-age),claimed_at:new Date(now.getTime()-800000-age)};
  value.context_digest=S.digest(JSON.stringify(['whatsapp-onboarding-v1',value.request_id,value.user_id,value.session_ref,value.session_expires_at.toISOString(),
   value.scope_type,value.scope_id,value.original_clinic_ids,value.scope_digest,value.created_at.toISOString(),value.expires_at.toISOString()]));
  value.state_hash=S.digest(S.stateFor(key,value));return value;
 }
 state.rows=[row({type:'clinic',id:19}),row({type:'group',id:29},1000)];
 const models={Clinica:{findAll:async q=>{state.snapshots++;state.onSnapshot?.(state.snapshots);return structuredClone(state.clinics.filter(c=>q.where.id_clinica?c.id_clinica===q.where.id_clinica:c.grupoClinicaId===q.where.grupoClinicaId));}},
  UsuarioClinica:{findAll:async q=>{assert(q.where.rol_clinica[Op.in].includes('personaldeclinica'));return q.where.id_clinica[Op.in].filter(id=>state.memberships.has(id)).map(id=>({id_clinica:id}));}},
  WhatsappAuthorizationState:{findAll:async q=>{state.queries.push(q);return structuredClone(state.rows.filter(r=>q.where[Op.or].some(s=>s.scope_type===r.scope_type&&s.scope_id===r.scope_id)).slice(0,q.limit));},
   findByPk:async id=>structuredClone(state.rows.find(r=>r.request_id===id))}};
 const sessions={verifyReference:async(actor,options)=>{state.sessions.push({actor,options});assert.equal(options.requireEmail,false);assert.equal(actor.userId,viewer.userId);
  assert.equal(actor.sessionRef,viewer.sessionRef);if(state.revoked)throw Object.assign(Error('FICTITIOUS_SESSION_SECRET'),{code:'auth_invalid',status:401});}};
 const broker={statusReadOnly:async context=>{state.brokerCalls.push(structuredClone(context));await state.afterBroker?.(context);
  return {status:state.remoteState,accessBlocked:false,configurationChanged:false,candidate:state.remoteState==='staged'?{wabaId:'301',phoneId:'401',FICTITIOUS_TOKEN:'NEVER_RETURN'}:null,
   phoneState:state.remoteState==='staged'?{phoneId:'401',isOnBizApp:true,platformType:'CLOUD_API',coexistenceAvailable:true,registrationAttempted:false,observedAt:now.getTime()}:null};},
  status:()=>assert.fail('ordinary status must not run'),begin:()=>assert.fail('begin must not run'),finish:()=>assert.fail('finish must not run'),abort:()=>assert.fail('abort must not run')};
 const service=createService({models,sessions,broker,loadBindings:()=>structuredClone(bindings),config:()=>{const k=Buffer.from(key);state.keys.push(k);return {key:k};},
  isBlocked:async scope=>state.blocked.has(scope.assignmentScope==='clinic'?'clinic:'+scope.clinicId:'group:'+scope.groupId),now:()=>new Date(now),clock:()=>state.clock});
 return {state,bindings,row,call:(scope=null)=>service.list({...viewer,scope}),raw:input=>service.list(input),viewer};
}
test('Expired OAuth and another original user/session remain visible through current MFA and scope ACL',async()=>{
 const f=fixture(),before=JSON.stringify(f.state.rows),result=await f.call();
 assert.equal(result.authorizations.length,2);assert.equal(result.incomplete,false);
 for(const dto of result.authorizations){assert.equal(dto.authorizationStatus,'awaiting_activation');assert.equal(dto.connected,false);assert.equal(dto.pending,true);assert.deepEqual(dto.selected,{wabaId:'301',phoneId:'401'});
  for(const field of ['authorization','state','userId','sessionRef','candidate','scopeDigest','FICTITIOUS_TOKEN'])assert(!Object.hasOwn(dto,field));}
 assert.equal(JSON.stringify(f.state.rows),before);assert(f.state.keys.every(k=>k.every(v=>v===0)));assert.equal(f.state.brokerCalls.length,2);
 assert(f.state.brokerCalls.every(c=>c.status==='expired'));assert.equal(f.state.queries[0].limit,50);assert(!Object.hasOwn(f.state.queries[0].where,'user_id'));
});
test('Explicit group requires every clinic; all view silently removes unauthorized scopes',async()=>{
 const f=fixture();f.state.memberships.delete(72);
 await assert.rejects(f.call({type:'group',id:29}),{code:'whatsapp_authorization_forbidden',status:403});assert.equal(f.state.brokerCalls.length,0);
 const result=await f.call();assert.equal(result.authorizations.length,1);assert.equal(result.authorizations[0].scope.id,19);
 assert.equal(f.state.brokerCalls.length,1);assert.equal(result.incomplete,false);
});
test('Current session revocation aborts the whole listing and does not disclose fetched metadata',async()=>{
 const f=fixture();f.state.afterBroker=()=>{f.state.revoked=true;};
 await assert.rejects(f.call(),{code:'auth_invalid',status:401,message:'auth_invalid'});assert(f.state.keys.every(k=>k.every(v=>v===0)));
});
test('Viewer revocation during the final ACL snapshot is checked immediately before returning',async()=>{
 const f=fixture();f.state.onSnapshot=count=>{if(count===4)f.state.revoked=true;};
 await assert.rejects(f.call({type:'clinic',id:19}),{code:'auth_invalid'});assert.equal(f.state.brokerCalls.length,1);
});
test('Membership lost while fetching a scope is rechecked; no abort or legacy mutation is called',async()=>{
 const f=fixture();f.state.afterBroker=()=>f.state.memberships.delete(72);
 await assert.rejects(f.call({type:'group',id:29}),{code:'whatsapp_authorization_forbidden'});
 const g=fixture();g.state.afterBroker=()=>g.state.memberships.delete(72);const result=await g.call();
 assert(!result.authorizations.some(v=>v.scope.type==='group'));
});
test('Changed group snapshot, binding config or original MAC never yields a successful receipt',async()=>{
 const f=fixture();f.state.rows[0].state_hash='0'.repeat(64);let result=await f.call({type:'clinic',id:19});assert.deepEqual(result,{authorizations:[],incomplete:true});assert.equal(f.state.brokerCalls.length,0);
 const g=fixture();g.state.afterBroker=()=>{g.bindings[0].connectionRef='changed';};result=await g.call({type:'clinic',id:19});assert.deepEqual(result,{authorizations:[],incomplete:true});
 const h=fixture();h.state.clinics.find(c=>c.id_clinica===19).grupoClinicaId=9;result=await h.call({type:'clinic',id:19});assert.deepEqual(result,{authorizations:[],incomplete:true});assert.equal(h.state.brokerCalls.length,0);
});
test('Scope block preserves the staged receipt as blocked with no sending or selected-phone assertion',async()=>{
 const f=fixture();f.state.blocked.add('clinic:19');const result=await f.call({type:'clinic',id:19});
 assert.equal(result.authorizations[0].authorizationStatus,'blocked');assert.equal(result.authorizations[0].connected,false);assert.equal(result.authorizations[0].selected,null);assert.equal(result.authorizations[0].phoneState,null);
});
test('Status errors are incomplete; limits are bounded and newest receipt wins per scope',async()=>{
 const f=fixture();f.state.afterBroker=()=>{throw Error('FICTITIOUS_PROVIDER_TOKEN');};assert.deepEqual(await f.call({type:'clinic',id:19}),{authorizations:[],incomplete:true});
 const g=fixture();g.state.rows=Array.from({length:55},(_,i)=>g.row({type:'clinic',id:19},i*1000));const result=await g.call();
 assert.equal(result.incomplete,true);assert.equal(result.authorizations.length,1);assert.equal(g.state.brokerCalls.length,1);assert.equal(result.authorizations[0].requestId,g.state.rows[0].request_id);
});
test('Nonstaged and cancelled receipts are not displayed as authorized',async()=>{
 const f=fixture();f.state.remoteState='staging';assert.deepEqual(await f.call({type:'clinic',id:19}),{authorizations:[],incomplete:true});
 const g=fixture();g.state.afterBroker=()=>{g.state.rows[0].state='cancelled';};assert.deepEqual(await g.call({type:'clinic',id:19}),{authorizations:[],incomplete:false});
});
test('A newer unsuccessful claim cannot hide an older staged receipt for the same scope',async()=>{
 const f=fixture(),newest=f.state.rows[0],older=f.row({type:'clinic',id:19},1000);f.state.rows=[newest,older];
 f.state.afterBroker=context=>{f.state.remoteState=context.requestId===newest.request_id?'interrupted':'staged';};
 const result=await f.call({type:'clinic',id:19});assert.equal(result.authorizations.length,1);assert.equal(result.authorizations[0].requestId,older.request_id);
 assert.equal(result.incomplete,true);assert.equal(f.state.brokerCalls.length,2);
});
test('A 12-second total remote budget preserves verified results and stops before another 5-second call',async()=>{
 const f=fixture();f.state.rows=[f.row({type:'clinic',id:19}),f.row({type:'clinic',id:35},1000),f.row({type:'group',id:29},2000)];
 f.state.afterBroker=()=>{f.state.clock+=5000;};const result=await f.call();
 assert.equal(f.state.brokerCalls.length,2);assert.equal(result.authorizations.length,2);assert.equal(result.incomplete,true);
});
test('Strict body rejects untrusted identity fields and malformed or missing scope',async()=>{
 const f=fixture();for(const scope of [{type:'clinic',id:'19'},{type:'other',id:19},{type:'clinic',id:19,admin:true},undefined])
  await assert.rejects(f.raw({...f.viewer,scope}),{code:'whatsapp_authorization_invalid'});
 await assert.rejects(f.raw({...f.viewer,scope:null,token:'FICTITIOUS'}),{code:'whatsapp_authorization_invalid'});
});
test('Regular reference verification still rejects password-only sessions and verifies trusted-device MFA',async()=>{
 const {createService:createSessions}=require('../../services/accessSession.service');const now=new Date('2026-09-15T12:00:00.000Z');let devices=0,deviceRevoked=false;
 const sessionId=randomUUID();const row={session_id:sessionId,user_id:501,state:'active',issued_at:new Date(now.getTime()-60000),
  expires_at:new Date(now.getTime()+3600000),absolute_expires_at:new Date(now.getTime()+3600000),authentication_method:'password',
  password_usuario:'FICTITIOUS_HASH',email_usuario:'qa@example.invalid',estado_cuenta:'activo',es_provisional:false};
 const sessions=createSessions({models:{sequelize:{query:async()=>[[row]]}},config:()=>({mode:'enforce',emailMfaMode:'enforce',secret:'FICTITIOUS_QA_SECRET',ttl:3600}),
  trustedDevices:{verifySession:async()=>{devices++;if(deviceRevoked)throw Object.assign(Error('auth_invalid'),{code:'auth_invalid'});}},now:()=>new Date(now)});
 row.credential_binding=sessions.credentialBinding({...row,id_usuario:501});const actor={userId:501,sessionRef:sessionId,expiresAt:row.expires_at};
 await assert.rejects(sessions.verifyReference(actor,{requireEmail:false}),{code:'auth_invalid'});
 row.authentication_method='password_email';row.email_verified_at=new Date(row.issued_at);row.email_challenge_id=randomUUID();
 await sessions.verifyReference(actor,{requireEmail:false});assert.equal(devices,0);
 row.authentication_method='password_trusted_device';row.email_challenge_id=null;row.trusted_device_id=randomUUID();
 await sessions.verifyReference(actor,{requireEmail:false});assert.equal(devices,1);
 await assert.rejects(sessions.verifyReference(actor,{requireEmail:true}),{code:'auth_email_verification_required'});
 deviceRevoked=true;await assert.rejects(sessions.verifyReference(actor,{requireEmail:false}),{code:'auth_invalid'});
});
