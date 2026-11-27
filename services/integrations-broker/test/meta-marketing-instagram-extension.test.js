'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { BrokerError } = require('../src/errors');
const C = require('../src/meta-marketing-oauth-contract');
const I = require('../src/meta-marketing-instagram-extension-contract');
const E = require('../src/meta-marketing-enrollment-contract');
const { assetSetDigest } = require('../src/meta-marketing-credential-renewal-contract');
const { createMetaMarketingOAuth } = require('../src/meta-marketing-oauth');
const { createMetaMarketingOAuthSecrets } = require('../src/meta-marketing-oauth-secrets');
const { createInstagramExtension } = require('../src/meta-marketing-instagram-extension');

function fixture(t, group = false, automatic = false, twoPages = false) {
  const now = Date.now();
  const store = {
    db: new DatabaseSync(':memory:'),
    backlog: () => ({ pending: 0 }),
    connection() {},
    assertAssetActive() {},
    appendAudit() {},
    transaction(work) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = work();
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    },
  };
  store.db.exec('CREATE TABLE asset_revocations(asset TEXT); CREATE TABLE meta_marketing_enrollment_claims(asset TEXT,enrollment TEXT);');
  t.after(() => store.db.close());
  const environment = 'staging';
  const accountId = '000000000001';
  const secretPath = '/clinicaclick/integrations/prod/meta-marketing/staging/';
  const prefix = 'arn:aws:secretsmanager:eu-west-3:' + accountId + ':secret:' + secretPath;
  const kmsKeyArn = 'arn:aws:kms:eu-west-3:' + accountId + ':key/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const scopeKey = group ? 'group:29' : 'clinic:10';
  const directory = group ? 'group-29/page-30' : 'clinic-10';
  const settings = I.config({ scopeKey, parentPageId: '30', secretArn: prefix + 'instagram-extension/' + directory + '/candidate-abcdef',
    slotVersionId: 'a'.repeat(32), expiresAt: now + 86400000 }, environment, '000000000001');
  const binding = { provider: C.PROVIDER, connectionRef: 'connection:test', secretArn: prefix + 'candidate-abcdef',
    clientSecretArn: prefix + 'app-abcdef', expiresAt: now + 86400000, initialState: 'active',
    metaMarketingOAuth: { appId: '20', scopeKey: settings.scopeKey, clinicIds: group ? [10, 11] : [10], appVersionId: 'b'.repeat(32), slotVersionId: 'c'.repeat(32),
      redirectUri: 'https://gateway.invalid/oauth/meta/marketing/callback', scopes: ['ads_read','pages_read_engagement','public_profile'] } };
  const requestFields = { tenantRef: 'clinic:10', connectionRef: binding.connectionRef, assetRef: 'meta-enroll:' + settings.scopeKey };
  const candidateBinding = I.derive(binding, settings);
  const siblingSettings = twoPages && I.config({ ...settings, parentPageId: '32',
    secretArn: settings.secretArn.replace('/page-30/', '/page-32/'), slotVersionId: 'd'.repeat(32) }, environment, accountId);
  const slots = siblingSettings ? [candidateBinding, I.derive(binding, siblingSettings)] : [candidateBinding];
  const roles = E.roles(environment);
  const gateway = { id: roles.gateway };
  const control = { id: roles.control };
  const policy = { version: 'test-v1', maxBacklog: 50, grants: [gateway, control].map(principal => ({
    ...requestFields, principalId: principal.id, operations: [...Object.values(I.OPERATIONS), ...Object.values(C.OPERATIONS)],
  })) };
  const metadata = { appId: '20', subjectId: '21', tokenType: 'USER', scopes: candidateBinding.metaMarketingOAuth.scopes,
    expiresAt: now + 3600000, dataAccessExpiresAt: null, granularScopes: [] };
  const assets = E.assets([{ assetRef: 'meta-facebook_page:30', kind: 'facebook_page', id: '30', parentPageId: null },
    { assetRef: 'meta-ad_account:31', kind: 'ad_account', id: '31', parentPageId: null },
    ...(twoPages ? [{ assetRef: 'meta-facebook_page:32', kind: 'facebook_page', id: '32', parentPageId: null }] : [])]);
  const credential = { versionId: randomUUID(), epoch: 0, digest: 'a'.repeat(64), metadata: { ...metadata, scopes: binding.metaMarketingOAuth.scopes } };
  const row = { id: randomUUID(), tenant: requestFields.tenantRef, scope: requestFields.assetRef, connection: binding.connectionRef,
    flow: credential.versionId, state: 'active' };
  const retained = [];
  const versionsByArn = new Map();
  const seed = (arn, versionId, body) => versionsByArn.set(arn, new Map([[versionId, { body: JSON.stringify(body), stages: ['AWSCURRENT'] }]]));
  for (const slot of [binding, ...slots]) {
    const config = slot.metaMarketingOAuth;
    seed(slot.secretArn, config.slotVersionId, { version: 1, provider: 'meta-marketing-oauth-slot', connectionRef: slot.connectionRef,
      scopeKey: config.scopeKey, clinicSetDigest: C.clinicDigest(config), appId: config.appId });
  }
  seed(binding.clientSecretArn, binding.metaMarketingOAuth.appVersionId, { version: 1, provider: 'meta-app', appId: '20', appSecret: '0123456789abcdef'.repeat(2) });
  let afterRetainDescribe;
  const client = { async send(command) {
    const { SecretId: arn, VersionId, VersionStage, MoveToVersionId, SecretString, ClientRequestToken, VersionStages } = command.input;
    const versions = versionsByArn.get(arn);
    assert(versions);
    switch (command.constructor.name) {
      case 'DescribeSecretCommand': {
        const stages = Object.fromEntries([...versions].map(([id, version]) => [id, [...version.stages]]));
        if (arn === settings.secretArn && retained.length) afterRetainDescribe?.(stages, retained.at(-1));
        return { ARN: arn, KmsKeyId: kmsKeyArn, VersionIdsToStages: stages };
      }
      case 'GetSecretValueCommand': {
        const version = versions.get(VersionId);
        assert(version && (!VersionStage || version.stages.includes(VersionStage)));
        return { ARN: arn, VersionId, VersionStages: [...version.stages], SecretString: version.body };
      }
      case 'PutSecretValueCommand':
        assert.ok(slots.some(slot => slot.secretArn === arn));
        assert.deepEqual(VersionStages, ['AWSPENDING']);
        versions.set(ClientRequestToken, { body: SecretString, stages: [...VersionStages] });
        return { ARN: arn, VersionId: ClientRequestToken, VersionStages };
      case 'ListSecretVersionIdsCommand':
        return { ARN: arn, Versions: [...versions.keys()].map(VersionId => ({ VersionId })) };
      case 'UpdateSecretVersionStageCommand':
        assert.ok(slots.some(slot => slot.secretArn === arn));
        assert.equal(command.input.RemoveFromVersionId, undefined);
        assert.match(VersionStage, /^CC_META_CREDENTIAL_[a-f0-9]{32}$/);
        versions.get(MoveToVersionId).stages.push(VersionStage);
        retained.push(VersionStage);
        return { ARN: arn };
      default:
        assert.fail('Unexpected Secrets Manager operation');
    }
  } };
  const secrets = createMetaMarketingOAuthSecrets({ client, accountId, prefix: secretPath, kmsKeyArn });
  let exchanges = 0, rejection = null;
  const http = { async withExchangedToken({ authorize, signal }, work) {
    exchanges++;
    authorize();
    return work(Buffer.from('FICTITIOUS_EXTENSION_TEST'), metadata, signal);
  } };
  const oauth = createMetaMarketingOAuth({ store, policy, secrets, http, now: () => now });
  let allocations = 0;
  const autoSlot = automatic && (async (source,page,prepare) => {
    assert.equal(source,binding);
    assert.ok(page === '30' || (twoPages && page === '32'));
    if (prepare) { prepare(); allocations++; }
    return page === '32' ? siblingSettings : settings;
  });
  const extension = createInstagramExtension({ store, oauth, secrets, settings:automatic?[]:settings, autoSlot, environment, now: () => now,
    resolveBinding: () => binding, resolvePolicy: () => policy, enrollment: { renewalAuthority: () => ({ row, binding, assets, credential }) },
    readCandidate: async ({ authorize, parentPageId }) => {
      authorize();
      if (rejection) throw rejection;
      const id = parentPageId === '32' ? '41' : '40';
      return { asset: { id }, assetSetDigest: require('../src/meta-marketing-instagram-selection').extendInstagramSelection({scopeKey, selected:assets, expectedAssetSetDigest:assetSetDigest(assets), parentPageId, instagramId:id}).assetSetDigest,
        profile: { assetRef: 'meta-instagram_business:' + id, kind: 'instagram_business', id, name: 'Navae ficticia', username: 'test_navae' } };
    },
  });
  t.after(() => { extension.close(); oauth.close(); });
  const exec = async (name, payload, principal = gateway, requestId = randomUUID()) => {
    const operation = I.OPERATIONS[name];
    const context = { request: { ...requestFields, requestId, operation, payload }, principal, binding, policy };
    const handler = extension.operations[operation];
    handler.validate(payload);
    handler.authorize(context);
    return handler.execute(context)
      .then(result => result.data);
  };
  function attempt() {
    const flowId = randomUUID(), state = randomBytes(32).toString('base64url');
    const pins = { enrollmentId: row.id, parentPageId: '30', assetSetDigest: assetSetDigest(assets), epoch: credential.epoch,
      versionId: credential.versionId, credentialDigest: credential.digest, expiresAt: now + 600000, state };
    return { flowId, state, begin: (patch = {}) => exec('begin', { ...pins, ...patch }, gateway, flowId),
      finish: (code = 'FICTITIOUS_CODE_' + flowId) => exec('finish', { flowId, state, code }),
      status: () => exec('status', { flowId }, control),
      abort: () => exec('abort', { flowId }, control),
      confirm: (candidateDigest, instagramId = '40') => exec('confirm', { flowId, candidateDigest, instagramId }),
    };
  }
  const ordinaryBegin = id => oauth.execute({ binding, principal: gateway, policy, request: { ...requestFields, requestId: id,
    operation: C.OPERATIONS.begin, payload: { state: randomBytes(32).toString('base64url'), scopeDigest: 'f'.repeat(64),
      clinicSetDigest: C.clinicDigest(binding.metaMarketingOAuth), expiresAt: now + 600000 } } });
  return { attempt, binding, credential, store, assets, row, now, get allocations(){return allocations;}, get exchanges() { return exchanges; }, retain: retained, exec, ordinaryBegin,
    set rejection(value) { rejection = value; }, set afterRetainDescribe(value) { afterRetainDescribe = value; } };
}

