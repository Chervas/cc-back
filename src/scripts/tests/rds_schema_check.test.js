'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
for (const key of ['exec', 'execFile', 'execSync', 'execFileSync', 'spawn', 'spawnSync', 'fork']) cp[key] = () => { throw Error('TEST_ONLY_no_child'); };
require('node:net').Socket.prototype.connect = () => { throw Error('TEST_ONLY_no_socket'); };
require('node:tls').connect = () => { throw Error('TEST_ONLY_no_tls'); };
const fs = require('node:fs'); const read = fs.readFileSync;
const path = require('node:path'), os = require('node:os');
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
  const state = { events: [], files: new Map(), missing: false, drift: false, badRole: false, compatible: true, innerArgs: [] };
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
      identity: structuredClone(identity), query: async (sql, values) => { state.events.push(sql); return state.missing ? [] : (values || []).map(name => ({ name })); },
      close: async () => { state.events.push('close_event'); return { physicalCloseObserved: true, physicalStreamDestroyed: true }; } }; },
    privateDirectory() {}, writePrivate: (path, value) => { assert.equal(state.files.has(path), false); state.files.set(path, JSON.stringify(value)); return { path, sha256: P.sha(state.files.get(path)) }; },
    hashFile: path => P.sha(state.files.get(path)),
    check: { sourceInfo: () => structuredClone(info), run: async args => {
      state.innerArgs = args.slice();
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
  return { state, deps, info };
}
test('one command derives a fresh app binding and uses each runtime own check without admin/snapshot/DDL', async () => {
  for (const runtime of ['staging', 'gateway']) {
    const f = fixture(runtime);
    const result = await Q.run(['--runtime', runtime, '--require-migration', NAME], f.deps);
    assert.equal(result.compatible, true); assert.equal(result.ddlStatements, 0); assert.equal(result.administrationSecretRead, false);
    assert.equal(result.snapshotCreated, false); assert.deepEqual(result.missingRequiredMigrations, []);
    assert.deepEqual(f.state.innerArgs.slice(-2), ['--require-migration', NAME]);
    assert.equal(JSON.stringify([...f.state.files.values()]).includes('TEST_ONLY_NOT_A_REAL_PASSWORD'), false);
    assert.equal(f.state.events.some(event => /CREATE|INSERT|UPDATE|DELETE|ALTER|DROP/.test(event)), false);
  }
});
test('all selected migration requirements reach the actual checker even when delegation is disabled', async () => {
  const f = fixture('staging'), delegated = '20261028110000-create-delegated-sessions.js';
  f.info.migrations[delegated] = 'f'.repeat(64);
  const observe = f.deps.observe; f.deps.observe = () => ({ env: { ...observe().env, AUTH_DELEGATION_ENABLED: 'false' } });
  const actualCheck = f.deps.check.run;
  f.deps.check.run = async args => {
    const result = await actualCheck(args);
    const required = args.flatMap((value, index) => value === '--require-migration' ? [args[index + 1]] : []);
    assert.deepEqual(required, [NAME, delegated]);
    // Models the real check's selected-feature branch: metadata/grants are
    // mandatory despite its runtime flag being off.
    return { ...result, compatible: required.includes(delegated), delegationGrants: { compatible: required.includes(delegated) } };
  };
  const result = await Q.run(['--runtime', 'staging', '--require-migration', NAME, '--require-migration', delegated], f.deps);
  assert.equal(result.compatible, true); assert.deepEqual(result.requiredMigrations, [NAME, delegated]);
});
function codeTree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-rds-check-pins-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const relative of Q.CODE) { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '// TEST_ONLY public helper ' + relative); }
  return root;
}
test('legacy runtime has six guarded pins and new runtime adds its seventh helper pin', async t => {
  const root = codeTree(t), f = fixture('gateway'); f.deps.codePins = () => Q.codePins(root);
  assert.equal(Q.CODE.length, 6); assert.equal(Q.codePins(root).length, 6);
  assert.equal((await Q.run(['--runtime', 'gateway'], f.deps)).runtimeCheckCodeRefs.length, 6);
  const file = path.join(root, 'src/lib/delegatedSchemaPreflight.js'); fs.writeFileSync(file, '// TEST_ONLY delegated helper');
  const actual = fixture('staging'); actual.deps.codePins = () => Q.codePins(root);
  const result = await Q.run(['--runtime', 'staging'], actual.deps);
  assert.equal(result.runtimeCheckCodeRefs.length, 7);
  assert.equal(result.runtimeCheckCodeRefs.at(-1).sha256, P.sha(fs.readFileSync(file)));
});
test('optional helper symlink, broken symlink, and pin-set or content drift fail closed', async t => {
  const root = codeTree(t), optional = path.join(root, 'src/lib/delegatedSchemaPreflight.js');
  fs.symlinkSync(path.join(root, Q.CODE[0]), optional);
  assert.throws(() => Q.codePins(root), /runtime_check_code/); fs.unlinkSync(optional);
  fs.symlinkSync(path.join(root, 'absent-public-helper'), optional);
  assert.throws(() => Q.codePins(root), error => error.code === 'ENOENT'); fs.unlinkSync(optional);
  for (const mutate of [() => fs.writeFileSync(optional, '// TEST_ONLY appeared'), () => fs.appendFileSync(path.join(root, Q.CODE[0]), '// TEST_ONLY changed')]) {
    const f = fixture('staging'); f.deps.codePins = () => Q.codePins(root); const check = f.deps.check.run;
    f.deps.check.run = async args => { const result = await check(args); mutate(); return result; };
    await assert.rejects(Q.run(['--runtime', 'staging'], f.deps), /runtime_check_changed/);
    assert.equal([...f.state.files.keys()].some(file => file.endsWith('/result.json')), false);
  }
});
test('a runtime checker that requires a missing helper still fails closed before publishing a result', async t => {
  const root = codeTree(t), f = fixture('staging'); f.deps.codePins = () => Q.codePins(root);
  f.deps.check.run = async () => { throw Object.assign(Error('TEST_ONLY_new_runtime_missing_required_helper'), { code: 'MODULE_NOT_FOUND' }); };
  await assert.rejects(Q.run(['--runtime', 'staging', '--require-migration', NAME], f.deps), error => error.code === 'MODULE_NOT_FOUND');
  assert.equal([...f.state.files.keys()].some(file => file.endsWith('/result.json')), false);
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
