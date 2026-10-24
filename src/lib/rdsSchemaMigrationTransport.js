'use strict';

// Operator-only transport. Native AWS credentials and the managed master secret
// stay in child pipes/JS memory; neither is passed in argv, env or artifacts.
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { sha, need } = require('./rdsSchemaMigrationPolicy');
const { buildDatabaseTlsOptions } = require('./databaseTlsConfig');
const HOST = 'clinicaclick-mysql.clkgw6ogy2cb.eu-west-3.rds.amazonaws.com';
const DATABASE = 'clinicaclick';
const DB_ID = 'clinicaclick-mysql';
const PRIMARY_DBI = 'db-2YF2E5HFTNWAHYB45MS4QW7VUA';
const REGION = 'eu-west-3';
const ACCOUNT = '137819318729';
const CA = '/etc/clinicaclick-database/rds-eu-west-3-bundle.pem';
const CA_SHA = '6f2e2f0cabeed0e40f7cc432e47be1ff7a4b6faa28318fb2a9e060afdee5bc26';
const SQL_MODES = ['ONLY_FULL_GROUP_BY', 'STRICT_TRANS_TABLES', 'NO_ZERO_IN_DATE', 'NO_ZERO_DATE',
  'ERROR_FOR_DIVISION_BY_ZERO', 'NO_ENGINE_SUBSTITUTION', 'IGNORE_SPACE'];
const IDENTITY_SQL = 'SELECT @@server_uuid AS uuid,@@version AS version,@@port AS port,DATABASE() AS db,CURRENT_USER() AS account,CONNECTION_ID() AS sid,@@session.foreign_key_checks AS fk,@@session.autocommit AS autocommit,@@session.sql_mode AS modes,@@session.character_set_connection AS charset';
const TLS_SQL = "SHOW SESSION STATUS WHERE Variable_name IN ('Ssl_version','Ssl_cipher')";
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const CLOSE_EVENTS = new WeakMap();
function watchClose(raw) {
  if (!CLOSE_EVENTS.has(raw)) {
    let resolve;
    const state = { observed: false, promise: new Promise(done => { resolve = done; }) };
    raw.stream.once('close', () => { state.observed = true; resolve(); }); CLOSE_EVENTS.set(raw, state);
  }
  return CLOSE_EVENTS.get(raw);
}
const PRIMARY = Object.freeze({ mode: 'PRIMARY', host: HOST, database: DATABASE, dbId: DB_ID });
function scopeFor(scope = PRIMARY) {
  if (scope.mode === 'PRIMARY') {
    need(JSON.stringify(scope) === JSON.stringify(PRIMARY), 'rds_schema_primary_scope_changed'); return scope;
  }
  // Not a CLI option. Only the separate Root QA launcher supplies this bound
  // empty-fixture scope; it cannot name the primary or a clinical schema.
  need(scope.mode === 'ISOLATED_EMPTY_QA' && /^cc-schema-qa-[0-9]{8}-[0-9]{4}$/.test(scope.dbId)
    && scope.host === scope.dbId + '.clkgw6ogy2cb.eu-west-3.rds.amazonaws.com'
    && scope.database === 'schema_release_fixture' && /^db-[A-Z0-9]+$/.test(scope.physicalDbId)
    && scope.physicalDbId !== PRIMARY_DBI && scope.engineVersion === '8.4.11', 'rds_schema_qa_scope_invalid');
  return Object.freeze({ ...scope });
}

