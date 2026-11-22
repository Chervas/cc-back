'use strict';

const fs = require('node:fs');
const path = require('node:path');
const C = require('./googleOAuthCohort.contract');
const GA = require('../../services/integrations-broker/src/google-analytics-contract');
const { projectGA } = require('../../services/integrations-broker/src/google-property-discovery-contract');
const { fromBinding, inspectRevocations } = require('./googlePropertyRevocation.contract');

const CONFIG = '/etc/clinicaclick-google-analytics/reviewed-properties.json';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HEX = /^[a-f0-9]{64}$/;
const KEYS = ['descriptorId', 'scopeKey', 'clinicId', 'clinicIds', 'connectionId', 'googleUserId', 'connectionRef', 'propertyName',
  'assetRef', 'authorizationBindingDigest', 'credentialVersion', 'reviewedAtEpochMs', 'expiresAtEpochMs'];
const capabilities = new WeakMap();
const fail = (code = 'broker_binding_invalid', httpStatus = 409) => C.fail(code, httpStatus);
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const positive = value => Number.isInteger(value) && C.positive(String(value));
const validIds = values => Array.isArray(values) && values.length > 0 && values.length <= 1000 &&
  values.every((value, i) => positive(value) && (!i || value > values[i - 1]));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const sqlOptions = transaction => ({ transaction, lock: transaction.LOCK.UPDATE, raw: true, logging: false });

function descriptor(value, now = Date.now()) {
  if (!exact(value, KEYS) || !UUID.test(value.descriptorId) || !UUID.test(value.credentialVersion)
    || !HEX.test(value.authorizationBindingDigest) || !positive(value.clinicId) || !positive(value.connectionId)
    || !validIds(value.clinicIds) || !value.clinicIds.includes(value.clinicId)
    || typeof value.googleUserId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(value.googleUserId) || value.googleUserId === 'unknown'
    || typeof value.connectionRef !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value.connectionRef)
    || !Number.isSafeInteger(value.reviewedAtEpochMs) || value.reviewedAtEpochMs < 0 || value.reviewedAtEpochMs > now
    || !Number.isSafeInteger(value.expiresAtEpochMs) || value.expiresAtEpochMs <= value.reviewedAtEpochMs
    || value.expiresAtEpochMs - value.reviewedAtEpochMs > 900000) fail();
  const resource = GA.property(value.propertyName), scope = C.requestedScope(value.scopeKey);
  if (resource.assetRef !== value.assetRef || scope.type === 'clinic' && !same(value.clinicIds, [scope.id])) fail();
  return Object.fromEntries(KEYS.map(key => [key, key === 'clinicIds' ? value.clinicIds.slice() : value[key]]));
}

function loadDescriptors() {
  let fd;
  try {
    for (let directory = path.dirname(CONFIG); ; directory = path.dirname(directory)) {
      const st = fs.lstatSync(directory);
      if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== 0 || st.mode & 0o022) fail('broker_configuration_invalid', 503);
      if (directory === '/') break;
    }
    fd = fs.openSync(CONFIG, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.uid !== 0n || before.gid !== 1000n || (before.mode & 0o777n) !== 0o640n
      || before.nlink !== 1n || before.size > 65536n) fail('broker_configuration_invalid', 503);
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd, { bigint: true });
    if (bytes.length !== Number(before.size) || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key])) fail();
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!exact(value, ['entries', 'schema']) || value.schema !== 'clinicaclick-reviewed-analytics-properties/1') fail();
    return value.entries;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    fail('broker_configuration_invalid', 503);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

async function inspectAdditionCapability(capability, input) {
  const inspect = capabilities.get(capability);
  if (!inspect) fail();
  return inspect(input);
}

