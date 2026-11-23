'use strict';
require('./fixtures/security_offline_runtime.cjs');
const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { GA_OPERATION } = require('../../../services/integrations-broker/src/google-property-discovery-contract');
const { createAnalyticsFirstReader, createAnalyticsRoutedClient } = require('../../services/analyticsBroker.service');
const C = require('../../services/googleOAuthCohort.contract');
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
  assert.deepEqual(commands,[{payload:command,budget:{timeoutMs:15000}}]);
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
  const state = { record,allowed:true,historyReads:0,authorityChecks:0,legacyStarts:0 };
  const transaction = { LOCK:{UPDATE:'UPDATE'} };
  const models = {
    GoogleOAuthBrokerBinding:{},
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
    './googleOAuthCohort.contract':C,'../../services/platform-audit/src/event':require('../../../services/platform-audit/src/event'),
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
  const input = {binding,scopeKey:context.scopeKey,actorId:71,sessionRef:randomUUID(),sessionExpiresAt:Date.parse('2099-01-01')/1000};
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