function createAws({ profile = 'clinicaclick-prov-temp', execute = promisify(execFile), now = Date.now, pause = sleep, scope: inputScope } = {}) {
  const scope = scopeFor(inputScope);
  need(/^[A-Za-z0-9_-]{1,64}$/.test(profile), 'rds_schema_aws_profile');
  let session;
  async function cli(args) {
    let result;
    try {
      result = await execute('/sbin/runuser', ['-u', 'ubuntu', '--', '/home/ubuntu/.local/bin/aws', '--profile', profile,
        '--region', REGION, '--output', 'json', '--no-cli-pager', '--no-cli-auto-prompt', '--cli-connect-timeout', '5', '--cli-read-timeout', '30', ...args], {
        timeout: 40000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8',
        env: { PATH: '/home/ubuntu/.local/bin:/usr/local/bin:/usr/bin:/bin', HOME: '/home/ubuntu', LC_ALL: 'C', AWS_PAGER: '',
          AWS_CONFIG_FILE: '/home/ubuntu/.aws/config', AWS_SHARED_CREDENTIALS_FILE: '/home/ubuntu/.aws/credentials',
          AWS_EC2_METADATA_DISABLED: 'true', AWS_MAX_ATTEMPTS: '1' },
      });
      return JSON.parse(result.stdout);
    } catch { throw Error('rds_schema_aws_operation_failed'); }
    finally { if (result) { result.stdout = ''; result.stderr = ''; } }
  }
  async function currentSession(minimumMs = 180000) {
    const value = await cli(['configure', 'export-credentials', '--format', 'process']);
    try {
      const expiresAtEpochMs = Date.parse(value.Expiration);
      need(typeof value.AccessKeyId === 'string' && typeof value.SecretAccessKey === 'string'
        && typeof value.SessionToken === 'string' && value.SessionToken.length > 0
        && Number.isSafeInteger(expiresAtEpochMs) && expiresAtEpochMs >= now() + minimumMs, 'rds_schema_temporary_aws_session_required');
      const fingerprint = sha(JSON.stringify([value.AccessKeyId, value.SessionToken]));
      let roleArn = session?.roleArn;
      if (!session || session.fingerprint !== fingerprint) {
        const caller = await cli(['sts', 'get-caller-identity']);
        need(caller.Account === ACCOUNT && typeof caller.Arn === 'string'
          && caller.Arn.startsWith(`arn:aws:sts::${ACCOUNT}:assumed-role/`), 'rds_schema_aws_identity');
        const observedRole = caller.Arn.slice(0, caller.Arn.lastIndexOf('/'));
        need(!roleArn || roleArn === observedRole, 'rds_schema_aws_session_changed');
        roleArn = observedRole;
      }
      session = { fingerprint, expiresAtEpochMs, roleArn }; return session;
    } finally { value.AccessKeyId = ''; value.SecretAccessKey = ''; value.SessionToken = ''; }
  }
  async function call(args) { await currentSession(); return cli(args); }
  async function inspect() {
    await currentSession();
    const caller = await call(['sts', 'get-caller-identity']);
    need(caller.Account === ACCOUNT && typeof caller.Arn === 'string'
      && caller.Arn.startsWith(`arn:aws:sts::${ACCOUNT}:assumed-role/`), 'rds_schema_aws_identity');
    const value = await call(['rds', 'describe-db-instances', '--db-instance-identifier', scope.dbId]);
    need(value.DBInstances?.length === 1, 'rds_schema_rds_identity');
    const db = value.DBInstances[0];
    need(db.DBInstanceIdentifier === scope.dbId && db.DBInstanceStatus === 'available' && db.Engine === 'mysql'
      && /^8\.4\.\d+$/.test(db.EngineVersion) && db.Endpoint?.Address === scope.host && db.Endpoint.Port === 3306
      && typeof db.DbiResourceId === 'string' && db.DbiResourceId.startsWith('db-')
      && (scope.mode === 'PRIMARY' ? db.DbiResourceId === PRIMARY_DBI && db.MultiAZ === true && db.BackupRetentionPeriod >= 1
        : db.DbiResourceId === scope.physicalDbId && db.EngineVersion === scope.engineVersion && db.DBInstanceClass === 'db.t4g.small')
      && db.StorageEncrypted === true
      && Object.keys(db.PendingModifiedValues || {}).length === 0
      && db.DBParameterGroups?.length > 0 && db.DBParameterGroups.every(group => group.ParameterApplyStatus === 'in-sync')
      && db.MasterUserSecret?.SecretStatus === 'active'
      && db.MasterUserSecret.SecretArn.startsWith(`arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:`), 'rds_schema_rds_not_ready');
    return db;
  }
  async function secret(db) {
    const value = await call(['secretsmanager', 'get-secret-value', '--secret-id', db.MasterUserSecret.SecretArn, '--version-stage', 'AWSCURRENT']);
    let body;
    try {
      need(value.ARN === db.MasterUserSecret.SecretArn && typeof value.VersionId === 'string'
        && value.VersionStages?.includes('AWSCURRENT') && typeof value.SecretString === 'string' && value.SecretString.length <= 16384, 'rds_schema_secret_identity');
      body = JSON.parse(value.SecretString);
      need(body.username === db.MasterUsername && typeof body.password === 'string' && body.password.length >= 16 && body.password.length <= 512
        && (!body.host || body.host === scope.host) && (!body.port || Number(body.port) === 3306), 'rds_schema_secret_identity');
      return { username: body.username, password: body.password, versionId: value.VersionId };
    } finally { value.SecretString = ''; if (body) body.password = ''; }
  }
  async function backup({ operationNonce, journal }) {
    // Snapshot creation is also once-only. A lost AWS reply is never retried.
    const snapshotId = (scope.mode === 'PRIMARY' ? 'cc-schema-' : 'cc-schema-qa-') + operationNonce.replace(/-/g, '');
    await currentSession(180000);
    journal({ event: 'backup_request', snapshotId });
    const result = await call(['rds', 'create-db-snapshot', '--db-instance-identifier', scope.dbId, '--db-snapshot-identifier', snapshotId]);
    need(result.DBSnapshot?.DBSnapshotIdentifier === snapshotId && result.DBSnapshot.DBInstanceIdentifier === scope.dbId, 'rds_schema_backup_response_unknown');
    journal({ event: 'backup_create_ack', snapshotId });
    // A real 100-GiB snapshot took 46 minutes on 2026-10-24. The application
    // keeps running during this wait; DDL still requires an available snapshot
    // and a fresh identity/schema/session check after it finishes.
    const deadline = now() + 90 * 60 * 1000;
    while (now() < deadline) {
      const value = await call(['rds', 'describe-db-snapshots', '--db-snapshot-identifier', snapshotId]);
      const snapshot = value.DBSnapshots?.[0];
      need(value.DBSnapshots?.length === 1 && snapshot.DBSnapshotIdentifier === snapshotId
        && snapshot.DBInstanceIdentifier === scope.dbId && snapshot.Encrypted === true, 'rds_schema_backup_identity');
      if (snapshot.Status === 'available') {
        const db = await inspect();
        need(snapshot.DbiResourceId === db.DbiResourceId && snapshot.Engine === db.Engine
          && snapshot.EngineVersion === db.EngineVersion && Number.isFinite(Date.parse(snapshot.SnapshotCreateTime)), 'rds_schema_backup_identity');
        const proof = { snapshotId, snapshotArn: snapshot.DBSnapshotArn, physicalDbId: db.DbiResourceId,
          createdAt: snapshot.SnapshotCreateTime, status: 'available', checkedAtEpochMs: now() };
        journal({ event: 'backup_available', ...proof }); return proof;
      }
      need(['creating', 'pending'].includes(snapshot.Status), 'rds_schema_backup_failed');
      await pause(15000);
    }
    throw Error('rds_schema_backup_timeout');
  }
  return { profile, inspect, secret, backup, ensureFresh: currentSession, assertFresh: (minimumMs = 30000) => {
    need(session && session.expiresAtEpochMs > now() + minimumMs, 'rds_schema_aws_session_expired');
  } };
}

