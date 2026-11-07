'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {createRequire}=require('node:module'),{randomUUID}=require('node:crypto');
require('node:net').Socket.prototype.connect=()=>{throw Error('OFFLINE_NETWORK_FORBIDDEN');};
global.fetch=()=>{throw Error('OFFLINE_PROVIDER_FORBIDDEN');};
const filename=path.resolve(__dirname,'../../services/metaMarketingEnrollmentAuthority.service.js'),actual=createRequire(filename);
const C=actual('./metaMarketingEnrollment.contract'),G=actual('./metaMarketingLegacyRecovery.service'),D=actual('../../services/integrations-broker/src/meta-marketing-discovery-contract');
function fixture({discoveryError}={}){
 const at=Date.parse('2030-01-01T00:00:00Z'),flowId=randomUUID(),sessionRef=randomUUID(),scopes=['ads_read','instagram_basic','pages_read_engagement','pages_show_list','public_profile'];
 const input={scopeKey:'group:29',actorId:1,sessionRef,sessionExpiresAt:new Date(at+3600000)};
 const metadata={versionId:flowId,digest:'a'.repeat(64),appId:'101',subjectId:'201',tokenType:'USER',scopes,expiresAt:at+3600000,dataAccessExpiresAt:null,granularScopes:[]};
 const row={flow_id:flowId,scope_key:input.scopeKey,actor_user_id:1,session_ref:sessionRef,session_expires_at:input.sessionExpiresAt,state:'staged',app_id:'101',
  clinic_ids:'[66,72]',scopes:JSON.stringify(scopes),scope_digest:'b'.repeat(64),candidate_metadata:JSON.stringify(metadata)};
 const asset=(kind,id,parentPageId=null)=>({assetRef:'meta-'+kind+':'+id,kind,id,parentPageId,name:'FICTITIOUS_PRIVATE_NAME',
  ...(kind==='ad_account'?{accountStatus:1,currency:'EUR',timezone:'Europe/Madrid'}:kind==='instagram_business'?{username:'fixture'}:{})});
 const assets=[asset('ad_account','301'),asset('ad_account','302'),asset('facebook_page','401'),asset('facebook_page','402'),asset('instagram_business','501','401')];
 const inventory={flowId,candidateVersionId:flowId,candidateDigest:metadata.digest,scopeDigest:row.scope_digest,scopeKey:row.scope_key,clinicSetDigest:C.hash(row.clinic_ids),
  observedAt:at,expiresAt:at+300000,accessBlocked:true,availableKinds:D.kinds(metadata),assets};
 const legacy={id:391,metaConnectionId:158,assetType:'ad_account',metaAssetId:'act_301',assignmentScope:'group',clinicaId:null,grupoClinicaId:29,isActive:1,
  whatsappAuthorizationId:null,page_credential_present:0,page_credential_sha256:null,wa_credential_present:0,wa_credential_sha256:null,additional_data_present:0,additional_data_sha256:null};
 const proof={version:2,scopeKey:row.scope_key,appId:'101',subjectId:'201',clinicIds:[66,72],mappingIds:[391],newPageCount:2,sourceConnectionId:158,canonicalConnectionId:172,
  aliases:[{...legacy,credentials_absent:1}],legacyAliases:G.normalizeAliases([legacy])};
 const state={discoveryCalls:0,transactions:0,writes:0};
 const models={sequelize:{transaction:async(_opts,work)=>{state.transactions++;return work({LOCK:{UPDATE:'UPDATE'}});}},
  MetaMarketingOAuthRequest:{findByPk:async()=>row},MetaMarketingEnrollmentRequest:{findOne:async()=>null,create:async()=>{state.writes++;throw Error('UNEXPECTED_WRITE');}},
  MetaMarketingEnrollmentClaim:{findAll:async()=>[]},ClinicMetaAsset:{findAll:async()=>[legacy]},MetaMarketingBrokerBinding:{findOne:async()=>null},
  MetaMarketingBrokerRevocation:{findOne:async()=>null},MetaMarketingEnrollmentIdentity:{findByPk:async()=>null},MetaConnection:{findAll:async()=>[{id:158,metaUserId:'201'}]}};
 const loaded={exports:{}};const requireClosed=name=>{
  if(name==='./metaMarketingOAuthScope.service')return {createScope:()=>({authorize:async()=>{},revalidate:async()=>{}})};
  if(name==='./metaScopeBlock.service')return {blocked:async()=>false};
  if(name==='./platformAudit.repository')return {createRepository:()=>({})};
  assert(!/models(?:\/index)?$|app\.js|dotenv/.test(name));return actual(name);
 };
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{require:requireClosed,module:loaded,exports:loaded.exports,process,JSON,structuredClone},{filename});
 const authority=loaded.exports.createAuthority({models,sessions:{},oauth:{assets:async()=>{state.discoveryCalls++;if(discoveryError)throw discoveryError;return {inventory};}},
  now:()=>new Date(at),enabled:()=>true,recoveryGuard:{forFlow:async()=>proof}});
 return {authority,input,flowId,sessionRef,state,refs:['meta-ad_account:301','meta-ad_account:302','meta-facebook_page:401','meta-facebook_page:402']};
}
async function capture(work){const logs=[],write=process.stderr.write;process.stderr.write=value=>{logs.push(String(value));return true;};try{await work(logs);}finally{process.stderr.write=write;}return logs.map(value=>JSON.parse(value));}
test('actual reserve logs physical Recovery selection rejection for four typed assets with only bounded counts',async()=>{
 const f=fixture();const refs=[...f.refs.slice(0,3),'meta-instagram_business:501'];
 const events=await capture(async()=>assert.rejects(f.authority.reserve(f.input,f.flowId,refs),{code:'meta_recovery_selection_changed',httpStatus:409}));
 assert.deepEqual(events,[{event:'meta_enrollment_reservation_rejected',phase:'physical',reason:'meta_recovery_selection_changed',selectedCount:4,adCount:2,pageCount:1,igCount:1,originalRequiredCount:1,selectedOriginalCount:1}]);
 assert.equal(f.state.discoveryCalls,1);assert.equal(f.state.writes,0);
});
test('actual reserve logs identity review after physical validation without changing the rejection',async()=>{
 const f=fixture();const events=await capture(async()=>assert.rejects(f.authority.reserve(f.input,f.flowId,f.refs),{code:'meta_enrollment_identity_review',httpStatus:409}));
 assert.equal(events.length,1);assert.equal(events[0].phase,'identity');assert.equal(events[0].reason,'meta_enrollment_identity_review');
 assert.equal(events[0].selectedCount,4);assert.equal(events[0].originalRequiredCount,1);assert.equal(f.state.discoveryCalls,1);assert.equal(f.state.writes,0);
});
test('discovery rejection remains outside SQL error normalization and cannot reflect canary error content or identifiers',async()=>{
 const canary='FICTITIOUS_PRIVATE_CANARY_NEVER_LOG',error=Object.assign(Error(canary),{name:'SequelizeUniqueConstraintError',code:canary,sql:canary});
 const f=fixture({discoveryError:error});const events=await capture(async()=>assert.rejects(f.authority.reserve(f.input,f.flowId,f.refs),value=>value===error));
 assert.deepEqual(events,[{event:'meta_enrollment_reservation_rejected',phase:'discovery',reason:'reservation_unavailable',selectedCount:4,adCount:2,pageCount:2,igCount:0}]);
 const text=JSON.stringify(events);for(const value of [canary,f.flowId,f.sessionRef,'FICTITIOUS_PRIVATE_NAME','meta-ad_account'])assert(!text.includes(value));
 assert.equal(f.state.transactions,0);assert.equal(f.state.writes,0);
});
test('a failed diagnostic sink cannot replace the original reservation error',async()=>{
 const f=fixture(),write=process.stderr.write;process.stderr.write=()=>{throw Error('FICTITIOUS_LOG_FAILURE');};
 try{await assert.rejects(f.authority.reserve(f.input,f.flowId,f.refs),{code:'meta_enrollment_identity_review',httpStatus:409});}finally{process.stderr.write=write;}
});
