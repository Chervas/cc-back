'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/whatsapp-onboarding-contract');
const P = require('../src/whatsapp-provisioning-contract');
const { provisioningFixture } = require('./whatsapp-provisioning-fixture.cjs');
const POLICY = 'meta-app-companion-v1';
const settings = () => ({ appId: '101', configId: '102', redirectUri: 'https://app.example.invalid/whatsapp/callback',
  scopes: ['whatsapp_business_management','whatsapp_business_messaging'], appVersionId: 'a'.repeat(32),
  clientSecretArn: P.ARN_PREFIX + '/clinicaclick/integrations/prod/qa-app-abcdef', maxConnections: 100 });
const withOverride = value => ({ ...value, grantPolicyOverrides: [{scopeKey:'clinic:123',policy:POLICY}] });
const companionSettings = () => ({ ...settings(), scopes: [...settings().scopes,'public_profile'] });
function slot(value, scope = 'clinic:123', ids = [123]) {
  const name = P.PREFIX + scope.replace(':','-') + '/candidate';
  return { state:'ready', scope, connection:P.connectionRef(scope), name,
    version_id:'11111111-1111-4111-8111-111111111111', config_digest:P.settingsDigest(value),
    arn:P.ARN_PREFIX + name + '-Abc123', clinic_ids:JSON.stringify(ids) };
}
test('Legacy empty-slot digest and enrollment fingerprint retain frozen c4126ddf values', () => {
  const value = settings(), row = slot(value);
  // Generated from the pre-change c4126ddf sources with these fictitious inputs.
  assert.equal(P.settingsDigest(value), 'c11473471f2518b90ef948051cf0a11d3931972f99ba795b7e5614d9c6ca623f');
  assert.equal(C.fingerprint(P.bindingFromSlot(value,row)), 'f466f9aead1812d6cf34010f74c1a6aee2fd3f62276ab5ab67d34b07ffaf8a51');
  assert.deepEqual(P.publicBinding(value,'clinic:123',[123]).customer, {selectionOnly:true});
});
test('A scoped opt-in changes only its enrollment fingerprint, retaining every other ready slot', () => {
  const value = companionSettings(), chosen = withOverride(value);
  assert.equal(P.settingsDigest(chosen), P.settingsDigest(value));
  const row = slot(value), before = P.bindingFromSlot(value,row), after = P.bindingFromSlot(chosen,row);
  assert.equal(after.whatsappOnboarding.customer.providerGrantPolicy, POLICY);
  assert.notEqual(C.fingerprint(after), C.fingerprint(before));
  assert.equal(after.secretArn,before.secretArn);
  assert.equal(after.whatsappOnboarding.slotVersionId,before.whatsappOnboarding.slotVersionId);
  for (const [scope, ids] of [['clinic:124',[124]],['group:9',[123,124]]]) {
    const other = slot(value,scope,ids);
    assert.deepEqual(P.bindingFromSlot(chosen,other),P.bindingFromSlot(value,other));
    assert.deepEqual(P.publicBinding(chosen,scope,ids),P.publicBinding(value,scope,ids));
  }
  assert.deepEqual(P.publicBinding(chosen,'clinic:123',[123]),P.publicBinding(P.publicTemplate(chosen),'clinic:123',[123]));
  assert.deepEqual(Object.keys(P.publicTemplate(chosen)).sort(),['appId','configId','grantPolicyOverrides','redirectUri','scopes']);
});
test('Only exact, unique, ordered, bounded server scope overrides are accepted', () => {
  const value = companionSettings(), valid = {scopeKey:'clinic:123',policy:POLICY};
  for (const overrides of [null,[],[null],[{...valid,scopeKey:'clinic:0'}],[{...valid,scopeKey:'clinic:*'}],
    [{...valid,policy:'allow-all'}],[{...valid,policy:undefined}],[{...valid,extra:true}],
    [valid,valid],[{...valid,scopeKey:'group:9'},valid],Array.from({length:65},(_,i)=>({...valid,scopeKey:'clinic:'+String(1000+i) }))]) {
    assert.throws(()=>P.validateSettings({...value,grantPolicyOverrides:overrides}),{code:'invalid_request'});
    assert.throws(()=>P.validatePublicTemplate({...P.publicTemplate(value),grantPolicyOverrides:overrides}),{code:'invalid_request'});
  }
  assert.deepEqual(P.validateSettings(withOverride(value)),withOverride(value));
  assert.throws(()=>P.validateSettings(withOverride(settings())),{code:'invalid_request'});
  assert.throws(()=>P.validateSettings({...value,grantPolicyOverrides:[valid],unexpected:true}),{code:'invalid_request'});
});
test('Signed automatic preparation returns the exact opted-in binding resolved by its Owner', async t => {
  const p = provisioningFixture(t), chosen = withOverride({...p.settings,scopes:[...p.settings.scopes,'public_profile']}), handle = p.make(undefined,chosen);
  const command = p.command(), prepared = await p.prepare(command,handle);
  const resolved = handle.provisioner.resolveBinding(command.connectionRef);
  assert.deepEqual(prepared.data.binding,P.publicBinding(P.publicTemplate(chosen),'clinic:123',[123]));
  assert.equal(resolved.whatsappOnboarding.customer.providerGrantPolicy,POLICY);
  assert.equal(prepared.data.connected,false);
  for (const field of ['clientSecretArn','secretArn','appVersionId','slotVersionId']) assert(!JSON.stringify(prepared).includes(field));
  const other = await p.prepare(p.command('clinic:124',[124]),handle);
  assert.deepEqual(other.data.binding.customer,{selectionOnly:true});
  assert.equal(p.f.state.codes,0);
  assert.equal(p.f.state.puts,0);
});
