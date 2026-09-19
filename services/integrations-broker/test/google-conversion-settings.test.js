'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { adsFixture, CUSTOMER, MANAGER, ACCESS } = require('./google-ads-fixture.cjs');
const contract = require('../src/google-ads-contract');
const row = () => ({ customer: { id: CUSTOMER, conversionTrackingSetting: { acceptedCustomerDataTerms: true,
  enhancedConversionsForLeadsEnabled: false, googleAdsConversionCustomer: 'customers/'+MANAGER } } });
test('signed settings read is one fixed account query; broker configuration cannot be supplied by Google', async t => {
  const f=adsFixture(t);f.state.response={results:[row()],dataManagerConfiguration:{quotaProjectConfigured:true},private:ACCESS};
  const result=await f.execute('conversion_settings',{});
  assert.deepEqual(result.data,{results:[row()],nextPageToken:null,dataManagerConfiguration:{quotaProjectConfigured:false}});
  assert.equal(f.state.calls.length,1);assert.equal(f.state.calls[0].loginCustomerId,MANAGER);
  assert.equal(f.state.calls[0].json.query,contract.query('conversion_settings',{}));
  assert.match(f.state.calls[0].json.query,/FROM customer LIMIT 2$/);
  assert.equal(result.data.results[0].customer.conversionTrackingSetting.googleAdsConversionCustomer,'customers/'+MANAGER);
  const persisted=JSON.stringify(f.store.db.prepare('SELECT * FROM commands').all())+JSON.stringify(f.store.db.prepare('SELECT * FROM audit_outbox').all());
  assert.doesNotMatch(persisted,/conversionTrackingSetting|acceptedCustomerDataTerms|FICTITIOUS_ADS_ACCESS/);
  f.binding.googleDataManager={quotaProjectId:'fictitious-project',destinations:[{assetRef:'ads:'+CUSTOMER,
    conversionActionId:'456',events:['lead'],sources:['WEB'],enhancedPolicy:null}]};
  // The runtime freezes policy at construction; changing the source fixture
  // must not silently change an already-authorized running broker.
  assert.equal((await f.execute('conversion_settings',{})).data.dataManagerConfiguration.quotaProjectConfigured,false);
  f.broker.policy=structuredClone(require('../src/policy').validatePolicy(f.policy));
  const configured=await f.execute('conversion_settings',{});
  assert.deepEqual(configured.data.dataManagerConfiguration,{quotaProjectConfigured:true});
  assert.doesNotMatch(JSON.stringify(configured),/fictitious-project|FICTITIOUS_ADS_ACCESS/);
});
test('absent provider flags remain null; typed flags and inherited resource owner are not coerced', async t => {
  const f=adsFixture(t);f.state.response={results:[{customer:{id:CUSTOMER}}]};
  assert.deepEqual((await f.execute('conversion_settings',{})).data.results[0].customer.conversionTrackingSetting,
    {acceptedCustomerDataTerms:null,enhancedConversionsForLeadsEnabled:null,googleAdsConversionCustomer:null});
  for(const settings of [{acceptedCustomerDataTerms:'true'},{enhancedConversionsForLeadsEnabled:1},
    {googleAdsConversionCustomer:'customers/0000000000'},{googleAdsConversionCustomer:'customers/123-456-7890'},
    {googleAdsConversionCustomer:{id:CUSTOMER}}]) {
    f.state.response={results:[{customer:{id:CUSTOMER,conversionTrackingSetting:settings}}]};
    await assert.rejects(f.execute('conversion_settings',{}));
  }
});
test('settings rejects arbitrary query, body, cursors and other account before secrets; malformed or paginated output is closed', async t => {
  const f=adsFixture(t);
  for(const input of [{query:'SELECT *'},{customerId:CUSTOMER},{pageToken:null},{headers:{}},{event:{}}])
    await assert.rejects(f.execute('conversion_settings',input),{code:'invalid_request'});
  await assert.rejects(f.execute('conversion_settings',{}, {assetRef:'ads:1111111111'}));assert.equal(f.state.sdk.length,0);
  for(const response of [{results:[]},{results:[row(),row()]},{results:[row()],nextPageToken:'unexpected'},
    {results:[{customer:{id:MANAGER,conversionTrackingSetting:{}}}]},{results:[row()],partialFailureError:{}}]) {
    f.state.response=response;await assert.rejects(f.execute('conversion_settings',{}),{code:'provider_failed'});
  }
});
test('revocation during settings read discards settings and no later settings read reaches secrets', async t => {
  const f=adsFixture(t);f.state.response={results:[row()]};f.state.onRead=()=>f.revoke();
  await assert.rejects(f.execute('conversion_settings',{}));const count=f.state.sdk.length;
  await assert.rejects(f.execute('conversion_settings',{}),{code:'asset_revoked'});assert.equal(f.state.sdk.length,count);
});
