'use strict';
const { Op } = require('sequelize');
const googleOAuth = require('./googleOAuthBroker.service');
const businessProfile = require('./businessProfileDiscovery.service');
const readers = { search_console: require('./searchConsoleBroker.service'), analytics: require('./analyticsBroker.service') };
const COMMON = ['mapping_id', 'clinica_id', 'google_connection_id', 'google_user_id', 'connection_ref', 'asset_ref', 'state'];
const fields = kind => [...COMMON, ...(kind === 'search_console' ? ['site_hash', 'site_url'] : ['property_name'])];
const positive = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const fail = code => { throw Object.assign(Error(code), { code }); };
const CONFLICT = new Set(['broker_binding_invalid', 'broker_discovery_scope_unconfigured', 'broker_discovery_limit', 'google_oauth_legacy_closed']);
const CODES = new Set([...CONFLICT, 'google_discovery_no_connection', 'broker_discovery_busy', 'broker_discovery_timeout', 'broker_registry_unavailable', 'broker_cohort_disabled',
  'broker_unavailable', 'broker_timeout', 'broker_configuration_invalid', 'broker_response_invalid', 'provider_failed', 'provider_timeout',
  'provider_unauthorized', 'connection_blocked', 'asset_revoked', 'secret_unavailable', 'credential_revoked', 'scope_denied', 'operation_denied',
  'audit_unavailable', 'rate_limited', 'google_discovery_session_required', 'google_discovery_scope_forbidden', 'google_credentials_unavailable']);
const safe = error => CODES.has(error?.code) ? error.code : 'google_discovery_unavailable';
const status = error => error?.code === 'google_discovery_no_connection' ? 404 : error?.code === 'google_discovery_session_required' ? 401 : error?.code === 'google_discovery_scope_forbidden' ? 403
  : CONFLICT.has(error?.code) ? 409 : 503;
function createGooglePropertyDiscovery({ hasManaged, listBindings, loadMapping, readers: adapters, enabled, now = Date.now }) {
  let active = 0;
  const registry = async fn => { try { return await fn(); } catch { fail('broker_registry_unavailable'); } };
  const managed = () => registry(hasManaged);
  const assertLegacyAllowed = async () => { if (await managed()) fail('google_oauth_legacy_closed'); };
  return {
    assertLegacyAllowed,
    async list({ kind, clinicIds, connectionId, revalidate }) {
      if (!['search_console', 'analytics'].includes(kind) || !Array.isArray(clinicIds) || !clinicIds.length || clinicIds.length > 1000
        || clinicIds.some(id => !positive(id)) || new Set(clinicIds).size !== clinicIds.length || !positive(connectionId)
        || typeof revalidate !== 'function') fail('broker_binding_invalid');
      if (active >= 4) fail('broker_discovery_busy');
      active++;
      try {
        if (!await managed()) return null;
        const deadline = now() + 60000;
        const check = async () => {
          await revalidate(true);
          if (!enabled(kind)) fail('broker_cohort_disabled');
          const remaining = deadline - now(); if (remaining <= 0) fail('broker_discovery_timeout');
          return { timeoutMs: Math.min(30000, remaining) };
        };
        await check();
        const list = () => registry(() => listBindings(kind, clinicIds, connectionId));
        const bindings = await list();
        if (!Array.isArray(bindings)) fail('broker_registry_unavailable');
        if (!bindings.length) fail('broker_discovery_scope_unconfigured');
        if (bindings.length > 20) fail('broker_discovery_limit');
        const signature = rows => JSON.stringify(rows.map(row => fields(kind).map(key => row[key])));
        const initial = signature(bindings); const ids = new Set(); const result = new Map();
        const mappings = [];
        for (const row of bindings) {
          if (!positive(Number(row.mapping_id)) || ids.has(Number(row.mapping_id)) || !clinicIds.includes(Number(row.clinica_id))
            || Number(row.google_connection_id) !== connectionId || row.state !== 'active') fail('broker_binding_invalid');
          ids.add(Number(row.mapping_id));
          const mapping = await registry(() => loadMapping(kind, Number(row.mapping_id)));
          if (!mapping || Number(mapping.id) !== Number(row.mapping_id) || Number(mapping.clinicaId) !== Number(row.clinica_id)
            || Number(mapping.googleConnectionId) !== connectionId || !mapping.isActive
            || mapping.broker_read_connection_ref !== row.connection_ref || mapping.broker_read_asset_ref !== row.asset_ref
            || (kind === 'search_console' ? mapping.siteUrl !== row.site_url : mapping.propertyName !== row.property_name)) fail('broker_binding_invalid');
          await check(); const context = await adapters[kind].prepare(mapping);
          if (!context) fail('broker_binding_invalid');
          const response = await adapters[kind].read(mapping, context, 'discovery', {}, { beforeExecute: check });
          await check();
          const key = kind === 'search_console' ? mapping.siteUrl : mapping.propertyName;
          if (result.has(key) && JSON.stringify(result.get(key)) !== JSON.stringify(response.data)) fail('broker_response_invalid');
          result.set(key, response.data); mappings.push(mapping);
        }
        const latest = await list(); if (!Array.isArray(latest) || signature(latest) !== initial) fail('broker_binding_invalid');
        // Recheck every mapping, including those read before a later await.
        for (const mapping of mappings) { await check(); if (!await adapters[kind].prepare(mapping)) fail('broker_binding_invalid'); }
        await check();
        const output = [...result.values()]; if (Buffer.byteLength(JSON.stringify(output)) > 1048576) fail('broker_discovery_limit');
        return output;
      } finally { active--; }
    },
  };
}
function createDiscoveryRepository(getModels) {
  const model = kind => getModels()[kind === 'search_console' ? 'SearchConsoleBrokerBinding' : 'AnalyticsBrokerBinding'];
  const repositories = { search_console: readers.search_console.createSearchConsoleRepository(getModels), analytics: readers.analytics.createAnalyticsRepository(getModels) };
  return {
    listBindings: (kind, clinicIds, connectionId) => model(kind).findAll({ where: { clinica_id: { [Op.in]: clinicIds }, google_connection_id: connectionId },
      attributes: fields(kind), order: [['mapping_id', 'ASC']], limit: 21, raw: true, logging: false }),
    loadMapping: (kind, id) => repositories[kind].loadMapping(id),
  };
}
const service = createGooglePropertyDiscovery({ readers, ...createDiscoveryRepository(() => require('../../models')),
  hasManaged: async () => {
    try { await googleOAuth.assertLegacyAllowed(); await businessProfile.assertLegacyAllowed(); return false; }
    catch (error) { if (['google_oauth_legacy_closed', 'broker_legacy_discovery_blocked'].includes(error?.code)) return true; throw error; }
  },
  enabled: kind => process.env[kind === 'search_console' ? 'GOOGLE_SEARCH_CONSOLE_BROKER_ENABLED' : 'GOOGLE_ANALYTICS_BROKER_ENABLED'] === 'true',
});
module.exports = { ...service, createGooglePropertyDiscovery, createDiscoveryRepository, safe, status };
