'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { generateKeyPairSync } = require('node:crypto');
const { createIntegrationsBrokerClient } = require('../../lib/integrationsBrokerClient');

test('bounded phone-unavailable error crosses the real CRM broker adapter without exposing provider details', async () => {
  const original = https.request;
  const privateKey = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' });
  let responseCode, requests = 0;
  https.request = (_url, _options, callback) => {
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => setImmediate(() => {
      requests++;
      const response = new EventEmitter();
      response.statusCode = 423;
      callback(response);
      response.emit('data', Buffer.from(JSON.stringify({ error: {
        code: responseCode, message: 'FICTITIOUS_PROVIDER_DETAIL', token: 'FICTITIOUS_SECRET',
      } })));
      response.emit('end');
    });
    return req;
  };
  try {
    const client = createIntegrationsBrokerClient({ origin: 'https://broker.invalid', privateKey,
      keyId: 'fictitious-key', audience: 'fictitious-audience', timeoutMs: 1000 });
    const command = { operation: require('../../../services/integrations-broker/src/whatsapp-authorized-profile').READ };
    for (const [code, expected] of [
      ['whatsapp_authorized_phone_unavailable', 'whatsapp_authorized_phone_unavailable'],
      ['credential_revoked', 'credential_revoked'],
      ['scope_denied', 'scope_denied'],
      ['FICTITIOUS_UNKNOWN_CODE', 'broker_unavailable'],
    ]) {
      responseCode = code;
      await assert.rejects(client.execute(command), error => {
        assert.equal(error.code, expected);
        assert.equal(error.message, expected);
        assert.doesNotMatch(JSON.stringify(error), /FICTITIOUS_PROVIDER_DETAIL|FICTITIOUS_SECRET/);
        return true;
      });
    }
    assert.equal(requests, 4);
  } finally {
    https.request = original;
  }
});
