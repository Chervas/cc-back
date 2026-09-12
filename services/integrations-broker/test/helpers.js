'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, generateKeyPairSync } = require('node:crypto');
const { BrokerStore } = require('../src/store');
const { Broker } = require('../src/broker');
const { signRequest } = require('../src/auth');
const { createFictitiousSecretStore } = require('../src/secrets');

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-broker-test-')); fs.chmodSync(dir, 0o700);
  const keys = generateKeyPairSync('ed25519');
  const policy = { audience: 'broker:test', version: 'qa-v1', maxBacklog: 100,
    principals: [{ id: 'api:test', keyId: 'qa-key', enabled: true, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }), maxPerMinute: 100 }],
    connections: [{ connectionRef: 'connection:test', provider: 'fictitious', initialState: 'active' }],
    grants: [{ principalId: 'api:test', tenantRef: 'clinic:123', connectionRef: 'connection:test', assetRef: 'asset:456', operations: ['fictitious.connection.check.v1'] }],
  };
  const filename = path.join(dir, 'state.sqlite');
  const store = new BrokerStore(filename);
  const broker = new Broker({ store, policy, secrets: createFictitiousSecretStore(), ...options });
  const command = (values = {}) => ({ requestId: randomUUID(), operation: 'fictitious.connection.check.v1',
    connectionRef: 'connection:test', assetRef: 'asset:456', tenantRef: 'clinic:123', payload: {}, ...values });
  const signed = value => signRequest(value, { keyId: 'qa-key', privateKey: keys.privateKey, audience: policy.audience, now: options.now?.() ?? Date.now() });
  const execute = value => { const r = signed(value); return broker.execute(r.raw, r.headers); };
  t.after(() => { try { store.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, filename, store, broker, policy, keys, command, signed, execute };
}
module.exports = { fixture };
