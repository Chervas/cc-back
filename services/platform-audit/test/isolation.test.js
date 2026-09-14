'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { verifyNetworkIsolation } = require('../src/verify-isolation');
function checks({ positive = 'CONNECTED', negative = 'TIMEOUT', ipv4 = 'TIMEOUT', ipv6 = 'ENETUNREACH' } = {}) {
  const calls = [];
  return { calls, run: () => verifyNetworkIsolation(
    async ({ host }) => { calls.push(host); return host.includes(':') ? ipv6 : ipv4; },
    async host => { calls.push(host); return host === '127.0.0.1' ? positive : negative; }) };
}
test('packet-drop timeout is accepted only after live local filter controls', async () => {
  const c = checks(); await c.run();
  assert.deepEqual(c.calls, ['127.0.0.1', '127.0.0.2', '169.254.169.254', 'fd00:ec2::254']);
});
test('missing filter fails before metadata even when metadata would time out', async () => {
  const c = checks({ negative: 'CONNECTED' }); await assert.rejects(c.run, /audit_isolation_invalid/);
  assert.deepEqual(c.calls, ['127.0.0.1', '127.0.0.2']);
});
test('broken positive listener or refused negative endpoint cannot pass as isolation', async () => {
  for (const values of [{ positive: 'TIMEOUT' }, { positive: 'ECONNREFUSED' }, { negative: 'ECONNREFUSED' }]) {
    await assert.rejects(checks(values).run, /audit_isolation_invalid/);
  }
});
test('reachable metadata and unexplained IPv4 routing failures remain closed', async () => {
  for (const values of [{ ipv4: 'CONNECTED' }, { ipv6: 'CONNECTED' }, { ipv4: 'ENETUNREACH' }, { ipv4: 'ECONNREFUSED' }]) {
    await assert.rejects(checks(values).run, /audit_isolation_invalid/);
  }
});
test('immediate kernel permission denial is still accepted', async () => {
  await checks({ negative: 'EPERM', ipv4: 'EACCES', ipv6: 'EAFNOSUPPORT' }).run();
});
