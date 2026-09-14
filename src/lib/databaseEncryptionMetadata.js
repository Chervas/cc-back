'use strict';

// Fixed metadata queries. No app models, environment, clinical rows, DDL or arbitrary SQL.
const BOOLEANS = ['default_table_encryption', 'innodb_redo_log_encrypt', 'innodb_undo_log_encrypt',
  'binlog_encryption', 'require_secure_transport', 'log_bin', 'general_log', 'slow_query_log', 'performance_schema'];
const VARIABLES = [...BOOLEANS, 'have_ssl', 'tls_version', 'datadir', 'socket', 'port'];
const QUERIES = Object.freeze({
  engine: 'SELECT VERSION() AS version',
  variables: "SHOW GLOBAL VARIABLES WHERE Variable_name IN (" + VARIABLES.map(value => "'" + value + "'").join(',') + ')',
  sessionTls: "SHOW SESSION STATUS WHERE Variable_name IN ('Ssl_cipher','Ssl_version')",
  tablespaces: 'SELECT SPACE_TYPE AS kind, ENCRYPTION AS encrypted, COUNT(*) AS count FROM information_schema.INNODB_TABLESPACES GROUP BY SPACE_TYPE, ENCRYPTION',
  schemaDefault: 'SELECT DEFAULT_ENCRYPTION AS encrypted FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = DATABASE()',
  schemaFootprint: 'SELECT ENGINE AS engine, COUNT(*) AS count, COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH),0) AS bytes FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = \'BASE TABLE\' GROUP BY ENGINE',
  keyringPlugins: "SELECT PLUGIN_NAME AS name, PLUGIN_STATUS AS status FROM information_schema.PLUGINS WHERE PLUGIN_NAME LIKE 'keyring%'",
  keyringComponent: "SELECT STATUS_KEY AS name, STATUS_VALUE AS value FROM performance_schema.keyring_component_status WHERE STATUS_KEY IN ('Component_name','Implementation_name','Component_status')",
  replicas: "SELECT COUNT(*) AS channels, COALESCE(SUM(SSL_ALLOWED = 'YES'),0) AS tlsChannels FROM performance_schema.replication_connection_configuration",
  observedTls: "SELECT COUNT(*) AS observedConnections, COALESCE(SUM(VARIABLE_VALUE <> ''),0) AS tlsConnections FROM performance_schema.status_by_thread WHERE VARIABLE_NAME = 'Ssl_cipher'",
});
const fail = () => { throw Error('metadata_response_invalid'); };
const count = value => /^(0|[1-9]\d{0,17})$/.test(String(value)) ? String(value) : fail();
const text = (value, regex, max = 120) => typeof value === 'string' && value.length <= max && regex.test(value) ? value : fail();
const bool = value => ['ON', 'OFF', 'YES', 'NO', '0', '1'].includes(String(value).toUpperCase())
  ? ['ON', 'YES', '1'].includes(String(value).toUpperCase()) : fail();
const safeCode = error => ['ER_ACCESS_DENIED_ERROR', 'ER_TABLEACCESS_DENIED_ERROR', 'ER_SPECIFIC_ACCESS_DENIED_ERROR',
  'ER_DBACCESS_DENIED_ERROR'].includes(error?.code) ? 'metadata_permission_denied'
  : ['ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR', 'ER_UNKNOWN_SYSTEM_VARIABLE'].includes(error?.code) ? 'metadata_capability_unavailable'
    : error?.message === 'metadata_response_invalid' ? 'metadata_response_invalid' : 'metadata_query_failed';
