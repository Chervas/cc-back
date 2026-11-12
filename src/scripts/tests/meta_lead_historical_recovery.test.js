'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
require('./fixtures/campaign_offline_runtime.cjs');
const {createHistoricalRecovery,optionsFromPlan,normalizeInput}=require('../../services/metaLeadHistoricalRecovery.service');
const proofs=require('../../lib/metaLeadHistoricalRecovery');
const reception=require('../../services/metaLeadReception.service');
const input={actorId:99,clinicIds:[66,72],pageAssetId:31,accountAssetId:32,formId:'702',runtime:'staging',startDate:'2026-11-08',endDate:'2026-11-12',
  startInstant:'2026-11-08T23:00:00Z',endInstant:'2026-11-12T12:00:00Z'};
const form={version:2,formId:'702',name:'Fictitious form',fields:[{key:'email',label:'Email',type:'EMAIL',values:['qa@example.invalid']}]};
function fixture(){
  const state={events:[],calls:[],leads:new Map(),writes:0,authorized:true,persistError:null,journalError:null,afterRead:null,
    entries:[{leadId:'701',formId:'702',adId:'603',campaignId:'601',createdTime:'2026-11-10T10:00:00+0000',isOrganic:false,proof:'OPAQUE_PRIVATE_PROVIDER_PROOF'}]};
  const context={page:{id:'401',mappingId:31,scopeKey:'group:29',clinicIds:[66,72],connectionId:172,credentialEpoch:1,credentialVersionId:'11111111-1111-4111-8111-111111111111'},
    account:{id:'301',mappingId:32,scopeKey:'group:29'},route:{recipientClinicId:66}};
  const models={LeadIntake:{findOne:async({where})=>state.leads.get(where.external_id)||null},JobRequest:{findByPk:async id=>state.jobs?.get(id)}};
  const response=(id='701')=>({event:{lead_id:id,page_id:'401',form_id:'702',ad_id:'603'},recipientClinicId:66,
    identity:{account_id:'301',campaign_id:'601',ad_id:'603',adset_id:'602'},form_response:form,
    lead:{id,form_id:'702',ad_id:'603',campaign_id:'601',created_time:state.createdTime||'2026-11-10T10:00:00+0000',
      field_data:state.noContact?[]:[{name:'email',values:['qa@example.invalid']},{name:'full_name',values:['FICTITIOUS PERSON']}]}});
  const reader={preparePair:async()=>context,assertPair:async()=>context,read:async(_pair,name,payload)=>{
    state.calls.push(name);if(state.listError&&name==='recoveryList')throw state.listError;
    if(name==='recoveryList')return {results:state.entries,nextCursor:state.nextCursor??null};
    assert.equal(name,'recoveryRead');assert.equal(payload.proof,'OPAQUE_PRIVATE_PROVIDER_PROOF');
    const result=response();await state.afterRead?.();return result;
  }};
  const retrieve=async({event})=>{state.calls.push('receiptRead');const result=response(event.lead_id);await state.afterRead?.();return {
    lead:result.lead,clinic:{id_clinica:66},responseVersion:2,formResponse:form,authority:{assert:async()=>context}};};
  const service=createHistoricalRecovery({models,reader,retrieve,resolveClinic:async()=>({id_clinica:66}),authorize:async()=>state.authorized,
    journal:async event=>{if(state.journalError===event.phase)throw Error('disk unavailable');state.events.push(event);},now:()=>new Date('2026-11-12T14:00:00Z'),
    persist:async({event,retrieved,recoveryProof})=>{
      assert.equal(state.events.at(-1).phase,'persist_intent');await retrieved.authority.assert({transaction:{LOCK:{UPDATE:'UPDATE'}}});
      if(state.persistError)throw state.persistError;
      reception.contactFields(retrieved.lead);const marker=proofs.forPersistence(recoveryProof,event,66,retrieved.lead.created_time),old=state.leads.get(event.lead_id);
      if(old)return {lead:old,duplicate:true};state.writes++;state.leads.set(event.lead_id,{id:state.writes,clinica_id:66,marker});return {duplicate:false};
    }});
  return {state,models,context,reader,service,response};
}
async function scan(f,extra={}){return f.service.run({...input,...extra});}
async function apply(f,plan){return f.service.run(optionsFromPlan(plan));}
test('scan reads metadata only, pins the Madrid cutoff and writes no provider proof/contact into its private plan',async()=>{
  const f=fixture();f.state.entries.unshift({...f.state.entries[0],leadId:'700',createdTime:'2026-11-08T10:00:00+0000'});
  const plan=await scan(f);assert.equal(plan.complete,true);assert.equal(plan.observed,2);assert.equal(plan.ignoredOutsideWindow,1);
  assert.deepEqual(plan.results,[{externalId:'701',source:'provider_form_recovery',status:'missing'}]);
  assert.deepEqual(f.state.calls,['recoveryList']);assert.equal(f.state.writes,0);
  assert.equal(plan.input.startInstant,'2026-11-08T23:00:00.000Z');assert.equal(plan.input.timeZone,'Europe/Madrid');assert.equal(plan.input.providerDayBasis,'UTC');
  for(const text of ['OPAQUE_PRIVATE_PROVIDER_PROOF','qa@example.invalid','FICTITIOUS PERSON'])assert(!JSON.stringify(plan).includes(text));
});
test('apply recovers only the pinned IDs and atomically marks them; repetition preserves original history and has no read/reply side effect',async()=>{
  const f=fixture(),plan=await scan(f);const result=await apply(f,plan);
  assert.equal(result.results[0].status,'recovered');assert.equal(f.state.writes,1);assert.equal(f.state.leads.get('701').marker.automatic_messages,'suppressed');
  assert.equal(f.state.events.filter(e=>e.phase==='persist_intent').length,1);assert.equal(f.state.events.filter(e=>e.phase==='persist_result').length,1);
  const original=JSON.stringify(f.state.leads.get('701')),before=f.state.calls.filter(v=>v==='recoveryRead').length;
  const duplicate=await apply(f,plan);assert.equal(duplicate.results[0].status,'already_present');assert.equal(f.state.writes,1);
  assert.equal(JSON.stringify(f.state.leads.get('701')),original);assert.equal(f.state.calls.filter(v=>v==='recoveryRead').length,before);
  assert.equal(result.messagesSent,0);assert.equal(duplicate.messagesSent,0);
});
test('a different epoch/scope cannot apply an old plan and unplanned new provider IDs are not imported',async()=>{
  const f=fixture(),plan=await scan(f);f.state.entries.push({...f.state.entries[0],leadId:'703',proof:'OTHER_PRIVATE_PROOF'});
  const result=await apply(f,plan);assert.deepEqual(result.results.map(v=>v.externalId),['701']);assert.equal(f.state.leads.has('703'),false);
  const other=fixture(),old=await scan(other);other.context.page.credentialEpoch=2;const before=other.state.calls.length;
  await assert.rejects(apply(other,old),{code:'meta_lead_recovery_scope_changed'});assert.equal(other.state.calls.length,before);assert.equal(other.state.writes,0);
});
test('pagination must finish within bounds before any INSERT; duplicates and circular cursors fail closed',async()=>{
  for(const mode of ['duplicate','circular','limit']){
    const f=fixture(),plan=await scan(f);
    if(mode==='duplicate')f.state.entries.push({...f.state.entries[0]});
    else{f.state.nextCursor='REPEATED_PRIVATE_CURSOR';if(mode==='limit')f.state.entries=[];}
    await assert.rejects(apply(f,plan));assert.equal(f.state.writes,0);assert.equal(f.state.calls.includes('recoveryRead'),false);
  }
});
test('known failed jobs use their existing receipt; contactless data remains unavailable and outside-window jobs are not imported',async()=>{
  for(const mode of ['valid','contactless','outside','unknown_ad']){
    const f=fixture();f.state.entries=[];f.state.jobs=new Map([[88,{id:88,type:reception.JOB_TYPE,status:'failed',payload:{lead_id:'701',page_id:'401',form_id:'702',ad_id:'603',
      page_asset_id:31,account_asset_id:32,receipt_ref:'11111111-1111-4111-8111-111111111111',__runtime_namespace:'staging'}}]]);
    if(mode==='contactless')f.state.noContact=true;if(mode==='outside')f.state.createdTime='2026-11-08T10:00:00Z';
    if(mode==='unknown_ad'){f.state.jobs.get(88).payload.ad_id=null;f.state.entries=[{...fixture().state.entries[0]}];}
    const plan=await scan(f,{acceptedJobIds:[88]});assert.equal(plan.results[0].source,'accepted_receipt');
    const result=await apply(f,plan);assert(f.state.calls.includes('receiptRead'));assert(!f.state.calls.includes('recoveryRead'));
    if(mode==='valid'||mode==='unknown_ad'){assert.equal(result.results[0].status,'recovered');assert.equal(f.state.leads.get('701').marker.source,'accepted_receipt');}
    else{assert.equal(f.state.writes,0);assert.equal(result.complete,false);assert.equal(result.results[0].status,mode==='outside'?'outside_window':'unavailable');
      if(mode==='contactless')assert.equal(result.results[0].code,'meta_lead_contact_unavailable');}
  }
});
test('a fresh verification or scope denial stops recovery without guessing contact, routes, ownership or consent',async()=>{
  const f=fixture(),plan=await scan(f);f.state.afterRead=()=>{f.state.authorized=false;};
  const result=await apply(f,plan);assert.equal(result.stopped,true);assert.equal(result.results[0].code,'meta_lead_recovery_forbidden');assert.equal(f.state.writes,0);
  const foreign=fixture(),otherPlan=await scan(foreign);foreign.state.leads.set('701',{id:1,clinica_id:999});
  const denied=await apply(foreign,otherPlan);assert.equal(denied.complete,false);
  assert.equal(denied.results[0].code,'meta_lead_existing_scope_mismatch');assert.equal(foreign.state.writes,0);
  const otherSite=fixture(),sameGroupPlan=await scan(otherSite);otherSite.state.leads.set('701',{id:1,clinica_id:72});
  const mismatched=await apply(otherSite,sameGroupPlan);assert.equal(mismatched.results[0].code,'meta_lead_existing_scope_mismatch');
  assert.equal(otherSite.state.writes,0);assert.equal(otherSite.state.leads.get('701').clinica_id,72);
});
test('journal failure before persist prevents INSERT; lost result ACK leaves an explicit unknown outcome and safe idempotent reconciliation',async()=>{
  for(const phase of ['persist_intent','persist_result']){
    const f=fixture(),plan=await scan(f);f.state.journalError=phase;const result=await apply(f,plan);
    assert.equal(result.complete,false);assert.equal(result.stopped,true);
    if(phase==='persist_intent'){assert.equal(f.state.writes,0);assert.equal(result.results[0].status,'unavailable');}
    else{assert.equal(f.state.writes,1);assert.equal(result.results[0].status,'outcome_unknown');assert.equal(f.state.events.at(-1).phase,'persist_intent');
      f.state.journalError=null;const reconciled=await apply(f,plan);assert.equal(reconciled.results[0].status,'already_present');assert.equal(f.state.writes,1);}
  }
});
test('a later lookup or final journal failure preserves already committed results for reconciliation',async()=>{
  const f=fixture();f.state.entries.push({...f.state.entries[0],leadId:'703'});const plan=await scan(f),original=f.models.LeadIntake.findOne;
  f.models.LeadIntake.findOne=async options=>{if(options.where.external_id==='703')throw Error('SQL unavailable');return original(options);};
  const partial=await apply(f,plan);assert.equal(partial.complete,false);assert.equal(partial.results[0].status,'recovered');
  assert.equal(partial.results[1].status,'unavailable');assert.equal(f.state.writes,1);
  const last=fixture(),other=await scan(last);last.state.journalError='finished';const closed=await apply(last,other);
  assert.equal(closed.complete,false);assert.equal(closed.journalUnavailable,true);assert.equal(closed.results[0].status,'recovered');
  assert.equal(last.state.writes,1);assert.equal(last.state.events.at(-1).phase,'persist_result');
});
test('invalid windows, unpinned apply, wrong namespaces and running jobs cannot cause provider writes',async()=>{
  assert.throws(()=>normalizeInput({...input,startInstant:'2026-11-08T22:00:00Z',endInstant:'2026-11-08T21:00:00Z'}));
  assert.throws(()=>normalizeInput({...input,startInstant:'2026-11-31T00:00:00Z'}));
  const f=fixture();await assert.rejects(f.service.run({...input,apply:true,expectedLeadIds:['701']}));assert.equal(f.state.calls.length,0);
  for(const patch of [{status:'running'},{payload:{__runtime_namespace:'dev'}}]){
    f.state.jobs=new Map([[88,{id:88,type:reception.JOB_TYPE,status:'failed',payload:{lead_id:'701',page_id:'401',form_id:'702',ad_id:'603',page_asset_id:31,account_asset_id:32,
      receipt_ref:'11111111-1111-4111-8111-111111111111',__runtime_namespace:'staging'},...patch}]]);
    await assert.rejects(scan(f,{acceptedJobIds:[88]}));assert.equal(f.state.calls.length,0);
  }
});
