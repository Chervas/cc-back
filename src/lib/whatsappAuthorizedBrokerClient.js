'use strict';

// Staging-only adapter. The registry contains routing metadata, never Meta
// credentials. Every send is pinned to an existing application Message ID.
const fs = require('node:fs');
const C = require('../../services/integrations-broker/src/whatsapp-authorized-contract');
const { requestIdFor, assertStaging } = require('./whatsappBrokerClient');
const { createIntegrationsBrokerClient } = require('./integrationsBrokerClient');
const ROOT = '/etc/clinicaclick-whatsapp-authorized/staging';
const CONFIG_FILE = ROOT + '/config.json';
const BINDING_KEYS = ['connectionRef','authorizationId','clinicId','assetId','phoneId','wabaId','revision','sendEnabled'];
// Only denials that cannot originate from checks after Meta's message POST.
// Scope/connection/asset revocations can race after that POST and remain unknown.
const NO_SEND_CODES = new Set(['invalid_signature','rate_limited']);
const PREFLIGHT_CODES = new Set(['whatsapp_broker_runtime_denied','whatsapp_authorized_configuration_invalid',
  'whatsapp_authorized_binding_invalid','whatsapp_authorized_scope_blocked','whatsapp_authorized_binding_changed']);
const id = v => Number.isInteger(v) && v > 0 && v <= 2147483647;
const providerId = v => typeof v === 'string' && /^[1-9][0-9]{0,29}$/.test(v);
const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
function fail(code, unknown = false) {
  throw Object.assign(Error(code), { code, retryable: false, ...(unknown ? { delivery_unknown: true } : {}) });
}
function checkedBinding(value) {
  if (!exact(value, BINDING_KEYS) || typeof value.connectionRef !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value.connectionRef)
    || !uuid(value.authorizationId) || !id(value.clinicId) || !id(value.assetId) || !id(value.revision)
    || !providerId(value.phoneId) || !providerId(value.wabaId) || typeof value.sendEnabled !== 'boolean') fail('whatsapp_authorized_binding_invalid');
  return Object.freeze(Object.fromEntries(BINDING_KEYS.map(key => [key, value[key]])));
}
const sameBinding = (a, b) => BINDING_KEYS.every(key => a[key] === b[key]);
function privateFile(file, max) {
  try {
    if (fs.realpathSync(file) !== file) throw Error();
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.mode & 0o077 || stat.size < 1 || stat.size > max) throw Error();
    return fs.readFileSync(file);
  } catch { fail('whatsapp_authorized_configuration_invalid'); }
}
function validateConfiguration(value) {
  if (!exact(value, ['version','origin','keyId','audience','privateKeyFile','caFile','bindings']) || value.version !== 1
    || typeof value.origin !== 'string' || typeof value.keyId !== 'string' || typeof value.audience !== 'string'
    || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value.keyId) || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value.audience)
    || value.privateKeyFile !== ROOT + '/private.pem' || value.caFile !== ROOT + '/ca.pem'
    || !Array.isArray(value.bindings) || value.bindings.length > 1000) fail('whatsapp_authorized_configuration_invalid');
  try {
    const url = new URL(value.origin);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error();
  } catch { fail('whatsapp_authorized_configuration_invalid'); }
  const bindings = value.bindings.map(checkedBinding);
  if (new Set(bindings.map(b => `${b.clinicId}:${b.assetId}`)).size !== bindings.length) fail('whatsapp_authorized_configuration_invalid');
  return Object.freeze({ ...value, bindings: Object.freeze(bindings) });
}
function configuration(env = process.env) {
  if (!env.WHATSAPP_AUTHORIZED_BROKER_CONFIG_FILE) return null;
  assertStaging(env);
  if (env.WHATSAPP_AUTHORIZED_BROKER_CONFIG_FILE !== CONFIG_FILE) fail('whatsapp_authorized_configuration_invalid');
  const raw = privateFile(CONFIG_FILE, 1048576);
  try { return validateConfiguration(JSON.parse(raw.toString('utf8'))); }
  catch { fail('whatsapp_authorized_configuration_invalid'); }
  finally { raw.fill(0); }
}
function configuredTransport(config) {
  return { async execute(command) {
    let key; let ca;
    try {
      key = privateFile(config.privateKeyFile, 8192); ca = privateFile(config.caFile, 65536);
      const client = createIntegrationsBrokerClient({ origin: config.origin, keyId: config.keyId, audience: config.audience,
        privateKey: key, ca, timeoutMs: 30000 });
      return await client.execute(command);
    } finally { key?.fill(0); ca?.fill(0); }
  } };
}
const models = () => require('../../models');
function createWhatsappAuthorizedBrokerClient({ environment = () => process.env, loadConfiguration = () => configuration(environment()),
  loadAsset = assetId => models().ClinicMetaAsset.findOne({ where: { id: assetId, assetType: 'whatsapp_phone_number' },
    attributes: ['id','clinicaId','grupoClinicaId','assignmentScope','assetType','phoneNumberId','wabaId','isActive'], raw: true }),
  loadClinic = clinicId => models().Clinica.findByPk(clinicId, { attributes: ['id_clinica','grupoClinicaId'], raw: true }),
  isBlocked = clinicId => require('../services/metaScopeBlock.service').blocked({ assignmentScope: 'clinic', clinicId }),
  createTransport = configuredTransport } = {}) {
  function read() {
    const value = loadConfiguration();
    if (value === null) return null;
    assertStaging(environment()); return validateConfiguration(value);
  }
  function selected(config, clinicId, assetId) {
    if (!id(clinicId) || !id(assetId)) fail('whatsapp_authorized_binding_invalid');
    return config?.bindings.find(b => b.clinicId === clinicId && b.assetId === assetId) || null;
  }
  async function binding(clinicId, assetId, assetHint) {
    try {
      const config = read(); const value = selected(config, clinicId, assetId);
      if (!value) return null;
      const asset = assetHint || await loadAsset(assetId); const clinic = await loadClinic(clinicId);
      if (!asset || !clinic || Number(clinic.id_clinica) !== clinicId || asset.id !== value.assetId || asset.assetType !== 'whatsapp_phone_number'
        || asset.phoneNumberId !== value.phoneId || asset.wabaId !== value.wabaId
        || !(asset.assignmentScope === 'clinic' && Number(asset.clinicaId) === clinicId
          || asset.assignmentScope === 'group' && id(Number(asset.grupoClinicaId)) && Number(asset.grupoClinicaId) === Number(clinic.grupoClinicaId))) {
        fail('whatsapp_authorized_binding_invalid');
      }
      // blocked() includes both this clinic and its current group, including
      // durable tombstones surviving deletion of the former connection.
      if (await isBlocked(clinicId) !== false) fail('whatsapp_authorized_scope_blocked');
      assertStaging(environment());
      const latest = read();
      if (!latest || JSON.stringify(latest) !== JSON.stringify(config)) fail('whatsapp_authorized_binding_changed');
      return value;
    } catch (error) { fail(PREFLIGHT_CODES.has(error?.code) ? error.code : 'whatsapp_authorized_binding_invalid'); }
  }
  return Object.freeze({
    bindingsForClinic(clinicId) {
      if (!id(clinicId)) return [];
      return read()?.bindings.filter(b => b.clinicId === clinicId).map(b => ({ ...b })) || [];
    },
    binding,
    async annotate(clinicId, assets = []) {
      const result = [];
      const config = read();
      for (const raw of assets) {
        const { whatsappAuthorizedBinding: ignored, ...asset } = raw;
        const authorized = config ? await binding(clinicId, Number(asset.id), asset) : null;
        if (authorized) result.push({ ...asset, whatsappAuthorizedBinding: authorized });
        else if (asset.isActive !== false && asset.isActive !== 0) result.push(asset);
      }
      return result;
    },
    async send(input) {
      assertStaging(environment());
      if (!exact(input, ['messageId','clinicId','assetId','expectedBinding','message']) || !id(input.clinicId) || !id(input.assetId)) fail('whatsapp_authorized_request_invalid');
      let intent;
      try { intent = structuredClone(input); } catch { fail('whatsapp_authorized_request_invalid'); }
      const requestId = requestIdFor(intent.messageId);
      const expected = checkedBinding(intent.expectedBinding);
      if (expected.clinicId !== intent.clinicId || expected.assetId !== intent.assetId) fail('whatsapp_authorized_binding_invalid');
      const payload = { authorizationId: expected.authorizationId, phoneId: expected.phoneId, message: intent.message };
      try { C.validateSend(payload); } catch { fail('whatsapp_authorized_request_invalid'); }
      const captured = await binding(intent.clinicId, intent.assetId);
      if (!captured || !sameBinding(captured, expected)) fail('whatsapp_authorized_binding_changed');
      if (!captured.sendEnabled) fail('whatsapp_authorized_send_paused');
      const config = read(); const transport = createTransport(config);
      // Recheck durable scope/asset and private revision immediately before the
      // only network dispatch. There is no credential or legacy fallback.
      const beforeSend = await binding(intent.clinicId, intent.assetId);
      if (!beforeSend || !sameBinding(captured, beforeSend) || JSON.stringify(read()) !== JSON.stringify(config)) fail('whatsapp_authorized_binding_changed');
      assertStaging(environment());
      let result;
      try {
        result = await transport.execute({ requestId, tenantRef: 'clinic:' + intent.clinicId, connectionRef: captured.connectionRef,
          assetRef: 'wa-phone:' + captured.phoneId, operation: C.SEND, payload });
      } catch (error) {
        if (PREFLIGHT_CODES.has(error?.code) || error?.code === 'broker_configuration_invalid') fail(error.code);
        if (NO_SEND_CODES.has(error?.code)) fail(error.code);
        fail('whatsapp_delivery_unknown', true);
      }
      try {
        assertStaging(environment());
        const latest = await binding(intent.clinicId, intent.assetId);
        if (!latest || !sameBinding(captured, latest) || !exact(result, ['requestId','data','replayed']) || result.requestId !== requestId
          || typeof result.replayed !== 'boolean' || !exact(result.data, ['messages']) || !Array.isArray(result.data.messages)
          || result.data.messages.length !== 1 || !exact(result.data.messages[0], ['id', ...(Object.hasOwn(result.data.messages[0] || {}, 'message_status') ? ['message_status'] : [])])) {
          fail('whatsapp_delivery_unknown', true);
        }
        return C.projectResult(result.data);
      } catch { fail('whatsapp_delivery_unknown', true); }
    },
  });
}
module.exports = { CONFIG_FILE, configuration, validateConfiguration, checkedBinding, createWhatsappAuthorizedBrokerClient,
  ...createWhatsappAuthorizedBrokerClient() };
