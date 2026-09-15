'use strict';
// Run inside the isolated service boundary. Output contains booleans only.
const fs = require('node:fs'); const net = require('node:net');
const mysql = require('mysql2/promise');
async function reachable(host, port) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port }); const finish = result => { socket.destroy(); resolve(result); };
    socket.setTimeout(1500, () => finish(false)); socket.on('connect', () => finish(true)); socket.on('error', () => finish(false));
  });
}
async function main() {
  require('../../lib/devRuntimeIsolation').assertDevRuntimeIsolation();
  const denied = {};
  for (const filename of ['/home/ubuntu/wt/back-staging/.env', '/home/ubuntu/wt/gateway/.env', '/home/ubuntu/.aws/config',
    '/home/ubuntu/.pm2/dump.pm2', '/etc/clinicaclick-security-mfa-20260914/email-mfa.key', '/etc/mysql/debian.cnf']) {
    try { fs.accessSync(filename, fs.constants.R_OK); denied[filename] = false; } catch { denied[filename] = true; }
  }
  const network = {};
  for (const [host, port] of [['127.0.0.1', 3306], ['127.0.0.1',6384], ['127.0.0.1',6379], ['127.0.0.1',3000],
    ['127.0.0.1',3001], ['13.39.100.55',8443], ['13.39.100.55',8445], ['169.254.169.254',80], ['1.1.1.1',443], ['::1',6379]])
    network[host + ':' + port] = await reachable(host, port);
  const connection = await mysql.createConnection({ host: process.env.DB_HOST, user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME, connectTimeout: 2000 });
  const forbiddenTables = {};
  try {
    for (const table of ['AuthSessions', 'MetaConnections', 'Citas', 'Usuarios']) {
      try { await connection.query('SELECT 1 FROM clinicaclick.' + table + ' LIMIT 0'); forbiddenTables[table] = false; }
      catch (e) { forbiddenTables[table] = e.code === 'ER_TABLEACCESS_DENIED_ERROR' || e.code === 'ER_DBACCESS_DENIED_ERROR'; }
    }
    await connection.query('SELECT 1 FROM Usuarios LIMIT 0');
  } finally { await connection.end(); }
  const Redis = require('ioredis'); const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 0, retryStrategy: () => null });
  const redisOwn = await redis.ping() === 'PONG'; await redis.quit();
  const report = { uid: process.getuid(), denied, network, forbiddenTables, redisOwn,
    passed: Object.values(denied).every(Boolean) && Object.values(forbiddenTables).every(Boolean) && redisOwn
      && Object.entries(network).every(([key, value]) => value === ['127.0.0.1:3306','127.0.0.1:6384'].includes(key)) };
  process.stdout.write(JSON.stringify(report) + '\n'); if (!report.passed) process.exitCode = 1;
}
main().catch(() => { process.stderr.write('dev_isolation_probe_failed\n'); process.exitCode = 1; });
