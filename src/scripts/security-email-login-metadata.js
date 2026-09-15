#!/usr/bin/env node
'use strict';
// Read-only preparation for the public email-login cut. No app/models, workers,
// AWS SDK, mail transport or migration execution is loaded.
const fs = require('node:fs'); const path = require('node:path');
const { configuration } = require('./security-database-metadata');
const ROOTS = Object.freeze({ dev: '/home/ubuntu/wt/back-dev', staging: '/home/ubuntu/wt/back-staging', gateway: '/home/ubuntu/wt/gateway' });
const TABLES = Object.freeze({
  Usuarios: ['id_usuario','email_usuario','password_usuario','estado_cuenta','es_provisional','ultimo_login'],
  AuthSessions: ['session_id','user_id','issued_at','expires_at','absolute_expires_at','credential_binding','state','ended_at','authentication_method','email_verified_at','email_challenge_id','trusted_device_id'],
  AuthTrustedDevices: ['device_id','user_id','token_hash','key_binding','credential_binding','creation_session_id','email_verified_at','created_at','expires_at','revoked_at','last_used_at'],
  AuthEmailChallenges: ['challenge_id','user_id','challenge_hash','code_hash','credential_binding','email_hash','state','created_at','expires_at','absolute_expires_at','last_sent_at','attempts','sends','verified_at','consumed_session_id','email_message_id'],
  PlatformAuditEvents: ['event_id','correlation_id','stage','result_part','occurred_at','body','digest','state','receipt','lease_token','lease_until','attempts','next_attempt_at','last_error','delivered_at'],
  PlatformAuditDeliveryStates: ['state_key','lease_token','lease_until'],
  EmailMessages: ['id','template_key','template_version','recipient_email_envelope','recipient_hash','template_context','status','job_request_id','related_type','related_id'],
  PasswordResetTokens: ['id','user_id','token_hash','status','email_message_id'],
  JobRequests: ['id','type','status','payload'],
});
const MIGRATIONS = Object.freeze(['20260829120000-create-email-system.js','20251020100000-create-job-requests.js',
  '20260912210000-create-platform-audit-events.js','20260912213000-create-platform-audit-delivery-states.js',
  '20260913003000-add-platform-audit-result-part.js','20260912220000-create-auth-sessions.js','20260913130000-create-auth-email-challenges.js','20260914220000-create-auth-trusted-devices.js']);
