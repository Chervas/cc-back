'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { adsFixture, CUSTOMER, ASSET } = require('./google-ads-fixture.cjs');
const contract = require('../src/google-ads-contract');
const leads = require('../src/google-leads-contract');
const day = offset => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const input = () => ({ sinceDate: day(-7), pageToken: null });
function row(id = 'opaque-lead', patch = {}) {
  return { customer: { id: CUSTOMER }, leadFormSubmissionData: {
    id, resourceName: `customers/${CUSTOMER}/leadFormSubmissionData/${id}`,
    campaign: `customers/${CUSTOMER}/campaigns/200`, asset: `customers/${CUSTOMER}/assets/300`,
    adGroup: `customers/${CUSTOMER}/adGroups/400`, adGroupAd: `customers/${CUSTOMER}/adGroupAds/400~500`,
    gclid: 'FICTITIOUS_CLICK', submissionDateTime: day(0) + ' 00:00:00+00:00',
    leadFormSubmissionFields: [{ fieldType: 'EMAIL', fieldValue: 'FICTIONAL_CONTACT@example.invalid' },
      { fieldType: 'FULL_NAME', fieldValue: 'Fictional Name' }, { fieldType: 'HEALTH_INFO', fieldValue: 'NEVER_RETAIN_CUSTOM_ANSWER' }],
    customLeadFormSubmissionFields: [{ questionText: 'Fictional private question', fieldValue: 'NEVER_RETAIN_CUSTOM_ANSWER' }], ...patch } };
}
test('typed native lead reads pin customer/manager, return basic contact and never persist PII in receipts or audit', async t => {
  const f = adsFixture(t); f.state.response = { results: [row()] };
  const result = await f.execute('leads', input());
  assert.equal(result.data.results[0].leadFormSubmissionData.leadFormSubmissionFields.length, 2);
  assert.match(JSON.stringify(result), /FICTIONAL_CONTACT@example.invalid/);
  assert.doesNotMatch(JSON.stringify(result), /NEVER_RETAIN|customLead|questionText/);
  assert.equal(result.data.nextPageToken, null);
  assert.match(f.state.calls[0].json.query, /SELECT customer.id, lead_form_submission_data.id/);
  assert.match(f.state.calls[0].json.query, /ORDER BY lead_form_submission_data.submission_date_time ASC, lead_form_submission_data.id ASC LIMIT 10001$/);
  assert.doesNotMatch(f.state.calls[0].json.query, /custom_lead_form_submission_fields/);
  const durable = JSON.stringify(f.store.db.prepare('SELECT * FROM commands').all()) + JSON.stringify(f.store.db.prepare('SELECT * FROM audit_outbox').all());
  assert.doesNotMatch(durable, /FICTIONAL_CONTACT|Fictional Name|opaque-lead|FICTITIOUS_CLICK|NEVER_RETAIN/);
  assert(f.store.db.prepare('SELECT result FROM commands').all().every(v => v.result === null));
});
test('ordinary report permission does not imply lead access, and scope or query injection stops before secrets', async t => {
  const f = adsFixture(t);f.broker.policy.grants[0].operations=contract.OPERATIONS.filter(v=>v!=='google.ads.leads.read.v1');
  await assert.rejects(f.execute('leads', input()));assert.equal(f.state.sdk.length,0);
  const g = adsFixture(t);
  for(const patch of [{query:'SELECT *'}, {customerId:CUSTOMER}, {fields:['EMAIL']}, {sinceDate:'2026-02-30'},
    {sinceDate:day(-8)}, {sinceDate:day(1)}])await assert.rejects(g.execute('leads',{...input(),...patch}),{code:'invalid_request'});
  for(const patch of [{assetRef:'ads:9999999999'},{tenantRef:'clinic:999'}])await assert.rejects(g.execute('leads',input(),patch));
  assert.equal(g.state.sdk.length,0);assert.equal(g.state.calls.length,0);
});
test('all resource identities, chronological bounds and consistency are checked before exposing a lead', async t => {
  const f = adsFixture(t);
  for(const patch of [{id:42},{resourceName:`customers/9999999999/leadFormSubmissionData/opaque-lead`},
    {campaign:'customers/9999999999/campaigns/200'},{asset:`customers/${CUSTOMER}/assets/../300`},
    {adGroupAd:`customers/${CUSTOMER}/adGroupAds/401~500`},{adGroup:'foreign'},
    {submissionDateTime:day(-8)+' 00:00:00+00:00'},{submissionDateTime:day(1)+' 12:00:00+00:00'},
    {submissionDateTime:day(0)+' 00:00:00'},{submissionDateTime:'2026-02-30 00:00:00+00:00'}]){
    f.state.response={results:[row('opaque-lead',patch)]};await assert.rejects(f.execute('leads',input()),{code:'provider_failed'});
  }
  f.state.response={results:[{...row(),customer:{id:'9999999999'}}]};await assert.rejects(f.execute('leads',input()),{code:'provider_failed'});
});
test('a bad contact remains an explicit invalid row beside valid leads; custom answers are never retained', async t => {
  const f=adsFixture(t);
  for(const fields of [null,[null],[{fieldType:'EMAIL',fieldValue:42}],Array(101).fill({fieldType:'EMAIL',fieldValue:'a@b.c'}),
    [{fieldType:'EMAIL',fieldValue:'a@b.c'},{fieldType:'EMAIL',fieldValue:'other@b.c'}]]){
    f.state.response={results:[row('good'),row('bad',{leadFormSubmissionFields:fields})]};
    const result=await f.execute('leads',input());assert.equal(result.data.results[1].leadFormSubmissionData.leadFormSubmissionFields,null);
    assert.equal(result.data.results[0].leadFormSubmissionData.leadFormSubmissionFields.length,2);
    assert.doesNotMatch(JSON.stringify(result),/NEVER_RETAIN/);
  }
  assert.deepEqual(leads.project(leads.project(row(),input(),{customerId:CUSTOMER}),input(),{customerId:CUSTOMER}),leads.project(row(),input(),{customerId:CUSTOMER}));
});
test('lead pages are complete and scoped, have a short memory lifetime and are released after consumption', async t => {
  const f=adsFixture(t);f.state.response={results:Array.from({length:501},(_,i)=>row('lead-'+i))};
  const first=await f.execute('leads',input()),token=first.data.nextPageToken;assert.equal(first.data.results.length,250);
  await assert.rejects(f.execute('leads',{...input(),sinceDate:day(-6),pageToken:token}),{code:'invalid_request'});
  const second=await f.execute('leads',{...input(),pageToken:token});assert.equal(second.data.results.length,250);
  const last=await f.execute('leads',{...input(),pageToken:second.data.nextPageToken});assert.equal(last.data.results.length,1);assert.equal(last.data.nextPageToken,null);
  assert.equal(f.state.calls.length,1);
  await assert.rejects(f.execute('leads',{...input(),pageToken:token}),{code:'invalid_request'});
  const again=await f.execute('leads',input());f.advance(60001);
  await assert.rejects(f.execute('leads',{...input(),pageToken:again.data.nextPageToken}),{code:'invalid_request'});
});
test('truncation, duplicate provider identities and malformed pages never become a completed empty sync', async t => {
  const f=adsFixture(t);
  for(const response of [{results:[row(),row()]},{results:Array.from({length:10000},(_,i)=>row('lead-'+i)),nextPageToken:'FICTITIOUS_MORE'},
    {results:[],nextPageToken:'FICTITIOUS_MORE'},{results:'wrong'}]){
    f.state.response=response;await assert.rejects(f.execute('leads',input()),{code:'provider_failed'});
  }
});
test('asset revocation discards cached PII and blocks a response revoked during provider I/O', async t => {
  const f=adsFixture(t);f.state.response={results:Array.from({length:251},(_,i)=>row('lead-'+i))};
  const token=(await f.execute('leads',input())).data.nextPageToken;await f.revoke();const lookups=f.state.sdk.length;
  await assert.rejects(f.execute('leads',{...input(),pageToken:token}),{code:'asset_revoked'});assert.equal(f.state.sdk.length,lookups);
  const g=adsFixture(t);g.state.response={results:[row()]};g.state.onRead=()=>g.revoke();
  await assert.rejects(g.execute('leads',input()));assert.equal(g.state.calls.length,1);
});
test('idle lead contacts are removed by their timer without another request or clock-based pruning', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const f=adsFixture(t);f.state.response={results:Array.from({length:251},(_,i)=>row('idle-'+i))};
  const token=(await f.execute('leads',input())).data.nextPageToken;
  // The fixture's cursor/expiry clock stays unchanged: only the idle timer fires.
  t.mock.timers.tick(60001);
  await assert.rejects(f.execute('leads',{...input(),pageToken:token}),{code:'invalid_request'});
});
