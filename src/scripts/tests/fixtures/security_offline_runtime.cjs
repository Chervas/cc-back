'use strict';
// Isolated process only: never load the real .env or start a queue/database connection.
require('./campaign_offline_runtime.cjs');
const forbiddenConnection = () => { throw Error('NETWORK_FORBIDDEN_IN_OFFLINE_SECURITY_TEST'); };
require('node:net').connect = forbiddenConnection;
require('node:net').createConnection = forbiddenConnection;
require('node:tls').connect = forbiddenConnection;
const file = require.resolve('dotenv');
require.cache[file] = { id: file, filename: file, loaded: true, exports: { config: () => ({ parsed: {} }) } };
Object.assign(process.env, { NODE_ENV: 'test', DB_USERNAME: 'offline', DB_PASSWORD: 'fictitious', DB_NAME: 'offline',
  // A fictitious remote hostname correctly trips the production TLS guard.
  // Local test configuration is explicit; all ordinary socket paths stay denied.
  DB_HOST: '127.0.0.1', DB_PORT: '1', DB_TLS_REQUIRED: 'false', DB_TLS_CA_FILE: '',
  DB_SOCKET_PATH: '', DB_SOCKET: '', DB_SQL_LOGGING: 'false', JWT_SECRET: require('node:crypto').randomBytes(32).toString('hex'),
  AUTH_SESSION_MODE: 'legacy', AUTH_EMAIL_MFA_MODE: 'off', AUTH_SESSION_EXPIRY_ENABLED: 'false',
  PLATFORM_AUDIT_VIEW_ENABLED: 'false', PLATFORM_AUDIT_RECONCILIATION_ENABLED: 'false',
  PLATFORM_AUDIT_PERMISSIONS_ENABLED: 'false', PLATFORM_AUDIT_REALTIME_ENABLED: 'false',
  PLATFORM_AUDIT_PATIENT_READS_ENABLED: 'false', PLATFORM_AUDIT_AUTH_ENABLED: 'false', PLATFORM_AUDIT_DELIVERY_ENABLED: 'false', PLATFORM_AUDIT_MONITOR_ENABLED: 'false',
  JOBS_AUTO_START: 'false', RUNTIME_ROLE: 'gateway', AWS_INFRA_COSTS_ENABLED: 'false',
  GOOGLE_OAUTH_BROKER_ENABLED: 'false', GOOGLE_OAUTH_BROKER_WORKER_ENABLED: 'false',
  GOOGLE_SEARCH_CONSOLE_BROKER_ENABLED: 'false',
  GOOGLE_ANALYTICS_BROKER_ENABLED: 'false',
  GOOGLE_BUSINESS_PROFILE_BROKER_ENABLED: 'false', GOOGLE_BUSINESS_PROFILE_WRITES_ENABLED: 'false', GOOGLE_BUSINESS_PROFILE_REVOCATION_ENABLED: 'false', GOOGLE_BUSINESS_PROFILE_REVOCATION_WORKER_ENABLED: 'false' });
