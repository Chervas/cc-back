'use strict';
const fs = require('node:fs'); const path = require('node:path'); const { Op, literal } = require('sequelize');
const contract = require('../../services/integrations-broker/src/google-analytics-contract');
const discovery = require('../../services/integrations-broker/src/google-property-discovery-contract');
const { inspectRevocations } = require('./googlePropertyRevocation.contract');
const { createIntegrationsBrokerClient } = require('../lib/integrationsBrokerClient');
const CODES = new Set(['broker_binding_invalid', 'broker_cohort_disabled', 'broker_response_invalid', 'broker_configuration_invalid',
  'google_discovery_session_required', 'google_discovery_scope_forbidden', 'broker_discovery_timeout', 'broker_discovery_limit',
  'broker_timeout', 'broker_unavailable', 'connection_blocked', 'asset_revoked', 'scope_denied', 'operation_denied', 'invalid_request',
  'secret_unavailable', 'credential_revoked', 'provider_failed', 'provider_timeout', 'provider_unauthorized', 'rate_limited',
  'google_oauth_legacy_closed', 'google_connection_missing', 'google_connection_changed', 'google_credentials_unavailable', 'google_property_revocation_unavailable']);
const safe = error => CODES.has(error?.code) ? error.code : 'analytics_read_failed';
const fail = (code = 'broker_binding_invalid') => { throw Object.assign(Error(code), { code }); };
const positive = value => /^[1-9]\d{0,9}$/.test(String(value)) && Number(value) <= 2147483647;
const marked = row => row.broker_read_connection_ref != null || row.broker_read_asset_ref != null;
function createAnalyticsBroker({ client, loadMapping, loadBindings, loadConnection, loadRevocations,
  enabled = () => process.env.GOOGLE_ANALYTICS_BROKER_ENABLED === 'true', now = () => Date.now() }) {
  const contexts = new WeakMap();
  async function inspect(mapping, expected) {
    if (!mapping || !positive(mapping.id) || !positive(mapping.clinicaId) || !positive(mapping.googleConnectionId)) fail();
    const resource = contract.property(mapping.propertyName);
    const current = await loadMapping(Number(mapping.id)); const records = await loadBindings(resource.propertyName);
    if (!Array.isArray(records) || records.length > 1000 || records.some(row => row.property_name !== resource.propertyName || !positive(row.mapping_id))) fail();
    const matches = records.filter(row => Number(row.mapping_id) === Number(mapping.id));
    if (matches.length > 1) fail(); const record = matches[0];
    const revokedProperty = inspectRevocations('analytics', resource.assetRef, mapping.clinicaId,
      current?.broker_read_connection_ref, await loadRevocations(resource.assetRef));
    if (!current || Number(current.id) !== Number(mapping.id) || !current.isActive || current.propertyName !== resource.propertyName
      || Number(current.clinicaId) !== Number(mapping.clinicaId) || Number(current.googleConnectionId) !== Number(mapping.googleConnectionId)) fail();
    if (!records.length && !revokedProperty && !marked(current) && !expected) return null;
    if (!record || !marked(current) || record.state !== 'active' || record.property_name !== resource.propertyName
      || record.asset_ref !== resource.assetRef || current.broker_read_asset_ref !== resource.assetRef
      || typeof record.connection_ref !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(record.connection_ref)
      || current.broker_read_connection_ref !== record.connection_ref || Number(record.mapping_id) !== Number(current.id)
      || Number(record.clinica_id) !== Number(current.clinicaId) || Number(record.google_connection_id) !== Number(current.googleConnectionId)
      || typeof record.google_user_id !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(record.google_user_id) || record.google_user_id === 'unknown') fail();
    const connection = await loadConnection(Number(current.googleConnectionId), record.google_user_id);
    if (!connection || Number(connection.id) !== Number(current.googleConnectionId) || connection.googleUserId !== record.google_user_id
      || Number(connection.credentials_external) !== 1) fail();
    inspectRevocations('analytics', resource.assetRef, current.clinicaId, record.connection_ref, await loadRevocations(resource.assetRef));
    const captured = { id: Number(current.id), clinicaId: Number(current.clinicaId), googleConnectionId: Number(current.googleConnectionId),
      propertyName: resource.propertyName, googleSubject: record.google_user_id, connectionRef: record.connection_ref,
      assetRef: resource.assetRef, tenantRef: `clinic:${Number(current.clinicaId)}` };
    if (expected && Object.keys(captured).some(key => captured[key] !== expected[key])) fail();
    if (!enabled()) fail('broker_cohort_disabled'); return captured;
  }
  const guarded = fn => async (...args) => { try { return await fn(...args); } catch (error) { fail(safe(error)); } };
  return {
    prepare: guarded(async mapping => {
      const captured = await inspect(mapping); if (!captured) return null;
      const context = Object.freeze({}); contexts.set(context, captured); return context;
    }),
    read: guarded(async (mapping, context, family, payload, { beforeExecute } = {}) => {
      const captured = context && typeof context === 'object' && contexts.get(context);
      if (!captured || captured.id !== Number(mapping?.id)) fail();
      const operation = contract.PREFIX + family + '.read.v1';
      if (family === 'discovery') {
        contract.validate(operation, payload); await inspect(mapping, captured); const budget = await beforeExecute?.();
        const response = await client.execute({ operation, connectionRef: captured.connectionRef, assetRef: captured.assetRef,
          tenantRef: captured.tenantRef, payload }, budget);
        await inspect(mapping, captured); await beforeExecute?.();
        try { return { data: discovery.projectGA(response?.data, captured.propertyName) }; } catch { fail('broker_response_invalid'); }
      }
      contract.validate(operation, { ...payload, pageToken: null });
      if (Object.keys(payload).sort().join(',') !== 'endDate,startDate') fail('invalid_request');
      const rows = []; const seen = new Set(); const deadline = now() + 450000;
      let bytes = 0; let pageToken = null; let rowCount = null; let metadata; let metadataText;
      for (let i = 0; i < contract.MAX_ROWS / contract.PAGE_SIZE; i++) {
        if (now() >= deadline) fail('broker_timeout');
        await inspect(mapping, captured);
        if (now() >= deadline) fail('broker_timeout');
        const response = await client.execute({ operation, connectionRef: captured.connectionRef, assetRef: captured.assetRef,
          tenantRef: captured.tenantRef, payload: { ...payload, pageToken } });
        await inspect(mapping, captured); if (now() >= deadline) fail('broker_timeout');
        let result; try { result = contract.project(family, response?.data, payload); } catch { fail('broker_response_invalid'); }
        const currentMetadata = JSON.stringify(result.metadata);
        if (rowCount === null) { rowCount = result.rowCount; metadata = result.metadata; metadataText = currentMetadata; }
        if (rowCount !== result.rowCount || metadataText !== currentMetadata
          || result.rows.length !== Math.min(contract.PAGE_SIZE, Math.max(0, rowCount - rows.length))) fail('broker_response_invalid');
        bytes += Buffer.byteLength(JSON.stringify(result.rows)); if (bytes > 40000000) fail('broker_response_invalid');
        for (const row of result.rows) {
          const key = JSON.stringify(row.dimensionValues.map(v => v.value)); if (seen.has(key)) fail('broker_response_invalid'); seen.add(key); rows.push(row);
        }
        const next = response.data.nextPageToken; const limited = response.data.rowLimitReached;
        const expectedLimit = rowCount > contract.MAX_ROWS && rows.length === contract.MAX_ROWS;
        const more = rows.length < Math.min(rowCount, contract.MAX_ROWS);
        if (typeof limited !== 'boolean' || limited !== expectedLimit || (more
          ? typeof next !== 'string' || !next || next.length > 4096 : next !== null)) fail('broker_response_invalid');
        if (!more) return { rows, rowCount, metadata, rowLimitReached: limited };
        pageToken = next;
      }
      fail('broker_response_invalid');
    }),
  };
}
function privateFile(filename) {
  try {
    if (typeof filename !== 'string' || !path.isAbsolute(filename) || fs.realpathSync(filename) !== filename) fail('broker_configuration_invalid');
    const stat = fs.statSync(filename); if (!stat.isFile() || stat.mode & 0o077 || stat.size > 65536) fail('broker_configuration_invalid');
    return fs.readFileSync(filename);
  } catch { fail('broker_configuration_invalid'); }
}
let cachedClient;
const client = { execute(command, budget) {
  cachedClient ||= createIntegrationsBrokerClient({ origin: process.env.GOOGLE_ANALYTICS_BROKER_ORIGIN,
    audience: process.env.GOOGLE_ANALYTICS_BROKER_AUDIENCE, keyId: process.env.GOOGLE_ANALYTICS_BROKER_KEY_ID,
    privateKey: privateFile(process.env.GOOGLE_ANALYTICS_BROKER_KEY_FILE), ca: privateFile(process.env.GOOGLE_ANALYTICS_BROKER_CA_FILE), timeoutMs: 30000 });
  return cachedClient.execute(command, budget);
} };
function createAnalyticsRepository(getModels) {
  return {
    loadMapping: id => getModels().ClinicAnalyticsProperty.findByPk(id, { attributes: ['id', 'clinicaId', 'googleConnectionId', 'propertyName', 'isActive',
      'broker_read_connection_ref', 'broker_read_asset_ref'], raw: true, logging: false }),
    loadBindings: propertyName => getModels().AnalyticsBrokerBinding.findAll({ where: { property_name: propertyName }, limit: 1001, raw: true, logging: false }),
    loadRevocations: assetRef => getModels().GooglePropertyBrokerRevocation.findAll({ where: { kind: 'analytics', asset_ref: assetRef }, limit: 1001, raw: true, logging: false }),
    loadConnection: async (id, subject) => {
      const rows = await getModels().GoogleConnection.findAll({ attributes: ['id', 'googleUserId', [literal('(accessToken IS NULL AND refreshToken IS NULL)'), 'credentials_external']],
        where: { [Op.or]: [{ id }, { googleUserId: subject }] }, limit: 2, raw: true, logging: false });
      return rows.length === 1 ? rows[0] : null;
    },
  };
}
const service = createAnalyticsBroker({ client, ...createAnalyticsRepository(() => require('../../models')) });
module.exports = { ...service, createAnalyticsBroker, createAnalyticsRepository, safe };
