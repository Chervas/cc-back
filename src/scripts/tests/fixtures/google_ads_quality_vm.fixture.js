'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const vm = require('node:vm');
const { createRequire } = require('node:module');
const denyNetwork = () => { throw Error('NETWORK_FORBIDDEN_IN_QUALITY_QA'); };
require('node:net').Socket.prototype.connect = denyNetwork;
require('node:tls').connect = denyNetwork; global.fetch = denyNetwork;
// No application/models bootstrap: every non-built-in dependency is explicit.
// Provider calls, tokens and registry rows below are wholly fictitious.
const root = path.resolve(__dirname, '../../../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const customer = '1234567890'; const connection = { id: 71, googleUserId: 'fixture-subject' };
function load(relative, dependencies, suffix = '') {
  const filename = path.join(root, relative); const module = { exports: {} };
  const requireExplicit = name => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    if (name.startsWith('node:')) return require(name);
    throw Error('UNEXPECTED_OFFLINE_IMPORT:' + name);
  };
  vm.runInNewContext(read(relative) + suffix, { module, exports: module.exports, require: requireExplicit,
    Buffer, URL, Date, Map, Set, console, process: { env: {} }, structuredClone }, { filename });
  return module.exports;
}
function fixture() {
  const state = { blocked: null, checks: 0, provider: 0 };
  const raw = load('src/services/googleLegacyCredentials.service.js', { sequelize: require('sequelize') });
  const registry = name => ({ findOne: async () => { state.checks++; return state.blocked === true || state.blocked === name ? { google_user_id: connection.googleUserId } : null; } });
  const credentials = raw.createGoogleLegacyCredentials({
    connectionModel: { findByPk: async id => ({ ...connection, id }) },
    ...Object.fromEntries(['bindingModel', 'searchConsoleModel', 'analyticsModel', 'propertyRevocationModel', 'adsModel', 'adsRevocationModel', 'enrollmentScopeModel', 'enrollmentRequestModel'].map(name => [name, registry(name)])),
  });
  const client = { googleAdsRequest: () => { throw Error('PROVIDER_NOT_INJECTED'); }, normalizeCustomerId: value => String(value || '').replace(/-/g, '') };
  const scoped = { GOOGLE_ADS_SCOPE: 'https://www.googleapis.com/auth/adwords', resolveScopedGoogleAdsRuntime: () => { throw Error('RUNTIME_NOT_INJECTED'); }, runtimeError: code => Object.assign(Error(code), { code }) };
  const service = load('src/services/googleAdsConnectOnlyQualityAudit.service.js', { '../lib/googleAdsClient': client,
    './googleAdsScopedRuntime.service': scoped, './googleLegacyCredentials.service': credentials,
    './googleAdsBrokerReader.service': createRequire(path.join(root, 'src/services/googleAdsBrokerReader.service.js'))('./googleAdsBrokerReader.service') });
  return { state, credentials, service, client, scoped };
}

const dataAssert = { ...assert, deepEqual: (a, b, message) => assert.deepEqual(structuredClone(a), structuredClone(b), message) };
function createLegacyServices() {
  const f = fixture(); const db = {};
  const quality = { ...f.service, auditConnectOnlyCampaignQuality: options => {
    const resolve = options.dependencies?.resolveRuntime;
    return f.service.auditConnectOnlyCampaignQuality({ ...options, dependencies: { ...options.dependencies,
      ...(resolve ? { resolveRuntime: async (...args) => ({ ...await resolve(...args), connection }) } : {}) } });
  } };
  const policy = load('src/services/googleAdsClinicaclickGoalPolicy.service.js', { '../../models': db,
    '../lib/googleAdsClient': f.client, './notifications.service': {}, '../controllers/campaignOnboarding.controller': {},
    './googleAdsScopedRuntime.service': f.scoped, './googleAdsConnectOnlyQualityAudit.service': quality,
    './googleLegacyCredentials.service': f.credentials,
    './googleAdsBrokerReader.service': createRequire(path.join(root, 'src/services/googleAdsBrokerReader.service.js'))('./googleAdsBrokerReader.service') });
  return { quality, policy };
}
module.exports = { fixture, createLegacyServices, dataAssert, root, read, load, customer, connection };