function project(name, rows) {
  if (!Array.isArray(rows) || rows.length > 100) fail();
  switch (name) {
    case 'engine':
      if (rows.length !== 1) fail();
      return { version: text(rows[0].version, /^\d+\.\d+\.\d+(?:[-+._a-zA-Z0-9]*)$/) };
    case 'variables': {
      const values = {};
      for (const row of rows) {
        if (!VARIABLES.includes(row.Variable_name) || Object.hasOwn(values, row.Variable_name)) fail();
        const value = row.Value;
        values[row.Variable_name] = BOOLEANS.includes(row.Variable_name) ? bool(value)
          : row.Variable_name === 'port' ? count(value)
            : ['datadir', 'socket'].includes(row.Variable_name) ? text(value, /^\/[\w./-]+$/, 512)
              : text(value, /^[A-Za-z0-9.,_ -]*$/);
      }
      return values;
    }
    case 'sessionTls': {
      const result = {};
      for (const row of rows) {
        if (!['Ssl_cipher', 'Ssl_version'].includes(row.Variable_name)) fail();
        result[row.Variable_name] = text(row.Value, /^[A-Za-z0-9_.-]*$/);
      }
      if (!Object.hasOwn(result, 'Ssl_cipher') || !Object.hasOwn(result, 'Ssl_version')) fail();
      return { encrypted: result.Ssl_cipher !== '', cipher: result.Ssl_cipher || null, version: result.Ssl_version || null };
    }
    case 'tablespaces':
      return rows.map(row => ({ kind: text(row.kind, /^(Single|General|Undo|System)$/),
        encrypted: ['Y', 'N'].includes(row.encrypted) ? row.encrypted === 'Y' : fail(), count: count(row.count) }));
    case 'schemaDefault':
      if (rows.length !== 1 || !['YES', 'NO'].includes(rows[0].encrypted)) fail();
      return { encryptedByDefault: rows[0].encrypted === 'YES' };
    case 'schemaFootprint':
      return rows.map(row => ({ engine: text(row.engine, /^[a-zA-Z0-9_]+$/), count: count(row.count), bytes: count(row.bytes) }));
    case 'keyringPlugins':
      return rows.map(row => ({ name: text(row.name, /^keyring_[a-z0-9_]+$/), status: text(row.status, /^(ACTIVE|DISABLED|INACTIVE|DELETED|DELETING)$/) }));
    case 'keyringComponent':
      return rows.map(row => ({ name: text(row.name, /^(Component_name|Implementation_name|Component_status)$/),
        value: text(row.value, /^[A-Za-z0-9_. -]+$/) }));
    case 'replicas':
      if (rows.length !== 1) fail();
      return { channels: count(rows[0].channels), tlsChannels: count(rows[0].tlsChannels) };
    case 'observedTls':
      if (rows.length !== 1) fail();
      return { observedConnections: count(rows[0].observedConnections), tlsConnections: count(rows[0].tlsConnections) };
    default: return fail();
  }
}
async function collectMetadata({ query, transport = 'unix_socket', now = () => new Date() }) {
  if (!['unix_socket', 'verified_tls'].includes(transport)) throw Error('metadata_transport_invalid');
  const checks = {};
  for (const [name, sql] of Object.entries(QUERIES)) {
    try { checks[name] = { status: 'verified', data: project(name, await query(sql)) }; }
    catch (error) { checks[name] = { status: 'unavailable', code: safeCode(error) }; }
  }
  const findings = [];
  const vars = checks.variables.data || {};
  for (const [key, code] of [['default_table_encryption', 'default_table_encryption_disabled'],
    ['innodb_redo_log_encrypt', 'redo_encryption_disabled'], ['innodb_undo_log_encrypt', 'undo_encryption_disabled'],
    ['require_secure_transport', 'secure_transport_not_required']]) if (vars[key] === false) findings.push(code);
  if (vars.log_bin === true && vars.binlog_encryption === false) findings.push('binary_log_encryption_disabled');
  if ((checks.tablespaces.data || []).some(row => !row.encrypted && BigInt(row.count) > 0n)) findings.push('unencrypted_tablespaces_observed');
  const tls = checks.observedTls.data;
  if (tls && BigInt(tls.observedConnections) > BigInt(tls.tlsConnections)) findings.push('non_tls_sessions_observed_transport_not_attributed');
  return { version: 1, collectedAt: now().toISOString(), mode: 'metadata_only', diagnosticTransport: transport,
    metadataScope: { tablespaces: 'visible_mysql_instance', schema: 'configured_database', connections: 'instrumented_instance_sessions' },
    checks, findings, providerVolumeEncryption: 'unverified', backupEncryption: 'unverified',
    applicationCertificateValidation: 'unverified', clinicalDataRead: false, completeEncryptionAssessment: false };
}
module.exports = { QUERIES, collectMetadata, project, safeCode };
