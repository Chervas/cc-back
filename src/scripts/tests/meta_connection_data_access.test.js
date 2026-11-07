'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
require('node:net').Socket.prototype.connect=()=>{throw Error('TEST_ONLY_no_network');};require('node:tls').connect=()=>{throw Error('TEST_ONLY_no_TLS');};
const M=require('../../services/metaConnectionMetadata.service');
function fixture(){
  const state={enabled:true,active:true,bindingActive:true,session:true,acl:true,reads:0,prepares:0,asserts:0,legacyMappings:0,onAssert:null,onResolve:null,scopeKey:'group:28',clinicIds:[1,70]};
  const recovery={recovery_id:randomUUID(),scope_key:'group:28',state:'active',canonical_connection_id:198,mapping_ids:'[359]',flow_id:randomUUID(),enrollment_id:randomUUID(),app_id:'101',meta_user_id:'201',snapshot:'{"version":1}',snapshot_digest:'a'.repeat(64),candidate_digest:'b'.repeat(64)};
  const binding={mapping_id:359,enrollment_id:recovery.enrollment_id,meta_connection_id:198,scope_key:'group:28',asset_ref:'meta-ad_account:301',state:'active'};
  const models={MetaMarketingRecovery:{async findAll(options){if(state.failSql)throw Error('FICTITIOUS_SQL_PASSWORD_MUST_NOT_ESCAPE');state.reads++;assert.deepEqual(options.attributes,M.DATA_RECOVERY_FIELDS);assert.equal(options.raw,true);assert.equal(options.logging,false);return state.active&&options.where.scope_key===recovery.scope_key?[{...recovery,accessToken:'FICTITIOUS_NEVER_SELECTED'}]:[];}},
    MetaMarketingBrokerBinding:{async findAll(options){state.reads++;assert.deepEqual(options.attributes,M.DATA_BINDING_FIELDS);assert.equal(options.raw,true);return state.bindingActive?[{...binding,private_key:'FICTITIOUS_NEVER_SELECTED'}]:[];}}};
  const contexts=new WeakMap();
  const captured=()=>({mappingId:359,kind:'ad_account',assetRef:binding.asset_ref,scopeKey:state.scopeKey,connectionId:binding.meta_connection_id,appId:'101',subjectId:'201',clinicIds:state.clinicIds.slice()});
  const broker={async prepare(id){state.prepares++;assert.equal(id,359);const value={};contexts.set(value,captured());return value;},describe(context){assert(contexts.has(context));return structuredClone(contexts.get(context));},async assertContext(context){state.asserts++;assert(contexts.has(context));state.onAssert?.();if(!state.bindingActive)throw Object.assign(Error('asset_revoked'),{code:'asset_revoked'});return captured();},read(){assert.fail('Metadata must never call the broker/provider');}};
  const loadDataAccess=M.createMetaDataAccessRepository(models,{broker,enabled:()=>state.enabled});
  const jti=randomUUID();
  const deps={loadDataAccess,session:async()=>state.session?{userId:1,jti,sessionVersion:1}:null,
    authorize:async req=>{if(!state.acl)throw Object.assign(Error('marketing_connection_scope_forbidden'),{code:'marketing_connection_scope_forbidden',httpStatus:403});const type=req.query.assignment_scope||'group',id=Number(type==='group'?req.query.group_id:req.query.clinic_id);return {requested:true,assignmentScope:type,groupId:type==='group'?id:null,clinicId:type==='clinic'?id:null,clinicIds:type==='group'?(id===28?[1,70]:[88]):[id]};},
    resolve:async req=>{state.onResolve?.();const type=req.query.assignment_scope||'group',id=Number(type==='group'?req.query.group_id:req.query.clinic_id);return {connection:null,assignment:null,scope:{assignmentScope:type,groupId:type==='group'?id:null,clinicId:type==='clinic'?id:null,scopeKey:`${type}:${id}`},source:'blocked'};},
    loadMappings:async()=>{state.legacyMappings++;return [];},scopeResponse:scope=>scope};
  const reader=M.createMetaConnectionMetadata(deps);
  const request=(query={assignment_scope:'group',group_id:'28'})=>({query,userData:{userId:1},headers:{authorization:'FICTITIOUS_MANAGED_SESSION'}});
  const call=async(query,mappings=false)=>{let status=200,body;const headers={};const res={set(k,v){headers[k]=v;return this;},status(v){status=v;return this;},json(value){body=value;return this;}};await reader.handler(mappings)(request(query),res);return {status,body,headers};};
  return {state,recovery,binding,reader,call,request,loadDataAccess};
}
test('active canonical read access is projected with a blocked/null legacy connection, without general connected or provider claims',async()=>{
  const f=fixture(),r=await f.call();assert.equal(r.status,200);assert.match(r.headers['Cache-Control'],/no-store/);
  assert.deepEqual(r.body.dataAccess,{version:1,configured:true,readOnly:true,sources:['meta_ads'],scope:{type:'group',id:28,key:'group:28',clinicCount:2}});
  assert.equal(r.body.connected,false);assert.equal(r.body.connectionStored,false);assert.deepEqual(r.body.availability,{available:false,reason:'meta_security_quarantine'});
  assert.equal(f.state.prepares,1);assert.equal(f.state.asserts,1);assert.equal(f.state.legacyMappings,0);assert(!JSON.stringify(r).includes('FICTITIOUS_NEVER_SELECTED'));assert(!Object.hasOwn(r.body.dataAccess,'verifiedAt'));assert(!Object.hasOwn(r.body.dataAccess,'lastSyncAt'));
  const mappings=await f.call(undefined,true);assert.deepEqual(mappings.body.mappings,[]);assert.deepEqual(mappings.body.dataAccess,r.body.dataAccess);
});
test('another group or a clinic request cannot inherit the complete group data-access capability',async()=>{
  const f=fixture();for(const q of [{assignment_scope:'group',group_id:'29'},{assignment_scope:'clinic',clinic_id:'1'}]){const r=await f.call(q);assert.equal(r.status,200);assert.equal(r.body.dataAccess,undefined);}assert.equal(f.state.prepares,0);
});
test('closed flags and missing active recovery produce no positive DTO, with zero new metadata queries when disabled',async()=>{
  const f=fixture();f.state.enabled=false;let r=await f.call();assert.equal(r.status,200);assert.equal(r.body.dataAccess,undefined);assert.equal(f.state.reads,0);
  f.state.enabled=true;f.state.active=false;r=await f.call();assert.equal(r.status,200);assert.equal(r.body.dataAccess,undefined);assert.equal(f.state.prepares,0);
});
test('recovery, canonical binding, group membership or gate changes during metadata I/O suppress all data access',async()=>{
  for(const change of [f=>{f.state.active=false;},f=>{f.binding.meta_connection_id=199;},f=>{f.state.clinicIds=[1,70,88];},f=>{f.state.enabled=false;}]){
    const f=fixture();let reads=0;f.state.onResolve=()=>{if(++reads===2)change(f);};const r=await f.call();assert([409,503].includes(r.status));assert.equal(r.body.dataAccess,undefined);assert.equal(r.body.connected,false);
  }
});
test('session or ACL revoked during the final canonical context fence returns no DTO or partial inventory',async()=>{
  for(const [field,expected]of [['session',401],['acl',403]]){const f=fixture();f.state.onAssert=()=>{f.state[field]=false;};const r=await f.call();assert.equal(r.status,expected);assert.equal(r.body.dataAccess,undefined);assert.equal(r.body.mappings,undefined);}
});
test('invalid mappings or canonical context, and unexpected SQL failures fail closed without secret detail',async()=>{
  for(const change of [f=>{f.recovery.mapping_ids='[359,359]';},f=>{f.state.bindingActive=false;},f=>{f.recovery.canonical_connection_id=199;},f=>{f.state.scopeKey='group:29';},
    f=>{f.recovery.snapshot='{"version":3}';},f=>{f.recovery.snapshot='null';},f=>{f.recovery.snapshot='{"version":2}';},f=>{f.recovery.snapshot='not-json';}]){
    const f=fixture();change(f);const r=await f.call();assert([409,503].includes(r.status));assert.equal(r.body.dataAccess,undefined);assert(!JSON.stringify(r).includes('FICTITIOUS_NEVER_SELECTED'));
  }
  const f=fixture();f.state.failSql=true;const failed=await f.call();assert.equal(failed.status,503);assert.equal(failed.body.dataAccess,undefined);assert(!JSON.stringify(failed).includes('FICTITIOUS_SQL_PASSWORD'));
});
test('retirement during the final broker metadata check is caught by the last generation readback',async()=>{
  const f=fixture();f.state.onAssert=()=>{f.state.active=false;};const r=await f.call();assert.equal(r.status,409);assert.equal(r.body.dataAccess,undefined);
});
