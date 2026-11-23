'use strict';
require('./fixtures/security_offline_runtime.cjs');
const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { GA_OPERATION,GA_ADMISSION_PROOF } = require('../../../services/integrations-broker/src/google-property-discovery-contract');
const { createAnalyticsFirstReader, createAnalyticsRoutedClient } = require('../../services/analyticsBroker.service');
const C = require('../../services/googleOAuthCohort.contract');
const Intent=require('../../services/googleOAuthAdmissionAttempt.contract'),Recovery=require('../../services/googleOAuthAdmissionRecovery.contract');
const { loadDiscoverySource } = require('./fixtures/business_profile_discovery.fixture');
const reference = 'google-first:analytics:group:11';
const discovered = { name:'properties/321',displayName:'Fictitious\u200f property',propertyType:'PROPERTY_TYPE_ORDINARY',
  account:'accounts/17',parent:'accounts/17' };
const command = { operation:GA_OPERATION,connectionRef:reference,tenantRef:'clinic:31',assetRef:'ga4:321',payload:{} };
const context = { attemptId:randomUUID(),scopeKey:'group:11',service:'analytics',clinicIds:[17,31] };
const receipt = { attemptId:context.attemptId,scopeKey:context.scopeKey,service:context.service,assetRef:'ga4:321',
  clinicId:31,mode:'provisioned',secretVersion:context.attemptId,connectionRef:reference,status:'confirmed_resource_access' };
const mockEnvironment = () => ({
  RUNTIME_ROLE:'api',JOB_RUNTIME_NAMESPACE:'staging',GOOGLE_ANALYTICS_BROKER_ENABLED:'true',GOOGLE_ANALYTICS_FIRST_READER_ENABLED:'true',
  GOOGLE_ANALYTICS_FIRST_READER_ORIGIN:'https://qa.invalid:8461',GOOGLE_ANALYTICS_FIRST_READER_KEY_ID:'fictitious-ga4-reader',
  GOOGLE_ANALYTICS_FIRST_READER_KEY_FILE:'/fictitious-ga4-reader.pem',GOOGLE_ANALYTICS_FIRST_READER_CA_FILE:'/fictitious-ga4-ca.pem',
});

test('the first reader only proves the selected native GA4 resource under a distinct signer', async () => {
  const commands = [], bytes = Buffer.from('FICTITIOUS_NOT_A_KEY');
  const reader = createAnalyticsFirstReader({ env:mockEnvironment(),readFile:path => path.endsWith('reader.pem') ? bytes : Buffer.from('FICTITIOUS_CA'),
    createClient(config) {
      assert.equal(config.audience,'clinicaclick:google-first-oauth:staging:v1');
      assert.equal(config.keyId,'fictitious-ga4-reader');
      assert.equal(config.privateKey,bytes);
      return { execute:async (payload,budget) => { commands.push({ payload,budget }); return {data:discovered}; } };
    } });
  assert.equal(reader.available(context),true);
  assert(bytes.every(byte => byte === 0));
  assert.deepEqual(await reader.verify({ receipt,context }),{ ...discovered,displayName:'Fictitious property' });
  assert.deepEqual(commands,[{payload:{...command,operation:GA_ADMISSION_PROOF},budget:{timeoutMs:15000}}]);
  for (const patch of [{clinicId:1},{assetRef:'sc:000'},{secretVersion:randomUUID()},{connectionRef:'google-first:analytics:group:19'}]) {
    assert.equal(await reader.verify({ receipt:{...receipt,...patch},context }),false);
  }
  assert.equal(commands.length,1);
});

test('an unavailable or foreign first reader never falls back to ordinary Analytics', () => {
  let ordinaryCalls = 0;
  const reader = createAnalyticsFirstReader({ env:{...mockEnvironment(),GOOGLE_ANALYTICS_FIRST_READER_ENABLED:'false'},
    readFile:() => assert.fail('read unconfigured signing material'),createClient:() => assert.fail('created unconfigured signer') });
  const routed = createAnalyticsRoutedClient(reader,{execute(){ordinaryCalls++; return 'ordinary';}});
  assert.equal(reader.available(context),false);
  assert.throws(() => routed.execute(command),{code:'broker_configuration_invalid'});
  assert.throws(() => routed.execute({...command,connectionRef:'google-first:search_console:group:11'}),{code:'broker_binding_invalid'});
  assert.throws(() => routed.execute({...command,connectionRef:'google-first:analytics:clinic:17'}),{code:'broker_binding_invalid'});
  assert.equal(ordinaryCalls,0);
  assert.equal(routed.execute({...command,connectionRef:'registered-analytics'}),'ordinary');
  assert.equal(ordinaryCalls,1);
});