test('Instagram is jointly validated and persisted only after explicit confirmation under a separate candidate slot', async t => {
  const f = fixture(t);
  const a = f.attempt();
  const start = await a.begin();
  assert.equal(start.status, 'awaiting');
  assert.equal(new URL(start.authUrl).searchParams.get('scope'), 'ads_read,instagram_basic,pages_read_engagement,public_profile');
  assert.deepEqual(await a.status(), { flowId: a.flowId, status: 'awaiting', candidate: null });
  const staged = await a.finish();
  assert.equal(staged.status, 'staged');
  assert.equal(staged.candidate.profile.username, 'test_navae');
  assert.equal(f.retain.length, 0);
  await assert.rejects(a.confirm(staged.candidate.digest, '41'), { code: 'idempotency_conflict' });
  assert.equal((await a.confirm(staged.candidate.digest)).status, 'active');
  assert.equal((await a.status()).status, 'active');
  assert.equal(f.retain.length, 1);
  assert.equal(f.exchanges, 1);
  assert.equal(f.credential.epoch, 0);
  assert(!f.binding.metaMarketingOAuth.scopes.includes('instagram_basic'));
  assert.equal(f.store.db.prepare('SELECT lane FROM meta_marketing_oauth_flows WHERE id=?').get(a.flowId).lane, 'instagram_extension');
  assert(!JSON.stringify(f.store.db.prepare('SELECT * FROM meta_marketing_instagram_extensions').all()).includes(a.state));
  const ordinary = randomUUID();
  assert.equal((await f.ordinaryBegin(ordinary)).data.flowId, ordinary);
  assert.equal(f.store.db.prepare('SELECT lane FROM meta_marketing_oauth_flows WHERE id=?').get(ordinary).lane, 'standard');
  f.credential.epoch++;
  assert.equal((await a.status()).status, 'active', 'an ordinary renewal does not invalidate the separately verified Instagram profile');
});

