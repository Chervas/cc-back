'use strict';
const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const { randomUUID, randomBytes, generateKeyPairSync } = require('node:crypto'); const { EventEmitter } = require('node:events'); const { PassThrough } = require('node:stream');
const { BrokerStore } = require('../src/store'); const { Broker } = require('../src/broker'); const { signRequest } = require('../src/auth');
const { createWhatsappOnboarding } = require('../src/whatsapp-onboarding'); const { createWhatsappOnboardingSecrets } = require('../src/whatsapp-onboarding-secrets');
const { createWhatsappOAuthHttp } = require('../src/whatsapp-oauth-http'); const C = require('../src/whatsapp-onboarding-contract'); const { ACCOUNT, SECRET_KEY } = require('../src/google-main');
const TOKEN = 'FICTITIOUS_ONBOARDING_TOKEN'; const APP = '0123456789abcdef'.repeat(2);
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-wa-onboarding-qa-')); fs.chmodSync(dir, 0o700);
  const filename = path.join(dir, 'state.sqlite'); const gateway = generateKeyPairSync('ed25519'); const control = generateKeyPairSync('ed25519');
  const prefix = `arn:aws:secretsmanager:eu-west-3:${ACCOUNT}:secret:/clinicaclick/integrations/prod/`;
  const binding = { connectionRef: 'connection:wa-enroll-qa', provider: C.PROVIDER, initialState: 'active', expiresAt: Date.now() + 86400000,
    secretArn: prefix + 'qa-candidate-abcdef', clientSecretArn: prefix + 'qa-app-abcdef', whatsappOnboarding: {
      appId: '101', configId: '102', redirectUri: 'https://app.example.invalid/whatsapp/callback', appVersionId: 'a'.repeat(32), slotVersionId: 's'.repeat(32),
      scopeKey: 'group:9', clinicIds: [71, 72], scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
    } };
  const principal = (id, keyId, key) => ({ id, keyId, enabled: true, maxPerMinute: 60, publicKey: key.publicKey.export({ type: 'spki', format: 'pem' }) });
  const grant = { connectionRef: binding.connectionRef, tenantRef: 'clinic:71', assetRef: 'wa-enroll:group:9' };
  const policy = { audience: 'broker:wa-onboarding-qa', version: 'wa-onboarding-qa-v1', maxBacklog: 100,
    principals: [principal('gateway:whatsapp-onboarding', 'qa-gateway', gateway), principal('control:whatsapp-onboarding', 'qa-control', control)],
    connections: [binding], grants: [{ ...grant, principalId: 'gateway:whatsapp-onboarding', operations: Object.values(C.OPERATIONS) },
      { ...grant, principalId: 'control:whatsapp-onboarding', operations: [C.OPERATIONS.status, C.OPERATIONS.abort, C.REVOKE] }] };
  const records = new Map();
  const seed = (arn, version, value) => records.set(arn, new Map([[version, { body: JSON.stringify(value), stages: ['AWSCURRENT'] }]]));
  seed(binding.secretArn, binding.whatsappOnboarding.slotVersionId, { version: 1, provider: 'meta-whatsapp-onboarding-slot', connectionRef: binding.connectionRef, scopeKey: 'group:9', appId: '101' });
  seed(binding.clientSecretArn, binding.whatsappOnboarding.appVersionId, { version: 1, provider: 'meta-app', appId: '101', appSecret: APP });
  const state = { clock: Date.now(), awsCalls: [], httpCalls: [], codes: 0, puts: 0, heldTokens: [], records,
    beforeAws: null, afterAws: null, beforeCode: null, afterGraph: null, failPut: false, losePut: false };
  const now = () => state.clock;
  const aws = { async send(command, options) {
    state.awsCalls.push(command); await state.beforeAws?.(command, options);
    const name = command.constructor.name; const input = command.input; const versions = records.get(input.SecretId);
    if (!versions) throw Error('FICTITIOUS_MISSING_SECRET'); let result;
    if (name === 'DescribeSecretCommand') result = { ARN: input.SecretId, KmsKeyId: SECRET_KEY, VersionIdsToStages: Object.fromEntries([...versions].map(([id, v]) => [id, [...v.stages]])) };
    else if (name === 'ListSecretVersionIdsCommand') {
      assert.equal(input.IncludeDeprecated, true); assert.equal(input.MaxResults, 100);
      result = { ARN: input.SecretId, Versions: [...versions.keys()].slice(0, 100).map(VersionId => ({ VersionId })), ...(versions.size > 100 ? { NextToken: 'more' } : {}) };
    } else if (name === 'GetSecretValueCommand') {
      const v = versions.get(input.VersionId); if (!v || input.VersionStage && !v.stages.includes(input.VersionStage)) throw Error('FICTITIOUS_MISSING_VERSION');
      result = { ARN: input.SecretId, VersionId: input.VersionId, VersionStages: [...v.stages], SecretString: v.body };
    } else if (name === 'PutSecretValueCommand') {
      state.puts++; assert.equal(input.SecretId, binding.secretArn); assert.deepEqual(input.VersionStages, ['AWSPENDING']); assert(C.uuid(input.ClientRequestToken));
      if (state.failPut) throw Error('FICTITIOUS_WRITE_FAILED');
      if (versions.has(input.ClientRequestToken)) assert.equal(versions.get(input.ClientRequestToken).body, input.SecretString);
      else { for (const v of versions.values()) v.stages = v.stages.filter(s => s !== 'AWSPENDING'); versions.set(input.ClientRequestToken, { body: input.SecretString, stages: ['AWSPENDING'] }); }
      if (state.losePut) { state.losePut = false; throw Error('FICTITIOUS_ACK_LOST'); }
      result = { ARN: input.SecretId, VersionId: input.ClientRequestToken, VersionStages: [...versions.get(input.ClientRequestToken).stages] };
    } else assert.fail('Unexpected AWS operation ' + name);
    return state.afterAws ? state.afterAws(command, result) : result;
  } };
  const http = async request => {
    state.httpCalls.push({ action: request.action, id: request.id }); state.heldTokens.push(request.token); if (request.candidate) state.heldTokens.push(request.candidate);
    let response;
    if (request.action === 'inspect') response = { data: { app_id: '101', user_id: '201', type: 'SYSTEM_USER', is_valid: true,
      expires_at: 0, data_access_expires_at: 0, scopes: [...binding.whatsappOnboarding.scopes],
      granular_scopes: binding.whatsappOnboarding.scopes.map(scope => ({ scope, target_ids: ['301'] })) } };
    else { assert.equal(request.action, 'phones'); assert.equal(request.id, '301'); response = { data: [{ id: '401' }] }; }
    return state.afterGraph ? state.afterGraph(request, response) : response;
  };
  const exchangeFactory = options => createWhatsappOAuthHttp({ ...options, request: (settings, callback) => {
    const req = new EventEmitter(); req.destroy = () => {}; req.end = () => {
      const url = new URL('https://graph.facebook.com' + settings.path); assert.equal(settings.hostname, 'graph.facebook.com');
      assert.equal(url.pathname, '/v24.0/oauth/access_token'); assert.equal(url.searchParams.get('client_secret'), APP);
      state.codes++;
      queueMicrotask(async () => {
        try { await state.beforeCode?.(); const res = new PassThrough(); res.statusCode = 200; res.headers = { 'content-type': 'application/json' }; callback(res);
          res.end(JSON.stringify({ access_token: TOKEN, token_type: 'bearer' })); } catch (e) { req.emit('error', e); }
      });
    }; return req;
  } });
  const secrets = createWhatsappOnboardingSecrets({ client: aws, accountId: ACCOUNT, prefix: '/clinicaclick/integrations/prod/', kmsKeyArn: SECRET_KEY });
  const stores = []; const engines = [];
  function make(target = new BrokerStore(filename), chosenPolicy = policy) {
    stores.push(target); const engine = createWhatsappOnboarding({ store: target, policy: chosenPolicy, secrets, http, exchangeFactory, now }); engines.push(engine);
    return { store: target, engine, broker: new Broker({ store: target, policy: chosenPolicy, secrets, operations: engine.operations, now }) };
  }
  let current = make();
  const command = (operation, payload, overrides = {}) => ({ requestId: randomUUID(), ...grant, operation, payload, ...overrides });
  const signed = (value, isControl = false) => signRequest(value, { keyId: isControl ? 'qa-control' : 'qa-gateway', privateKey: (isControl ? control : gateway).privateKey, audience: policy.audience, now: now() });
  const execute = (operation, payload, overrides = {}, isControl = false, instance = current) => { const s = signed(command(operation, payload, overrides), isControl); return instance.broker.execute(s.raw, s.headers); };
  const begin = async (overrides = {}, instance = current) => {
    const flowId = randomUUID(); const payload = { state: randomBytes(32).toString('base64url'), expiresAt: now() + 600000,
      scopeDigest: C.hash('fictitious-group-snapshot'), clinicSetDigest: C.clinicDigest(binding.whatsappOnboarding), ...overrides };
    const result = await execute(C.OPERATIONS.begin, payload, { requestId: flowId }, false, instance); return { flowId, payload, result, code: 'FICTITIOUS_WA_CODE_' + flowId };
  };
  const finish = (flow, changes = {}, instance = current) => execute(C.OPERATIONS.finish, { flowId: flow.flowId, state: flow.payload.state, code: flow.code, wabaId: '301', phoneId: '401', ...changes }, {}, false, instance);
  const status = (flow, instance = current) => execute(C.OPERATIONS.status, { flowId: flow.flowId }, {}, false, instance);
  const abort = (flow, instance = current, isControl = false) => execute(C.OPERATIONS.abort, { flowId: flow.flowId }, {}, isControl, instance);
  const snapshot = (instance = current) => JSON.stringify(['whatsapp_onboarding_flows', 'whatsapp_onboarding_wabas', 'whatsapp_onboarding_assets', 'whatsapp_onboarding_scope_blocks', 'audit_outbox', 'commands']
    .map(table => instance.store.db.prepare('SELECT * FROM ' + table).all()));
  t.after(() => { for (const engine of engines) engine.close(); for (const store of stores) try { store.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, filename, binding, policy, state, records, secrets, aws, http, exchangeFactory, now, make, command, signed, execute,
    begin, finish, status, abort, snapshot, gateway, control, get current() { return current; }, restart() { current.engine.close(); current.store.close(); current = make(); return current; } };
}
module.exports = { fixture, TOKEN, APP };
