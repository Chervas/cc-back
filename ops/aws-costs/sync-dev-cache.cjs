'use strict';

// The only SQL writes in this tool are four fixed cost-cache keys in isolated DEV.
// No models/bootstrap, AWS client, provider credentials, environment loading or I/O on import.
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const dotenv = require('dotenv');
const { buildDatabaseTlsOptions } = require('../../src/lib/databaseTlsConfig');
const { HOST, DATABASE, CA, CA_SHA, USERS } = require('../../src/lib/schemaReleaseDatabase');
const { projectSnapshot, projectAccountSnapshot, keyFor, accountKeyFor, monthsAt, cacheErrorCodes } = require('../../src/services/awsInfrastructureCosts.service');
const SOURCE_ENV = '/home/ubuntu/wt/back-staging/.env';
const DESTINATION_ENVS = Object.freeze(['/etc/clinicaclick-dev/runtime.env', '/etc/clinicaclick-dev/clinical-qa.env']);
const DEV_UUID = 'f22a7594-fcca-11ee-b0f3-064dc31d7557';
const IDENTITY_SQL = 'SELECT @@server_uuid AS uuid,DATABASE() AS database_name,CURRENT_USER() AS account,@@port AS port';
const TLS_SQL = "SHOW SESSION STATUS WHERE Variable_name IN ('Ssl_version','Ssl_cipher')";
const SELECT_SQL = 'SELECT cache_key,snapshot,collected_at,last_attempt_at,last_error_code,lease_token,lease_until FROM AwsInfrastructureCostCaches WHERE cache_key IN (?,?,?,?)';
const UPSERT_SQL = 'INSERT INTO AwsInfrastructureCostCaches (cache_key,snapshot,collected_at,last_attempt_at,last_error_code,created_at,updated_at) VALUES (?,?,?,?,?,?,?) AS incoming ON DUPLICATE KEY UPDATE snapshot=incoming.snapshot,collected_at=incoming.collected_at,last_attempt_at=incoming.last_attempt_at,last_error_code=incoming.last_error_code,updated_at=incoming.updated_at';
const DB_KEYS = new Set(['DB_HOST','DB_PORT','DB_NAME','DB_USERNAME','DB_PASSWORD','DB_TLS_REQUIRED','DB_TLS_CA_FILE']);
const LINE = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/mg;
const fail = code => { throw Error(code); };
const need = (value, code) => { if (!value) fail(code); };
const canonical = value => value instanceof Date ? JSON.stringify(value.toISOString()) : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key)+':'+canonical(value[key])).join(',') + '}' : JSON.stringify(value);
function parseEnvironment(text) {
  const seen = new Set(); const expression = new RegExp(LINE.source, LINE.flags); let match;
  while ((match = expression.exec(text.replace(/\r\n?/g, '\n')))) {
    if (DB_KEYS.has(match[1])) { need(!seen.has(match[1]), 'cost_mirror_duplicate_database_key'); seen.add(match[1]); }
  }
  return dotenv.parse(text);
}
function readEnvironment(filename, io = fs) {
  let fd; let bytes;
  try {
    fd = io.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = io.fstatSync(fd);
    need(before.isFile() && [0,1000].includes(before.uid) && (before.mode & 0o027) === 0 && before.nlink === 1
      && before.size > 0 && before.size <= 1024*1024, 'cost_mirror_environment_file');
    bytes = io.readFileSync(fd); const after = io.lstatSync(filename); const final = io.fstatSync(fd);
    for (const key of ['dev','ino','uid','gid','mode','nlink','size','mtimeMs','ctimeMs']) need(before[key] === after[key] && before[key] === final[key], 'cost_mirror_environment_changed');
    need(bytes.length === before.size, 'cost_mirror_environment_changed'); return parseEnvironment(bytes.toString('utf8'));
  } finally { bytes?.fill(0); if (fd !== undefined) io.closeSync(fd); }
}
function configurations(source, destination, readCa = filename => fs.readFileSync(filename)) {
  need(source.DB_HOST === HOST && String(source.DB_PORT || '3306') === '3306' && source.DB_NAME === DATABASE
    && source.DB_USERNAME === USERS.staging && source.DB_TLS_REQUIRED === 'true' && source.DB_TLS_CA_FILE === CA,
  'cost_mirror_source_configuration');
  need(destination.DB_HOST === '127.0.0.1' && String(destination.DB_PORT || '3306') === '3306'
    && destination.DB_NAME === 'clinicaclick_dev_isolated' && destination.DB_USERNAME === 'cc_dev_api'
    && [undefined,'','false'].includes(destination.DB_TLS_REQUIRED) && destination.AWS_INFRA_COSTS_ENABLED !== 'true', 'cost_mirror_destination_configuration');
  for (const env of [source,destination]) need(typeof env.DB_PASSWORD === 'string' && env.DB_PASSWORD.length >= 16 && env.DB_PASSWORD.length <= 512, 'cost_mirror_database_password_shape');
  const tls = buildDatabaseTlsOptions(source, readCa);
  need(createHash('sha256').update(tls.ssl.ca).digest('hex') === CA_SHA, 'cost_mirror_ca_changed');
  const common = { port: 3306, connectTimeout: 5000, multipleStatements: false, charset: 'utf8mb4', supportBigNumbers: true, bigNumberStrings: true };
  return { source: { ...common, host: HOST, user: source.DB_USERNAME, password: source.DB_PASSWORD, database: DATABASE, ...tls },
    destination: { ...common, host: '127.0.0.1', user: 'cc_dev_api', password: destination.DB_PASSWORD, database: 'clinicaclick_dev_isolated' } };
}
function cacheKeys(now = new Date()) { return monthsAt(now).flatMap(month => [keyFor(month), accountKeyFor(month)]); }
function projectRow(row, keys, destination) {
  need(row && keys.includes(row.cache_key), 'cost_mirror_cache_scope');
  if (destination) need(row.lease_token == null && row.lease_until == null, 'cost_mirror_destination_lease');
  let snapshot = row.snapshot;
  if (typeof snapshot === 'string') { try { snapshot = JSON.parse(snapshot); } catch { fail('cost_mirror_snapshot_invalid'); } }
  if (snapshot != null) snapshot = (row.cache_key.startsWith('aws:account:') ? projectAccountSnapshot : projectSnapshot)(snapshot, row.cache_key.slice(-7));
  const attempt = row.last_attempt_at == null ? null : new Date(row.last_attempt_at);
  need(attempt === null || Number.isFinite(attempt.getTime()), 'cost_mirror_attempt_invalid');
  return { cache_key: row.cache_key, snapshot: snapshot || null, collected_at: snapshot ? new Date(snapshot.collectedAt) : null,
    last_attempt_at: attempt, last_error_code: row.last_error_code == null ? null
      : cacheErrorCodes.includes(row.last_error_code) ? row.last_error_code : 'cost_cache_unavailable' };
}
function planRows(sourceRows, destinationRows, keys) {
  const map = (rows, destination) => {
    need(Array.isArray(rows) && rows.length <= 4, 'cost_mirror_cache_shape'); const result = new Map();
    for (const raw of rows) { const row = projectRow(raw, keys, destination); need(!result.has(row.cache_key), 'cost_mirror_duplicate_cache'); result.set(row.cache_key, row); }
    return result;
  };
  const source = map(sourceRows, false); const destination = map(destinationRows, true); const writes = [];
  for (const [key, row] of source) {
    const old = destination.get(key); const next = { ...row };
    // Missing/incomplete collection never erases a previously available amount.
    if (old?.snapshot?.status === 'available' && row.snapshot?.status !== 'available') { next.snapshot = old.snapshot; next.collected_at = old.collected_at; }
    if (!old || canonical(old) !== canonical(next)) writes.push(next);
  }
  return writes;
}
async function physicalClose(connection) {
  if (!connection) return;
  const raw = connection.connection || connection; const stream = raw.stream;
  need(stream && typeof stream.once === 'function', 'cost_mirror_close_unproven');
  if (stream.closed === true) { if (raw.config) raw.config.password = ''; return; }
  await new Promise((resolve, reject) => {
    let settled = false; let force; let deadline;
    const finish = error => { if (settled) return; settled = true; clearTimeout(force); clearTimeout(deadline); stream.removeListener('close', closed); error ? reject(error) : resolve(); };
    const closed = () => finish(); stream.once('close', closed);
    force = setTimeout(() => { try { raw.destroy?.(); stream.destroy?.(); } catch {} }, 2000);
    deadline = setTimeout(() => finish(Error('cost_mirror_close_unproven')), 3000);
    try { Promise.resolve(connection.end()).catch(() => { try { raw.destroy?.(); stream.destroy?.(); } catch {} }); }
    catch { try { raw.destroy?.(); stream.destroy?.(); } catch {} }
  });
  if (raw.config) raw.config.password = '';
}
function openOwnedConnection(settings, retain, createRawConnection) {
  // mysql2/promise hides its raw connection if authentication/handshake rejects.
  // Retain our raw handle before the first asynchronous handshake event instead.
  const raw = createRawConnection(settings); retain(raw);
  raw.on('error', () => {});
  return new Promise((resolve, reject) => {
    raw.connect(error => {
      if (error) { reject(Error('cost_mirror_connection_failed')); return; }
      try { const connection = raw.promise(); retain(connection); resolve(connection); }
      catch { reject(Error('cost_mirror_connection_failed')); }
    });
  });
}
async function syncDevCache({ sourceEnv, destinationEnv, createRawConnection, readCa, now = () => new Date() }) {
  const settings = configurations(sourceEnv, destinationEnv, readCa); const keys = cacheKeys(now());
  const deadline = now().getTime() + 30000; let source; let destination; let transaction = false; let result; let failure;
  const query = async (connection, sql, values = []) => {
    const remaining = deadline - now().getTime(); need(remaining > 100, 'cost_mirror_deadline');
    const options = { sql, timeout: Math.min(5000, remaining) };
    const [rows] = values.length ? await connection.execute(options, values) : await connection.query(options);
    const reserve = deadline - now().getTime(); need(reserve > 0, 'cost_mirror_deadline');
    const [warnings] = await connection.query({ sql: 'SHOW WARNINGS', timeout: Math.min(5000, reserve) });
    need(Array.isArray(warnings) && warnings.length === 0, 'cost_mirror_sql_warning'); return rows;
  };
  try {
    const make = createRawConnection || require('mysql2').createConnection;
    source = await openOwnedConnection(settings.source, value => { source = value; }, make);
    destination = await openOwnedConnection(settings.destination, value => { destination = value; }, make);
    for (const [connection, expected, remote] of [[source,settings.source,true],[destination,settings.destination,false]]) {
      const raw = connection.connection || connection;
      need(raw.config?.host === expected.host && Number(raw.config.port) === 3306 && !raw.config.socketPath
        && raw.stream && typeof raw.stream.once === 'function' && typeof raw.destroy === 'function' && raw.stream.destroyed !== true
        && (remote ? raw.config.ssl?.rejectUnauthorized === true && raw.config.ssl.verifyIdentity === true
          && raw.config.ssl.minVersion === 'TLSv1.2' && createHash('sha256').update(raw.config.ssl.ca).digest('hex') === CA_SHA : !raw.config.ssl), 'cost_mirror_driver_changed');
      const rows = await query(connection, IDENTITY_SQL);
      need(Array.isArray(rows) && rows.length === 1 && rows[0].database_name === expected.database && String(rows[0].port) === '3306'
        && rows[0].account === expected.user + (remote ? '@%' : '@localhost') && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(rows[0].uuid)
        && (remote ? rows[0].uuid !== DEV_UUID : rows[0].uuid === DEV_UUID), 'cost_mirror_identity_changed');
      if (remote) {
        const status = await query(connection, TLS_SQL); need(Array.isArray(status) && status.length === 2, 'cost_mirror_tls_unproven');
        const tls = Object.fromEntries(status.map(row => [row.Variable_name,row.Value]));
        need(['TLSv1.2','TLSv1.3'].includes(tls.Ssl_version) && typeof tls.Ssl_cipher === 'string' && tls.Ssl_cipher.length > 0, 'cost_mirror_tls_unproven');
      }
    }
    const sourceRows = await query(source, SELECT_SQL, keys); const destinationRows = await query(destination, SELECT_SQL, keys);
    const writes = planRows(sourceRows, destinationRows, keys);
    if (writes.length) {
      await query(destination, 'START TRANSACTION'); transaction = true;
      for (const row of writes) await query(destination, UPSERT_SQL, [row.cache_key, row.snapshot ? JSON.stringify(row.snapshot) : null,
        row.collected_at,row.last_attempt_at,row.last_error_code,now(),now()]);
      await query(destination, 'COMMIT'); transaction = false;
    }
    result = { status: 'COST_CACHE_MIRROR_SYNCED', keysRequested: keys.length, sourceRows: sourceRows.length, rowsWritten: writes.length,
      sourceReadOnly: true, destinationScope: 'isolated_dev_cost_cache_only', awsCalls: 0 };
  } catch (error) {
    failure = error;
    if (transaction && destination) { try { await query(destination, 'ROLLBACK'); } catch {} }
  } finally {
    const closures = await Promise.allSettled([physicalClose(source),physicalClose(destination)]);
    for (const env of [sourceEnv,destinationEnv]) env.DB_PASSWORD = '';
    for (const config of Object.values(settings)) config.password = '';
    if (closures.some(item => item.status === 'rejected')) failure = Error('cost_mirror_close_unproven');
  }
  if (failure) throw failure;
  return { ...result, physicalConnectionsClosed: 2 };
}
async function main() {
  need(process.getuid() === 0, 'cost_mirror_root_required');
  const sourceEnv = readEnvironment(SOURCE_ENV);
  const destinationEnv = Object.assign({}, ...DESTINATION_ENVS.map(file => readEnvironment(file)));
  return syncDevCache({ sourceEnv,destinationEnv });
}
if (require.main === module) {
  if (process.argv.length !== 3 || process.argv[2] !== '--sync-dev-cache') process.stdout.write('INERT: explicit --sync-dev-cache required\n');
  else main().then(result => process.stdout.write(JSON.stringify(result)+'\n')).catch(error => {
    const code = /^cost_mirror_[a-z_]+$/.test(error?.message || '') ? error.message : 'cost_mirror_failed';
    process.stdout.write(JSON.stringify({ status:'COST_CACHE_MIRROR_FAILED',error:code })+'\n'); process.exitCode = 1;
  });
}
module.exports = { SOURCE_ENV,DESTINATION_ENVS,DEV_UUID,IDENTITY_SQL,TLS_SQL,SELECT_SQL,UPSERT_SQL,
  parseEnvironment,readEnvironment,configurations,cacheKeys,planRows,physicalClose,syncDevCache };
