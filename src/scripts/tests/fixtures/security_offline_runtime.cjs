'use strict';
// Isolated process only: never load the real .env or start a queue/database connection.
require('./campaign_offline_runtime.cjs');
const file = require.resolve('dotenv');
require.cache[file] = { id: file, filename: file, loaded: true, exports: { config: () => ({ parsed: {} }) } };
Object.assign(process.env, { NODE_ENV: 'test', DB_USERNAME: 'offline', DB_PASSWORD: 'fictitious', DB_NAME: 'offline',
  DB_HOST: 'offline.invalid', DB_SQL_LOGGING: 'false', JWT_SECRET: require('node:crypto').randomBytes(32).toString('hex'),
  JOBS_AUTO_START: 'false', RUNTIME_ROLE: 'gateway', AWS_INFRA_COSTS_ENABLED: 'false' });
