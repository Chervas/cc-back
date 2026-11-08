'use strict';
require('./offline-guard.cjs');
const test=require('node:test'),assert=require('node:assert/strict');
const {ready,ACCOUNT}=require('./meta-marketing-leads-fixture.cjs');
const {hasLeadAccess}=require('../src/meta-marketing-page-lead-access');
test('Lead readiness addresses the inspected subject and app, preserving Page identity and pacing',async t=>{
 const r=await ready(t),v=(await r.execute('pageStatus',{adAccountAssetRef:ACCOUNT})).data;
 assert.equal(v.page.has_lead_access,true);
 const reads=r.state.calls.filter(c=>c.fields?.includes('has_lead_access'));
 assert.equal(reads.length,1);assert.equal(reads[0].path,'/v24.0/401');assert.equal(reads[0].fields,'id,has_lead_access.user_id(201).app_id(101)');
 assert.equal(r.state.calls.length,7);
 for(let i=1;i<r.state.calls.length;i++)assert(r.state.calls[i].at-r.state.calls[i-1].at>=1000);
});
test('a provider response for another user is rejected before reading subscriptions or performing writes',async t=>{
 const r=await ready(t);r.state.before=u=>{r.state.raw=u.searchParams.get('fields')?.includes('has_lead_access')?{id:'401',has_lead_access:{page_id:'401',user_id:'999',can_access_lead:true}}:null;};
 await assert.rejects(r.execute('pageStatus',{adAccountAssetRef:ACCOUNT}),{code:'provider_failed'});
 assert(!r.state.calls.some(c=>c.path.endsWith('/subscribed_apps')));assert(!r.state.calls.some(c=>c.method==='POST'));
});
test('correct identity with explicitly denied lead permission is false and does not enable the Page',async t=>{
 const r=await ready(t);r.state.before=u=>{r.state.raw=u.searchParams.get('fields')?.includes('has_lead_access')?{id:'401',has_lead_access:{page_id:'401',user_id:'201',can_access_lead:false,app_has_leads_permission:false,user_has_leads_permission:true}}:null;};
 const status=(await r.execute('pageStatus',{adAccountAssetRef:ACCOUNT})).data;
 assert.equal(status.page.has_lead_access,false);
 await assert.rejects(r.execute('pageEnable',{adAccountAssetRef:ACCOUNT,expectedSubscriptionRevision:status.subscription.revision}),{code:'scope_denied'});
 assert(!r.state.calls.some(c=>c.method==='POST'));
});
test('a fresh debug response for another subject cannot reach the Page-access query',async t=>{
 const r=await ready(t);r.f.state.afterGraph=(kind,raw)=>kind==='inspect'?{...raw,data:{...raw.data,user_id:'999'}}:raw;
 await assert.rejects(r.execute('pageStatus',{adAccountAssetRef:ACCOUNT}),{code:'oauth_identity_mismatch'});
 assert(!r.state.calls.some(c=>c.fields?.includes('has_lead_access')));assert(!r.state.calls.some(c=>c.method==='POST'));
});
