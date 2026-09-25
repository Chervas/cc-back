'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./whatsapp-authorized-fixture.cjs');
const S = require('../src/whatsapp-authorized-status');

test('operational status exposes only the exact durable revocation without reading Meta credentials', async t => {
  const f = await fixture(t);
  const request = changes => f.request(undefined, { operation: S.READ, payload: {
    authorizationId: f.definition.authorizationId, phoneId: f.definition.phoneId, ...changes,
  } });
  let result = await f.execute(request());
  assert.deepEqual(result.data, { permissionStatus: 'connected' });
  assert.equal(f.state.calls.length, 0);
  f.current.store.db.prepare("UPDATE connections SET state='revoked',revision=revision+1,reason='revoked' WHERE ref=?").run(f.binding.connectionRef);
  result = await f.execute(request());
  assert.deepEqual(result.data, { permissionStatus: 'disconnected' });
  assert.equal(f.state.calls.length, 0);
  await assert.rejects(f.execute(request({ authorizationId: 'b1234567-1234-4234-8234-123456789abc' })), { code: 'scope_denied' });
  await assert.rejects(f.execute(request({ phoneId: '402' })), { code: 'scope_denied' });
});

test('operational status keeps administrative and asset blocks distinct from credential revocation', async t => {
  const f = await fixture(t);
  const request = () => f.request(undefined, { operation: S.READ,
    payload: { authorizationId: f.definition.authorizationId, phoneId: f.definition.phoneId } });
  f.current.store.db.prepare("UPDATE connections SET state='blocked',revision=revision+1,reason='blocked' WHERE ref=?").run(f.binding.connectionRef);
  await assert.rejects(f.execute(request()), { code: 'connection_blocked' });
  assert.equal(f.state.calls.length, 0);
});
