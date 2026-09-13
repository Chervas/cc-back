'use strict';

// No model bootstrap or provider credentials at import time. The independent
// registry also disables unrestricted discovery after the first approved cut.
const { Op } = require('sequelize');
const broker = require('./businessProfileBroker.service');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const FIELDS = ['external_location_id', 'connection_ref', 'asset_ref', 'clinica_id', 'google_connection_id'];
const LOCATION_FIELDS = ['id', 'clinica_id', 'google_connection_id', 'location_id', 'is_active', 'broker_read_connection_ref', 'broker_read_asset_ref'];
const fingerprint = rows => JSON.stringify(rows.map(row => FIELDS.map(key => row[key])));
const CONFLICT_CODES = new Set(['broker_binding_invalid', 'broker_legacy_discovery_blocked', 'broker_discovery_scope_unconfigured', 'broker_discovery_limit']);
const ERROR_CODES = new Set([...CONFLICT_CODES, 'broker_registry_unavailable', 'broker_cohort_disabled', 'broker_discovery_busy',
  'broker_discovery_timeout', 'broker_configuration_invalid', 'broker_unavailable', 'broker_response_invalid', 'broker_timeout',
  'invalid_request', 'invalid_signature', 'scope_denied', 'operation_denied', 'connection_blocked', 'request_replayed',
  'idempotency_conflict', 'outcome_unknown', 'rate_limited', 'provider_disabled', 'provider_failed', 'provider_timeout',
  'provider_unauthorized', 'credential_revoked', 'secret_unavailable', 'audit_unavailable', 'internal_error']);

function createBusinessProfileDiscovery({ hasManagedBindings, listBindings, loadLocation, broker: reader,
  enabled = () => process.env.GOOGLE_BUSINESS_PROFILE_BROKER_ENABLED === 'true', now = Date.now }) {
  let active = 0;
  async function registryCall(fn) {
    try { return await fn(); } catch { fail('broker_registry_unavailable'); }
  }
  const hasManaged = () => registryCall(hasManagedBindings);
  async function assertLegacyAllowed() {
    if (await hasManaged()) fail('broker_legacy_discovery_blocked');
  }
  return {
    assertLegacyAllowed,
    async list({ clinicIds, connectionId, revalidate }) {
      if (!Array.isArray(clinicIds) || !clinicIds.length || clinicIds.length > 1000
        || clinicIds.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(clinicIds).size !== clinicIds.length
        || !Number.isSafeInteger(connectionId) || connectionId < 1 || typeof revalidate !== 'function') fail('broker_binding_invalid');
      if (active >= 4) fail('broker_discovery_busy');
      active++;
      try {
        await revalidate();
        if (!await hasManaged()) return null;
        if (!enabled()) fail('broker_cohort_disabled');
        const deadline = now() + 30000;
        const bindings = await registryCall(() => listBindings(clinicIds, connectionId));
        if (!Array.isArray(bindings) || !bindings.length) fail('broker_discovery_scope_unconfigured');
        if (bindings.length > 20) fail('broker_discovery_limit');
        const original = fingerprint(bindings);
        const result = []; const mappingIds = [];
        for (const binding of bindings) {
          if (!clinicIds.includes(Number(binding.clinica_id)) || Number(binding.google_connection_id) !== connectionId) fail('broker_binding_invalid');
          await revalidate();
          if (!enabled()) fail('broker_cohort_disabled');
          const location = await registryCall(() => loadLocation(binding));
          if (!location?.is_active || location.broker_read_connection_ref !== binding.connection_ref || location.broker_read_asset_ref !== binding.asset_ref) fail('broker_binding_invalid');
          // The reader rechecks the persistent registry/mapping around each call.
          const context = await reader.prepare(location, () => fail('broker_binding_invalid'), new Map());
          const response = await reader.read(location, context, 'discovery', {}, { beforeExecute: async () => {
            await revalidate();
            if (!enabled()) fail('broker_cohort_disabled');
            const remaining = deadline - now();
            if (remaining <= 0) fail('broker_discovery_timeout');
            return { timeoutMs: remaining };
          } });
          mappingIds.push(Number(location.id)); result.push(response.data);
          if (Buffer.byteLength(JSON.stringify(result)) > 1048576) fail('broker_discovery_limit');
        }
        await revalidate();
        if (!enabled()) fail('broker_cohort_disabled');
        const latest = await registryCall(() => listBindings(clinicIds, connectionId));
        if (!Array.isArray(latest) || fingerprint(latest) !== original) fail('broker_binding_invalid');
        for (let index = 0; index < latest.length; index++) {
          const location = await registryCall(() => loadLocation(latest[index]));
          if (!location?.is_active || Number(location.id) !== mappingIds[index]
            || Number(location.clinica_id) !== Number(latest[index].clinica_id)
            || Number(location.google_connection_id) !== connectionId
            || location.broker_read_connection_ref !== latest[index].connection_ref
            || location.broker_read_asset_ref !== latest[index].asset_ref) fail('broker_binding_invalid');
          await reader.prepare(location, () => fail('broker_binding_invalid'), new Map());
        }
        await revalidate();
        if (!enabled()) fail('broker_cohort_disabled');
        if (now() >= deadline) fail('broker_discovery_timeout');
        return result;
      } finally { active--; }
    },
  };
}

const service = createBusinessProfileDiscovery({ broker,
  hasManagedBindings: async () => !!await require('../../models').BusinessProfileBrokerBinding.findOne({ attributes: ['external_location_id'], raw: true }),
  listBindings: (clinicIds, connectionId) => require('../../models').BusinessProfileBrokerBinding.findAll({
    where: { clinica_id: { [Op.in]: clinicIds }, google_connection_id: connectionId }, attributes: FIELDS,
    order: [['external_location_id', 'ASC']], limit: 21, raw: true,
  }),
  loadLocation: async binding => {
    const rows = await require('../../models').ClinicBusinessLocation.findAll({
      where: { clinica_id: binding.clinica_id, google_connection_id: binding.google_connection_id,
        broker_read_connection_ref: binding.connection_ref, broker_read_asset_ref: binding.asset_ref },
      attributes: LOCATION_FIELDS, limit: 2, raw: true,
    });
    if (rows.length !== 1) throw Error('mapping_missing_or_ambiguous');
    return rows[0];
  },
});
module.exports = { ...service, createBusinessProfileDiscovery, ERROR_CODES, CONFLICT_CODES };
