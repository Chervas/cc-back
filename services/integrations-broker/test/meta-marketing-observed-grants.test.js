'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const M=require('../src/meta-marketing-contract'),O=require('../src/meta-marketing-oauth-contract');
const {fixture:oauthFixture,TOKEN,APP}=require('./meta-marketing-oauth-fixture.cjs');
const {fixture:readFixture}=require('./meta-marketing-fixture.cjs');
const NOW=1794068000000,scopes=['public_profile','ads_read','leads_retrieval','pages_show_list','pages_read_engagement','pages_manage_ads','pages_manage_metadata'];
const extras=['whatsapp_business_messaging','whatsapp_business_management','business_management','business_metadata','email'];
const expected={appId:'101',subjectId:'201',scopes};
function raw(){return {data:{app_id:'101',user_id:'201',type:'USER',is_valid:true,scopes:[...scopes,...extras],expires_at:Math.floor(NOW/1000)+3600,data_access_expires_at:0,
 granular_scopes:[{scope:'ads_read',target_ids:['301']},{scope:'pages_read_engagement',target_ids:['401']},{scope:'whatsapp_business_messaging',target_ids:['901']},{scope:'business_management',target_ids:['902']}]}};}
function rejecting(value,reason){let error;try{M.inspectCredential(value,expected,NOW);}catch(e){error=e;}assert.equal(error?.code,'oauth_credentials_incomplete');if(reason)assert.equal(error.credentialValidationReason,reason);return error;}
test('prior WA/business grants are validated then projected exactly; raw input and cross-asset guard are preserved',()=>{
 const value=raw(),before=structuredClone(value),metadata=M.inspectCredential(value,expected,NOW);
 assert.deepEqual(metadata.scopes,[...scopes].sort());assert.deepEqual(metadata.granularScopes,[{scope:'ads_read',targetIds:['301']},{scope:'pages_read_engagement',targetIds:['401']}]);assert.deepEqual(value,before);
 assert(!JSON.stringify(metadata).includes('whatsapp'));assert(!JSON.stringify(metadata).includes('business_management'));
 M.assertAssetCredential(metadata,{kind:'ad_account',id:'301'});assert.throws(()=>M.assertAssetCredential(metadata,{kind:'ad_account',id:'999'}),{code:'scope_denied'});
 assert.throws(()=>M.assertAssetCredential(metadata,{kind:'instagram_business',id:'501',parentPageId:'401'}),{code:'scope_denied'});
});
test('narrow resource bindings get only their own scopes; every requested scope remains mandatory',()=>{
 const narrow=M.inspectCredential(raw(),{...expected,scopes:['ads_read']},NOW);assert.deepEqual(narrow.scopes,['ads_read']);assert.deepEqual(narrow.granularScopes,[{scope:'ads_read',targetIds:['301']}]);
 for(const missing of scopes){const v=raw();v.data.scopes=v.data.scopes.filter(s=>s!==missing);rejecting(v,'debug_required_scope_missing');}
 for(const scope of ['whatsapp_business_messaging','business_management'])assert.throws(()=>M.inspectCredential(raw(),{...expected,scopes:[scope]},NOW),{code:'invalid_request'});
});
test('malformed or excessive observed scopes are rejected even when unrelated to requested permissions',()=>{
 for(const mutate of [d=>d.scopes.push(d.scopes[0]),d=>d.scopes.push('extra scope'),d=>d.scopes.push('scope\n'),d=>d.scopes.push('éxtra'),d=>d.scopes.push('x'.repeat(129)),d=>d.scopes.push(null),d=>d.scopes=[],d=>d.scopes='ads_read',d=>d.scopes.push(...Array.from({length:65},(_,i)=>'extra_'+i))]){const value=raw();mutate(value.data);rejecting(value,'debug_scope_shape');}
 const boundary=raw();boundary.data.scopes=[...scopes,...Array.from({length:64-scopes.length},(_,i)=>'extra_'+i)];boundary.data.granular_scopes=[];assert.equal(M.inspectCredential(boundary,expected,NOW).scopes.length,scopes.length);
});
test('all granular rows and targets are validated before filtering unrelated permissions',()=>{
 for(const mutate of [d=>d.granular_scopes.push({...d.granular_scopes[2]}),d=>d.granular_scopes[2].target_ids=['901','901'],d=>d.granular_scopes[2].target_ids=['bad'],d=>d.granular_scopes[2].target_ids=Array.from({length:1001},(_,i)=>String(i+1)),d=>d.granular_scopes[2].scope='not_observed',d=>d.granular_scopes[2].target_ids='901',d=>d.granular_scopes[2].unexpected='forbidden',d=>d.granular_scopes.push(null),d=>{d.scopes=Array.from({length:11},(_,i)=>'extra_'+i).concat(scopes);d.granular_scopes=Array.from({length:11},(_,i)=>({scope:'extra_'+i,target_ids:Array.from({length:1000},(_,j)=>String(j+1))}));}]){const value=raw();mutate(value.data);rejecting(value,'debug_granular_shape');}
 const value=raw();value.data.granular_scopes[0].target_ids=[];assert.throws(()=>M.assertAssetCredential(M.inspectCredential(value,expected,NOW),{kind:'ad_account',id:'301'}),{code:'scope_denied'});
});
test('identity, type, validity and expiry checks stay mandatory',()=>{
 for(const [mutate,code]of [[d=>d.app_id='999','oauth_identity_mismatch'],[d=>d.user_id='999','oauth_identity_mismatch'],[d=>d.type='PAGE','oauth_identity_mismatch'],[d=>d.is_valid=false,'credential_revoked'],[d=>d.expires_at=1,'credential_revoked']]){const value=raw();mutate(value.data);assert.throws(()=>M.inspectCredential(value,expected,NOW),{code});}
 for(const mutate of [d=>delete d.expires_at,d=>d.data_access_expires_at='3600',d=>d.expires_at=-1]){const value=raw();mutate(value.data);rejecting(value,'debug_expiry_shape');}
});
test('diagnostics expose only fixed reasons or bounded counts, never provider values or permissions',()=>{
 const logs=[],write=process.stderr.write;process.stderr.write=function(v){logs.push(String(v));return true;};
 try{const value=raw();value.error={message:TOKEN+APP};rejecting(value,'debug_response_shape');M.inspectCredential(raw(),expected,NOW);}finally{process.stderr.write=write;}
 assert.deepEqual(logs.map(s=>JSON.parse(s)),[{event:'meta_marketing_credential_validation_failed',reason:'debug_response_shape'},{event:'meta_marketing_scopes_projected',requestedScopeCount:7,ignoredScopeCount:5}]);
 for(const secret of [TOKEN,APP,'business_management'])assert(!logs.join('').includes(secret));
});
test('real OAuth HTTP and vault staging accept accumulated grants while persisting exact slot metadata only',async t=>{
 const f=oauthFixture(t),flow=await f.begin();f.state.afterGraph=(kind,response)=>{if(kind==='inspect'){response.data.scopes.push(...extras);response.data.granular_scopes.push({scope:'whatsapp_business_messaging',target_ids:['901']});}return response;};
 const result=await f.finish(flow);assert.equal(result.data.status,'staged');assert.equal(f.state.codes,1);assert.equal(f.state.puts,1);
 const row=f.current.store.db.prepare('SELECT credential_metadata FROM meta_marketing_oauth_flows WHERE id=?').get(flow.flowId),metadata=JSON.parse(row.credential_metadata);
 assert.deepEqual(metadata.scopes,[...f.binding.metaMarketingOAuth.scopes].sort());assert(!metadata.granularScopes.some(r=>extras.includes(r.scope)));O.metadata(metadata,f.binding);
 for(const secret of [TOKEN,APP])assert(!JSON.stringify(result).includes(secret));
});
test('signed reads with a broad token still deny unassigned assets, WA calls and requesting extra permissions',async t=>{
 const f=readFixture(t);f.state.inspect=()=>{const result=f.inspect();result.data.scopes.push(...extras);result.data.granular_scopes.push({scope:'whatsapp_business_messaging',target_ids:['901']});return result;};
 assert.equal((await f.execute()).data.assetRef,'meta-ad_account:301');const before=f.state.http.length;
 await assert.rejects(f.execute(f.command({assetRef:'meta-ad_account:999'})));await assert.rejects(f.execute(f.command({operation:'meta.whatsapp.text.send.v1'})));assert.equal(f.state.http.length,before);
 const binding=structuredClone(f.binding);binding.metaMarketing.scopes.push('whatsapp_business_messaging');assert.throws(()=>M.bindingFor(binding),{code:'invalid_request'});
});