function createReviewedAnalyticsMapping({ models, sessions, readProperty, descriptors = loadDescriptors,
  enabled = () => process.env.GOOGLE_ANALYTICS_BROKER_ENABLED === 'true', now = Date.now }) {
  const authority = require('./googleOAuthCohortScope.service').authorizeReviewedAnalyticsAddition;
  const getModels = () => typeof models === 'function' ? models() : models;
  const transact = fn => getModels().sequelize.transaction({ isolationLevel: 'SERIALIZABLE' }, fn);
  let active = 0;

  function pin(input) {
    C.requestedScope(input.scopeKey);
    if (!positive(input.actorId) || !positive(input.connectionId) || !UUID.test(input.sessionRef)
      || !Number.isSafeInteger(input.sessionExpiresAt) || input.sessionExpiresAt <= now()
      || !validIds(input.clinicIds) || typeof input.revalidate !== 'function') fail();
    return { ...input, clinicIds: input.clinicIds.slice() };
  }

  async function entries(input) {
    const values = await descriptors();
    if (!Array.isArray(values) || values.length > 20) fail('broker_configuration_invalid', 503);
    const checked = values.map(value => descriptor(value, now()));
    if (new Set(checked.map(value => value.descriptorId)).size !== checked.length ||
      new Set(checked.map(value => JSON.stringify([value.scopeKey, value.clinicId, value.assetRef]))).size !== checked.length) fail();
    return checked.filter(value => value.scopeKey === input.scopeKey && value.connectionId === input.connectionId
      && same(value.clinicIds, input.clinicIds) && value.expiresAtEpochMs > now());
  }

  async function existing(m, entry, transaction) {
    const options = sqlOptions(transaction);
    const mapping = await m.ClinicAnalyticsProperty.findOne({ ...options,
      where: { clinicaId: entry.clinicId, propertyName: entry.propertyName } });
    const records = await m.AnalyticsBrokerBinding.findAll({ ...options,
      where: { clinica_id: entry.clinicId, property_name: entry.propertyName }, limit: 2 });
    if (mapping && (![1, true].includes(mapping.isActive) || Number(mapping.googleConnectionId) !== entry.connectionId
      || mapping.broker_read_connection_ref !== entry.connectionRef || mapping.broker_read_asset_ref !== entry.assetRef)) fail();
    if (!Array.isArray(records) || records.length !== (mapping ? 1 : 0)) fail();
    if (mapping) {
      const record = records[0];
      fromBinding('analytics', record);
      if (record.state !== 'active' || Number(record.mapping_id) !== Number(mapping.id) || record.connection_ref !== entry.connectionRef
        || record.asset_ref !== entry.assetRef || record.google_user_id !== entry.googleUserId
        || Number(record.google_connection_id) !== entry.connectionId) fail();
    }
    return mapping;
  }

  async function check(input, entry, transaction) {
    if (!enabled()) fail('broker_cohort_disabled', 503);
    const revalidate = async () => {
      await input.revalidate();
      if (!(await entries(input)).some(value => same(value, entry)) || !enabled()) fail();
    };
    await revalidate();
    const m = getModels(), options = sqlOptions(transaction);
    const binding = await m.GoogleOAuthBrokerBinding.findOne({ ...options, where: { google_user_id: entry.googleUserId, cohort: 'analytics' } });
    if (!binding || binding.policy_version !== C.POLICY || binding.connection_ref !== entry.connectionRef
      || Number(binding.google_connection_id) !== entry.connectionId || C.digest(binding) !== entry.authorizationBindingDigest
      || binding.secret_version !== entry.credentialVersion || !(binding.confirmed_at instanceof Date) || +binding.confirmed_at > now()) {
      fail('broker_discovery_scope_unconfigured');
    }
    const proof = Object.freeze({});
    capabilities.set(proof, async request => {
      if (request.models !== m || request.requestScopeKey !== input.scopeKey || request.actorId !== input.actorId
        || request.sessionRef !== input.sessionRef || +request.expiresAt !== input.sessionExpiresAt || request.transaction !== transaction
        || C.digest(request.binding) !== entry.authorizationBindingDigest) fail();
      await revalidate();
      return entry;
    });
    try {
      await authority({ models: m, binding, requestScopeKey: input.scopeKey, actorId: input.actorId, sessionRef: input.sessionRef,
        expiresAt: new Date(input.sessionExpiresAt), transaction, sessions: sessions || require('./accessSession.service') }, proof);
    } finally { capabilities.delete(proof); }
    const history = await m.GooglePropertyBrokerRevocation.findAll({ ...options, where: { kind: 'analytics', asset_ref: entry.assetRef }, limit: 1001 });
    inspectRevocations('analytics', entry.assetRef, entry.clinicId, entry.connectionRef, history);
    if (history.some(row => Number(row.clinica_id) === entry.clinicId)) fail('asset_revoked');
    const mapping = await existing(m, entry, transaction);
    await revalidate();
    return mapping;
  }

  async function bounded(work) {
    if (active >= 4) fail('broker_discovery_busy', 503);
    active++;
    try { return await work(now() + 60000); } finally { active--; }
  }
  async function read(input, entry, deadline) {
    const recheck = () => transact(transaction => check(input, entry, transaction));
    await recheck();
    const remaining = deadline - now();
    if (remaining <= 0) fail('broker_discovery_timeout', 503);
    const actual = projectGA(await readProperty(entry, { beforeExecute: recheck, timeoutMs: Math.min(remaining, 30000) }), entry.propertyName);
    await recheck();
    if (deadline <= now()) fail('broker_discovery_timeout', 503);
    return actual;
  }

  return {
    async additionStatus(input) {
      const pinned = pin(input), available = await entries(pinned);
      if (!available.length) return null;
      return bounded(async deadline => {
        for (const entry of available) {
          await transact(transaction => check(pinned, entry, transaction));
          if (deadline <= now()) fail('broker_discovery_timeout', 503);
        }
        return { mode: 'broker_reviewed_addition', connected: false, google_service: 'analytics', inventory_access: 'operator_reviewed_exact_property' };
      });
    },
    async inventory(input) {
      const pinned = pin(input), available = await entries(pinned);
      return bounded(async deadline => {
        const results = new Map();
        for (const entry of available) {
          const value = await read(pinned, entry, deadline);
          if (results.has(value.name) && !same(results.get(value.name), value)) fail('broker_response_invalid', 503);
          results.set(value.name, value);
        }
        return [...results.values()];
      });
    },
    async map(input, payload) {
      const pinned = pin(input);
      if (!exact(payload, ['mappings']) || !Array.isArray(payload.mappings) || payload.mappings.length !== 1
        || !exact(payload.mappings[0], ['clinicaId', 'propertyName'])) fail('broker_binding_invalid', 400);
      const { clinicaId, propertyName } = payload.mappings[0];
      if (!pinned.clinicIds.includes(clinicaId)) fail('google_discovery_scope_forbidden', 403);
      const entry = (await entries(pinned)).find(value => value.clinicId === clinicaId && value.propertyName === propertyName);
      if (!entry) fail('broker_discovery_scope_unconfigured');
      return bounded(async deadline => {
        const asset = await read(pinned, entry, deadline), m = getModels();
        return transact(async transaction => {
          let mapping = await check(pinned, entry, transaction);
          if (!mapping) {
            mapping = await m.ClinicAnalyticsProperty.create({ clinicaId, propertyName, googleConnectionId: entry.connectionId,
              propertyDisplayName: asset.displayName, propertyType: asset.propertyType, parent: asset.parent, measurementId: null, isActive: true,
              broker_read_connection_ref: entry.connectionRef, broker_read_asset_ref: entry.assetRef }, { transaction, logging: false });
            await m.AnalyticsBrokerBinding.create({ property_name: propertyName, mapping_id: Number(mapping.id), connection_ref: entry.connectionRef,
              asset_ref: entry.assetRef, clinica_id: clinicaId, google_connection_id: entry.connectionId, google_user_id: entry.googleUserId,
              state: 'active' }, { transaction, logging: false });
          }
          const verified = await check(pinned, entry, transaction);
          if (!verified || Number(verified.id) !== Number(mapping.id) || deadline <= now()) fail();
          return { success: true, mapped: 1, inventory_mode: 'broker_grants', assets: [{ id: Number(mapping.id), clinicaId, propertyName }] };
        });
      });
    },
  };
}

let singleton;
const service = () => singleton ||= createReviewedAnalyticsMapping({ models: () => require('../../models'),
  readProperty: require('./analyticsBroker.service').readReviewedProperty });
module.exports = { CONFIG, descriptor, createReviewedAnalyticsMapping, inspectAdditionCapability,
  additionStatus: (...args) => service().additionStatus(...args), inventory: (...args) => service().inventory(...args), map: (...args) => service().map(...args) };