test('cancellation before Owner begin is durable, wrong parents and existing claims cannot be linked', async t => {
  const f = fixture(t);
  const cancelled = f.attempt();
  assert.equal((await cancelled.abort()).status, 'aborted');
  assert.equal((await cancelled.status()).status, 'aborted');
  await assert.rejects(cancelled.begin(), { code: 'idempotency_conflict' });
  const scoped = f.attempt();
  await assert.rejects(scoped.begin({ parentPageId: '999' }), { code: 'scope_denied' });
  await scoped.begin();
  f.store.db.prepare('INSERT INTO meta_marketing_enrollment_claims(asset) VALUES (?)').run('meta-instagram_business:40');
  await assert.rejects(scoped.finish(), { code: 'scope_denied' });
  assert.equal((await scoped.abort()).status, 'aborted');
  assert.equal((await scoped.status()).status, 'aborted');
  assert.equal(f.retain.length, 0);
});

test('a missing provider permission and a changed live credential fail closed without losing the base grant', async t => {
  const f = fixture(t);
  const rejected = f.attempt();
  await rejected.begin();
  f.rejection = new BrokerError('oauth_credentials_incomplete');
  await assert.rejects(rejected.finish(), { code: 'oauth_credentials_incomplete' });
  assert.equal((await rejected.abort()).status, 'aborted');
  f.rejection = null;
  const rotated = f.attempt();
  await rotated.begin();
  const staged = await rotated.finish();
  f.credential.epoch++;
  await assert.rejects(rotated.confirm(staged.candidate.digest), { code: 'scope_denied' });
  assert.equal((await rotated.abort()).status, 'aborted');
  assert.equal(f.retain.length, 0);
});

