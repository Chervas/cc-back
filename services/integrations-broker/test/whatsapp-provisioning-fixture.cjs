'use strict';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./whatsapp-onboarding-fixture.cjs');
const { createWhatsappProvisioning } = require('../src/whatsapp-onboarding-provisioning');
const { createWhatsappOnboarding } = require('../src/whatsapp-onboarding');
const { Broker } = require('../src/broker'); const { BrokerStore } = require('../src/store');
const C = require('../src/whatsapp-onboarding-contract'); const P = require('../src/whatsapp-provisioning-contract');
function provisioningFixture(t) {
  const f = fixture(t, { customer: { selectionOnly: true } });
  const b = f.binding.whatsappOnboarding;
  const settings = { appId: b.appId, configId: b.configId, redirectUri: b.redirectUri, scopes: b.scopes,
    appVersionId: b.appVersionId, clientSecretArn: f.binding.clientSecretArn, maxConnections: 100 };
  const publicTemplate = Object.fromEntries(['appId','configId','redirectUri','scopes'].map(k => [k,settings[k]]));
  const metadata = new Map(); const state = { creates: 0, loseCreate: false, before: null, after: null, denied: false };
  const aws = { async send(command, options) {
    const type = command.constructor.name, input = command.input;
    await state.before?.(command);
    let result;
    if (type === 'CreateSecretCommand') {
      state.creates++;
      if (state.denied) throw Object.assign(Error('FICTITIOUS_IAM_DENIAL'), { name: 'AccessDeniedException' });
      if (metadata.has(input.Name)) throw Object.assign(Error('FICTITIOUS_EXISTS'), { name: 'ResourceExistsException' });
      assert(input.Name.startsWith(P.PREFIX));
      const ARN = P.ARN_PREFIX + input.Name + '-Abc123';
      metadata.set(input.Name, { ARN, Name: input.Name, Tags: input.Tags, KmsKeyId: input.KmsKeyId });
      f.records.set(ARN, new Map([[input.ClientRequestToken, { body: input.SecretString, stages: ['AWSCURRENT'] }]]));
      if (state.loseCreate) { state.loseCreate = false; throw Error('FICTITIOUS_LOST_ACK'); }
      result = { ARN, Name: input.Name, VersionId: input.ClientRequestToken };
    } else if (type === 'DescribeSecretCommand' && input.SecretId.startsWith(P.PREFIX)) {
      const m = metadata.get(input.SecretId);
      if (!m) throw Object.assign(Error('FICTITIOUS_NOT_FOUND'), { name: 'ResourceNotFoundException' });
      const existing = await aws.send(new command.constructor({ SecretId: m.ARN }), options);
      return existing;
    } else {
      if (!f.records.has(input.SecretId)) throw Object.assign(Error('FICTITIOUS_NOT_FOUND'), { name: 'ResourceNotFoundException' });
      result = await f.aws.send(command, options);
      if (type === 'DescribeSecretCommand') Object.assign(result, [...metadata.values()].find(m => m.ARN === input.SecretId));
    }
    return state.after ? state.after(command, result) : result;
  } };
  const handles = [];
  function make(store = new BrokerStore(f.dir + '/automatic.sqlite'), chosenSettings = settings) {
    const provisioner = createWhatsappProvisioning({ store, policy: f.policy, settings: chosenSettings, client: aws, now: f.now });
    const engine = createWhatsappOnboarding({ store, policy: f.policy, secrets: f.secrets, http: f.http,
      exchangeFactory: f.exchangeFactory, now: f.now, resolveBinding: provisioner.resolveBinding });
    const broker = new Broker({ store, policy: f.policy, secrets: f.secrets, operations: engine.operations,
      policyResolver: provisioner, now: f.now });
    const handle = { store, provisioner, engine, broker, close() { engine.close(); try { store.close(); } catch {} } };
    handles.push(handle); return handle;
  }
  const current = make(); t.after(() => handles.forEach(h => h.close()));
  function command(scope = 'clinic:123', ids = [123], overrides = {}) {
    return { requestId: randomUUID(), operation: P.PREPARE, connectionRef: P.connectionRef(scope),
      tenantRef: 'clinic:' + ids[0], assetRef: 'wa-enroll:' + scope,
      payload: { scopeKey: scope, clinicIds: ids, scopeDigest: C.hash('FICTITIOUS_SCOPE'),
        clinicSetDigest: C.hash(JSON.stringify(ids)), expiresAt: f.now() + 600000 }, ...overrides };
  }
  async function prepare(value = command(), handle = current, control = false) {
    const signed = f.signed(value, control); return handle.provisioner.prepare(signed.raw, signed.headers);
  }
  async function execute(value, handle = current, control = false) {
    const signed = f.signed(value, control); return handle.broker.execute(signed.raw, signed.headers);
  }
  return { f, settings, publicTemplate, metadata, state, aws, current, make, command, prepare, execute };
}
module.exports = { provisioningFixture };
