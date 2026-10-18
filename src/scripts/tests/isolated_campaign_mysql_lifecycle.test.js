'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const { ownedMysqlDataLifecycle } = require('./fixtures/isolated_mysql_data_lifecycle.fixture');

function ownedDirectories(t) {
  const root = fs.mkdtempSync('/tmp/cc-campaign-opt-mysql-');
  fs.chmodSync(root, 0o700);
  const data = path.join(root, 'data');
  fs.mkdirSync(data, { mode: 0o700 });
  fs.writeFileSync(path.join(data, 'owned-test-data'), 'synthetic fixture');
  fs.writeFileSync(path.join(root, 'result.json'), '{"success":true}');
  fs.writeFileSync(path.join(root, 'mysql-error.log'), 'synthetic log');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, data };
}

test('successful, closed fixture removes only its owned data and keeps evidence', t => {
  const { root, data } = ownedDirectories(t);
  const finish = ownedMysqlDataLifecycle(root, data);
  assert.equal(finish({ successful: true, closedCleanly: true }).status, 'removed');
  assert.equal(fs.existsSync(data), false);
  assert.equal(fs.readFileSync(path.join(root, 'mysql-error.log'), 'utf8'), 'synthetic log');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'result.json'))).success, true);
});

for (const [name, options, reason] of [
  ['failed test', { successful: false, closedCleanly: true }, 'test_failed'],
  ['unclean shutdown', { successful: true, closedCleanly: false }, 'unclean_shutdown'],
  ['explicit reproduction request', { successful: true, closedCleanly: true, keepData: true }, 'explicit_keep'],
]) {
  test(`${name} preserves the owned data directory`, t => {
    const { root, data } = ownedDirectories(t);
    assert.equal(ownedMysqlDataLifecycle(root, data)(options).reason, reason);
    assert.equal(fs.readFileSync(path.join(data, 'owned-test-data'), 'utf8'), 'synthetic fixture');
  });
}

test('cleanup refuses a replaced data directory and a symlink to another fixture', t => {
  const first = ownedDirectories(t), second = ownedDirectories(t);
  const finish = ownedMysqlDataLifecycle(first.root, first.data);
  fs.renameSync(first.data, path.join(first.root, 'original-data'));
  fs.mkdirSync(first.data, { mode: 0o700 });
  assert.throws(() => finish({ successful: true, closedCleanly: true }), /was replaced/);
  fs.rmdirSync(first.data);
  fs.symlinkSync(second.data, first.data, 'dir');
  assert.throws(() => finish({ successful: true, closedCleanly: true }), /must not be a symlink/);
  assert.equal(fs.readFileSync(path.join(second.data, 'owned-test-data'), 'utf8'), 'synthetic fixture');
});

test('cleanup refuses a replaced root without removing replacement data', t => {
  const { root, data } = ownedDirectories(t);
  const finish = ownedMysqlDataLifecycle(root, data);
  const moved = `${root}-original`;
  fs.renameSync(root, moved);
  t.after(() => fs.rmSync(moved, { recursive: true, force: true }));
  fs.mkdirSync(root, { mode: 0o700 });
  fs.mkdirSync(data, { mode: 0o700 });
  fs.writeFileSync(path.join(data, 'replacement'), 'keep');
  assert.throws(() => finish({ successful: true, closedCleanly: true }), /root was replaced/);
  assert.equal(fs.readFileSync(path.join(data, 'replacement'), 'utf8'), 'keep');
});

test('cleanup cannot target the evidence root or another fixture', t => {
  const first = ownedDirectories(t), second = ownedDirectories(t);
  assert.throws(() => ownedMysqlDataLifecycle(first.root, first.root), /Only the owned data directory/);
  assert.throws(() => ownedMysqlDataLifecycle(first.root, second.data), /Only the owned data directory/);
  assert.equal(fs.existsSync(second.data), true);
});

