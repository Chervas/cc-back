'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { brokerForGateway } = require('./fixtures/whatsapp_onboarding_gateway.fixture.cjs');
const C = require('../../../services/integrations-broker/src/whatsapp-onboarding-contract');
const { TOKEN } = require('../../../services/integrations-broker/test/whatsapp-onboarding-fixture.cjs');
const companions = ['business_management','ads_management','ads_read','leads_retrieval',
  'pages_show_list','pages_manage_metadata','pages_read_engagement','pages_manage_ads'];
function setup(t, policy = true) {
  const g = brokerForGateway(t,{customer:{selectionOnly:true,...(policy?{providerGrantPolicy:'meta-app-companion-v1'}:{})},
    scopes:['public_profile','whatsapp_business_manage_events','whatsapp_business_management','whatsapp_business_messaging']});
  g.f.state.afterGraph = (request,response) => {
    if (request.action==='inspect') {
      response.data.scopes.push(...companions);
      response.data.granular_scopes.push(...companions.map((scope,i)=>({scope,target_ids:[String(900+i)]})));
    }
    return response;
  };
  const row = {requestId:randomUUID(),status:'awaiting',scope:{type:'group',id:9},clinicIds:[71,72],
    expiresAt:new Date(g.f.now()+600000).toISOString(),scopeDigest:C.hash('FICTITIOUS_COMPANION_GATEWAY_SCOPE'),
    clinicSetDigest:C.hash('[71,72]'),state:randomBytes(32).toString('base64url')};
  return {g,row,finish:{state:row.state,code:'FICTITIOUS_COMPANION_CODE_'+row.requestId,wabaId:'301',phoneId:'401'}};
}
test('Gateway and immutable candidate preserve all observed scopes while exposing no Marketing operation',async t=>{
  const {g,row,finish}=setup(t);await g.client.begin(row);
  const result=await g.client.finish(row,finish);
  assert.equal(result.status,'staged');assert.equal(result.connected,false);
  assert.deepEqual(result.candidate.scopes,[...g.metadata.scopes,...companions].sort());
  assert.equal(result.candidate.providerGrant.version,1);
  assert(result.candidate.providerGrant.granularScopes.some(item=>item.scope==='ads_read'));
  assert.deepEqual(result.candidate.grantedWabaIds,['301']);
  assert(!JSON.stringify(result).includes(TOKEN));
  assert(g.f.state.httpCalls.every(request=>['inspect','waba_owner','phones','phone_state'].includes(request.action)));
  g.f.restart();assert.equal((await g.client.status(row)).status,'staged');
  assert.equal(g.f.state.codes,1);assert.equal(g.f.state.puts,1);
});
test('Unknown or missing provider evidence never becomes an accepted gateway receipt',async t=>{
  const {g,row,finish}=setup(t);await g.client.begin(row);await g.client.finish(row,finish);
  for(const mutate of [v=>{delete v.providerGrant},v=>{v.providerGrant.version=99},
    v=>{v.scopes.push('pages_messaging')},v=>{v.providerGrant.granularScopes.push({scope:'pages_messaging',targetIds:['999']})},
    v=>{v.providerGrant.granularScopes[0].targetIds=['malformed']},
    v=>{v.providerGrant.granularScopes.find(row=>row.scope==='whatsapp_business_messaging').targetIds=['999']},
    v=>{v.scopes=v.scopes.filter(scope=>scope!=='whatsapp_business_messaging')}]) {
    g.state.after=(command,value)=>{mutate(value.data.candidate);return value};
    await assert.rejects(g.client.status(row),{code:'whatsapp_onboarding_result_unknown'});
  }
  g.state.after=null;assert.equal((await g.client.status(row)).status,'staged');
  assert.equal(g.f.state.codes,1);assert.equal(g.f.state.puts,1);
});
test('An identical mixed grant still fails closed without explicit server policy',async t=>{
  const {g,row,finish}=setup(t,false);await g.client.begin(row);
  await assert.rejects(g.client.finish(row,finish),{code:'whatsapp_onboarding_result_unknown'});
  assert.equal((await g.client.status(row)).status,'interrupted');
  assert.equal(g.f.state.puts,0);
});
