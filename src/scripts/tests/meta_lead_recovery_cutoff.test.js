'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const R=require('../../lib/metaLeadHistoricalRecovery');
const now=new Date('2026-11-12T14:00:00Z'),created='2026-11-10T10:00:00+0000';
const policy={version:1,scopeKey:'group:29',connectionId:172,before:'2026-11-12T12:00:00Z',
  pages:[{pageId:'100586185397014',clinicId:66},{pageId:'162719417401326',clinicId:72}]};
function fixture(clinicId=66){
  const pageId=clinicId===66?'100586185397014':'162719417401326',event={lead_id:'701',page_id:pageId,form_id:'702',ad_id:'603'};
  const state={assertions:0,current:{page:{id:pageId,scopeKey:'group:29',connectionId:172},account:{scopeKey:'group:29',connectionId:172},route:{recipientClinicId:clinicId}}};
  const input={event,clinic:{id_clinica:clinicId,grupoClinicaId:29},transaction:{LOCK:{UPDATE:'UPDATE'}},recoveredAt:now,
    env:{META_MARKETING_LEAD_RECOVERY_CUTOFF_POLICY:JSON.stringify(policy)},retrieved:{connectionId:172,lead:{id:'701',form_id:'702',ad_id:'603',created_time:created},
      authority:{assert:async options=>{assert.equal(options.transaction,input.transaction);state.assertions++;return state.current;}}}};
  return {state,input,event};
}
for(const clinicId of [66,72])test(`late signed receipt policy creates a system denial only for the exact clinic ${clinicId}`,async()=>{
  const f=fixture(clinicId),proof=await R.forLateProviderReceipt(f.input),marker=R.forPersistence(proof,f.event,clinicId,created);
  assert.equal(marker.source,'late_provider_receipt');assert.equal(marker.actor_kind,'system');assert.equal(marker.actor_user_id,null);
  assert.equal(marker.automatic_messages,'suppressed');assert.equal(marker.cutoff_before,'2026-11-12T12:00:00.000Z');assert.match(marker.policy_digest,/^[a-f0-9]{64}$/);
  const rows=[{raw_payload:{provider:'meta_leadgen',lead_id:'701',provider_created_at:created},attribution_steps:{meta_historical_recovery:marker}}];
  assert.equal(await R.suppressesAutomaticReply({LeadAttributionAudit:{findAll:async()=>JSON.parse(JSON.stringify(rows))}},
    {id:1,clinica_id:clinicId,external_source:'meta_leadgen',external_id:'701'}),true);
  // A persisted denial remains valid after the runtime policy is removed.
  f.input.env={};assert.equal(await R.forLateProviderReceipt(f.input),null);
});
test('absent policy and other connections do not change admission or ordinary data',async()=>{
  const f=fixture();f.input.env={};assert.equal(await R.forLateProviderReceipt(f.input),null);assert.equal(f.state.assertions,0);
  f.input.env={META_MARKETING_LEAD_RECOVERY_CUTOFF_POLICY:JSON.stringify(policy)};f.state.current.page.connectionId=999;
  assert.equal(await R.forLateProviderReceipt(f.input),null);
});
test('fresh and exact-cutoff leads remain ordinary; impossible, ambiguous and future native dates are denied',async()=>{
  const f=fixture();for(const value of ['2026-11-12T12:00:00Z','2026-11-12T13:00:00Z']){
    f.input.retrieved.lead.created_time=value;assert.equal(await R.forLateProviderReceipt(f.input),null);
  }
  for(const value of ['12/11/2026','2026-02-31T10:00:00Z','2026-11-12T15:00:00Z']){
    f.input.retrieved.lead.created_time=value;await assert.rejects(R.forLateProviderReceipt(f.input),/proof_invalid/);
  }
});
test('policy cannot expand scope, change clinic routing, impersonate a human or be injected as a JSON proof',async()=>{
  for(const patch of [{scopeKey:'group:28'},{connectionId:171},{before:'2026-11-13T00:00:00Z'},
    {pages:[policy.pages[0]]},{pages:[policy.pages[0],policy.pages[0]]},{allow:true}])assert.throws(()=>R.cutoffPolicy(JSON.stringify({...policy,...patch}),now),/cutoff_invalid/);
  const f=fixture();f.state.current.route.recipientClinicId=72;await assert.rejects(R.forLateProviderReceipt(f.input),/proof_invalid/);
  assert.throws(()=>R.issue({actorId:null,actorKind:'system',clinicId:66,event:f.event,source:'late_provider_receipt',providerCreatedAt:created,recoveredAt:now}),/proof_invalid/);
  assert.throws(()=>R.forPersistence({actor_kind:'system',source:'late_provider_receipt'},f.event,66,created),/proof_invalid/);
});
