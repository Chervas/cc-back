'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CREDENTIALS_PROCESS, validateCredentials, createCredentialsProcessProvider } = require('../src/credentials');
const now = () => Date.parse('2026-10-24T10:00:00Z');
const value = () => ({ Version: 1, AccessKeyId: 'ASIA' + 'A'.repeat(16), SecretAccessKey: 'S'.repeat(40),
  SessionToken: 'FICTITIOUS_TOKEN_ONLY', Expiration: '2026-10-24T10:15:00Z' });
const fsImpl = { lstatSync: name => ({ uid: 0, mode: name === CREDENTIALS_PROCESS ? 0o100755 : 0o40755, nlink: 1,
  isDirectory: () => name !== CREDENTIALS_PROCESS, isFile: () => name === CREDENTIALS_PROCESS }) };
test('fixed process has closed arguments/environment and temporary credentials stay only in RAM', async () => {
  let calls = 0; let command; let callback;
  const provider = createCredentialsProcessProvider({ fsImpl, now, execute: (file, args, options, done) => {
    calls++; command = { file, args, options }; callback = done; return { stdin: { on() {}, end() {} } };
  } });
  const first = provider(); const second = provider();
  assert.equal(calls, 1); callback(null, JSON.stringify(value()), 'PRIVATE_STDERR_NOT_RETURNED');
  assert.equal((await first).accessKeyId, value().AccessKeyId); assert.equal(await first, await second);
  assert.equal(await provider(), await first); assert.equal(calls, 1);
  assert.equal(command.file, CREDENTIALS_PROCESS); assert.deepEqual(command.args, []);
  assert.equal(command.options.timeout, 8000); assert.equal(command.options.maxBuffer, 16384);
  assert.equal(command.options.shell, undefined);
  assert.deepEqual(command.options.env, { PATH: '/usr/bin:/bin', TZ: 'UTC', AWS_CONFIG_FILE: '/dev/null',
    AWS_SHARED_CREDENTIALS_FILE: '/dev/null', AWS_EC2_METADATA_DISABLED: 'true' });
});
test('missing, writable or replaced helper fails before execution and has no credential fallback', async () => {
  for (const patch of [{ uid: 1000 }, { mode: 0o100775 }, { nlink: 2 }, { isFile: () => false }]) {
    let calls = 0;
    const provider = createCredentialsProcessProvider({ now, fsImpl: { lstatSync: name => ({ ...fsImpl.lstatSync(name), ...(name === CREDENTIALS_PROCESS ? patch : {}) }) },
      execute() { calls++; assert.fail('must not execute'); } });
    await assert.rejects(provider(), /cost_credentials_unavailable/); assert.equal(calls, 0);
  }
});
test('long-lived, expired, malformed and wrong-account credentials are rejected without disclosing output', () => {
  for (const patch of [{ Expiration: undefined }, { Expiration: '2026-10-24T12:00:00Z' },
    { Expiration: '2026-10-24T09:59:00Z' }, { AccessKeyId: 'AKIA' + 'A'.repeat(16) },
    { AccountId: '000000000000' }, { SecretAccessKey: 'PRIVATE_SENTINEL' }, { Extra: 'PRIVATE_SENTINEL' }]) {
    assert.throws(() => validateCredentials({ ...value(), ...patch }, now()), error => error.message === 'cost_credentials_invalid');
  }
});
test('helper failure and invalid JSON return closed errors; no stderr, credentials or retry is surfaced', async () => {
  for (const [error, stdout] of [[Error('PRIVATE_SENTINEL'), ''], [null, '{PRIVATE_SENTINEL']]) {
    let calls = 0;
    const provider = createCredentialsProcessProvider({ fsImpl, now, execute: (_f, _a, _o, done) => {
      calls++; done(error, stdout, 'PRIVATE_SENTINEL');
    } });
    await assert.rejects(provider(), e => ['cost_credentials_unavailable', 'cost_credentials_invalid'].includes(e.message));
    assert.equal(calls, 1);
  }
});
