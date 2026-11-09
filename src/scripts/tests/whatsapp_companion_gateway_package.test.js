'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const C=require('../../../services/integrations-broker/src/whatsapp-onboarding-contract');
const P=require('../../../services/integrations-broker/src/whatsapp-provisioning-contract');
const {createWhatsappOnboardingBrokerClient}=require('../../lib/whatsappOnboardingBrokerClient');
const extras=['business_management','ads_management','ads_read','leads_retrieval',
  'pages_show_list','pages_manage_metadata','pages_read_engagement','pages_manage_ads'];
function setup(policy=true){
  const template={appId:'101',configId:'102',redirectUri:'https://example.invalid/callback',
    scopes:['public_profile','whatsapp_business_management','whatsapp_business_messaging'],
    ...(policy?{grantPolicyOverrides:[{scopeKey:'clinic:123',policy:'meta-app-companion-v1'}]}:{})};
  const b=P.publicBinding(template,'clinic:123',[123]);
  const row={requestId:randomUUID(),status:'claimed',scope:{type:'clinic',id:123},clinicIds:[123],
    expiresAt:new Date(Date.now()+600000).toISOString(),scopeDigest:C.hash('FICTITIOUS_GATEWAY_SNAPSHOT'),clinicSetDigest:C.hash('[123]')};
  const state={calls:0,mutate:null};
  const client=createWhatsappOnboardingBrokerClient({guard(){},loadBinding:async()=>b,client:{async execute(command){
    state.calls++;assert.equal(command.operation,C.OPERATIONS.status);
    const candidate={versionId:row.requestId,appId:'101',subjectId:'201',wabaId:'301',phoneId:'401',tokenType:'SYSTEM_USER',
      scopes:[...template.scopes,...extras].sort(),expiresAt:null,dataAccessExpiresAt:null,businessId:'501',grantedWabaIds:['301'],
      providerGrant:{version:1,granularScopes:[...['whatsapp_business_management','whatsapp_business_messaging'].map(scope=>({scope,targetIds:['301']})),
        ...extras.map((scope,i)=>({scope,targetIds:scope==='business_management'?null:[String(900+i)]}))].sort((a,b)=>a.scope.localeCompare(b.scope))}};
    state.mutate?.(candidate);
    return {requestId:command.requestId,replayed:false,data:{flowId:row.requestId,status:'staged',expiresAt:Date.parse(row.expiresAt),expired:false,
      scopeKey:b.scopeKey,scopeDigest:row.scopeDigest,clinicCount:1,clinicSetDigest:row.clinicSetDigest,
      configurationChanged:false,accessBlocked:false,connected:false,channelRole:'primary',candidate}};
  }}});
  return {client,row,state};
}
test('Packaged gateway preserves a scoped complete provider receipt without loading the broker runtime',async()=>{
  const {client,row,state}=setup();const v=await client.status(row);
  assert.equal(v.status,'staged');assert.equal(v.connected,false);assert.equal(v.candidate.scopes.length,11);
  assert.equal(v.candidate.providerGrant.granularScopes.length,10);assert.equal(state.calls,1);
});
test('Packaged gateway rejects malformed or inconsistent WhatsApp authority within provider evidence',async()=>{
  const {client,row,state}=setup();
  for(const mutate of [v=>{delete v.providerGrant},v=>{v.scopes.push('pages_messaging')},
    v=>{v.providerGrant.granularScopes.find(g=>g.scope==='whatsapp_business_messaging').targetIds=['999']},
    v=>{v.grantedWabaIds=['999']}]){
    state.mutate=mutate;await assert.rejects(client.status(row),{code:'whatsapp_onboarding_result_unknown'});
  }
  assert.equal(state.calls,4);
});
test('A provider receipt cannot opt a strict gateway binding into the compatibility policy',async()=>{
  const {client,row}=setup(false);await assert.rejects(client.status(row),{code:'whatsapp_onboarding_result_unknown'});
});
