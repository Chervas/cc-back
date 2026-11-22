'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createSearchConsoleBroker,createSearchConsoleFirstReader } = require('../../services/searchConsoleBroker.service');
const { site } = require('../../../services/integrations-broker/src/google-search-console-contract');

const resource = site('sc-domain:fictitious-reader.example');
const scopeKey = 'group:29';
const attemptId = randomUUID();
const scope = { attemptId,scopeKey,service:'search_console',clinicIds:[66,72] };
const receipt = { attemptId,service:'search_console',scopeKey,clinicId:72,mode:'provisioned',secretVersion:attemptId,
  connectionRef:'google-first:search_console:'+scopeKey,assetRef:resource.assetRef,status:'confirmed_resource_access',
  resource:{ siteUrl:resource.siteUrl,permissionLevel:'siteOwner' } };
const discovery = { operation:'google.search_console.discovery.read.v1',connectionRef:receipt.connectionRef,
  assetRef:resource.assetRef,tenantRef:'clinic:72',payload:{} };

const goodEnv = {
  RUNTIME_ROLE:'api',JOB_RUNTIME_NAMESPACE:'staging',GOOGLE_SEARCH_CONSOLE_BROKER_ENABLED:'true',
  GOOGLE_SEARCH_CONSOLE_FIRST_READER_ENABLED:'true',GOOGLE_SEARCH_CONSOLE_FIRST_READER_ORIGIN:'https://first.example.invalid/',
  GOOGLE_SEARCH_CONSOLE_FIRST_READER_KEY_ID:'first-sc-reader',
  GOOGLE_SEARCH_CONSOLE_FIRST_READER_KEY_FILE:'/etc/first/reader.key',GOOGLE_SEARCH_CONSOLE_FIRST_READER_CA_FILE:'/etc/first/ca.pem',
};

test('the dedicated native reader is absent by default and cannot run from another namespace', () => {
  const never = () => assert.fail('unexpected signer or key access');
  const disabled = createSearchConsoleFirstReader({ env:{},readFile:never,createClient:never });
  assert.equal(disabled.available(scope),false);
  assert.throws(() => disabled.execute(discovery),{ code:'broker_configuration_invalid' });
  const gateway = createSearchConsoleFirstReader({ env:{ ...goodEnv,RUNTIME_ROLE:'gateway' },readFile:never,createClient:never });
  assert.throws(() => gateway.available(scope),{ code:'broker_configuration_invalid' });
});

function fixture(t) {
  const key = Buffer.from('FICTITIOUS_NATIVE_READER_KEY');
  const requests = [];
  const state = { permissionLevel:'siteOwner' };
  const reader = createSearchConsoleFirstReader({
    env:goodEnv,
    readFile(filename) { return filename === goodEnv.GOOGLE_SEARCH_CONSOLE_FIRST_READER_KEY_FILE ? key : Buffer.from('FICTITIOUS_CA'); },
    createClient(params) {
      assert.equal(params.privateKey,key);
      assert.equal(params.keyId,goodEnv.GOOGLE_SEARCH_CONSOLE_FIRST_READER_KEY_ID);
      assert.equal(params.audience,'clinicaclick:google-first-oauth:staging:v1');
      return { async execute(command,options) {
        requests.push({ command,options });
        return { data:{ siteUrl:resource.siteUrl,permissionLevel:state.permissionLevel } };
      } };
    },
  });
  t.after(() => assert(key.every(byte => byte === 0)));
  return { reader,requests,state };
}

test('pre-publication verification uses the exact ordinary discovery operation and requires the approved tenant/version', async t => {
  const { reader,requests,state } = fixture(t);
  assert.equal(reader.available(scope),true);
  assert.equal(await reader.verify({ receipt:{ ...receipt,clinicId:67 },context:scope }),false);
  assert.equal(await reader.verify({ receipt:{ ...receipt,secretVersion:randomUUID() },context:scope }),false);
  assert.equal(await reader.verify({ receipt:{ ...receipt,mode:'reuse' },context:scope }),false);
  assert.equal(requests.length,0);
  assert.equal(await reader.verify({ receipt,context:scope }),true);
  assert.deepEqual(requests[0],{ command:discovery,options:{ timeoutMs:15000 } });
  state.permissionLevel = 'siteFullUser';
  assert.equal(await reader.verify({ receipt,context:scope }),false);
  assert.throws(() => reader.execute({ ...discovery,connectionRef:'google-first:search_console:clinic:66' }),{ code:'broker_binding_invalid' });
  assert.throws(() => reader.execute({ ...discovery,operation:'google.search_console.asset.revoke.v1' }),{ code:'broker_binding_invalid' });
});

test('the ordinary mapped reader signs the same discovery call and enforces its database tombstone', async t => {
  const { reader,requests } = fixture(t);
  const row = { id:3,clinicaId:72,googleConnectionId:61,siteUrl:resource.siteUrl,isActive:true,
    broker_read_connection_ref:receipt.connectionRef,broker_read_asset_ref:resource.assetRef };
  let current = row;
  const service = createSearchConsoleBroker({
    client:reader,enabled:() => true,loadMapping:async () => current,loadRevocations:async () => [],
    loadConnection:async () => ({ id:61,googleUserId:'fictitious-new-subject',credentials_external:1 }),
    loadBindings:async () => [{ site_hash:resource.siteHash,site_url:resource.siteUrl,mapping_id:3,connection_ref:receipt.connectionRef,
      asset_ref:resource.assetRef,clinica_id:72,google_connection_id:61,google_user_id:'fictitious-new-subject',state:'active' }],
  });
  const bound = await service.prepare(row);
  assert.deepEqual(await service.read(row,bound,'discovery',{}),{ data:receipt.resource });
  assert.deepEqual(requests[0].command,discovery);
  current = { ...row,isActive:false };
  await assert.rejects(service.read(row,bound,'discovery',{}),{ code:'broker_binding_invalid' });
  assert.equal(requests.length,1);
});