function observedEnvironment(runtime) {
  if (!Object.hasOwn(ROOTS, runtime)) throw Error('email_login_metadata_invalid');
  const isolated = runtime === 'dev' && fs.existsSync('/etc/clinicaclick-dev/runtime.env');
  if (isolated && process.getuid() !== 0) throw Error('email_login_metadata_isolated_dev_requires_root');
  const root = isolated ? fs.realpathSync('/opt/clinicaclick-dev/current') : ROOTS[runtime];
  const file = isolated ? '/etc/clinicaclick-dev/runtime.env' : path.join(root, '.env');
  const env = require('dotenv').parse(fs.readFileSync(file)); const processes = [];
  for (const pid of fs.readdirSync('/proc').filter(v => /^[1-9][0-9]*$/.test(v))) {
    try {
      const prefix = '/proc/' + pid; if (fs.realpathSync(prefix + '/cwd') !== root) continue;
      const args = fs.readFileSync(prefix + '/cmdline').toString().split('\0');
      if (!(args[0] === 'node' || args[0].endsWith('/node')) || args[1] !== 'src/app.js') continue;
      const startup = Object.fromEntries(fs.readFileSync(prefix + '/environ').toString().split('\0').filter(v => v.includes('=')).map(v => {
        const at = v.indexOf('='); return [v.slice(0, at), v.slice(at + 1)];
      }));
      const name = { dev: 'pm2-back-dev', staging: 'pm2-back-staging', gateway: 'pm2-gateway' }[runtime];
      if (startup.name !== name) continue;
      processes.push({ pid: Number(pid), uid: fs.statSync(prefix).uid, name, startup });
    } catch {}
  }
  if (processes.length !== 1) throw Error('email_login_runtime_ambiguous');
  return { root, env: { ...env, ...processes[0].startup }, process: { pid: processes[0].pid, uid: processes[0].uid, name: processes[0].name } };
}
async function collect(query) {
  const names = Object.keys(TABLES); const placeholders = names.map(() => '?').join(',');
  const [tables, columns, indexes] = await Promise.all([
    query('SELECT TABLE_NAME, ENGINE, TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (' + placeholders + ')', names),
    query('SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (' + placeholders + ') ORDER BY TABLE_NAME,ORDINAL_POSITION', names),
    query('SELECT TABLE_NAME,INDEX_NAME,NON_UNIQUE,COLUMN_NAME,SEQ_IN_INDEX FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (' + placeholders + ') ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX', names),
  ]);
  const result = {};
  for (const name of names) {
    const table = tables.find(row => row.TABLE_NAME === name); const cols = columns.filter(row => row.TABLE_NAME === name);
    result[name] = { exists: Boolean(table), engine: table?.ENGINE || null, approximateRows: table?.TABLE_ROWS ?? null,
      missingColumns: TABLES[name].filter(column => !cols.some(c => c.COLUMN_NAME === column)),
      columns: cols.map(row => ({ name: row.COLUMN_NAME, type: row.COLUMN_TYPE, nullable: row.IS_NULLABLE === 'YES' })),
      indexes: indexes.filter(row => row.TABLE_NAME === name).map(row => ({ name: row.INDEX_NAME, unique: row.NON_UNIQUE === 0, column: row.COLUMN_NAME, position: row.SEQ_IN_INDEX })) };
  }
  const meta = await query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='SequelizeMeta'", []);
  const applied = meta.length ? await query('SELECT name FROM SequelizeMeta WHERE name IN (' + MIGRATIONS.map(() => '?').join(',') + ')', MIGRATIONS) : [];
  return { tables: result, migrations: Object.fromEntries(MIGRATIONS.map(name => [name, applied.some(row => row.name === name)])),
    schemaCompatibleByColumnPresenceOnly: Object.values(result).every(value => value.exists && value.missingColumns.length === 0) };
}
async function run(args) {
  if (args.length !== 5 || args[0] !== '--read-only' || args[1] !== '--runtime' || !['staging','gateway'].includes(args[2]) || args[3] !== '--out') throw Error('email_login_metadata_invalid');
  const output = args[4]; const evidence = '/home/ubuntu/qa-evidence/security-migration-20260912';
  if (path.dirname(output) !== evidence || fs.realpathSync(evidence) !== evidence) throw Error('email_login_metadata_invalid');
  const fd = fs.openSync(output, 'wx', 0o600); let connection;
  try {
    const observed = observedEnvironment(args[2]); const env = observed.env;
    const config = configuration(env);
    if (!fs.statSync(config.socketPath).isSocket()) throw Error();
    connection = await require('mysql2/promise').createConnection(config);
    const report = { at: new Date().toISOString(), runtime: args[2], process: observed.process, mode: 'read_only_metadata',
      limitation: 'Configuration combines current .env and process startup; this is not a dump of effective JS configuration. Row counts are InnoDB estimates.',
      settings: Object.fromEntries(['RUNTIME_NAMESPACE','JOB_RUNTIME_NAMESPACE','QUEUE_PREFIX','JOBS_WORKER_ENABLED','JOBS_CRON_LEADER',
        'AUTH_EMAIL_MFA_MODE','AUTH_SESSION_MODE','PLATFORM_AUDIT_AUTH_ENABLED','PLATFORM_AUDIT_AUTH_POLICY','PLATFORM_AUDIT_DELIVERY_ENABLED',
        'EMAIL_PROVIDER','EMAIL_ENABLED','EMAIL_SES_SANDBOX_MODE','EMAIL_REQUIRE_RECIPIENT_ALLOWLIST'].map(k => [k, env[k] ?? null])),
      configuredOnly: Object.fromEntries(['JWT_SECRET','AUTH_EMAIL_MFA_KEY_FILE','EMAIL_DATA_ENCRYPTION_KEY','EMAIL_AWS_ACCESS_KEY_ID',
        'EMAIL_AWS_SECRET_ACCESS_KEY','PLATFORM_AUDIT_WRITER_SOURCE_ROLE_ARN','PLATFORM_AUDIT_NODE_BINARY'].map(k => [k, Boolean(env[k])])),
      recipientAllowlistCount: String(env.EMAIL_RECIPIENT_ALLOWLIST || env.EMAIL_SANDBOX_RECIPIENT_ALLOWLIST || '').split(',').filter(v => v.trim()).length,
      schema: await collect(async (sql, values) => (await connection.query({ sql, values, timeout: 5000 }))[0]) };
    const dev = observedEnvironment('dev');
    report.devComparison = { sameOsUid: dev.process.uid === observed.process.uid,
      sameDbIdentityConfigured: ['DB_HOST','DB_NAME','DB_USERNAME'].every(k => dev.env[k] && dev.env[k] === env[k]),
      sameJwtSecretConfigured: Boolean(env.JWT_SECRET && dev.env.JWT_SECRET && env.JWT_SECRET === dev.env.JWT_SECRET),
      sameEmailEncryptionKeyConfigured: Boolean(env.EMAIL_DATA_ENCRYPTION_KEY && env.EMAIL_DATA_ENCRYPTION_KEY === dev.env.EMAIL_DATA_ENCRYPTION_KEY) };
    fs.writeFileSync(fd, JSON.stringify(report, null, 2) + '\n');
    return { evidence: output, runtime: args[2], schemaCompatibleByColumnPresenceOnly: report.schema.schemaCompatibleByColumnPresenceOnly,
      missingTables: Object.entries(report.schema.tables).filter(([,value]) => !value.exists).map(([name]) => name), devComparison: report.devComparison };
  } catch {
    fs.writeFileSync(fd, JSON.stringify({ status: 'unavailable', code: 'email_login_metadata_unavailable' }) + '\n');
    throw Error('email_login_metadata_unavailable');
  } finally { try { if (connection) await connection.end(); } finally { fs.closeSync(fd); } }
}
if (require.main === module) run(process.argv.slice(2)).then(value => process.stdout.write(JSON.stringify(value) + '\n')).catch(() => {
  process.stderr.write('email_login_metadata_unavailable; no credentials or raw errors emitted\n'); process.exitCode = 1;
});
module.exports = { collect, observedEnvironment, TABLES, MIGRATIONS, run };