function statusFixture() {
  const authorized = new Date('2026-11-23T03:00:00Z');
  const binding = { google_user_id:'fictitious-ga4-subject',cohort:'analytics',google_connection_id:15,
    connection_ref:reference,asset_ref:'ga4:321',clinica_id:31,scope_key:'connection:15',policy_version:C.POLICY,
    secret_version:context.attemptId,confirmed_at:authorized };
  const record = { attempt_id:context.attemptId,receipt_id:randomUUID(),receipt_digest:'e'.repeat(64),google_connection_id:15,
    scope_key:context.scopeKey,clinic_id:31,service:'analytics',asset_ref:'ga4:321',published_at:new Date(+authorized+1000) };
  const sessionRef=randomUUID(),original={attemptId:context.attemptId,actorId:71,sessionRef,sessionExpiresAt:Date.parse('2099-01-01'),scopeKey:context.scopeKey,clinicIds:context.clinicIds,service:'analytics'};
  const originalAttempt=Intent.prepare(original,new Date(+authorized-1000)),bindingDigest=Intent.bindingDigest(original);
  const effectReceipt={attemptId:context.attemptId,scopeKey:context.scopeKey,service:'analytics',clinicId:31,assetRef:'ga4:321',bindingDigest,
    clinicSetDigest:Recovery.digest(context.clinicIds),receiptId:record.receipt_id,googleUserId:binding.google_user_id,connectionRef:reference,secretVersion:context.attemptId,
    mode:'provisioned',observedAt:+authorized,validUntil:+authorized+60000,status:'confirmed_resource_access'};
  record.receipt_digest=Recovery.digest(effectReceipt);
  const proof={name:'properties/321',displayName:'Fictitious property',propertyType:'PROPERTY_TYPE_ORDINARY',parent:'accounts/17',account:'accounts/17'};
  const effect={attempt_id:context.attemptId,crm_intent_id:randomUUID(),dispatch_request_id:randomUUID(),binding_digest:bindingDigest,actor_user_id:71,
    session_ref_hash:Intent.sessionHash(sessionRef),session_expires_at:new Date(original.sessionExpiresAt),scope_key:context.scopeKey,clinic_ids:JSON.stringify(context.clinicIds),
    clinic_digest:Recovery.digest(context.clinicIds),service:'analytics',clinic_id:31,asset_ref:'ga4:321',selection_digest:Recovery.selection(original,{clinicId:31,assetRef:'ga4:321'}).digest,
    attempt_requested_at:originalAttempt.requested_at,attempt_expires_at:originalAttempt.expires_at,google_user_id:binding.google_user_id,
    subject_digest:require('../../../services/integrations-broker/src/google-property-discovery-contract').firstAnalyticsSubjectDigest(binding.google_user_id),claim_digest:'a'.repeat(64),
    scope_lock:null,subject_lock:null,state:'published',revision:5,generation:1,lease_token:null,lease_until:null,
    owner_observation:null,owner_observation_digest:null,owner_receipt:require('../../../services/integrations-broker/src/canonical').canonical(effectReceipt),owner_receipt_digest:record.receipt_digest,
    native_resource:require('../../../services/integrations-broker/src/canonical').canonical(proof),native_resource_digest:Recovery.digest(proof),sql_publication_digest:Recovery.publicationDigest(record),
    last_error:null,created_at:authorized,updated_at:record.published_at,completed_at:record.published_at};
  const ack={attemptId:context.attemptId,scopeKey:context.scopeKey,service:'analytics',crmIntentId:effect.crm_intent_id,clinicId:31,assetRef:'ga4:321',secretVersion:context.attemptId,
    state:'published',receiptId:record.receipt_id,receiptDigest:record.receipt_digest,receipt:null};
  effect.owner_observation=require('../../../services/integrations-broker/src/canonical').canonical(ack);effect.owner_observation_digest=Recovery.digest(ack);Recovery.record(effect);
  const state = { record,effect,allowed:true,historyReads:0,authorityChecks:0,legacyStarts:0 };
  const transaction = { LOCK:{UPDATE:'UPDATE'} };
  const models = {
    GoogleOAuthBrokerBinding:{},
    GoogleOAuthAdmissionRecovery:{async findByPk(){return state.effect;}},
    GoogleOAuthBrokerRequest:{async findOne(){state.legacyStarts++; return null;}},
    GoogleOAuthAdmissionPublication:{async findByPk(id,options){
      state.historyReads++;
      assert.equal(id,context.attemptId);
      assert.equal(options.transaction,transaction);
      assert.equal(options.lock,transaction.LOCK.UPDATE);
      return state.record;
    }},
    sequelize:{async transaction(_options,work){return work(transaction);}},
  };
  const {createGoogleOAuthBroker} = loadDiscoverySource('services/googleOAuthBroker.service.js',{
    'node:crypto':require('node:crypto'),'sequelize':require('sequelize'),
    './googleOAuthAdmissionRecovery.contract':Recovery,'./googleOAuthCohort.contract':C,'../../services/platform-audit/src/event':require('../../../services/platform-audit/src/event'),
    './googleOAuthBrokerScope.service':{
      fail(code,httpStatus){throw Object.assign(Error(code),{code,httpStatus});},
      async authorize(input){
        state.authorityChecks++;
        assert.equal(input.requestScopeKey,context.scopeKey);
        if (!state.allowed) throw Object.assign(Error('forbidden'),{code:'google_oauth_scope_forbidden'});
        return {binding:input.binding,clinicIds:context.clinicIds};
      },
    },
  });
  const service = createGoogleOAuthBroker({models,client:{execute:() => assert.fail('status called a provider')},
    audit:{},enabled:() => true,now:() => new Date(+authorized+60000)});
  const input = {binding,scopeKey:context.scopeKey,actorId:71,sessionRef,sessionExpiresAt:Date.parse('2099-01-01')/1000};
  return { service,input,binding,state };
}

