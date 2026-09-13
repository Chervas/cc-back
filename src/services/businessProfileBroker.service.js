'use strict';
const fs = require('node:fs'); const path = require('node:path');
const { createIntegrationsBrokerClient } = require('../lib/integrationsBrokerClient');
const PREFIX = 'google.business_profile.';
const OPERATIONS = new Set(['metrics', 'reviews', 'posts', 'media', 'details', 'verification', 'discovery']);
const fail = code => { throw Object.assign(new Error(code), { code }); };
function privateFile(filename) {
  try {
    if (typeof filename !== 'string' || !path.isAbsolute(filename) || fs.realpathSync(filename) !== filename) fail('broker_configuration_invalid');
    const stat = fs.statSync(filename);
    if (!stat.isFile() || stat.mode & 0o077 || stat.size > 65536) fail('broker_configuration_invalid');
    return fs.readFileSync(filename);
  } catch { fail('broker_configuration_invalid'); }
}
const marked = location => location.broker_read_connection_ref != null || location.broker_read_asset_ref != null;
function externalLocationId(location) {
  const match = /^(?:accounts\/[1-9]\d{0,29}\/)?(?:locations\/)?([1-9]\d{0,29})$/.exec(String(location.location_id));
  if (!match) fail('broker_binding_invalid');
  return match[1];
}
function binding(location) {
  const ref = location.broker_read_connection_ref;
  const match = typeof location.broker_read_asset_ref === 'string' && /^gbp:([1-9]\d{0,29}):([1-9]\d{0,29})$/.exec(location.broker_read_asset_ref);
  const locationId = /^(?:accounts\/[1-9]\d{0,29}\/)?(?:locations\/)?([1-9]\d{0,29})$/.exec(String(location.location_id));
  if (typeof ref !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(ref) || !match || !locationId
    || locationId[1] !== match[2] || !Number.isSafeInteger(Number(location.clinica_id)) || Number(location.clinica_id) < 1
    || !Number.isSafeInteger(Number(location.id)) || Number(location.id) < 1) fail('broker_binding_invalid');
  return { connectionRef: ref, assetRef: location.broker_read_asset_ref, tenantRef: `clinic:${Number(location.clinica_id)}` };
}
function createBusinessProfileBroker({ client, loadLocation, loadManagedBinding, loadRevocation = async () => null, enabled = () => process.env.GOOGLE_BUSINESS_PROFILE_BROKER_ENABLED === 'true' }) {
  const contexts = new WeakMap();
  const managed = (location, context) => marked(location) || !!(context && typeof context === 'object' && contexts.has(context));
  async function recordedBinding(location) {
    if (await loadRevocation(externalLocationId(location))) fail('asset_revoked');
    const record = await loadManagedBinding(externalLocationId(location));
    if (!record && !marked(location)) return null;
    if (!record || !marked(location)) fail('broker_binding_invalid');
    const scope = binding(location);
    if (record.external_location_id !== externalLocationId(location) || record.connection_ref !== scope.connectionRef || record.asset_ref !== scope.assetRef
      || Number(record.clinica_id) !== Number(location.clinica_id) || Number(record.google_connection_id) !== Number(location.google_connection_id)) fail('broker_binding_invalid');
    return scope;
  }
  return {
    managed,
    async prepare(location, loadLegacyToken, legacyCache) {
      // Independent registry survives disconnect/cascade/recreation of the old mapping.
      const scope = await recordedBinding(location);
      if (scope) {
        if (!enabled()) fail('broker_cohort_disabled');
        const context = Object.freeze({}); contexts.set(context, { ...scope, id: Number(location.id), googleConnectionId: Number(location.google_connection_id) });
        return context;
      }
      const key = Number(location.google_connection_id);
      if (!legacyCache.has(key)) legacyCache.set(key, (await loadLegacyToken(location.google_connection_id)).accessToken);
      return legacyCache.get(key);
    },
    async read(location, context, family, payload, options) {
      if (!enabled()) fail('broker_cohort_disabled');
      const captured = context && typeof context === 'object' && contexts.get(context);
      if (!captured || !OPERATIONS.has(family) || captured.id !== Number(location.id)) fail('broker_binding_invalid');
      const current = await loadLocation(captured.id);
      if (!current || !current.is_active || !marked(current)) fail('broker_binding_invalid');
      const scope = await recordedBinding(current);
      if (Number(current.google_connection_id) !== captured.googleConnectionId
        || Object.keys(scope).some(k => scope[k] !== captured[k])) fail('broker_binding_invalid');
      const transportOptions = options?.beforeExecute ? await options.beforeExecute() : options;
      const result = await client.execute({ ...scope, operation: PREFIX + family + '.read.v1', payload }, transportOptions);
      if (!enabled()) fail('broker_cohort_disabled');
      const latest = await loadLocation(captured.id);
      if (!latest || !latest.is_active || !marked(latest) || Number(latest.google_connection_id) !== captured.googleConnectionId) fail('broker_binding_invalid');
      const latestScope = await recordedBinding(latest);
      if (Object.entries(latestScope).some(([key, value]) => value !== captured[key])) fail('broker_binding_invalid');
      return { data: result.data };
    },
  };
}
let cachedClient;
const client = { execute(command, options) {
  cachedClient ||= createIntegrationsBrokerClient({ origin: process.env.INTEGRATIONS_BROKER_ORIGIN,
    audience: process.env.INTEGRATIONS_BROKER_AUDIENCE, keyId: process.env.GOOGLE_BUSINESS_PROFILE_BROKER_KEY_ID,
    ca: privateFile(process.env.INTEGRATIONS_BROKER_CA_FILE), privateKey: privateFile(process.env.GOOGLE_BUSINESS_PROFILE_BROKER_KEY_FILE), timeoutMs: 30000 });
  return cachedClient.execute(command, options);
} };
const service = createBusinessProfileBroker({ client,
  loadRevocation: id => require('../../models').BusinessProfileBrokerRevocation.findByPk(id, { attributes: ['external_location_id'], raw: true }),
  loadManagedBinding: id => require('../../models').BusinessProfileBrokerBinding.findByPk(id, { raw: true }),
  loadLocation: id => require('../../models').ClinicBusinessLocation.findByPk(id, {
  attributes: ['id', 'clinica_id', 'google_connection_id', 'location_id', 'is_active', 'broker_read_connection_ref', 'broker_read_asset_ref'], raw: true,
}) });
module.exports = { ...service, createBusinessProfileBroker, binding };