async function connectAdmin({ aws, db, secret, makeConnection = require('mysql2').createConnection, readFile = fs.readFileSync, scope: inputScope }) {
  const scope = scopeFor(inputScope);
  const ca = readFile(CA); need(sha(ca) === CA_SHA, 'rds_schema_ca_changed');
  const tls = buildDatabaseTlsOptions({ DB_TLS_REQUIRED: 'true', DB_TLS_CA_FILE: CA }, () => ca);
  let connection; let attempted = false;
  try {
    attempted = true;
    const owned = makeConnection({ host: scope.host, port: 3306, database: scope.database, user: secret.username,
      password: secret.password, ...tls, charset: 'UTF8MB4_UNICODE_CI', multipleStatements: false,
      supportBigNumbers: true, bigNumberStrings: true, connectTimeout: 5000 });
    // Retain ownership before the asynchronous handshake. The promise factory
    // rejects without returning its raw handle when authentication/TLS fails.
    connection = owned;
    const raw = owned.connection || owned;
    need(raw.stream && typeof raw.stream.once === 'function', 'rds_schema_driver_stream_required');
    watchClose(raw);
    need(typeof owned.promise === 'function', 'rds_schema_driver_connection_required');
    connection = owned.promise();
    await connection.connect();
    need(raw.config?.host === scope.host && !raw.config.socketPath && raw.config.ssl?.rejectUnauthorized === true
      && raw.config.ssl.verifyIdentity === true && sha(raw.config.ssl.ca) === CA_SHA, 'rds_schema_driver_tls_changed');
    const query = async (sql, values = [], timeout = 30000) => {
      aws.assertFresh(timeout + 30000);
      const [rows] = await connection.query({ sql, values, timeout });
      const [warnings] = await connection.query({ sql: 'SHOW WARNINGS', timeout: 5000 });
      need(Array.isArray(warnings) && warnings.length === 0, 'rds_schema_warnings'); return rows;
    };
    // Prepare only this owned session; never inherit a weaker engine default
    // or alter GLOBAL modes. The following identity readback must be exact.
    await query('SET SESSION sql_mode=?', [SQL_MODES.join(',')]);
    const rows = await query(IDENTITY_SQL); need(rows.length === 1, 'rds_schema_sql_identity');
    const id = rows[0]; const modes = String(id.modes).split(',');
    need(/^[a-f0-9-]{36}$/.test(id.uuid) && id.uuid !== 'f22a7594-fcca-11ee-b0f3-064dc31d7557'
      && id.version === db.EngineVersion && String(id.port) === '3306' && id.db === scope.database
      && id.account === secret.username + '@%' && Number(id.sid) === raw.threadId
      && String(id.fk) === '1' && String(id.autocommit) === '1' && id.charset === 'utf8mb4'
      && modes.length === SQL_MODES.length && new Set(modes).size === modes.length
      && SQL_MODES.every(mode => modes.includes(mode)), 'rds_schema_sql_identity');
    const status = await query(TLS_SQL); const values = Object.fromEntries(status.map(row => [row.Variable_name, row.Value]));
    need(status.length === 2 && ['TLSv1.2', 'TLSv1.3'].includes(values.Ssl_version) && values.Ssl_cipher, 'rds_schema_tls_required');
    const identity = { host: scope.host, database: scope.database, port: 3306, serverUuid: id.uuid, engineVersion: id.version,
      physicalDbId: db.DbiResourceId, secretVersionId: secret.versionId, caSha256: CA_SHA,
      strictTls: true, hostnameVerified: true };
    return { connection, raw, query, identity, close: () => closePhysical(connection) };
  } catch (error) {
    if (attempted) error.transportOpened = true;
    if (connection) {
      try { error.closure = await closePhysical(connection); }
      catch (closureError) { closureError.transportOpened = true; throw closureError; }
    }
    throw error;
  }
  finally { secret.password = ''; }
}

async function closePhysical(connection) {
  const raw = connection.connection || connection; const stream = raw.stream;
  need(stream && typeof stream.destroy === 'function', 'rds_schema_physical_close_unproven');
  const observed = watchClose(raw); let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Error('rds_schema_physical_close_unproven')), 8000); });
  try { raw.destroy(); } catch {}
  try { stream.destroy(); } catch {}
  if (raw.config) raw.config.password = '';
  try { await Promise.race([observed.promise, timeout]); } finally { clearTimeout(timer); }
  need(observed.observed && stream.destroyed === true, 'rds_schema_physical_close_unproven');
  return { physicalCloseObserved: true, physicalStreamDestroyed: true };
}

module.exports = { HOST, DATABASE, DB_ID, PRIMARY_DBI, CA, CA_SHA, SQL_MODES, PRIMARY, scopeFor, IDENTITY_SQL, TLS_SQL, createAws, connectAdmin, closePhysical };
