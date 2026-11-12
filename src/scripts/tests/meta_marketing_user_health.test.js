'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{randomUUID}=require('node:crypto'),{createRequire}=require('node:module');
const {Op}=require('sequelize'),M=require('../../../services/integrations-broker/src/meta-marketing-credential-maintenance-contract');
const F=require('../../services/metaMarketingEffectiveCredential.service'),C=require('../../services/metaMarketingBusiness.contract');
const {scopeKeys}=require('../../lib/metaMarketingUserHealth');
const HOUR=3600000,START=Date.parse('2030-01-01T12:00:00Z');
function fixture(){
 let clock=START,health='healthy',failure=null,beforeResponse=null,observedExpiry=undefined;
 const id=randomUUID(),version=randomUUID(),rows=new Map(),calls=[],changes=[],audits=[];
 const enrollment={enrollment_id:id,flow_id:randomUUID(),state:'active',scope_key:'group:29',clinic_ids:'[66,72]',connection_ref:'meta:fixture',actor_user_id:99,
  assets:JSON.stringify([{assetRef:'meta-ad_account:301',kind:'ad_account',id:'301',parentPageId:null}])};
 const current={epoch:1,versionId:version,digest:'a'.repeat(64),metadata:{tokenType:'USER',expiresAt:clock+60*24*HOUR,dataAccessExpiresAt:null},lastHealthyAt:new Date(clock-7*HOUR),lastError:'credential_revoked',observedAt:new Date(clock-HOUR)};
 const opts={scopeKeys:['group:29']};
 function matches(value,where={}){return Reflect.ownKeys(where).every(key=>{
  if(key===Op.or)return where[key].some(v=>matches(value,v));
  const expected=where[key],actual=value[key];
  if(expected&&typeof expected==='object'&&!(expected instanceof Date))return Reflect.ownKeys(expected).every(op=>op===Op.in?expected[op].includes(actual):op===Op.lte?+actual<=+expected[op]:false);
  return expected instanceof Date?+actual===+expected:actual===expected;
 });}
 const T={findOne:async({where})=>{const r=[...rows.values()].find(v=>matches(v,where));return r?structuredClone(r):null;},
  findByPk:async key=>rows.has(key)?structuredClone(rows.get(key)):null,
  create:async row=>{assert(![...rows.values()].some(v=>v.pending_enrollment_id&&v.pending_enrollment_id===row.pending_enrollment_id));rows.set(row.maintenance_id,structuredClone(row));return row;},
  update:async(patch,{where,transaction})=>{assert(transaction);const values=[...rows.values()].filter(v=>matches(v,where));for(const v of values)rows.set(v.maintenance_id,{...v,...structuredClone(patch)});return[values.length];},
  findAll:async({where})=>[...rows.values()].filter(v=>matches(v,where)).map(v=>({maintenance_id:v.maintenance_id}))};
 const transactions=[];
 const models={MetaMarketingCredentialMaintenance:T,MetaMarketingEffectiveCredential:{},MetaMarketingEnrollmentRequest:{findAll:async()=>[{enrollment_id:id}],findByPk:async()=>structuredClone(enrollment)},
  MetaMarketingOAuthRequest:{findByPk:async()=>({flow_id:enrollment.flow_id})},sequelize:{transaction:async(_opts,work)=>{const tx={LOCK:{UPDATE:'UPDATE'},ordinal:transactions.length};transactions.push(tx);return work(tx);}}};
 const credentials={resolve:async()=>{
  const value=structuredClone(current),row=[...rows.values()].find(r=>r.expected_epoch===value.epoch&&r.expected_version_id===value.versionId);
  if(row?.health_metadata){const proof=JSON.parse(row.health_metadata);for(const key of ['expiresAt','dataAccessExpiresAt'])if(proof[key]!==null)value.metadata[key]=value.metadata[key]===null?proof[key]:Math.min(value.metadata[key],proof[key]);}
  return value;
 },getCredentialStatus:async()=>({epoch:current.epoch,versionId:current.versionId,tokenType:'USER',healthKind:current.lastError?'permission_lost':'healthy',expired:false,unknownSince:null,lastHealthyAt:+current.lastHealthyAt}),
  recordHealthy:async(pin,value,{transaction})=>{assert(transactions.includes(transaction));if(pin.epoch!==current.epoch||pin.versionId!==current.versionId||value.digest!==current.digest)return false;changes.push({kind:'healthy',pin,transaction});current.lastError=null;current.lastHealthyAt=new Date(value.verifiedAt);return true;},
  recordFailure:async(pin,error,{transaction})=>{assert(transactions.includes(transaction));if(pin.epoch!==current.epoch||pin.versionId!==current.versionId)return false;changes.push({kind:'failure',pin,transaction});current.lastError=error.code;return true;}};
 const filename=path.resolve(__dirname,'../../services/metaMarketingCredentialMaintenance.service.js'),actual=createRequire(filename),loaded={exports:{}};
 const requireClosed=name=>name==='./metaMarketingBusiness.contract'?{...C,F:{...F,createEffectiveCredentials:()=>credentials}}
  :name==='./metaMarketingEnrollmentBinding.service'?{createBindings:()=>({committed:async(_id,_tx,options)=>{assert.equal(options.allowExpiredCredential,true);}})}
  :name==='./metaMarketingTransactionOrder.service'?{createOrder:()=>({prepareEnrollment:async enrollmentId=>({enrollmentId}),lockPrepared:async()=>{}})}
  :name==='./metaMarketingBusinessSource.service'?{createSource:()=>({forEnrollment:async()=>null})}:actual(name);
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{require:requireClosed,module:loaded,exports:loaded.exports,Date,Buffer,process:{env:{}},console},{filename});
 const client={execute:async request=>{assert.equal(request.operation,M.OPERATIONS.health);assert.equal(request.payload.expectedEpoch,current.epoch);calls.push(request);
  if(failure)throw Object.assign(Error(failure),{code:failure,...failure==='rate_limited'?{retryAfterMs:2*HOUR}:{}});
  const data={enrollmentId:id,epoch:current.epoch,versionId:current.versionId,digest:current.digest,verifiedAt:clock,
   expiresAt:health==='expired'?clock-1000:observedExpiry===undefined?current.metadata.expiresAt:observedExpiry,dataAccessExpiresAt:null,healthy:health==='healthy',reason:health==='healthy'?null:health==='expired'?'credential_expired':'credential_revoked'};
  await beforeResponse?.();return{requestId:request.requestId,data,replayed:false};}};
 const api=loaded.exports.createMaintenance({models,client,now:()=>new Date(clock),enabled:()=>true,userHealthScopeKeys:()=>opts.scopeKeys,
  audit:{health:async()=>({pending:0,oldestAgeSeconds:0}),append:async event=>audits.push(event)}});
 return{api,rows,calls,changes,current,enrollment,audits,opts,advance:ms=>{clock+=ms;},health:value=>{health=value;},fail:value=>{failure=value;},beforeResponse:fn=>{beforeResponse=fn;},observedExpiry:value=>{observedExpiry=value;},now:()=>clock};
}
test('USER supervision is an explicit scoped cohort; invalid configuration cannot expand it',()=>{
 assert.deepEqual(scopeKeys({}),[]);assert.deepEqual(scopeKeys({META_MARKETING_USER_HEALTH_SCOPE_KEYS:'["group:29"]'}),['group:29']);
 for(const raw of['*','{}','["*"]','["group:29","group:29"]','[29]'])assert.throws(()=>scopeKeys({META_MARKETING_USER_HEALTH_SCOPE_KEYS:raw}),{code:'broker_configuration_invalid'});
});
test('USER health runs every six hours, never invokes rotation and preserves epoch and previous failure evidence',async()=>{
 const f=fixture();await f.api.run();assert.equal(f.calls.length,1);assert.equal(f.changes.length,1);assert.equal(f.current.lastError,null);
 const row=[...f.rows.values()][0];assert.equal(row.state,'scheduled');assert.equal(row.attempts,0);assert.equal(row.rotate_sent_at,null);assert.equal(+row.health_next_at,f.now()+6*HOUR);
 assert.equal(JSON.parse(row.health_metadata).previousFailure.code,'credential_revoked');assert.equal(f.current.epoch,1);
 const status=await f.api.getMaintenanceStatus(f.enrollment);assert.equal(status.automaticSupported,false);assert.equal(status.mechanism,'user_legacy');
 f.advance(5*HOUR);await f.api.run();assert.equal(f.calls.length,1);f.advance(HOUR);await f.api.run();assert.equal(f.calls.length,2);
 assert.equal(JSON.parse([...f.rows.values()][0].health_metadata).previousFailure.code,'credential_revoked');
});
test('a USER scope outside the explicit cohort never borrows a credential',async()=>{
 const f=fixture();f.opts.scopeKeys=[];await f.api.run();assert.equal(f.calls.length,0);assert.equal(f.rows.size,0);assert.equal(f.current.lastError,'credential_revoked');
});
test('temporary provider failure preserves permanent denial, records unknown supervision and observes cooldown',async()=>{
 const f=fixture();f.fail('rate_limited');await f.api.run();assert.equal(f.calls.length,1);assert.equal(f.current.lastError,'credential_revoked');assert.equal(f.changes.length,0);
 const row=[...f.rows.values()][0];assert.equal(row.state,'scheduled');assert.equal(+row.health_next_at,f.now()+2*HOUR);assert(row.unknown_since);
 f.advance(HOUR);await f.api.run();assert.equal(f.calls.length,1);f.advance(HOUR);f.fail(null);await f.api.run();assert.equal(f.calls.length,2);
});
test('confirmed invalid USER access requires human authorization rather than rotating or repeating every minute',async()=>{
 const f=fixture();f.health('invalid');await f.api.run();const row=[...f.rows.values()][0];assert.equal(row.state,'human_required');assert.equal(row.pending_enrollment_id,null);
 assert.equal(f.current.lastError,'credential_revoked');f.advance(8*HOUR);await f.api.run();assert.equal(f.calls.length,1);
});
test('expired observed USER credential remains denied and keeps a distinct expiry proof',async()=>{
 const f=fixture();f.health('expired');await f.api.run();const row=[...f.rows.values()][0],proof=JSON.parse(row.health_metadata);
 assert.equal(proof.reason,'credential_expired');assert.equal(proof.healthy,false);assert(proof.expiresAt<f.now());assert.equal(row.state,'human_required');assert.equal(f.changes[0].kind,'failure');
});
test('a stale provider observation cannot clear failure for a newer credential',async()=>{
 const f=fixture();f.beforeResponse(()=>{f.current.epoch++;f.current.versionId=randomUUID();f.current.digest='b'.repeat(64);});
 await f.api.run();assert.equal(f.changes.length,0);assert.equal(f.current.lastError,'credential_revoked');assert.equal([...f.rows.values()][0].health_metadata,null);
});
test('a renewed USER retires its prior pending supervision by CAS and preserves the old proof',async()=>{
 const f=fixture();await f.api.run();const old=[...f.rows.values()][0];f.current.epoch++;f.current.versionId=randomUUID();f.current.digest='b'.repeat(64);f.current.lastHealthyAt=new Date(f.now());
 await f.api.run();assert.equal(f.rows.size,2);assert.equal(f.rows.get(old.maintenance_id).state,'failed');assert.equal(f.rows.get(old.maintenance_id).pending_enrollment_id,null);
 assert.equal(JSON.parse(f.rows.get(old.maintenance_id).health_metadata).previousFailure.code,'credential_revoked');assert.equal(f.audits.length,1);
 const next=[...f.rows.values()].find(r=>r.maintenance_id!==old.maintenance_id);assert.equal(next.expected_epoch,2);assert.equal(next.state,'scheduled');assert.equal(f.calls.length,1);
});


test('recurring USER health cannot extend an earlier observed expiry on the same epoch',async()=>{
 const f=fixture(),floor=f.now()+7*HOUR;f.observedExpiry(floor);await f.api.run();
 assert.equal(JSON.parse([...f.rows.values()][0].health_metadata).expiresAt,floor);
 f.advance(6*HOUR);f.observedExpiry(null);await f.api.run();assert.equal(JSON.parse([...f.rows.values()][0].health_metadata).expiresAt,floor);
 f.advance(6*HOUR);f.observedExpiry(f.now()+60*24*HOUR);await f.api.run();
 const proof=JSON.parse([...f.rows.values()][0].health_metadata);assert.equal(proof.expiresAt,floor);assert.equal(proof.reason,'credential_expired');
 assert.equal(proof.healthy,false);assert.equal(f.current.lastError,'credential_revoked');assert.equal(f.current.epoch,1);
});