test('Instagram confirmation waits for the new retention label without writing it twice', async t => {
  const f = fixture(t);
  const a = f.attempt();
  await a.begin();
  const staged = await a.finish();
  let observations = 0;
  f.afterRetainDescribe = (stages, label) => {
    observations++;
    if (observations <= 2 || observations === 5) stages[a.flowId] = stages[a.flowId].filter(value => value !== label);
  };
  assert.equal((await a.confirm(staged.candidate.digest)).status, 'active');
  assert.equal(observations, 6);
  assert.equal((await a.status()).status, 'active');
  assert.equal(f.retain.length, 1);
  assert.equal(f.exchanges, 1);
});

test('an indefinitely absent retention label exhausts only the bounded read budget', async t => {
  const f = fixture(t);
  const a = f.attempt();
  await a.begin();
  const staged = await a.finish();
  let observations = 0;
  f.afterRetainDescribe = (stages, label) => {
    observations++;
    stages[a.flowId] = stages[a.flowId].filter(value => value !== label);
  };
  await assert.rejects(a.confirm(staged.candidate.digest), { code: 'secret_version_changed' });
  assert.equal(observations, 5);
  assert.equal(f.retain.length, 1);
  assert.equal(f.store.db.prepare('SELECT state FROM meta_marketing_instagram_extensions WHERE id=?').get(a.flowId).state, 'staged');
  f.afterRetainDescribe = undefined;
  assert.equal((await a.confirm(staged.candidate.digest)).status, 'active');
  assert.equal(f.retain.length, 1);
  assert.equal(f.exchanges, 1);
});