// Exercise the fixture's real finally/report flow without starting mysqld or
// loading application models. Only the child process and SQL driver are doubles.
async function exerciseFixture(t, { failWork = false, failInitialize = false, failClose = false,
  failDelete = false, shutdownCode = 0, keepData, keepFlag } = {}) {
  const filename = path.join(__dirname, 'fixtures/isolated_campaign_mysql.fixture.js');
  const localRequire = createRequire(filename);
  const roots = [], sqlConfigurations = [], commands = [], reports = [];
  let datadir;
  const fsDouble = { ...fs,
    mkdtempSync(prefix) {
      const root = fs.mkdtempSync(prefix); roots.push(root);
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      return root;
    },
  };
  class SqlDouble {
    constructor(config) { sqlConfigurations.push(config); }
    async authenticate() {}
    async query(text) {
      if (text.startsWith('SELECT @@datadir')) return [[{ datadir, isolated: 1, performance_schema: 0, version: 'synthetic-mysql' }]];
      assert.equal(text, 'CREATE DATABASE campaign_optimization_qa');
      return [];
    }
    addHook() {}
    async close() { if (failClose) throw Error('synthetic connection close failure'); }
  }
  const childProcessDouble = {
    execFile(binary, args, options, callback) {
      commands.push({ binary, args });
      callback(failInitialize ? Error('synthetic initialize failure') : null, '', '');
    },
    spawn(binary, args) {
      commands.push({ binary, args });
      datadir = args.find(value => value.startsWith('--datadir=')).slice('--datadir='.length);
      fs.writeFileSync(path.join(datadir, 'synthetic-ibdata'), 'owned test data');
      const child = new EventEmitter();
      child.pid = 123; child.exitCode = null; child.signalCode = null;
      child.kill = signal => {
        assert.equal(signal, 'SIGTERM');
        child.exitCode = shutdownCode;
        queueMicrotask(() => child.emit('exit', shutdownCode, null));
        return true;
      };
      return child;
    },
  };
  const isolatedRequire = name => {
    if (name === 'node:fs') return fsDouble;
    if (name === 'node:child_process') return childProcessDouble;
    if (name === 'node:net') return { Socket: { prototype: { connect() { throw Error('No real network allowed'); } } } };
    if (name === 'sequelize') return { Sequelize: SqlDouble };
    if (name === './campaign_offline_runtime.cjs') return {};
    if (name === './isolated_mysql_data_lifecycle.fixture') return {
      ownedMysqlDataLifecycle(root, data) {
        return ownedMysqlDataLifecycle(root, data, { fsImpl: failDelete ? {
          ...fs, rmSync() { throw Object.assign(Error('synthetic delete failure'), { code: 'EACCES' }); },
        } : fs });
      },
    };
    return localRequire(name);
  };
  isolatedRequire.resolve = name => localRequire.resolve(name);
  isolatedRequire.cache = {};
  const moduleDouble = { exports: {} };
  const env = { CAMPAIGN_OPTIMIZATION_MYSQL_TEST: '1' };
  if (keepFlag !== undefined) env.CAMPAIGN_OPTIMIZATION_MYSQL_KEEP_DATA = keepFlag;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: isolatedRequire, module: moduleDouble, setTimeout, clearTimeout,
    process: { env, getuid: () => process.getuid() },
    console: { log(value) { reports.push(JSON.parse(value)); } },
  }, { filename });
  let observedError;
  try {
    await moduleDouble.exports.withIsolatedCampaignMysql(async () => {
      if (failWork) throw Error('synthetic assertion failure');
    }, keepData === undefined ? {} : { keepData });
  } catch (error) { observedError = error; }
  assert(sqlConfigurations.every(config => config.dialectOptions.socketPath.startsWith(roots[0] + path.sep)));
  assert(commands.every(command => command.binary === '/usr/sbin/mysqld' && command.args.includes('--no-defaults')));
  if (commands.length === 2) assert(commands[1].args.includes('--skip-networking') && commands[1].args.includes('--skip-log-bin'));
  return { roots, observedError, report: reports[0], commands };
}

test('fixture removes successful data after shutdown and persists result/log', async t => {
  const { roots: [root], report, observedError } = await exerciseFixture(t);
  assert.equal(observedError, undefined);
  assert.equal(report.success, true);
  assert.equal(report.shutdown.code, 0);
  assert.equal(report.dataCleanup.status, 'removed');
  assert.equal(fs.existsSync(path.join(root, 'data')), false);
  assert.equal(fs.existsSync(path.join(root, 'mysql-error.log')), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'result.json'))).dataCleanup.status, 'removed');
});

for (const [name, options] of [
  ['assertion failure', { failWork: true }],
  ['initialization failure', { failInitialize: true }],
  ['connection close failure', { failClose: true }],
  ['unclean mysqld exit', { shutdownCode: 1 }],
]) {
  test(`fixture retains data and reports ${name}`, async t => {
    const { roots: [root], report, observedError } = await exerciseFixture(t, options);
    assert(observedError);
    assert.equal(report.success, false);
    assert.equal(report.dataCleanup.status, 'retained');
    assert.equal(fs.existsSync(path.join(root, 'data')), true);
    assert.equal(fs.existsSync(path.join(root, 'mysql-error.log')), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'result.json'))).success, false);
  });
}

for (const options of [{ keepData: true }, { keepFlag: '1' }]) {
  test(`fixture supports explicit retention through ${options.keepData ? 'option' : 'environment'}`, async t => {
    const { roots: [root], report, observedError } = await exerciseFixture(t, options);
    assert.equal(observedError, undefined);
    assert.equal(report.success, true);
    assert.equal(report.dataCleanup.reason, 'explicit_keep');
    assert.equal(fs.existsSync(path.join(root, 'data')), true);
  });
}

test('data removal failure fails the fixture visibly and preserves evidence', async t => {
  const { roots: [root], report, observedError } = await exerciseFixture(t, { failDelete: true });
  assert.match(observedError.message, /cleanup failed/);
  assert.equal(report.success, false);
  assert.equal(report.dataCleanup.status, 'failed');
  assert.equal(report.dataCleanup.code, 'EACCES');
  assert(report.cleanupErrors.some(value => value.includes('synthetic delete failure')));
  assert.equal(fs.existsSync(path.join(root, 'data')), true);
  assert.equal(fs.existsSync(path.join(root, 'mysql-error.log')), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'result.json'))).success, false);
});

test('invalid keep flag fails before creating any directory or starting MySQL', async t => {
  const { roots, commands, observedError } = await exerciseFixture(t, { keepFlag: 'yes' });
  assert.match(observedError.message, /must be 0 or 1/);
  assert.equal(roots.length, 0);
  assert.equal(commands.length, 0);
});
