'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');const {Op}=require('sequelize');
const S=require('../../services/whatsappAuthorizationState.contract');const {createService}=require('../../services/whatsappAuthorizationListing.service');
function fixture({automatic=null}={}){
 const now=new Date('2026-09-15T12:00:00.000Z'),key=Buffer.alloc(32,7),viewer={userId:501,sessionRef:randomUUID(),sessionExpiresAt:Math.floor(now.getTime()/1000)+3600};
 const state={clinics:[{id_clinica:19,grupoClinicaId:5},{id_clinica:35,grupoClinicaId:5},{id_clinica:66,grupoClinicaId:29},{id_clinica:72,grupoClinicaId:29}],
  memberships:new Set([19,35,66,72]),blocked:new Set(),sessions:[],brokerCalls:[],queries:[],keys:[],revoked:false,afterBroker:null,onSnapshot:null,snapshots:0,remoteState:'staged',clock:0,rows:[],
  assets:[],assetQueries:[],onAssetRead:null,phoneIds:new Map(),superseded:new Set(),active:new Set(),credentialRevoked:new Set(),authorizedCalls:[]};
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
  GrupoClinica:{findAll:async q=>[{id_grupo:q.where.id_grupo,nombre_grupo:'Fictitious group'}]},
  WhatsappChannelBinding:{findAll:async()=>[]},
  ClinicMetaAsset:{findAll:async q=>{state.assetQueries.push(q);state.onAssetRead?.(state.assetQueries.length);
   assert(!q.attributes.includes('additionalData'));assert(!q.attributes.includes('waAccessToken'));assert(!q.attributes.includes('pageAccessToken'));
   assert.equal(q.limit,2);assert.equal(q.raw,true);assert(!q.include);assert(!Object.hasOwn(q.where,'isActive'));
   return state.assets.filter(a=>Object.entries(q.where).every(([k,v])=>a[k]===v)).slice(0,q.limit)
    .map(a=>Object.fromEntries(q.attributes.map(attr=>{const name=Array.isArray(attr)?attr[1]:attr;return[name,a[name]];})));}},
  UsuarioClinica:{findAll:async q=>{assert(q.where.rol_clinica[Op.in].includes('personaldeclinica'));return q.where.id_clinica[Op.in].filter(id=>state.memberships.has(id)).map(id=>({id_clinica:id}));}},
  WhatsappPhoneActivation:{findAll:async q=>q.where.authorization_id[Op.in].flatMap(authorization_id=>state.superseded.has(authorization_id)
   ?[{authorization_id,asset_id:382,state:'superseded'}]:state.active.has(authorization_id)?[{authorization_id,asset_id:382,state:'active'}]:[])},
  WhatsappAuthorizationState:{findAll:async q=>{state.queries.push(q);
   if(q.group)return [...new Map(state.rows.map(r=>[r.scope_type+':'+r.scope_id,{scope_type:r.scope_type,scope_id:r.scope_id}])).values()];
   return structuredClone(state.rows.filter(r=>q.where[Op.or].some(s=>s.scope_type===r.scope_type&&s.scope_id===r.scope_id)).slice(0,q.limit));},
   findByPk:async id=>structuredClone(state.rows.find(r=>r.request_id===id))}};
 const sessions={verifyReference:async(actor,options)=>{state.sessions.push({actor,options});assert.equal(options.requireEmail,false);assert.equal(actor.userId,viewer.userId);
  assert.equal(actor.sessionRef,viewer.sessionRef);if(state.revoked)throw Object.assign(Error('FICTITIOUS_SESSION_SECRET'),{code:'auth_invalid',status:401});}};
 const broker={statusReadOnly:async context=>{state.brokerCalls.push(structuredClone(context));await state.afterBroker?.(context);
  const phoneId=state.phoneIds.get(context.requestId)||'401';
  return {status:state.remoteState,accessBlocked:false,configurationChanged:false,channelRole:context.channelRole,
   ...(state.credentialRevoked.has(context.requestId)?{credentialStatus:'revoked'}:{}),candidate:state.remoteState==='staged'?{wabaId:'301',phoneId,FICTITIOUS_TOKEN:'NEVER_RETURN'}:null,
   phoneState:state.remoteState==='staged'?{phoneId,isOnBizApp:true,platformType:'CLOUD_API',coexistenceAvailable:true,registrationAttempted:false,observedAt:now.getTime()}:null};},
  status:()=>assert.fail('ordinary status must not run'),begin:()=>assert.fail('begin must not run'),finish:()=>assert.fail('finish must not run'),abort:()=>assert.fail('abort must not run')};
 const authorizedBroker={permissionStatus:async(clinicId,assetId)=>{state.authorizedCalls.push({clinicId,assetId});return state.credentialRevoked.size?'disconnected':'connected';}};
 const service=createService({models,sessions,broker,authorizedBroker,loadBindings:()=>structuredClone(bindings),loadAutomatic:()=>automatic,config:()=>{const k=Buffer.from(key);state.keys.push(k);return {key:k};},
  isBlocked:async scope=>state.blocked.has(scope.assignmentScope==='clinic'?'clinic:'+scope.clinicId:'group:'+scope.groupId),now:()=>new Date(now),clock:()=>state.clock});
 return {state,bindings,row,call:(scope=null)=>service.list({...viewer,scope}),raw:input=>service.list(input),viewer,
  resign:(r,channelRole)=>{r.channel_role=channelRole;r.context_digest=S.contextDigest(r);r.state_hash=S.digest(S.stateFor(key,r));}};
}
function localAsset(overrides={}){
 const row={id:382,assetType:'whatsapp_phone_number',phoneNumberId:'401',wabaId:'301',assignmentScope:'clinic',clinicaId:19,grupoClinicaId:null,
  metaAssetName:'Fictitious business number',waVerifiedName:'Fictitious clinic',quality_rating:'GREEN',messaging_limit:'TIER_1K',isActive:false,
  createdAt:new Date('2026-01-01T00:00:00Z'),updatedAt:new Date('2026-09-15T10:00:00Z'),
  wa_local_profile_description:'Local public profile',wa_local_profile_email:'qa@example.invalid',wa_local_profile_website:'https://example.invalid/',
  wa_local_profile_picture_url:'https://example.invalid/avatar.png',wa_local_registration_phone_status:'CONNECTED',
  wa_local_connection_mode:'coexistence',wa_local_is_on_biz_app:'true',wa_local_coexistence_can_send_api:'true',
  wa_local_health_state:'healthy',wa_local_health_can_send:'true',wa_local_health_provider_status:'CONNECTED',wa_local_health_observed_at:'"2026-09-15T10:00:00Z"',
  wa_local_channel_role:'primary',...overrides};
 for(const field of ['waAccessToken','pageAccessToken','additionalData','password_usuario'])Object.defineProperty(row,field,{get(){assert.fail('private field read: '+field);}});
 return row;
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
test('Dynamically prepared clinics remain visible without static configuration, through current clinic ACL only',async()=>{
 const automatic={appId:'101',configId:'102',redirectUri:'https://example.invalid/whatsapp/callback',scopes:['whatsapp_business_management','whatsapp_business_messaging']};
 const f=fixture({automatic});f.bindings.splice(0);f.state.rows=[f.row({type:'clinic',id:35})];
 let result=await f.call({type:'clinic',id:35});assert.equal(result.authorizations.length,1);assert.equal(result.incomplete,false);
 result=await f.call();assert.equal(result.authorizations.length,1);assert.equal(result.authorizations[0].scope.id,35);
 f.state.memberships.delete(35);result=await f.call();assert.equal(result.authorizations.length,0);
 await assert.rejects(f.call({type:'clinic',id:35}),{code:'whatsapp_authorization_forbidden'});
});
test('Changing dynamic configuration during a read never yields a verified receipt',async()=>{
 const automatic={appId:'101',configId:'102',redirectUri:'https://example.invalid/whatsapp/callback',scopes:['whatsapp_business_management','whatsapp_business_messaging']};
 const f=fixture({automatic});f.bindings.splice(0);f.state.rows=[f.row({type:'clinic',id:35})];
 f.state.afterBroker=()=>{automatic.configId='103';};
 assert.deepEqual(await f.call({type:'clinic',id:35}),{authorizations:[],incomplete:true});
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
test('An operational credential revocation keeps the exact phone visible for permission renewal',async()=>{
 const f=fixture();f.state.assets=[localAsset()];f.state.active.add(f.state.rows[0].request_id);f.state.credentialRevoked.add(f.state.rows[0].request_id);
 const result=await f.call({type:'clinic',id:19}),receipt=result.authorizations[0];
 assert.equal(receipt.authorizationStatus,'awaiting_activation');assert.equal(receipt.permissionStatus,'disconnected');
 assert.equal(receipt.localPhone.id,382);assert.deepEqual(receipt.selected,{wabaId:'301',phoneId:'401'});
 assert.deepEqual(f.state.authorizedCalls,[{clinicId:19,assetId:382}]);
 const blocked=fixture();blocked.state.assets=[localAsset()];blocked.state.blocked.add('clinic:19');
 const blockedReceipt=(await blocked.call({type:'clinic',id:19})).authorizations[0];
 assert.equal(blockedReceipt.authorizationStatus,'blocked');assert.equal(Object.hasOwn(blockedReceipt,'permissionStatus'),false);
});
test('A superseded credential receipt is retained for audit but no longer shown as reconnectable',async()=>{
 const f=fixture();f.state.superseded.add(f.state.rows[0].request_id);const result=await f.call({type:'clinic',id:19});
 assert.deepEqual(result,{authorizations:[],incomplete:false});assert.equal(f.state.brokerCalls.length,0);
});
test('Status errors are incomplete; limits are bounded and newest receipt wins per scope and phone',async()=>{
 const f=fixture();f.state.afterBroker=()=>{throw Error('FICTITIOUS_PROVIDER_TOKEN');};assert.deepEqual(await f.call({type:'clinic',id:19}),{authorizations:[],incomplete:true});
 const g=fixture();g.state.rows=Array.from({length:55},(_,i)=>g.row({type:'clinic',id:19},i*1000));const result=await g.call();
 assert.equal(result.incomplete,true);assert.equal(result.authorizations.length,1);assert.equal(g.state.brokerCalls.length,50);assert.equal(result.authorizations[0].requestId,g.state.rows[0].request_id);
});
test('Nonstaged and cancelled receipts are not displayed as authorized',async()=>{
 const f=fixture();f.state.remoteState='staging';assert.deepEqual(await f.call({type:'clinic',id:19}),{authorizations:[],incomplete:true});
 const g=fixture();g.state.afterBroker=()=>{g.state.rows[0].state='cancelled';};assert.deepEqual(await g.call({type:'clinic',id:19}),{authorizations:[],incomplete:false});
});
test('A newer unsuccessful claim cannot hide an older staged receipt for the same scope',async()=>{
 const f=fixture(),newest=f.state.rows[0],older=f.row({type:'clinic',id:19},1000);f.state.rows=[newest,older];
 f.state.afterBroker=context=>{f.state.remoteState=context.requestId===newest.request_id?'interrupted':'staged';};
 const result=await f.call({type:'clinic',id:19});assert.equal(result.authorizations.length,1);assert.equal(result.authorizations[0].requestId,older.request_id);
 assert.equal(result.incomplete,false);assert.equal(f.state.brokerCalls.length,2);
});
test('Old confirmed aborted or interrupted attempts do not make a staged receipt incomplete',async()=>{
 const f=fixture(),staged=f.state.rows[0],aborted=f.row({type:'clinic',id:19},1000),interrupted=f.row({type:'clinic',id:19},2000);
 f.state.rows=[staged,aborted,interrupted];f.state.afterBroker=context=>{f.state.remoteState=context.requestId===staged.request_id?'staged':context.requestId===aborted.request_id?'aborted':'interrupted';};
 const result=await f.call({type:'clinic',id:19});assert.equal(result.authorizations.length,1);assert.equal(result.authorizations[0].requestId,staged.request_id);
 assert.equal(result.incomplete,false);assert.equal(f.state.brokerCalls.length,3);
 const g=fixture(),old=g.row({type:'clinic',id:19},1000);g.state.rows=[g.state.rows[0],old];g.state.afterBroker=context=>{if(context.requestId===old.request_id)throw Error('FICTITIOUS_TRANSPORT_FAILURE');};
 const failed=await g.call({type:'clinic',id:19});assert.equal(failed.authorizations.length,1);assert.equal(failed.incomplete,true);
});
test('A 12-second total remote budget preserves verified results and stops before another 5-second call',async()=>{
 const f=fixture();f.state.rows=[f.row({type:'clinic',id:19}),f.row({type:'clinic',id:35},1000),f.row({type:'group',id:29},2000)];
 f.state.afterBroker=()=>{f.state.clock+=5000;};const result=await f.call();
 assert.equal(f.state.brokerCalls.length,2);assert.equal(result.authorizations.length,2);assert.equal(result.incomplete,true);
});
test('Inactive exact local asset restores public metadata without reading credential columns or the JSON document',async()=>{
 const f=fixture();f.state.assets=[localAsset()];f.state.clinics[0].nombre_clinica='Fictitious clinic';
 const result=await f.call({type:'clinic',id:19}),phone=result.authorizations[0].localPhone;
 assert.equal(result.incomplete,false);assert.equal(phone.id,382);assert.equal(phone.metadata_source,'local');assert.equal(phone.sending_enabled,false);
 assert.equal(phone.profile_description,'Local public profile');assert.equal(phone.profile_email,'qa@example.invalid');
 assert.equal(phone.clinic_name,'Fictitious clinic');assert.equal(phone.group_name,'Fictitious group');assert.equal(phone.group_id,5);
 assert.equal(phone.health.can_send,true);assert.equal(phone.health.is_stale,true);assert.equal(phone.registration_phone_status,'CONNECTED');
 assert.equal(phone.coexistence_can_send_api,true);assert.equal(f.state.assets[0].isActive,false);assert.equal(f.state.assetQueries.length,2);
 for(const q of f.state.assetQueries){assert.equal(q.where.clinicaId,19);assert.equal(q.where.phoneNumberId,'401');assert.equal(q.where.wabaId,'301');
  for(const attr of q.attributes){if(Array.isArray(attr)){assert.equal(attr[0].fn,'JSON_EXTRACT');assert.equal(attr[0].args[0].col,'additionalData');assert.match(attr[0].args[1].val,/^'\$\.[A-Za-z_]+(?:\.[A-Za-z_]+)*'$/);}
   else assert(!/token|password|additionalData/i.test(attr));}}
 const serialized=JSON.stringify(result);for(const name of ['waAccessToken','pageAccessToken','password_usuario','additionalData','FICTITIOUS_TOKEN'])assert(!serialized.includes(name));
});
test('Same provider phone in another scope or WABA never supplies local profile metadata',async()=>{
 const f=fixture();f.state.assets=[localAsset({clinicaId:35}),localAsset({id:383,wabaId:'999'}),localAsset({id:384,assignmentScope:'group',clinicaId:null,grupoClinicaId:5})];
 const result=await f.call({type:'clinic',id:19});assert.equal(result.incomplete,false);assert.equal(result.authorizations[0].localPhone,null);
 assert.equal(f.state.assetQueries.length,1);
});
test('Ambiguous exact local mapping keeps the receipt but marks metadata incomplete',async()=>{
 const f=fixture();f.state.assets=[localAsset(),localAsset({id:383})];const result=await f.call({type:'clinic',id:19});
 assert.equal(result.authorizations.length,1);assert.equal(result.authorizations[0].localPhone,null);assert.equal(result.incomplete,true);
});
test('Local asset reassignment while reading removes metadata instead of returning a stale profile',async()=>{
 const f=fixture();f.state.assets=[localAsset()];f.state.onAssetRead=count=>{if(count===2)f.state.assets[0].clinicaId=35;};
 const result=await f.call({type:'clinic',id:19});assert.equal(result.authorizations[0].localPhone,null);assert.equal(result.incomplete,true);
});
test('Final metadata read still rechecks scope blocks and current membership',async()=>{
 const f=fixture();f.state.assets=[localAsset()];f.state.onAssetRead=count=>{if(count===2)f.state.blocked.add('clinic:19');};
 const result=await f.call({type:'clinic',id:19});assert.equal(result.authorizations[0].authorizationStatus,'blocked');
 assert.equal(result.authorizations[0].selected,null);assert.equal(result.authorizations[0].localPhone,null);
 const g=fixture();g.state.assets=[localAsset()];g.state.onAssetRead=count=>{if(count===2)g.state.memberships.delete(19);};
 await assert.rejects(g.call({type:'clinic',id:19}),{code:'whatsapp_authorization_forbidden'});
 const h=fixture();h.state.assets=[localAsset()];h.state.blocked.add('clinic:19');await h.call({type:'clinic',id:19});assert.equal(h.state.assetQueries.length,0);
});
test('Multiple phones in the same scope remain visible with distinct signed roles',async()=>{
 const f=fixture(),first=f.state.rows[0],second=f.row({type:'clinic',id:19},1000);f.resign(first,'primary');f.resign(second,'secondary');f.state.rows=[first,second];
 f.state.phoneIds.set(second.request_id,'402');f.state.assets=[localAsset(),localAsset({id:383,phoneNumberId:'402'})];
 const result=await f.call({type:'clinic',id:19});assert.equal(result.incomplete,false);assert.equal(result.authorizations.length,2);
 assert.deepEqual(result.authorizations.map(a=>a.channelRole),['primary','secondary']);assert.equal(result.authorizations[1].localPhone.whatsapp_channel_role,'primary');
 assert.equal(result.authorizations[1].localPhone.base_whatsapp_channel_role,'primary');assert(result.authorizations.every(a=>a.connected===false&&a.localPhone.sending_enabled===false));
});
test('Adding a channel role without updating the original MAC cannot expose metadata',async()=>{
 const f=fixture();f.state.assets=[localAsset()];f.state.rows[0].channel_role='secondary';
 const result=await f.call({type:'clinic',id:19});assert.deepEqual(result,{authorizations:[],incomplete:true});assert.equal(f.state.brokerCalls.length,0);assert.equal(f.state.assetQueries.length,0);
});
test('Public URL parameters survive while credentials, signed URLs and unsafe schemes are removed',async()=>{
 const f=fixture();f.state.assets=[localAsset({wa_local_profile_website:'https://example.invalid/contact?utm_source=crm#hours',
  wa_local_profile_picture_url:'https://example.invalid/avatar.png?X-Amz-Signature=FICTITIOUS_URL_SECRET'})];
 let result=await f.call({type:'clinic',id:19});assert.equal(result.authorizations[0].localPhone.profile_picture_url,null);
 assert.equal(result.authorizations[0].localPhone.profile_website,'https://example.invalid/contact?utm_source=crm#hours');
 assert(!JSON.stringify(result).includes('FICTITIOUS_URL_SECRET'));
 for(const unsafe of ['javascript:alert(1)','https://user:password@example.invalid/','https://example.invalid/#access_token=FICTITIOUS_URL_SECRET',
  'https://example.invalid/?access_token=FICTITIOUS_URL_SECRET','https://example.invalid/?oh=FICTITIOUS_URL_SECRET']){
  f.state.assets[0].wa_local_profile_website=unsafe;result=await f.call({type:'clinic',id:19});assert.equal(result.authorizations[0].localPhone.profile_website,null);}
});
test('A group receipt joins only its exact group asset and preserves local metadata without a routing write',async()=>{
 const f=fixture();f.state.assets=[localAsset({assignmentScope:'group',clinicaId:null,grupoClinicaId:29}),localAsset({id:383,clinicaId:66})];
 const result=await f.call({type:'group',id:29}),phone=result.authorizations[0].localPhone;
 assert.equal(result.incomplete,false);assert.equal(phone.id,382);assert.equal(phone.assignmentScope,'group');assert.equal(phone.group_id,29);assert.equal(phone.clinic_id,null);
 assert.equal(phone.routing_binding,null);assert(f.state.assetQueries.every(q=>q.where.grupoClinicaId===29&&!Object.hasOwn(q.where,'clinicaId')));
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