test('explicit retention conflicts are rejected immediately after observing the candidate', async t => {
  for (const change of [
    (stages, id, label) => { stages[id] = ['AWSPENDING']; stages[randomUUID()] = [label]; },
    (stages, id) => { delete stages[id]; },
    (stages, id, label) => { stages[id] = [label, 'AWSCURRENT']; },
  ]) {
    const f = fixture(t);
    const a = f.attempt();
    await a.begin();
    const staged = await a.finish();
    let observations = 0;
    f.afterRetainDescribe = (stages, label) => {
      observations++;
      if (observations >= 2) change(stages, a.flowId, label);
    };
    await assert.rejects(a.confirm(staged.candidate.digest), { code: 'secret_version_changed' });
    assert.equal(observations, 2);
    assert.equal(f.retain.length, 1);
    assert.equal(f.store.db.prepare('SELECT state FROM meta_marketing_instagram_extensions WHERE id=?').get(a.flowId).state, 'staged');
  }
});


test('a group candidate belongs to the group and its page while using the enrollment tenant for transport', async t => {
  const f = fixture(t, true);
  const a = f.attempt();
  assert.equal((await a.begin()).status, 'awaiting');
  const staged = await a.finish();
  assert.equal(staged.status, 'staged');
  assert.equal((await a.confirm(staged.candidate.digest)).status, 'active');
  const b = f.attempt();
  await assert.rejects(b.begin({parentPageId:'999'}), {code:'scope_denied'});
  assert.equal((await a.status()).status, 'active');
});

test('a self-service slot is prepared only for the current confirmed Facebook page and credential', async t => {
  const f=fixture(t,true,true), a=f.attempt();
  assert.equal((await a.status()).status,'not_found');
  await assert.rejects(a.begin({parentPageId:'42'}),{code:'scope_denied'});
  await assert.rejects(a.begin({epoch:99}),{code:'scope_denied'});
  assert.equal(f.allocations,0);
  assert.equal((await a.begin()).status,'awaiting');
  assert.equal(f.allocations,1);
  const staged = await a.finish();
  assert.equal((await a.confirm(staged.candidate.digest)).status,'active');
  assert.equal((await a.status()).candidate.profile.username,'test_navae');
  assert.equal(f.allocations,1);
  const delayed=f.attempt();
  await delayed.abort();
  await assert.rejects(delayed.begin(),{code:'scope_denied'});
  assert.equal(f.allocations,1);
});

test('a confirmed group page remains active while a second page completes its own consent', async t => {
  const f = fixture(t, true, true, true);
  const first = f.attempt();
  await first.begin();
  const medical = await first.finish();
  const blocked = f.attempt();
  await assert.rejects(blocked.begin({ parentPageId: '32' }), { code: 'oauth_flow_busy' });
  await blocked.abort();
  assert.equal((await first.confirm(medical.candidate.digest)).status, 'active');
  const capilar = f.attempt();
  await capilar.begin({ parentPageId: '32' });
  const staged = await capilar.finish();
  assert.equal(staged.candidate.profile.id, '41');
  assert.equal((await capilar.confirm(staged.candidate.digest, '41')).status, 'active');
  assert.equal((await first.status()).candidate.profile.id, '40');
});

test('single-clinic messaging derives the Instagram extension only from the confirmed owner selection and matching credential subject', async t => {
  const f=fixture(t), single=require('../src/meta-marketing-social-single').createSingleClinicSocial({store:f.store,channels:['instagram'],now:()=>f.now});
  const targets=(subject=f.credential.metadata.subjectId)=>single.targets(f.row,f.binding,f.assets,subject);
  const attempt=f.attempt(); await attempt.begin(); const staged=await attempt.finish();
  assert.deepEqual(targets(),[]);
  await attempt.confirm(staged.candidate.digest);
  assert.deepEqual(targets(),[{channel:'instagram',clinicId:10,pageId:'30',accountId:'40'}]);
  assert.deepEqual(targets('999'),[]);
  f.store.db.prepare('INSERT INTO meta_marketing_enrollment_claims(asset,enrollment) VALUES(?,?)').run('meta-instagram_business:40',f.row.id);
  assert.equal(single.owners('instagram','40').length,2);
  assert.deepEqual(targets(),[]);
  f.store.db.prepare('DELETE FROM meta_marketing_enrollment_claims').run();
  f.store.db.prepare('INSERT INTO asset_revocations VALUES(?)').run('meta-instagram_business:40');
  assert.deepEqual(targets(),[]);
});
