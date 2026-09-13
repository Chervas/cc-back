'use strict';
const assert = require('node:assert/strict');
const { randomBytes, generateKeyPairSync } = require('node:crypto');
const { fixture } = require('./helpers'); const { oauthSecretsFixture } = require('./google-oauth-fixture.cjs');
const { Broker } = require('../src/broker'); const { signRequest } = require('../src/auth');
const { createGoogleOAuth } = require('../src/google-oauth'); const { operationsFor } = require('../src/google-oauth-contract');
const { createGoogleSecretStore } = require('../src/google-secrets');
const COHORTS = {
  google_business_profile: { contract: require('../src/google-business-profile-contract'), cohort: 'google-business-profile-read-v1',
    create: require('../src/google-business-profile').createGoogleBusinessProfileOperations },
  google_search_console: { contract: require('../src/google-search-console-contract'), cohort: 'google-search-console-read-v1',
    create: require('../src/google-search-console').createSearchConsoleOperations },
  google_ads: { contract: require('../src/google-ads-contract'), cohort: 'google-ads-read-v1',
    create: ({ http, cursor, oauth }) => ({ ...require('../src/google-ads').createGoogleAdsOperations({ http, cursor,
      withDeveloperSecret: async (_binding, use) => { const token = Buffer.from('FICTITIOUS_DEVELOPER'); try { return await use(token); } finally { token.fill(0); } } }).operations,
      ...require('../src/google-oauth-contract').controlsFor('google_ads', oauth) }) },
  google_analytics: { contract: require('../src/google-analytics-contract'), cohort: 'google-analytics-read-v1',
    create: require('../src/google-analytics').createAnalyticsOperations },
};
function setup(t, provider = 'google_business_profile') {
  const f = fixture(t); const sm = oauthSecretsFixture(provider); const spec = COHORTS[provider]; const operations = operationsFor(provider);
  const oauthKey = generateKeyPairSync('ed25519'); const revokeKey = generateKeyPairSync('ed25519');
  const policy = structuredClone(f.policy); policy.connections[0] = { ...sm.binding, initialState: 'active' };
  for (const [id, keyId, key] of [['oauth:qa', 'qa-oauth', oauthKey], ['revoke:qa', 'qa-revoke', revokeKey]]) {
    policy.principals.push({ ...policy.principals[0], id, keyId, publicKey: key.publicKey.export({ type: 'spki', format: 'pem' }) });
  }
  const assetRef = provider === 'google_search_console' ? sm.binding.searchConsoleSites[0].assetRef : provider === 'google_analytics'
    ? sm.binding.analyticsProperties[0].assetRef : provider === 'google_ads' ? 'ads:1234567890' : 'gbp:123:456';
  const readOperation = provider === 'google_business_profile' ? 'google.business_profile.details.read.v1'
    : provider === 'google_ads' ? 'google.ads.account.read.v1' : spec.contract.OPERATIONS.find(op => op.endsWith('.discovery.read.v1'));
  const readResult = provider === 'google_business_profile' ? { name: 'locations/456', title: 'FICTITIOUS_TITLE' }
    : provider === 'google_search_console' ? { siteUrl: sm.binding.searchConsoleSites[0].siteUrl, permissionLevel: 'siteOwner' }
    : provider === 'google_ads' ? { results: [{ customer: { id: '1234567890', manager: false, currencyCode: 'EUR', timeZone: 'Europe/Madrid' } }], nextPageToken: null }
    : { name: 'properties/123', account: 'accounts/456', parent: 'accounts/456', displayName: 'Fictitious property', propertyType: 'PROPERTY_TYPE_ORDINARY' };
  const grant = { tenantRef: 'clinic:123', connectionRef: 'connection:test', assetRef };
  policy.grants = [{ ...grant, principalId: 'api:test', operations: [readOperation] },
    { ...grant, principalId: 'oauth:qa', operations: Object.values(operations) },
    { ...grant, tenantRef: 'clinic:124', principalId: 'oauth:qa', operations: Object.values(operations) },
    { ...grant, principalId: 'revoke:qa', operations: [spec.contract.REVOKE_OPERATION] }];
  const state = Object.assign(sm.state, { codes: 0, refreshes: 0, userinfos: 0, reads: 0, activated: 0, clock: Date.now() });
  const http = async request => {
    if (request.hostname === 'oauth2.googleapis.com') {
      const form = new URLSearchParams(request.form); assert.equal(form.get('client_secret'), sm.app.clientSecret);
      if (form.get('grant_type') === 'authorization_code') {
        state.codes++; state.lastCode = form.get('code'); state.lastVerifier = form.get('code_verifier'); await state.beforeToken?.();
      } else { state.refreshes++; assert.equal(form.get('refresh_token'), sm.value.refreshToken); }
      return { access_token: 'FICTITIOUS_ACCESS', refresh_token: state.omitRefresh ? undefined : sm.value.refreshToken, token_type: 'Bearer', expires_in: 3600,
        scope: state.missingScope ? 'openid' : sm.binding.oauth.scopes.map(s => s === 'email' ? 'https://www.googleapis.com/auth/userinfo.email'
          : s === 'profile' ? 'https://www.googleapis.com/auth/userinfo.profile' : s).join(' ') };
    }
    if (request.hostname === 'www.googleapis.com' && request.path === '/oauth2/v2/userinfo') {
      state.userinfos++; state.userinfoToken = request.token; await state.beforeIdentity?.();
      return { id: state.foreignIdentity ? 'other' : sm.binding.oauth.subject, email: 'FICTITIOUS_EMAIL', name: 'FICTITIOUS_NAME' };
    }
    state.reads++; await state.beforeRead?.(); return structuredClone(readResult);
  };
  const secrets = createGoogleSecretStore({ client: sm.client, http, ...sm.config, provider, now: () => state.clock });
  let engine; let broker;
  const reopen = (store = f.store) => {
    engine?.close(); engine = createGoogleOAuth({ store, secrets: sm.secrets, http, policy, now: () => state.clock,
      onActivated: ref => { state.activated++; secrets.invalidate(ref); } });
    broker = new Broker({ store, policy, secrets, now: () => state.clock, operations: spec.create({ http, cursor: {}, oauth: engine }) });
  };
  reopen(); t.after(() => { engine.close(); secrets.close(); });
  const execute = (operation, payload = {}, changes = {}, role = 'oauth') => {
    const command = f.command({ operation, assetRef, payload, ...changes });
    const signed = signRequest(command, { keyId: role === 'oauth' ? 'qa-oauth' : role === 'revoke' ? 'qa-revoke' : 'qa-key',
      privateKey: role === 'oauth' ? oauthKey.privateKey : role === 'revoke' ? revokeKey.privateKey : f.keys.privateKey,
      audience: policy.audience, now: state.clock }); return broker.execute(signed.raw, signed.headers);
  };
  const begin = async () => {
    const stateToken = randomBytes(32).toString('base64url'); const result = await execute(operations.begin, { state: stateToken });
    return { flowId: result.data.flowId, stateToken, url: new URL(result.data.authUrl) };
  };
  const finish = flow => execute(operations.finish, { flowId: flow.flowId, state: flow.stateToken, code: 'FICTITIOUS_CODE' });
  const status = flow => execute(operations.status, { flowId: flow.flowId }); const activate = flow => execute(operations.activate, { flowId: flow.flowId });
  const snapshot = () => JSON.stringify(f.store.db.prepare('SELECT * FROM google_oauth_flows').all())
    + JSON.stringify(f.store.db.prepare('SELECT * FROM audit_outbox').all()) + JSON.stringify(f.store.db.prepare('SELECT * FROM commands').all());
  return { ...f, ...sm, ...spec, policy, state, execute, begin, finish, status, activate, snapshot, reopen,
    secrets, oauthSecrets: sm.secrets, oauthKey, revokeKey, http, assetRef, readOperation, readResult };
}
module.exports = { setup, COHORTS };
