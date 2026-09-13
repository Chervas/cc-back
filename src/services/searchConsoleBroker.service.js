'use strict';
const fs = require('node:fs'); const path = require('node:path'); const { Op, literal } = require('sequelize');
const contract = require('../../services/integrations-broker/src/google-search-console-contract');
const discovery = require('../../services/integrations-broker/src/google-property-discovery-contract');
const { createIntegrationsBrokerClient } = require('../lib/integrationsBrokerClient');
const fail = (code = 'broker_binding_invalid') => { throw Object.assign(Error(code), { code }); };
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 && Number(value) <= 2147483647;
const marked = row => row.broker_read_connection_ref != null || row.broker_read_asset_ref != null;
function createSearchConsoleBroker({ client, loadMapping, loadBinding, loadConnection,
  enabled = () => process.env.GOOGLE_SEARCH_CONSOLE_BROKER_ENABLED === 'true', now = () => Date.now() }) {
  const contexts = new WeakMap();
  async function inspect(mapping, expected) {
    if (!mapping || !positive(mapping.id) || !positive(mapping.clinicaId) || !positive(mapping.googleConnectionId)) fail();
    const resource = contract.site(mapping.siteUrl);
    const current = await loadMapping(Number(mapping.id));
    const record = await loadBinding(resource.siteHash);
    if (!current || Number(current.id) !== Number(mapping.id) || !current.isActive || current.siteUrl !== mapping.siteUrl || Number(current.clinicaId) !== Number(mapping.clinicaId)
      || Number(current.googleConnectionId) !== Number(mapping.googleConnectionId)) fail();
    if (!record && !marked(current) && !expected) return null;
    if (!record || !marked(current) || record.state !== 'active' || record.site_hash !== resource.siteHash || record.site_url !== resource.siteUrl
      || record.asset_ref !== resource.assetRef || current.broker_read_asset_ref !== resource.assetRef
      || typeof record.connection_ref !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(record.connection_ref) || current.broker_read_connection_ref !== record.connection_ref
      || Number(record.mapping_id) !== Number(current.id) || Number(record.clinica_id) !== Number(current.clinicaId)
      || Number(record.google_connection_id) !== Number(current.googleConnectionId)
      || typeof record.google_user_id !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(record.google_user_id) || record.google_user_id === 'unknown') fail();
    const connection = await loadConnection(Number(current.googleConnectionId), record.google_user_id);
    if (!connection || Number(connection.id) !== Number(current.googleConnectionId) || connection.googleUserId !== record.google_user_id
      || Number(connection.credentials_external) !== 1) fail();
    const captured = { id: Number(current.id), clinicaId: Number(current.clinicaId), googleConnectionId: Number(current.googleConnectionId),
      siteUrl: resource.siteUrl, googleSubject: record.google_user_id, connectionRef: record.connection_ref,
      assetRef: resource.assetRef, tenantRef: `clinic:${Number(current.clinicaId)}` };
    if (expected && Object.keys(captured).some(key => captured[key] !== expected[key])) fail();
    if (!enabled()) fail('broker_cohort_disabled');
    return captured;
  }
  async function page(mapping, context, family, payload, beforeExecute) {
    const captured = context && typeof context === 'object' && contexts.get(context);
    const operation = contract.PREFIX + family + '.read.v1';
    if (!captured || captured.id !== Number(mapping.id)) fail(); contract.validate(operation, payload);
    await inspect(mapping, captured); const budget = await beforeExecute?.();
    const result = await client.execute({ operation, connectionRef: captured.connectionRef, assetRef: captured.assetRef, tenantRef: captured.tenantRef, payload }, budget);
    await inspect(mapping, captured); await beforeExecute?.();
    if (!result || !result.data || typeof result.data !== 'object') fail('broker_response_invalid');
    const projected = family === 'discovery' ? discovery.projectSC(result.data, captured.siteUrl) : contract.project(family, result.data, payload);
    return { ...projected, ...(family === 'queries' ? { nextPageToken: result.data.nextPageToken, rowLimitReached: result.data.rowLimitReached } : {}) };
  }
  return {
    async prepare(mapping) {
      const captured = await inspect(mapping);
      if (!captured) return null;
      const context = Object.freeze({}); contexts.set(context, captured); return context;
    },
    async read(mapping, context, family, payload, { beforeExecute } = {}) {
      if (!['queries', 'pages'].includes(family)) return { data: await page(mapping, context, family, payload, beforeExecute) };
      const rows = []; const seen = new Set(); const deadline = now() + 450000; let bytes = 0; let pageToken = null; let rowLimitReached = false;
      if (family === 'pages' && (!Number.isInteger(payload.rowLimit) || payload.rowLimit < 1 || payload.rowLimit > contract.MAX_ROWS
        || !Number.isInteger(payload.startRow) || payload.startRow < 0 || payload.startRow + payload.rowLimit > contract.MAX_ROWS)) fail('invalid_request');
      for (let i = 0; i < contract.MAX_ROWS / contract.PAGE_SIZE; i++) {
        if (now() >= deadline) fail('broker_timeout');
        const request = family === 'queries' ? { ...payload, pageToken }
          : { ...payload, startRow: payload.startRow + rows.length, rowLimit: Math.min(contract.PAGE_SIZE, payload.rowLimit - rows.length) };
        const result = await page(mapping, context, family, request, beforeExecute);
        if (now() >= deadline) fail('broker_timeout');
        if (!Array.isArray(result.rows) || result.rows.length > contract.PAGE_SIZE) fail('broker_response_invalid');
        bytes += Buffer.byteLength(JSON.stringify(result.rows)); if (bytes > 40000000) fail('broker_response_invalid');
        for (const row of result.rows) {
          const key = JSON.stringify(row.keys); if (seen.has(key)) fail('broker_response_invalid'); seen.add(key); rows.push(row);
        }
        if (family === 'pages') {
          if (rows.length === payload.rowLimit || result.rows.length < request.rowLimit) break;
        } else {
          if (typeof result.rowLimitReached !== 'boolean' || result.nextPageToken !== null && (typeof result.nextPageToken !== 'string'
            || !result.nextPageToken || result.nextPageToken.length > 4096) || result.nextPageToken && result.rows.length !== contract.PAGE_SIZE) fail('broker_response_invalid');
          pageToken = result.nextPageToken; rowLimitReached = result.rowLimitReached;
          if (rowLimitReached && (pageToken || rows.length !== contract.MAX_ROWS)) fail('broker_response_invalid');
          if (!pageToken) break;
          if (i === contract.MAX_ROWS / contract.PAGE_SIZE - 1) fail('broker_response_invalid');
        }
      }
      return { data: { rows, ...(family === 'queries' ? { rowLimitReached } : {}) } };
    },
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
  cachedClient ||= createIntegrationsBrokerClient({ origin: process.env.GOOGLE_SEARCH_CONSOLE_BROKER_ORIGIN,
    audience: process.env.GOOGLE_SEARCH_CONSOLE_BROKER_AUDIENCE, keyId: process.env.GOOGLE_SEARCH_CONSOLE_BROKER_KEY_ID,
    privateKey: privateFile(process.env.GOOGLE_SEARCH_CONSOLE_BROKER_KEY_FILE), ca: privateFile(process.env.GOOGLE_SEARCH_CONSOLE_BROKER_CA_FILE), timeoutMs: 30000 });
  return cachedClient.execute(command, budget);
} };
function createSearchConsoleRepository(getModels) {
  return {
    loadMapping: id => getModels().ClinicWebAsset.findByPk(id, { attributes: ['id', 'clinicaId', 'googleConnectionId', 'siteUrl', 'isActive',
      'broker_read_connection_ref', 'broker_read_asset_ref'], raw: true, logging: false }),
    loadBinding: hash => getModels().SearchConsoleBrokerBinding.findByPk(hash, { raw: true, logging: false }),
    loadConnection: async (id, subject) => {
      const rows = await getModels().GoogleConnection.findAll({ attributes: ['id', 'googleUserId', [literal('(accessToken IS NULL AND refreshToken IS NULL)'), 'credentials_external']],
        where: { [Op.or]: [{ id }, { googleUserId: subject }] }, limit: 2, raw: true, logging: false });
      return rows.length === 1 ? rows[0] : null;
    },
  };
}
const service = createSearchConsoleBroker({ client, ...createSearchConsoleRepository(() => require('../../models')) });
module.exports = { ...service, createSearchConsoleBroker, createSearchConsoleRepository };
