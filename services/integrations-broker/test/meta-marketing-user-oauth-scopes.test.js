
'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../src/meta-marketing-oauth-contract'),M=require('../src/meta-marketing-contract');
const API=require('../../../src/services/metaMarketingOAuth.contract');
const {fixture}=require('./meta-marketing-oauth-fixture.cjs');
test('API USER slot admits explicit paid Lead scope and preserves USER-only restrictions',t=>{
  const make=scopes=>({scope_key:'group:9',connection_ref:'qa:meta-scope',asset_ref:'meta-enroll:group:9',app_id:'101',clinic_ids:'[71,72]',scopes:JSON.stringify([...scopes].sort()),redirect_uri:'https://example.invalid/oauth/meta/marketing/callback',state:'active',expires_at:new Date(Date.now()+600000)});
  const old=['public_profile','ads_read','pages_show_list','pages_read_engagement','leads_retrieval','pages_manage_ads','pages_manage_metadata'];
  assert.deepEqual(API.slot(make(old)).scopeValues,[...old].sort());assert(API.slot(make([...old,'ads_management'])).scopeValues.includes('ads_management'));
  for(const scope of ['business_management','whatsapp_business_messaging','pages_messaging','instagram_manage_messages']){
    assert.throws(()=>API.slot(make([...old,scope])),{code:'meta_oauth_unavailable'});
    const f=fixture(t);f.binding.metaMarketingOAuth.scopes.push(scope);assert.throws(()=>C.bindingFor(f.binding),{code:'invalid_request'});
  }
  assert.equal(M.SCOPES.includes('ads_management'),false);assert.equal(C.SCOPES.includes('ads_management'),true);
});
test('plan-only enrollment accepts explicit paid Lead permission without becoming executable or admitting business/WhatsApp scopes',()=>{
  const {buildPlan}=require('../../../ops/security/plan-meta-marketing-reconnection.cjs');
  const scopes=['ads_management','ads_read','leads_retrieval','pages_manage_ads','pages_manage_metadata','pages_read_engagement','pages_show_list','public_profile'];
  const input={version:1,mode:'plan',environment:'staging',scopes};
  const plan=buildPlan(input);assert.equal(plan.status,'prerequisites_missing');assert.equal(plan.executable,false);assert.equal(plan.ready,false);
  for(const scope of ['business_management','whatsapp_business_management'])assert.throws(()=>buildPlan({...input,scopes:[...scopes,scope].sort()}),{code:'meta_plan_scopes_invalid'});
});
