'use strict';
const { randomBytes, generateKeyPairSync } = require('node:crypto');
const { fixture } = require('./helpers'); const { Broker } = require('../src/broker');
const { signRequest } = require('../src/auth'); const { cursorCodec } = require('../src/provider-cursor');
const { createGoogleAdsOperations } = require('../src/google-ads');
const { createGoogleSecretStore } = require('../src/google-secrets');
const { createGoogleAdsDeveloperSecret } = require('../src/google-ads-developer-secret');
const contract = require('../src/google-ads-contract'); const runtime = require('../src/google-main');
const CUSTOMER = '1234567890'; const MANAGER = '9876543210'; const ASSET = 'ads:' + CUSTOMER;
const ACCESS = 'FICTITIOUS_ADS_ACCESS'; const DEVELOPER = 'FICTITIOUS_ADS_DEVELOPER';
function row(index = 1, metrics = false, group = false) {
  return { customer: { id: CUSTOMER }, campaign: { id: String(index), name: 'FICTITIOUS_CAMPAIGN_' + index, status: 'ENABLED' },
    ...(metrics ? { segments: { date: '2026-09-01', device: 'MOBILE', adNetworkType: 'SEARCH' }, metrics: { impressions: '2', clicks: '1', costMicros: '42', conversions: 0.5 } } : {}),
    ...(group ? { adGroup: { id: String(index + 100), name: 'FICTITIOUS_GROUP' } } : {}) };
}
function adsFixture(t, options = {}) {
  const f = fixture(t); let at = Date.now();
  const arn = suffix => `arn:aws:secretsmanager:eu-west-3:${runtime.ACCOUNT}:secret:/clinicaclick/integrations/prod/fictitious-ads-${suffix}-abcdef`;
  const binding = { connectionRef: 'connection:test', initialState: 'active', provider: contract.PROVIDER,
    secretArn: arn('connection'), clientSecretArn: arn('client'), developerSecretArn: arn('developer'), googleSubject: 'fictitious-subject',
    googleAdsAccounts: [{ assetRef: ASSET, customerId: CUSTOMER, loginCustomerId: MANAGER }] };
  f.policy.connections = [binding]; f.policy.maxBacklog = 10000; f.policy.principals[0].maxPerMinute = 600;
  f.policy.grants[0] = { ...f.policy.grants[0], assetRef: ASSET, operations: contract.OPERATIONS };
  const control = generateKeyPairSync('ed25519');
  f.policy.principals.push({ ...f.policy.principals[0], id: 'control:test', keyId: 'control-key', publicKey: control.publicKey.export({ type: 'spki', format: 'pem' }) });
  f.policy.grants.push({ ...f.policy.grants[0], principalId: 'control:test', operations: [contract.REVOKE_OPERATION] });
  const state = { sdk: [], calls: [], refreshes: 0, version: 'fictitious-current', developer: DEVELOPER,
    response: { results: [row()] }, token: ACCESS, failMetadata: false, onRead: null };
  const sdk = { async send(command) {
    state.sdk.push(command.constructor.name); const id = command.input.SecretId;
    if (state.failMetadata) throw Error('FICTITIOUS_PROVIDER_SECRET');
    if (command.constructor.name === 'DescribeSecretCommand') return { ARN: id, KmsKeyId: runtime.SECRET_KEY };
    assertKnown(id);
    const value = id === binding.secretArn ? { version: 3, provider: contract.PROVIDER, connectionRef: binding.connectionRef,
      googleUserId: binding.googleSubject, clientId: 'fictitious-client', refreshToken: 'FICTITIOUS_REFRESH', scopes: contract.SCOPES }
      : id === binding.clientSecretArn ? { version: 1, provider: 'google-oauth-client', clientId: 'fictitious-client', clientSecret: 'FICTITIOUS_CLIENT_SECRET' }
        : { version: 1, provider: 'google-ads-developer', developerToken: state.developer };
    return { ARN: id, VersionId: state.version, VersionStages: ['AWSCURRENT'], SecretString: JSON.stringify(value) };
  } };
  function assertKnown(id) { require('node:assert/strict').ok([binding.secretArn, binding.clientSecretArn, binding.developerSecretArn].includes(id)); }
  const http = async request => {
    if (request.hostname === 'oauth2.googleapis.com') { state.refreshes++; return { access_token: state.token, token_type: 'Bearer', expires_in: 3600, scope: contract.SCOPES[0] }; }
    require('node:assert/strict').equal(request.token.toString(), state.token);
    require('node:assert/strict').equal(request.developerToken.toString(), state.developer);
    state.calls.push({ hostname: request.hostname, path: request.path, loginCustomerId: request.loginCustomerId, json: request.json });
    await state.onRead?.(); return typeof state.response === 'function' ? state.response(request) : structuredClone(state.response);
  };
  const secretOptions = { client: sdk, accountId: runtime.ACCOUNT, prefix: '/clinicaclick/integrations/prod/', kmsKeyArn: runtime.SECRET_KEY };
  const secrets = createGoogleSecretStore({ ...secretOptions, http, provider: contract.PROVIDER, now: () => at });
  const cursor = cursorCodec(randomBytes(32), () => at);
  const engine = createGoogleAdsOperations({ http, cursor, withDeveloperSecret: createGoogleAdsDeveloperSecret(secretOptions), now: () => at, ...options });
  const invalidate = secrets.invalidate; secrets.invalidate = ref => { invalidate(ref); engine.invalidate(ref); };
  const make = store => new Broker({ store, policy: f.policy, secrets, operations: engine.operations, now: () => at });
  const broker = make(f.store);
  const command = (family, payload = { pageToken: null }, overrides = {}) => f.command({ operation: contract.PREFIX + family + '.read.v1', assetRef: ASSET, payload, ...overrides });
  const execute = (family, payload, overrides) => {
    const value = command(family, payload, overrides); const signed = signRequest(value, { keyId: 'qa-key', privateKey: f.keys.privateKey, audience: f.policy.audience, now: at });
    return broker.execute(signed.raw, signed.headers);
  };
  const revoke = () => {
    const value = f.command({ operation: contract.REVOKE_OPERATION, assetRef: ASSET });
    const signed = signRequest(value, { keyId: 'control-key', privateKey: control.privateKey, audience: f.policy.audience, now: at });
    return broker.execute(signed.raw, signed.headers);
  };
  t.after(() => { secrets.close(); engine.close(); });
  return { ...f, binding, state, sdk, http, secrets, engine, broker, execute, revoke, command, make, control,
    advance: ms => { at += ms; } };
}
module.exports = { adsFixture, row, CUSTOMER, MANAGER, ASSET, ACCESS, DEVELOPER };
