'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const ROOT=require('node:path').resolve(__dirname,'../../..');
const {createMetaMarketingBrokerScope}=require(ROOT+'/src/services/metaMarketingBrokerScope.service');
const {createMetaMarketingAdsReader}=require(ROOT+'/src/services/metaMarketingAdsReader.service');
const E='00000001-1111-4111-8111-111111111111',F='00000002-1111-4111-8111-111111111111';
function fixture(){
 const state={callbacks:0,io:0,mutate:null},mapping={id:1,metaConnectionId:2,assetType:'ad_account',metaAssetId:'act_301',assignmentScope:'group',clinicaId:null,grupoClinicaId:5,isActive:true,credentials_absent:1};
 const binding={mapping_id:1,enrollment_id:E,asset_ref:'meta-ad_account:301',meta_connection_id:2,meta_user_id:'201',app_id:'101',connection_ref:'meta:fixture',scope_key:'group:5',tenant_clinic_id:11,parent_page_id:null,state:'active'};
 const scope=createMetaMarketingBrokerScope({enabled:()=>true,loadMapping:async()=>mapping,loadBindings:async()=>[binding],loadRevocations:async()=>[],loadMappings:async()=>[mapping],loadClinics:async()=>[{id_clinica:11,grupoClinicaId:5}],loadShared:async()=>[],loadPrimaryGroups:async()=>[],
  inspectEnrollment:async()=>({enrollmentId:E,flowId:F,mappingIds:[1],clinicIds:[11],digest:'a'.repeat(64),credential:{epoch:0,versionId:F}}),loadGrants:async()=>[{assignmentScope:'group',grupoClinicaId:5,metaConnectionId:2,status:'active'}],loadConnection:async()=>({id:2,metaUserId:'201',broker_app_id:'101',credentials_external:1,credentials_absent:1}),blocked:async()=>false,
  inspectInTransaction:async(captured,transaction)=>{state.callbacks++;state.transaction=transaction;if(state.mutate)state.mutate(captured);return captured;}});
 const reader=createMetaMarketingAdsReader({scope,enabled:()=>true,client:{execute:async()=>{state.io++;assert.fail('No broker inside SQL');}}});return{scope,reader,state};
}
test('source assertion forwards the exact live caller transaction without provider I/O',async()=>{const f=fixture(),source=await f.reader.sourceForAsset(1),tx={LOCK:{UPDATE:'UPDATE'}};await source.assert({transaction:tx});assert.equal(f.state.transaction,tx);assert.equal(f.state.callbacks,1);assert.equal(f.state.io,0);});
test('malformed transaction options never fall back to an independent transaction',async()=>{const f=fixture(),source=await f.reader.sourceForAsset(1);for(const options of[null,{}, {transaction:undefined},{transaction:null},{transaction:{LOCK:{UPDATE:'UPDATE'}},extra:true}])await assert.rejects(source.assert(options),{code:'invalid_request'});assert.equal(f.state.callbacks,0);});
test('unregistered context and finished/nonlocking transactions cannot enter the transactional inspector',async()=>{const f=fixture(),context=await f.reader.prepare(1);for(const transaction of[{}, {LOCK:{UPDATE:'UPDATE'},finished:'commit'}])await assert.rejects(f.scope.assertContext(context,{transaction}),{code:'meta_broker_binding_invalid'});await assert.rejects(f.scope.assertContext({}, {transaction:{LOCK:{UPDATE:'UPDATE'}}}),{code:'meta_broker_binding_invalid'});assert.equal(f.state.callbacks,0);});
test('epoch, grant, identity, physical and registry drift is rejected after the full transaction inspection',async()=>{for(const field of ['credentialEpoch','enrollmentHash','assetRef','subjectId','registryHash','mappingsHash','grantsHash','clinicsHash']){const f=fixture(),source=await f.reader.sourceForAsset(1);f.state.mutate=captured=>{captured[field]=field==='credentialEpoch'?1:'changed';};await assert.rejects(source.assert({transaction:{LOCK:{UPDATE:'UPDATE'}}}),{code:'meta_broker_scope_changed'});assert.equal(f.state.io,0);}});

