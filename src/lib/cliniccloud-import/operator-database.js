'use strict';

// Operator-only SQL connection. Never bootstraps application models, workers or
// mutates process.env. CRM credentials must not be copied into isolated DEV.
const fs = require('node:fs');
const dotenv = require('dotenv');
const { buildDatabaseTlsOptions } = require('../databaseTlsConfig');

const TARGETS = Object.freeze({
  dev: '/home/ubuntu/wt/back-dev/.env',
  crm: '/home/ubuntu/wt/back-staging/.env',
});

function databaseOptions(target, { readFile = filename => fs.readFileSync(filename), stat = filename => fs.lstatSync(filename) } = {}) {
  if (!Object.hasOwn(TARGETS, target)) throw Error('EXPLICIT_DATABASE_TARGET_REQUIRED');
  const filename = TARGETS[target];
  const metadata = stat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077)) throw Error('OPERATOR_ENV_PERMISSIONS_INVALID');
  const env = dotenv.parse(readFile(filename));
  if (!env.DB_HOST || !env.DB_USERNAME || !env.DB_NAME || !env.DB_PASSWORD) throw Error('OPERATOR_DATABASE_CONFIG_INCOMPLETE');
  const isolated = env.DB_NAME === 'clinicaclick_dev_isolated' && env.DB_USERNAME === 'cc_dev_api';
  if ((target === 'dev' && !isolated) || (target === 'crm' && /isolated|\bdev\b/i.test(env.DB_NAME))) throw Error('OPERATOR_DATABASE_TARGET_MISMATCH');
  return { host: env.DB_HOST, port: Number(env.DB_PORT || 3306), user: env.DB_USERNAME,
    password: env.DB_PASSWORD, database: env.DB_NAME, dateStrings: true, timezone: 'Z',
    multipleStatements: false, ...buildDatabaseTlsOptions(env) };
}

async function connectOperatorDatabase(target) {
  const connection = await require('mysql2/promise').createConnection(databaseOptions(target));
  try {
    await connection.query('SET SESSION MAX_EXECUTION_TIME = 15000');
    await connection.query('SET SESSION innodb_lock_wait_timeout = 5');
    return connection;
  } catch (error) { await connection.end(); throw error; }
}

module.exports = { databaseOptions, connectOperatorDatabase };
