'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID,generateKeyPairSync } = require('node:crypto');
const { Broker } = require('../src/broker');
const { BrokerStore } = require('../src/store');
const { signRequest } = require('../src/auth');
const { site } = require('../src/google-search-console-contract');
const { createFirstGoogleAdmissionRpc,clinicSetFingerprint,OPERATIONS } = require('../src/google-first-admission-rpc');

const proof = { attemptId:randomUUID(),service:'search_console',bindingDigest:'f'.repeat(64),expiresAt:1800000060000 };
const scope = { scopeKey:'group:9',clinicIds:[17,31],services:['search_console','analytics'] };
const property = site('sc-domain:fixture-first.example');
const principalId = 'crm:qa:google-first', audience = 'cc:qa:google-first', keyId = 'first-qa';
const defaultTimestamp = 1800000000000;

function fixture(t,{ enabled = true } = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(),'cc-google-first-publication-rpc-'));
  const store = new BrokerStore(path.join(folder,'owner.sqlite'));
  t.after(() => { store.close(); fs.rmSync(folder,{ recursive:true,force:true }); });
  const keys = generateKeyPairSync('ed25519');
  const policy = { version:'qa-first-publication',audience,maxBacklog:100,connections:[],grants:[],
    principals:[{ id:principalId,keyId,enabled:true,publicKey:keys.publicKey.export({ type:'spki',format:'pem' }),maxPerMinute:60 }] };
  const forbidden = async () => assert.fail('Unexpected OAuth flow or ordinary credential read');
  const flow = { begin:forbidden,finish:forbidden,status:forbidden,abort:forbidden };
  const state = { at:defaultTimestamp,calls:[],change:null };
  const resources = [
    { scopeKey:scope.scopeKey,service:'search_console',clinicId:31,resource:{ siteUrl:property.siteUrl } },
    { scopeKey:scope.scopeKey,service:'analytics',clinicId:17,resource:{ propertyName:'properties/321' } },
  ];
  const publication = enabled ? { resources,async publish(pin,owner,selection,resource) {
    state.calls.push({ pin,owner,selection,resource });
    return { attemptId:pin.attemptId,service:pin.service,bindingDigest:pin.bindingDigest,
      scopeKey:selection.scopeKey,clinicId:selection.clinicId,assetRef:selection.assetRef,
      clinicSetDigest:clinicSetFingerprint(scope.clinicIds),receiptId:randomUUID(),googleUserId:'fictitious_google_subject',
      connectionRef:'google-first:'+pin.service+':'+selection.scopeKey,secretVersion:pin.attemptId,mode:'provisioned',
      observedAt:state.at,validUntil:state.at+5000,status:'confirmed_resource_access',
      ...(pin.service === 'search_console' ? { resource:{ siteUrl:resource.siteUrl,permissionLevel:'siteOwner' } } : {}),
      ...state.change,
    };
  } } : undefined;
  const boundary = createFirstGoogleAdmissionRpc({ policy,principalId,scopes:[scope],flow,publication,now:() => state.at });
  const broker = new Broker({ store,policy,...boundary,now:() => state.at,secrets:{ withSecret:forbidden } });
  const send = (payload = {},envelope = {},key = keys.privateKey) => {
    const selectedProof = { ...proof,...payload };
    const command = { requestId:randomUUID(),operation:OPERATIONS.publication,connectionRef:'google-first:'+selectedProof.attemptId,
      tenantRef:'clinic:17',assetRef:'google-oauth:'+selectedProof.service+':'+scope.scopeKey,
      payload:{ ...selectedProof,clinicSetDigest:clinicSetFingerprint(scope.clinicIds),clinicId:31,selectedAssetRef:property.assetRef,...payload },
      ...envelope };
    const { raw,headers } = signRequest(command,{ keyId,privateKey:key,audience,now:state.at });
    return broker.execute(raw,headers);
  };
  return { send,state,resources,policy,flow };
}

test('signed publication resolves only the configured native locator for the approved clinic and service', async t => {
  const f = fixture(t);
  const exact = await f.send();
  assert.equal(exact.data.clinicId,31);
  assert.equal(exact.data.assetRef,property.assetRef);
  assert.deepEqual(exact.data.resource,{ siteUrl:property.siteUrl,permissionLevel:'siteOwner' });
  assert.deepEqual(f.state.calls[0],{ pin:proof,owner:{ principalId,tenantRef:'clinic:17',
    connectionRef:'google-first:'+proof.attemptId,assetRef:'google-oauth:search_console:group:9' },
  selection:{ scopeKey:'group:9',clinicId:31,assetRef:property.assetRef },resource:{ siteUrl:property.siteUrl } });
  const ga = await f.send({ service:'analytics',clinicId:17,selectedAssetRef:'ga4:321',expectedSubjectDigest:'e'.repeat(64) });
  assert.equal(ga.data.service,'analytics');
  assert.equal(ga.data.resource,undefined);
  assert.deepEqual(f.state.calls[1].resource,{ propertyName:'properties/321' });
});

test('wrong roster, clinic, asset, principal and extra raw locator stop before publication', async t => {
  const f = fixture(t);
  for (const work of [
    () => f.send({ clinicId:17 }),() => f.send({ selectedAssetRef:'sc:'+'b'.repeat(64) }),
    () => f.send({ clinicSetDigest:'b'.repeat(64) }),() => f.send({}, { tenantRef:'clinic:31' }),
    () => f.send({}, { assetRef:'google-oauth:search_console:group:10' }),
    () => f.send({ siteUrl:property.siteUrl }),
    () => f.send({}, {},generateKeyPairSync('ed25519').privateKey),
    () => f.send({ expiresAt:defaultTimestamp }),
  ]) await assert.rejects(work);
  assert.deepEqual(f.state.calls,[]);
});

test('an unexpected receipt, unverified permission or expired version is never projected', async t => {
  const f = fixture(t);
  for (const change of [
    { clinicId:17 },{ secretVersion:randomUUID() },{ refreshToken:'FICTITIOUS_SECRET' },
    { resource:{ siteUrl:'sc-domain:foreign.example',permissionLevel:'siteOwner' } },
    { resource:{ siteUrl:property.siteUrl,permissionLevel:'siteUnverifiedUser' } },
    { validUntil:defaultTimestamp },{ mode:'reuse' },
  ]) {
    f.state.change = change;
    await assert.rejects(f.send());
  }
});

test('ordinary first controls can be installed without registering publication', async t => {
  const f = fixture(t,{ enabled:false });
  await assert.rejects(f.send());
  assert.deepEqual(f.state.calls,[]);
});
