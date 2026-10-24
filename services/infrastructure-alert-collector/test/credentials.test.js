'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const C = require('../src/credentials'); const S = require('../src/scope');
const now = Date.parse('2026-10-24T14:00:00Z');
const value = () => ({ Version: 1, AccessKeyId: 'ASIA' + 'A'.repeat(16), SecretAccessKey: 'x'.repeat(40), SessionToken: 'fixture'.repeat(10), Expiration: new Date(now + 900000).toISOString() });
const fsImpl = { lstatSync: path => path === S.CREDENTIALS_PROCESS ? { isFile: () => true, uid: 0, mode: 0o100755, nlink: 1 } : { isDirectory: () => true, uid: 0, mode: 0o40755 } };
test('only temporary bounded purpose credentials are accepted', () => {
  assert.equal(C.validateCredentials(value(), now).expiration.getTime(), now + 900000);
  for (const patch of [{ AccessKeyId: 'AKIA' + 'A'.repeat(16) }, { Expiration: new Date(now + 59000).toISOString() }, { Expiration: new Date(now + 3600001).toISOString() }, { AccountId: '000000000000' }, { SessionToken: 'x'.repeat(8193) }, { url: 'evil' }]) assert.throws(() => C.validateCredentials({ ...value(), ...patch }, now), /alerts_credentials_invalid/);
});
test('purpose wrapper is fixed, noargs, minimum environment, bounded stdout/deadline and cached in RAM', async () => {
  let calls = 0; let invocation;
  const provider = C.createCredentialsProcessProvider({ fsImpl, now: () => now, execute: (file, args, options, callback) => {
    calls++; invocation = { file, args, options }; callback(null, JSON.stringify(value())); return { stdin: { on() {}, end() {} } };
  } });
  await provider(); await provider(); assert.equal(calls, 1); assert.equal(invocation.file, S.CREDENTIALS_PROCESS);
  assert.deepEqual(invocation.args, []); assert.equal(invocation.options.timeout, 8000); assert.equal(invocation.options.maxBuffer, 16384);
  assert.deepEqual(Object.keys(invocation.options.env).sort(), ['AWS_CONFIG_FILE', 'AWS_EC2_METADATA_DISABLED', 'AWS_SHARED_CREDENTIALS_FILE', 'PATH', 'TZ']);
  assert.equal(invocation.options.env.AWS_CONFIG_FILE, '/dev/null'); assert.equal(invocation.options.shell, undefined);
});
test('writable parent, symlink wrapper, wrong ownership and extra hardlink are refused before spawn', async () => {
  for (const patch of [{ path: '/usr/local', stat: { isDirectory: () => true, uid: 0, mode: 0o40775 } },
    { path: S.CREDENTIALS_PROCESS, stat: { isFile: () => false, uid: 0, mode: 0o120777, nlink: 1 } },
    { path: S.CREDENTIALS_PROCESS, stat: { isFile: () => true, uid: 1000, mode: 0o100755, nlink: 1 } },
    { path: S.CREDENTIALS_PROCESS, stat: { isFile: () => true, uid: 0, mode: 0o100755, nlink: 2 } }]) {
    const provider = C.createCredentialsProcessProvider({ now: () => now, fsImpl: { lstatSync: path => path === patch.path ? patch.stat : fsImpl.lstatSync(path) }, execute: () => { throw Error('must not execute'); } });
    await assert.rejects(provider(), /alerts_credentials_unavailable/);
  }
});