test('ordinary scoped status after reload recognizes the exact first GA4 publication without reading Google', async () => {
  const f = statusFixture();
  const status = await f.service.status(f.input);
  assert.equal(status.authorization_status,'active');
  assert.equal(status.activation_confirmed,true);
  assert.equal(status.google_service,'analytics');
  assert.equal(status.enabled,false);
  assert.equal(status.connected,false);
  assert.equal(f.state.legacyStarts,0);
  await assert.rejects(f.service.begin({...f.input,returnTo:'https://crm.clinicaclick.com'}),{code:'google_oauth_disabled'});
  assert.equal(f.state.legacyStarts,0);
});

test('first GA4 publication does not appear active after authorization denial or inconsistent local receipt', async () => {
  const f = statusFixture();
  f.state.allowed = false;
  await assert.rejects(f.service.status(f.input),{code:'google_oauth_scope_forbidden'});
  assert.equal(f.state.historyReads,0);
  f.state.allowed = true;
  f.state.record = {...f.state.record,clinic_id:17};
  await assert.rejects(f.service.status(f.input),{code:'google_oauth_scope_conflict'});
  f.state.record = null;
  await assert.rejects(f.service.status(f.input),{code:'google_oauth_scope_conflict'});
  const previous = await f.service.status({...f.input,binding:{...f.binding,connection_ref:'registered-analytics'}});
  assert.equal(previous.authorization_status,'none');
  assert.equal(f.state.legacyStarts,1);
});


test('normal Settings status remains pending while SQL exists without persisted exact Owner ACK',async()=>{
 const f=statusFixture();f.state.effect={...f.state.effect,state:'sql_committed',completed_at:null,lease_token:randomUUID(),lease_until:new Date('2099-01-01'),
  scope_lock:Recovery.scopeLock(context.scopeKey),subject_lock:Recovery.subjectLock(f.state.effect.subject_digest)};
 let status=await f.service.status(f.input);assert.equal(status.activation_confirmed,false);assert.equal(status.authorization_status,'processing');assert.equal(status.pending,true);assert.equal(status.connected,false);
 f.state.effect=null;status=await f.service.status(f.input);assert.equal(status.activation_confirmed,false);assert.equal(status.authorization_status,'processing');
});
