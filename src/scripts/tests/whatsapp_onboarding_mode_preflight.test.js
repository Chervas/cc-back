'use strict';
require('../../../services/integrations-broker/test/offline-guard.cjs');
const test=require('node:test');const assert=require('node:assert/strict');
const {randomUUID,randomBytes}=require('node:crypto');
const {brokerForGateway}=require('./fixtures/whatsapp_onboarding_gateway.fixture.cjs');
const C=require('../../../services/integrations-broker/src/whatsapp-onboarding-contract');
const {WA_SCOPES}=require('../../../services/integrations-broker/test/whatsapp-companion-fixture.cjs');
const row=mode=>({requestId:randomUUID(),status:'awaiting',scope:{type:'group',id:9},clinicIds:[71,72],
  scopeDigest:C.hash('FICTITIOUS_MODE_SCOPE'),clinicSetDigest:C.hash('[71,72]'),state:randomBytes(32).toString('base64url'),
  expiresAt:new Date(Date.now()+599000).toISOString(),mode});
test('Explicit Cloud mode cannot open Meta against a pinned companion static binding',async t=>{
  const g=brokerForGateway(t,{customer:{selectionOnly:true,providerGrantPolicy:C.PROVIDER_GRANT_POLICY},scopes:[...WA_SCOPES]});
  await assert.rejects(g.client.begin(row('cloud_api')),{code:'whatsapp_onboarding_preparation_unavailable'});
  assert.deepEqual(g.state.calls,[]);assert.equal(g.f.state.codes,0);assert.equal(g.f.state.puts,0);
});
test('An explicit coexistence intent retains a strict static binding without enabling companion',async t=>{
  const g=brokerForGateway(t,{customer:{selectionOnly:true},scopes:[...WA_SCOPES]});
  const result=await g.client.begin(row('coexistence'));
  assert.equal(result.status,'awaiting');assert.equal(g.metadata.customer.providerGrantPolicy,undefined);
  assert.deepEqual(g.state.calls,[C.OPERATIONS.begin]);assert.equal(g.f.state.codes,0);
});
test('An invalid mode cannot reach the broker or change a bound profile',async t=>{
  const g=brokerForGateway(t,{customer:{selectionOnly:true},scopes:[...WA_SCOPES]});
  for(const mode of [null,'legacy',false,undefined])await assert.rejects(g.client.begin(row(mode)),{code:'whatsapp_onboarding_binding_invalid'});
  assert.deepEqual(g.state.calls,[]);
});