// Exercise the production forModels transaction registry with closed persistence
// collaborators. The full repository/Binding path is covered by the owned SQL
// regression; these cases reach the bridge's own admission and reservation code.
function modelBridgeFixture({ waitForHint = false } = {}) {
  const fs = require('node:fs'), vm = require('node:vm');
  const filename = require.resolve(ROOT + '/src/services/metaMarketingBrokerReader.service');
  const load = require('node:module').createRequire(filename);
  const state = { hints: 0, locks: 0, brokerCalls: 0 };
  let release;
  const hint = new Promise(resolve => { release = resolve; });
  const order = {
    prepareEnrollment: async () => { state.hints++; if (waitForHint) await hint; return {}; },
    lockPrepared: async () => { state.locks++; },
  };
  const scopeModule = {
    createMetaMarketingScopeRepository: () => ({}),
    createMetaMarketingBrokerScope: options => options.inspectInTransaction ? {
      assertContext: (context, optionsArg) => options.inspectInTransaction(context, optionsArg.transaction),
    } : { prepare: async mappingId => ({ mappingId }), describe: context => context },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, require: name => {
    if (name === './metaMarketingBrokerScope.service') return scopeModule;
    if (name === './metaMarketingTransactionOrder.service') return { createOrder: () => order };
    if (name === '../lib/integrationsBrokerClient') return { createIntegrationsBrokerClient: () => ({ execute: () => { state.brokerCalls++; assert.fail('provider I/O forbidden'); } }) };
    return load(name);
  }, process: { env: {} }, console });
  const models = { sequelize: {} };
  const bridge = module.exports.forModels(models);
  const transaction = { sequelize: models.sequelize, LOCK: { UPDATE: 'UPDATE' }, options: { isolationLevel: 'REPEATABLE READ' } };
  return { bridge, state, transaction, release };
}

test('production forModels rejects alien, closed, nonlocking and non-RR transactions before prefix inspection', async () => {
  const f = modelBridgeFixture(), captured = { mappingId: 1, enrollmentId: E };
  for (const transaction of [
    { ...f.transaction, sequelize: {} },
    { ...f.transaction, finished: 'commit' },
    { ...f.transaction, LOCK: {} },
    { ...f.transaction, options: { isolationLevel: 'READ COMMITTED' } },
  ]) await assert.rejects(f.bridge.assertContext(captured, { transaction }), { code: 'meta_broker_binding_invalid' });
  await assert.rejects(f.bridge.assertContext({ mappingId: 1 }, { transaction: f.transaction }), { code: 'meta_broker_binding_invalid' });
  assert.equal(f.state.hints, 0); assert.equal(f.state.locks, 0); assert.equal(f.state.brokerCalls, 0);
});

test('production forModels reserves one account before awaits and rejects account/enrollment changes without late locks', async () => {
  const f = modelBridgeFixture({ waitForHint: true }), captured = { mappingId: 1, enrollmentId: E, scopeKey: 'group:5', appId: '101' };
  const pending = f.bridge.assertContext(captured, { transaction: f.transaction });
  assert.equal(f.state.hints, 1);
  for (const changed of [{ ...captured, mappingId: 2 }, { ...captured, enrollmentId: F }]) {
    await assert.rejects(f.bridge.assertContext(changed, { transaction: f.transaction }), { code: 'meta_broker_scope_changed' });
  }
  assert.equal(f.state.hints, 1); assert.equal(f.state.locks, 0);
  f.release();
  assert.equal((await pending).mappingId, 1);
  assert.equal((await f.bridge.assertContext(captured, { transaction: f.transaction })).mappingId, 1);
  assert.equal(f.state.hints, 1); assert.equal(f.state.locks, 1); assert.equal(f.state.brokerCalls, 0);
});
