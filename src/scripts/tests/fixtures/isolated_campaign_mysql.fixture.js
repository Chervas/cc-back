'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Sequelize } = require('sequelize');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// This fixture owns its mysqld process and data directory. It cannot connect to TCP or the host socket.
async function withIsolatedCampaignMysql(work) {
  if (process.env.CAMPAIGN_OPTIMIZATION_MYSQL_TEST !== '1') throw Error('Explicit CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 is required');
  const root = fs.mkdtempSync('/tmp/cc-campaign-opt-mysql-');
  fs.chmodSync(root, 0o700);
  const data = path.join(root, 'data'); fs.mkdirSync(data, { mode: 0o700 });
  const socketPath = path.join(root, 'mysql.sock');
  const log = path.join(root, 'mysql-error.log');
  const originalConnect = net.Socket.prototype.connect;
  require('./campaign_offline_runtime.cjs');
  const rejected = [];
  net.Socket.prototype.connect = function (...args) {
    const input = Array.isArray(args[0]) ? args[0][0] : args[0];
    const socket = typeof input === 'string' ? input : input?.path;
    if (socket !== socketPath || input?.port || input?.host) {
      rejected.push('non-test socket'); throw Error('NETWORK_FORBIDDEN_IN_MYSQL_CAMPAIGN_TEST');
    }
    return originalConnect.apply(this, args);
  };
  const models = {};
  const modelFile = require.resolve('../../../../models');
  if (require.cache[modelFile]) throw Error('Production model index must not be loaded before this fixture');
  require.cache[modelFile] = { id: modelFile, filename: modelFile, loaded: true, exports: models };
  const report = { root, database: 'campaign_optimization_qa', checks: [], rejected, success: false };
  let child; let exited; let admin; let sql;
  try {
    await promisify(execFile)('/usr/sbin/mysqld', ['--no-defaults', '--initialize-insecure', `--datadir=${data}`,
      `--log-error=${log}`, '--innodb-buffer-pool-size=64M'], { timeout: 90000, env: { PATH: '/usr/sbin:/usr/bin:/bin', HOME: root } });
    child = spawn('/usr/sbin/mysqld', ['--no-defaults', `--datadir=${data}`, `--socket=${socketPath}`,
      `--pid-file=${path.join(root, 'mysql.pid')}`, `--log-error=${log}`, '--skip-networking', '--mysqlx=0', '--skip-log-bin',
      '--innodb-buffer-pool-size=64M', '--performance-schema=OFF', '--max-connections=32', '--skip-name-resolve'],
    { stdio: 'ignore', env: { PATH: '/usr/sbin:/usr/bin:/bin', HOME: root } });
    exited = new Promise(resolve => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', error => resolve({ error: error.message })); });
    const config = { username: 'root', password: '', host: 'localhost', dialect: 'mysql', dialectOptions: { socketPath }, logging: false,
      pool: { min: 0, max: 12, acquire: 15000, idle: 1000 } };
    admin = new Sequelize({ ...config, database: undefined });
    const deadline = Date.now() + 30000;
    for (;;) {
      if (child.exitCode !== null || child.signalCode) throw Error('Temporary mysqld exited before readiness');
      try { await admin.authenticate(); break; }
      catch (error) { if (Date.now() >= deadline || rejected.length) throw error; await delay(100); }
    }
    const [rows] = await admin.query('SELECT @@datadir AS datadir, @@skip_networking AS isolated, VERSION() AS version');
    assert.equal(fs.realpathSync(rows[0].datadir), fs.realpathSync(data)); assert.equal(Number(rows[0].isolated), 1);
    report.mysql = rows[0].version; report.pid = child.pid;
    await admin.query('CREATE DATABASE campaign_optimization_qa');
    sql = new Sequelize({ ...config, database: report.database, timezone: '+00:00' });
    sql.addHook('afterConnect', connection => new Promise((resolve, reject) => connection.query('SET SESSION innodb_lock_wait_timeout = 5', error => error ? reject(error) : resolve())));
    models.sequelize = sql;
    await work({ sql, models, report });
    assert.equal(rejected.length, 0, 'No other database, Redis or provider connection is allowed');
    report.success = true;
  } catch (error) {
    report.error = { message: error.message, code: error.original?.code || error.code || null };
    throw error;
  } finally {
    const cleanupErrors = [];
    for (const [name, connection] of [['sql', sql], ['admin', admin]]) {
      if (!connection) continue;
      let timer;
      try {
        await Promise.race([connection.close(), new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error(`${name} close timed out`)), 5000);
        })]);
      } catch (error) { cleanupErrors.push(error.message); }
      finally { clearTimeout(timer); }
    }
    if (child && child.exitCode === null && !child.signalCode) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => { if (child.exitCode === null && !child.signalCode) { report.forcedShutdown = true; child.kill('SIGKILL'); } }, 20000);
      report.shutdown = await exited; clearTimeout(timer);
    } else if (exited) report.shutdown = await exited;
    if (report.forcedShutdown || report.shutdown?.code !== 0 && child) cleanupErrors.push('Temporary mysqld did not exit cleanly');
    if (cleanupErrors.length) { report.cleanupErrors = cleanupErrors; report.success = false; }
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(report));
    if (cleanupErrors.length && !report.error) throw Error('Isolated MySQL cleanup failed; inspect result.json');
  }
}

module.exports = { withIsolatedCampaignMysql };
