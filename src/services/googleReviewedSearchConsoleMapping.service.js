'use strict';
const fs = require('node:fs'); const path = require('node:path');
const C = require('./googleOAuthCohort.contract');
const SC = require('../../services/integrations-broker/src/google-search-console-contract');
const projection = require('../../services/integrations-broker/src/google-property-discovery-contract');
const revocations = require('./googlePropertyRevocation.contract');
const CONFIG = '/etc/clinicaclick-google-search-console/reviewed-properties.json';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const KEYS = ['descriptorId','scopeKey','clinicId','connectionId','googleUserId','connectionRef','siteUrl','assetRef',
  'authorizationBindingDigest','reviewedAtEpochMs','expiresAtEpochMs'].sort().join(',');
const fail = (code = 'broker_binding_invalid', httpStatus = 409) => { throw Object.assign(Error(code), { code, httpStatus }); };
function descriptor(row, now, { allowExpired = false } = {}) {
  if (!row || Object.keys(row).sort().join(',') !== KEYS || !UUID.test(row.descriptorId)
    || !C.positive(String(row.clinicId)) || !Number.isInteger(row.clinicId)
    || !C.positive(String(row.connectionId)) || !Number.isInteger(row.connectionId)
    || typeof row.googleUserId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(row.googleUserId) || row.googleUserId === 'unknown'
    || typeof row.connectionRef !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(row.connectionRef)
    || typeof row.authorizationBindingDigest !== 'string' || !/^[a-f0-9]{64}$/.test(row.authorizationBindingDigest)
    || !Number.isSafeInteger(row.reviewedAtEpochMs) || !Number.isSafeInteger(row.expiresAtEpochMs)
    || row.reviewedAtEpochMs < 0 || row.reviewedAtEpochMs > now || row.expiresAtEpochMs <= row.reviewedAtEpochMs
    || !allowExpired && row.expiresAtEpochMs <= now
    || row.expiresAtEpochMs > row.reviewedAtEpochMs + 900000) fail();
  C.requestedScope(row.scopeKey);
  const site = SC.site(row.siteUrl);
  if (row.assetRef !== site.assetRef || row.scopeKey.startsWith('clinic:') && row.scopeKey !== 'clinic:' + row.clinicId) fail();
  return { ...row };
}
// This is an operator-owned capability input, never an HTTP body or environment
// descriptor. An absent file leaves existing inventory unchanged/fail-closed.
function loadDescriptors() {
  let fd;
  try {
    for (let parent = path.dirname(CONFIG); ; parent = path.dirname(parent)) {
      const st = fs.lstatSync(parent);
      if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== 0 || st.mode & 0o022) fail('broker_configuration_invalid', 503);
      if (parent === '/') break;
    }
    fd = fs.openSync(CONFIG, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.uid !== 0n || before.gid !== 1000n || (before.mode & 0o777n) !== 0o640n
      || before.nlink !== 1n || before.size > 65536n) fail('broker_configuration_invalid', 503);
    const bytes = fs.readFileSync(fd); const after = fs.fstatSync(fd, { bigint: true });
    if (['dev','ino','size','mtimeNs','ctimeNs'].some(k => before[k] !== after[k]) || bytes.length !== Number(before.size)) fail('broker_configuration_invalid', 503);
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || Object.keys(value).sort().join(',') !== 'entries,schema'
      || value.schema !== 'clinicaclick-reviewed-search-console-properties/1' || !Array.isArray(value.entries)
      || value.entries.length > 20) fail('broker_configuration_invalid', 503);
    return value.entries;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    fail('broker_configuration_invalid', 503);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function createReviewedSearchConsoleMapping({ models, sessions, readSite, descriptors = loadDescriptors,
  authorize = require('./googleOAuthCohortScope.service').authorize,
  enabled = () => process.env.GOOGLE_SEARCH_CONSOLE_BROKER_ENABLED === 'true', now = Date.now }) {
  let active = 0;
  const getModels = () => typeof models === 'function' ? models() : models;
  const load = async () => {
    const rows = await descriptors();
    if (!Array.isArray(rows) || rows.length > 20) fail('broker_configuration_invalid', 503);
    // Expired capabilities remain structurally validated, but cannot break
    // ordinary inventory for properties already registered independently.
    const valid = rows.map(row => descriptor(row, now(), { allowExpired: true }));
    if (new Set(valid.map(row => row.descriptorId)).size !== valid.length
      || new Set(valid.map(row => JSON.stringify([row.scopeKey,row.clinicId,row.siteUrl]))).size !== valid.length) fail();
    return valid.filter(row => row.expiresAtEpochMs > now());
  };
  const matching = (rows, input) => rows.filter(row => row.scopeKey === input.scopeKey && row.connectionId === input.connectionId
    && input.clinicIds.includes(row.clinicId));
  const key = row => JSON.stringify(row);
  async function check(input, entry, transaction) {
    if (!enabled()) fail('broker_cohort_disabled', 503);
    if (now() >= entry.expiresAtEpochMs) fail();
    await input.revalidate();
    const freshDescriptors = await load();
    if (!freshDescriptors.some(row => key(row) === key(entry))) fail();
    const m = getModels(); const options = { transaction, lock: transaction.LOCK.UPDATE, logging: false, raw: true };
    // No synthetic OAuth binding or exception to standard consumer inspection.
    const binding = await m.GoogleOAuthBrokerBinding.findOne({ ...options,
      where: { google_user_id: entry.googleUserId, cohort: 'search_console' } });
    if (!binding || binding.policy_version !== C.POLICY || C.cohortOf(C.validate(binding)) !== 'search_console'
      || Number(binding.google_connection_id) !== entry.connectionId || binding.connection_ref !== entry.connectionRef
      || C.digest(binding) !== entry.authorizationBindingDigest) fail('broker_discovery_scope_unconfigured');
    await authorize({ models: m, binding, requestScopeKey: input.scopeKey, actorId: input.actorId,
      sessionRef: input.sessionRef, expiresAt: new Date(input.sessionExpiresAt), transaction,
      sessions: sessions || require('./accessSession.service') });
    const rows = await m.GooglePropertyBrokerRevocation.findAll({ ...options,
      where: { kind: 'search_console', asset_ref: entry.assetRef }, limit: 1001 });
    revocations.inspectRevocations('search_console', entry.assetRef, entry.clinicId, entry.connectionRef, rows);
    if (now() >= entry.expiresAtEpochMs) fail();
  }
  async function inspect(input, entry, deadline) {
    const m = getModels();
    const recheck = () => m.sequelize.transaction({ isolationLevel: 'SERIALIZABLE' }, transaction => check(input, entry, transaction));
    await recheck();
    const remaining = deadline - now(); if (remaining <= 0) fail('broker_discovery_timeout', 503);
    const result = projection.projectSC(await readSite(entry, { beforeExecute: recheck, timeoutMs: Math.min(30000, remaining) }), entry.siteUrl);
    if (now() >= deadline) fail('broker_discovery_timeout', 503);
    await recheck(); return result;
  }
  function validateInput(input) {
    C.requestedScope(input.scopeKey);
    if (!C.positive(String(input.actorId)) || !C.positive(String(input.connectionId)) || !UUID.test(input.sessionRef)
      || !Number.isSafeInteger(input.sessionExpiresAt) || input.sessionExpiresAt <= now()
      || !Array.isArray(input.clinicIds) || !input.clinicIds.length || input.clinicIds.length > 1000
      || input.clinicIds.some(id => !Number.isInteger(id) || !C.positive(String(id)))
      || new Set(input.clinicIds).size !== input.clinicIds.length || typeof input.revalidate !== 'function') fail();
  }
  async function bounded(work) {
    if (active >= 4) fail('broker_discovery_busy', 503); active++;
    try { return await work(now() + 60000); } finally { active--; }
  }
  return {
    async inventory(getInput) {
      const entries = await load(); if (!entries.length) return [];
      const input = await getInput(); validateInput(input); const selected = matching(entries, input);
      return bounded(async deadline => {
        const result = [];
        for (const entry of selected) result.push(await inspect(input, entry, deadline));
        return result;
      });
    },
    async map(input, payload) {
      validateInput(input);
      if (!payload || payload.replace_existing === true || !Array.isArray(payload.mappings) || payload.mappings.length !== 1) fail();
      const requested = payload.mappings[0]; const site = SC.site(requested?.siteUrl);
      if (!C.positive(String(requested?.clinicaId)) || !input.clinicIds.includes(Number(requested.clinicaId))) fail();
      const rows = matching(await load(), input).filter(row => row.clinicId === Number(requested.clinicaId) && row.siteUrl === site.siteUrl);
      if (rows.length !== 1) fail('broker_discovery_scope_unconfigured');
      const entry = rows[0];
      return bounded(async deadline => {
        const actual = await inspect(input, entry, deadline); const m = getModels();
        const result = await m.sequelize.transaction({ isolationLevel: 'SERIALIZABLE' }, async transaction => {
          await check(input, entry, transaction);
          const options = { transaction, lock: transaction.LOCK.UPDATE, logging: false };
          let mapping = await m.ClinicWebAsset.findOne({ ...options, where: { clinicaId: entry.clinicId, siteUrl: entry.siteUrl } });
          if (mapping) {
            if (!mapping.isActive || Number(mapping.googleConnectionId) !== entry.connectionId
              || mapping.broker_read_connection_ref !== entry.connectionRef || mapping.broker_read_asset_ref !== entry.assetRef) fail();
          } else {
            mapping = await m.ClinicWebAsset.create({ clinicaId: entry.clinicId, googleConnectionId: entry.connectionId,
              siteUrl: entry.siteUrl, propertyType: entry.siteUrl.startsWith('sc-domain:') ? 'sc-domain' : 'url-prefix',
              permissionLevel: actual.permissionLevel, verified: true, isActive: true,
              broker_read_connection_ref: entry.connectionRef, broker_read_asset_ref: entry.assetRef }, { transaction, logging: false });
            await m.SearchConsoleBrokerBinding.create({ site_hash: site.siteHash, site_url: site.siteUrl, mapping_id: Number(mapping.id),
              connection_ref: entry.connectionRef, asset_ref: entry.assetRef, clinica_id: entry.clinicId,
              google_connection_id: entry.connectionId, google_user_id: entry.googleUserId, state: 'active' }, { transaction, logging: false });
          }
          const bindings = await m.SearchConsoleBrokerBinding.findAll({ ...options, raw: true, limit: 2,
            where: { site_hash: site.siteHash, mapping_id: Number(mapping.id) } });
          if (bindings.length !== 1) fail();
          const binding = bindings[0]; revocations.fromBinding('search_console', binding);
          if (binding.connection_ref !== entry.connectionRef || binding.asset_ref !== entry.assetRef
            || Number(binding.clinica_id) !== entry.clinicId || Number(binding.google_connection_id) !== entry.connectionId
            || binding.google_user_id !== entry.googleUserId || binding.state !== 'active') fail();
          await check(input, entry, transaction);
          if (now() >= deadline) fail('broker_discovery_timeout', 503);
          return { id: Number(mapping.id), clinicaId: entry.clinicId, googleConnectionId: entry.connectionId,
            siteUrl: entry.siteUrl, propertyType: entry.siteUrl.startsWith('sc-domain:') ? 'sc-domain' : 'url-prefix',
            permissionLevel: actual.permissionLevel, verified: true, isActive: true };
        });
        // No automatic backfill/provider job: activation is a separate decision.
        return { success: true, mapped: 1, assets: [result], inventory_mode: 'broker_grants' };
      });
    },
  };
}
let singleton;
const service = () => singleton ||= createReviewedSearchConsoleMapping({ models: () => require('../../models'),
  readSite: require('./searchConsoleBroker.service').readReviewedSite });
module.exports = { CONFIG, descriptor, loadDescriptors, createReviewedSearchConsoleMapping,
  inventory: (...args) => service().inventory(...args), map: (...args) => service().map(...args) };
