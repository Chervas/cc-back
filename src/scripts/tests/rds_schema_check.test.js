'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
for (const key of ['exec', 'execFile', 'execSync', 'execFileSync', 'spawn', 'spawnSync', 'fork']) cp[key] = () => { throw Error('TEST_ONLY_no_child'); };
require('node:net').Socket.prototype.connect = () => { throw Error('TEST_ONLY_no_socket'); };
require('node:tls').connect = () => { throw Error('TEST_ONLY_no_tls'); };
const fs = require('node:fs'); const read = fs.readFileSync;
fs.readFileSync = function(file, ...args) {
  if (typeof file === 'string' && /(?:\/\.env(?:\.|$)|\/\.aws\/|\/proc\/|\/Goal\b)/.test(file)) throw Error('TEST_ONLY_no_secret_read');
  return read.call(fs, file, ...args);
};
const P = require('../../lib/rdsSchemaMigrationPolicy');
const T = require('../../lib/rdsSchemaMigrationTransport');
const Q = require('../security-rds-schema-check');
const USER = { staging: 'cc_app_api_ee4b8ca0', gateway: 'cc_app_wa_ee4b8ca0' };
const NAME = '20261024120000-add-owned-column.js';
function fixture(runtime) {
  const state = { events: [], files: new Map(), missing: false, drift: false, badRole: false, compatible: true };
  const pins = [{ path: Q.ROOTS[runtime] + '/src/scripts/security-schema-release.js', sha256: 'a'.repeat(64) }];
  const info = { revision: 'b'.repeat(40), contractDigest: 'c'.repeat(64), migrations: { [NAME]: 'd'.repeat(64) } };
  const identity = { host: T.HOST, database: T.DATABASE, physicalDbId: T.PRIMARY_DBI, strictTls: true,
    hostnameVerified: true, caSha256: T.CA_SHA, serverUuid: '8f74b18c-cf99-11f1-bd78-0afff7054403', engineVersion: '8.4.11' };
  const deps = { operatorUid: () => 0, now: () => 1792842000000,
    codePins: () => state.drift ? [{ ...pins[0], sha256: 'e'.repeat(64) }] : structuredClone(pins),
    observe: () => ({ env: { DB_HOST: T.HOST, DB_PORT: '3306', DB_NAME: T.DATABASE,
      DB_USERNAME: state.badRole ? 'NOT_AN_APP' : USER[runtime], DB_PASSWORD: 'TEST_ONLY_NOT_A_REAL_PASSWORD',
      DB_TLS_REQUIRED: 'true', DB_TLS_CA_FILE: T.CA } }),
    awsFactory: () => ({ inspect: async () => { state.events.push('aws_inspect'); return {}; },
      secret() { throw Error('TEST_ONLY_master_forbidden'); }, backup() { throw Error('TEST_ONLY_backup_forbidden'); } }),
    connect: async ({ secret }) => { assert.equal(secret.username, USER[runtime]); state.events.push('app_connect'); return {
      identity: structuredClone(identity), query: async sql => { state.events.push(sql); return state.missing ? [] : [{ name: NAME }]; },
      close: async () => { state.events.push('close_event'); return { physicalCloseObserved: true, physicalStreamDestroyed: true }; } }; },
    privateDirectory() {}, writePrivate: (path, value) => { assert.equal(state.files.has(path), false); state.files.set(path, JSON.stringify(value)); return { path, sha256: P.sha(state.files.get(path)) }; },
    hashFile: path => P.sha(state.files.get(path)),
    check: { sourceInfo: () => structuredClone(info), run: async args => {
      state.events.push('genuine_runtime_check');
      assert.equal(args[0], 'check'); assert.equal(args[args.indexOf('--runtime') + 1], runtime);
      const binding = JSON.parse(state.files.get(args[args.indexOf('--binding') + 1]));
      assert.equal(binding.serverUuid, identity.serverUuid); assert.equal(binding.expectedUsername, USER[runtime]);
      assert.equal(Object.keys(binding).length, 12);
      assert.equal(state.events.indexOf('close_event') < state.events.indexOf('genuine_runtime_check'), true);
      const report = { compatible: state.compatible, runtime };
      state.files.set(args[args.indexOf('--out') + 1], JSON.stringify(report)); return report;
    } },
  };
  return { state, deps };
}
test('one command derives a fresh app binding and uses each runtime own check without admin/snapshot/DDL', async () => {
  for (const runtime of ['staging', 'gateway']) {
    const f = fixture(runtime);
    const result = await Q.run(['--runtime', runtime, '--require-migration', NAME], f.deps);
    assert.equal(result.compatible, true); assert.equal(result.ddlStatements, 0); assert.equal(result.administrationSecretRead, false);
    assert.equal(result.snapshotCreated, false); assert.deepEqual(result.missingRequiredMigrations, []);
    assert.equal(JSON.stringify([...f.state.files.values()]).includes('TEST_ONLY_NOT_A_REAL_PASSWORD'), false);
    assert.equal(f.state.events.some(event => /CREATE|INSERT|UPDATE|DELETE|ALTER|DROP/.test(event)), false);
  }
});
test('missing selected migration or incompatible contract stays incompatible; DEV and supplied binding are refused', async () => {
  const missing = fixture('staging'); missing.state.missing = true;
  const result = await Q.run(['--runtime', 'staging', '--require-migration', NAME], missing.deps);
  assert.equal(result.compatible, false); assert.deepEqual(result.missingRequiredMigrations, [NAME]);
  const incompatible = fixture('gateway'); incompatible.state.compatible = false;
  assert.equal((await Q.run(['--runtime', 'gateway'], incompatible.deps)).compatible, false);
  assert.throws(() => Q.parse(['--runtime', 'dev']), /arguments/);
  assert.throws(() => Q.parse(['--runtime', 'staging', '--binding', '/tmp/fake']), /arguments/);
});
test('wrong application role or concurrent runtime-helper drift refuses publication proof', async () => {
  const role = fixture('gateway'); role.state.badRole = true;
  await assert.rejects(Q.run(['--runtime', 'gateway'], role.deps), /app_configuration/);
  assert.deepEqual(role.state.events, []);
  const drift = fixture('staging'); const old = drift.deps.check.run;
  drift.deps.check.run = async args => { const result = await old(args); drift.state.drift = true; return result; };
  await assert.rejects(Q.run(['--runtime', 'staging'], drift.deps), /runtime_check_changed/);
  assert.equal([...drift.state.files.keys()].some(path => path.endsWith('/result.json')), false);
});
