'use strict';
// Explicit fake models/broker only. No models/index, .env, sockets or providers.
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const vm = require('node:vm'); const path = require('node:path');
const { createHash } = require('node:crypto'); const { Op } = require('sequelize');
const C = require('../../services/googleOAuthCohort.contract');
const SC = require('../../../services/integrations-broker/src/google-search-console-contract');
const R = require('../../services/googlePropertyRevocation.contract');
const { createGoogleLegacyOAuthGuard, REGISTRIES } = require('../../services/googleLegacyOAuthGuard.service');
const { createReviewedSearchConsoleMapping, descriptor } = require('../../services/googleReviewedSearchConsoleMapping.service');
const { createGoogleOAuthBroker } = require('../../services/googleOAuthBroker.service');
const { createSearchConsoleBroker } = require('../../services/searchConsoleBroker.service');
const clock = Date.parse('2026-10-28T17:00:00Z');
const sessionRef = '10000000-0000-4000-8000-000000000001';
function matches(row, where = {}) {
  return Reflect.ownKeys(where).every(k => {
    const v = where[k]; if (k === Op.or) return v.some(clause => matches(row, clause));
    if (k === Op.and) return v.every(clause => matches(row, clause));
    if (v && typeof v === 'object' && !(v instanceof Date)) return Reflect.ownKeys(v).every(op =>
      op === Op.in ? v[op].includes(row[k]) : op === Op.lte ? row[k] <= v[op] : op === Op.notIn ? !v[op].includes(row[k]) : false);
    return row[k] === v;
  });
}
function fixture() {
  const state = { tables: {}, writes: [], audit: [], reads: [], transactions: [], external: 1, sessionActive: true, permission: true, time: clock,
    failBindingCreate: false, descriptorEntries: [], afterRead: null, afterWrite: null };
  const models = {};
  const names = [...new Set([...REGISTRIES.map(x => x[0]), 'GoogleConnection', 'GoogleConnectionAssignment','Clinica','UsuarioClinica',
    'ClinicWebAsset','ClinicAnalyticsProperty','ClinicBusinessLocation','ClinicGoogleAdsAccount','GroupAssetClinicAssignment','GrupoClinica',
    'GoogleOAuthBrokerRequest'])];
  for (const name of names) {
    state.tables[name] = [];
    const wrap = row => row && Object.assign({}, row, { async update(values, options) {
      assert(options?.transaction); Object.assign(row, values); Object.assign(this, values); state.writes.push([name, 'update']);
      await state.afterWrite?.(); return this;
    }, get() { return { ...row }; } });
    const select = options => {
      let rows = state.tables[name].filter(row => matches(row, options?.where));
      if (options?.order) rows = [...rows].sort((a,b) => {
        for (const [field, direction] of options.order) { const d = a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0;
          if (d) return direction === 'DESC' ? -d : d; } return 0;
      });
      return rows.slice(0, options?.limit ?? rows.length).map(row => options?.raw ? { ...row } : wrap(row));
    };
    models[name] = {
      findAll: async options => select(options), findOne: async options => select({ ...options, limit: 1 })[0] || null,
      findByPk: async (id, options) => select({ ...options, where: { [name === 'GoogleOAuthBrokerRequest' ? 'flow_id' : 'id']: id }, limit: 1 })[0] || null,
      create: async (values, options) => {
        assert(options?.transaction); if (name === 'SearchConsoleBrokerBinding' && state.failBindingCreate) throw Error('FICTITIOUS_BINDING_WRITE_FAILURE');
        const row = { id: state.tables[name].length + 100, ...values }; state.tables[name].push(row); state.writes.push([name, 'create']);
        await state.afterWrite?.(); return wrap(row);
      },
      update: async (values, options) => { assert(options?.where); for (const row of state.tables[name].filter(row => matches(row, options.where))) Object.assign(row, values); },
    };
  }
  models.sequelize = {
    query: async (sql, options) => {
      assert.match(sql, /credentials_external/); assert(!/SELECT[^;]*,\s*(?:accessToken|refreshToken)\s*[, ]/i.test(sql));
      assert(options.transaction); return [[{ id: 81, googleUserId: 'fictitious-subject', credentials_external: state.external }]];
    },
    transaction: async (options, fn) => {
      if (typeof options === 'function') { fn = options; options = {}; }
      const snapshot = structuredClone(state.tables); const transaction = { LOCK: { SHARE: 'SHARE', UPDATE: 'UPDATE' } };
      state.transactions.push(options.isolationLevel);
      try { return await fn(transaction); } catch (error) { state.tables = snapshot; throw error; }
    },
  };
  state.tables.Clinica.push({ id_clinica: 71, grupoClinicaId: null });
  state.tables.UsuarioClinica.push({ id_usuario: 501, id_clinica: 71, rol_clinica: require('../../lib/role-helpers').MARKETING_WRITE_ROLES[0], estado_invitacion: 'aceptada' });
  state.tables.GoogleConnectionAssignment.push({ scopeKey: 'clinic:71', assignmentScope: 'clinic', clinicaId: 71, googleConnectionId: 81, status: 'active' });
  const controlSite = SC.site('sc-domain:control.example.invalid');
  const binding = { cohort: 'search_console', google_user_id: 'fictitious-subject', google_connection_id: 81,
    connection_ref: 'fictitious-sc-connection', asset_ref: controlSite.assetRef, clinica_id: 71,
    scope_key: 'connection:81', policy_version: C.POLICY };
  state.tables.GoogleOAuthBrokerBinding.push(binding);
  state.tables.ClinicWebAsset.push({ id: 11, clinicaId: 71, googleConnectionId: 81, siteUrl: controlSite.siteUrl, isActive: true,
    broker_read_connection_ref: binding.connection_ref, broker_read_asset_ref: binding.asset_ref });
  state.tables.SearchConsoleBrokerBinding.push({ site_hash: controlSite.siteHash, site_url: controlSite.siteUrl, mapping_id: 11,
    clinica_id: 71, google_connection_id: 81, google_user_id: binding.google_user_id,
    connection_ref: binding.connection_ref, asset_ref: binding.asset_ref, state: 'active' });
  const reviewedSite = SC.site('https://reviewed.example.invalid/');
  const entry = { descriptorId: '20000000-0000-4000-8000-000000000002', scopeKey: 'clinic:71', clinicId: 71,
    connectionId: 81, googleUserId: binding.google_user_id, connectionRef: binding.connection_ref, siteUrl: reviewedSite.siteUrl,
    assetRef: reviewedSite.assetRef, authorizationBindingDigest: C.digest(binding), reviewedAtEpochMs: clock, expiresAtEpochMs: clock + 600000 };
  state.descriptorEntries.push(entry);
  const sessions = { verifyReference: async input => { assert.equal(input.sessionRef, sessionRef);
    if (!state.sessionActive) throw Object.assign(Error('fictitious'), { code: 'auth_invalid' }); } };
  const input = { actorId: 501, sessionRef, sessionExpiresAt: clock + 1200000, connectionId: 81, scopeKey: 'clinic:71', clinicIds: [71],
    revalidate: async () => { if (!state.permission) throw Object.assign(Error('fictitious'), { code: 'google_discovery_scope_forbidden' }); } };
  const readSite = async (row, options) => {
    await options.beforeExecute(); state.reads.push({ operation: 'google.search_console.discovery.read.v1', connectionRef: row.connectionRef,
      tenantRef: 'clinic:' + row.clinicId, assetRef: SC.site(row.siteUrl).assetRef });
    await state.afterRead?.(); await options.beforeExecute(); return { siteUrl: row.siteUrl, permissionLevel: 'siteOwner' };
  };
  const service = createReviewedSearchConsoleMapping({ models, sessions, descriptors: () => state.descriptorEntries,
    readSite, enabled: () => true, now: () => state.time });
  return { state, models, sessions, binding, input, entry, service, payload: { mappings: [{ clinicaId: 71, siteUrl: entry.siteUrl }] } };
}
test('general OAuth state/callback worker, exact property discovery, atomic mapping, then genuine registered reader', async () => {
  const f = fixture(); let authorizationState;
  const client = { execute: async request => {
    const base = { flowId: request.payload.flowId || request.requestId, connectionRef: f.binding.connection_ref,
      googleUserId: f.binding.google_user_id, accessBlocked: false };
    if (request.operation.endsWith('.begin.v1')) {
      authorizationState = request.payload.state; const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      Object.entries({ state: authorizationState, response_type: 'code', code_challenge_method: 'S256', code_challenge: 'a'.repeat(43), login_hint: base.googleUserId }).forEach(([k,v]) => url.searchParams.set(k,v));
      return { requestId: request.requestId, replayed: false, data: { flowId: base.flowId, expiresAt: clock + 600000, authUrl: url.toString() } };
    }
    const status = request.operation.endsWith('.activate.v1') ? 'active' : 'staged';
    return { requestId: request.requestId, replayed: false, data: { ...base, status, secretVersion: base.flowId } };
  } };
  const broker = createGoogleOAuthBroker({ models: f.models, client, sessions: f.sessions, now: () => new Date(clock),
    enabled: () => true, workerEnabled: () => true,
    audit: { health: async () => ({ pending: 0, oldestAgeSeconds: 0 }), append: async event => f.state.audit.push(event) } });
  assert((await broker.begin({ binding: f.binding, scopeKey: f.input.scopeKey, actorId: 501, sessionRef,
    sessionExpiresAt: (clock + 1200000) / 1000, returnTo: 'https://app.clinicaclick.com' })).authUrl);
  const callback = await broker.callback({ state: authorizationState, code: 'FICTITIOUS_CODE', denied: false });
  assert.equal(callback.authorization_status, 'activation_pending'); assert.equal(callback.activation_confirmed, false);
  await broker.run();
  const status = await broker.status({ binding: f.binding, scopeKey: f.input.scopeKey, actorId: 501, sessionRef, sessionExpiresAt: (clock + 1200000) / 1000 });
  assert.equal(status.activation_confirmed, true); assert.equal(status.connected, false);
  assert.deepEqual(await f.service.inventory(async () => f.input), [{ siteUrl: f.entry.siteUrl, permissionLevel: 'siteOwner' }]);
  const mapped = await f.service.map(f.input, f.payload); assert.equal(mapped.mapped, 1);
  const created = f.state.tables.ClinicWebAsset.find(row => row.siteUrl === f.entry.siteUrl);
  assert(created); assert.equal(f.state.tables.SearchConsoleBrokerBinding.filter(row => row.mapping_id === created.id).length, 1);
  assert.equal((await f.service.map(f.input, f.payload)).assets[0].id, created.id);
  const reader = createSearchConsoleBroker({ enabled: () => true,
    loadMapping: async id => f.state.tables.ClinicWebAsset.find(row => row.id === id),
    loadBindings: async hash => f.state.tables.SearchConsoleBrokerBinding.filter(row => row.site_hash === hash),
    loadConnection: async () => ({ id: 81, googleUserId: f.binding.google_user_id, credentials_external: 1 }),
    loadRevocations: async () => [], client: { execute: async request => { assert.equal(request.assetRef, f.entry.assetRef);
      assert.equal(request.tenantRef, 'clinic:71'); return { data: { siteUrl: f.entry.siteUrl, permissionLevel: 'siteOwner' } }; } } });
  const context = await reader.prepare(created); assert.equal((await reader.read(created, context, 'discovery', {})).data.siteUrl, f.entry.siteUrl);
  assert(f.state.reads.every(row => row.assetRef === f.entry.assetRef && row.tenantRef === 'clinic:71'));
});
test('no descriptor/no real SC OAuth control cannot invent an initial mapping or binding', async () => {
  const f = fixture(); f.state.descriptorEntries = [];
  assert.deepEqual(await f.service.inventory(() => { assert.fail('No descriptor must not request identity'); }), []);
  await assert.rejects(f.service.map(f.input, f.payload), { code: 'broker_discovery_scope_unconfigured' });
  f.state.descriptorEntries = [f.entry]; f.state.tables.GoogleOAuthBrokerBinding = [];
  await assert.rejects(f.service.inventory(async () => f.input), { code: 'broker_discovery_scope_unconfigured' });
  assert.equal(f.state.reads.length + f.state.writes.length, 0);
});
test('standard cohort consumers guard is genuine: an unregistered GA consumer blocks SC before broker', async () => {
  const f = fixture(); f.state.tables.ClinicAnalyticsProperty.push({ id: 55, clinicaId: 71, googleConnectionId: 81, propertyName: 'properties/123', isActive: true });
  await assert.rejects(f.service.map(f.input, f.payload), { code: 'google_oauth_consumers_pending' }); assert.equal(f.state.reads.length, 0);
});
test('externalized unique identity, session and full clinic permission are mandatory', async () => {
  for (const variant of ['external', 'sessionActive', 'permission']) {
    const f = fixture(); f.state[variant] = variant === 'external' ? 0 : false;
    await assert.rejects(f.service.map(f.input, f.payload)); assert.equal(f.state.reads.length + f.state.writes.length, 0);
  }
});
test('exact descriptor site/hash/tenant/scope, expiry and standard binding digest fail closed', async () => {
  for (const change of [{ assetRef: 'sc:' + 'a'.repeat(64) }, { authorizationBindingDigest: 'a'.repeat(64) },
    { clinicId: 72 }, { expiresAtEpochMs: clock }, { googleUserId: 123 }]) {
    const f = fixture(); f.state.descriptorEntries = [{ ...f.entry, ...change }];
    await assert.rejects(f.service.map(f.input, f.payload)); assert.equal(f.state.reads.length + f.state.writes.length, 0);
  }
  const f = fixture(); assert.throws(() => descriptor({ ...f.entry, freeHttpApproval: true }, clock));
  await assert.rejects(f.service.map(f.input, { ...f.payload, replace_existing: true }));
  await assert.rejects(f.service.map(f.input, { mappings: [...f.payload.mappings, ...f.payload.mappings] }));
});
test('revocation appearing during Sites.get prevents mapping; no legacy fallback', async () => {
  const f = fixture(); f.state.afterRead = () => {
    const row = { kind: 'search_console', resource: f.entry.siteUrl, connection_ref: f.entry.connectionRef, asset_ref: f.entry.assetRef,
      clinica_id: 71, google_connection_id: 81, google_user_id: f.entry.googleUserId,
      state: 'pending', request_id: '30000000-0000-4000-8000-000000000003', actor_user_id: 501, requested_at: new Date(clock) };
    row.tuple_hash = R.tupleHash(row); f.state.tables.GooglePropertyBrokerRevocation.push(row);
  };
  await assert.rejects(f.service.map(f.input, f.payload), { code: 'asset_revoked' }); assert.equal(f.state.writes.length, 0);
});
test('descriptor/session changes after broker fail; binding write failure rolls mapping back', async () => {
  const f = fixture(); f.state.afterRead = () => { f.state.descriptorEntries = []; };
  await assert.rejects(f.service.map(f.input, f.payload)); assert.equal(f.state.writes.length, 0);
  const g = fixture(); g.state.failBindingCreate = true;
  await assert.rejects(g.service.map(g.input, g.payload), /FICTITIOUS_BINDING_WRITE_FAILURE/);
  assert.equal(g.state.tables.ClinicWebAsset.length, 1); assert.equal(g.state.tables.SearchConsoleBrokerBinding.length, 1);
});
test('managed mapping cannot overwrite an existing legacy, blocked or foreign mapping', async () => {
  const f = fixture(); f.state.tables.ClinicWebAsset.push({ id: 19, clinicaId: 71, googleConnectionId: 81, siteUrl: f.entry.siteUrl, isActive: false });
  await assert.rejects(f.service.map(f.input, f.payload)); assert.equal(f.state.tables.ClinicWebAsset[1].isActive, false);
  assert.equal(f.state.tables.SearchConsoleBrokerBinding.length, 1);
});
function persistenceWith(models) {
  const filename = path.resolve(__dirname, '../../services/oauthConnectionPersistence.service.js'); const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename,'utf8'), { module, exports: module.exports,
    require: name => name === '../../models' ? models : name === './googleLegacyOAuthGuard.service'
      ? { createGoogleLegacyOAuthGuard } : (() => { throw Error('UNEXPECTED_DEPENDENCY'); })() }, { filename, timeout: 1000 });
  return module.exports.persistGoogleConnection;
}
test('any managed registry including GBP/revocation closes legacy write before token persistence', async () => {
  for (const [name] of REGISTRIES) {
    const f = fixture(); for (const table of Object.keys(f.state.tables)) f.state.tables[table] = [];
    f.state.tables[name].push({ google_user_id: 'fictitious-other-subject', external_location_id: '123' });
    await assert.rejects(createGoogleLegacyOAuthGuard({ models: f.models }).assertAllowed(), { code: 'google_oauth_legacy_closed' });
    await assert.rejects(persistenceWith(f.models)({ userId: 501, googleUserId: 'fictitious-subject', accessToken: 'FICTITIOUS' }), { code: 'google_oauth_legacy_closed' });
    assert.equal(f.state.writes.length, 0);
  }
});
test('legacy persistence retains identity/refresh semantics and rolls back a marker race', async () => {
  const f = fixture(); for (const table of Object.keys(f.state.tables)) f.state.tables[table] = [];
  const persist = persistenceWith(f.models); const payload = { userId: 501, googleUserId: 'fictitious-subject', accessToken: 'FICTITIOUS_A', refreshToken: 'FICTITIOUS_R' };
  await persist(payload); await persist({ ...payload, accessToken: 'FICTITIOUS_B', refreshToken: null });
  assert.equal(f.state.tables.GoogleConnection.length, 1); assert.equal(f.state.tables.GoogleConnection[0].refreshToken, 'FICTITIOUS_R');
  f.state.afterWrite = () => f.state.tables.BusinessProfileBrokerBinding.push({ external_location_id: '123' });
  await assert.rejects(persist({ ...payload, accessToken: 'FICTITIOUS_C' }), { code: 'google_oauth_legacy_closed' });
  assert.equal(f.state.tables.GoogleConnection[0].accessToken, 'FICTITIOUS_B'); assert(f.state.transactions.every(x => x === 'SERIALIZABLE'));
});
test('existing GET assets and POST map-assets handlers preserve ordinary DTO/body and cannot invoke legacy/backfill', async () => {
  const { loadDiscoverySource, unusedMetaSurfaceDependencies } = require('./fixtures/business_profile_discovery.fixture');
  const express = require('express'); const propertyErrors = require('../../services/googlePropertyDiscovery.service');
  const f = fixture();
  const failLegacy = () => assert.fail('No legacy credential, provider or automatic backfill call is allowed');
  const sessions = { ...f.sessions, bearer: value => value, verify: async () => ({ userId: 501, sessionVersion: 1, jti: sessionRef, exp: (clock + 1200000) / 1000 }) };
  const router = loadDiscoverySource('routes/oauth.routes.js', { ...unusedMetaSurfaceDependencies(), express,
    sequelize: require('sequelize'), '../../models': f.models, './auth.middleware': () => {},
    '../services/accessSession.service': sessions,
    '../services/googleReviewedSearchConsoleMapping.service': f.service,
    '../services/googlePropertyDiscovery.service': { safe: propertyErrors.safe, status: propertyErrors.status,
      list: async () => {
        if (f.state.registeredInventory) return [{ siteUrl: f.state.tables.ClinicWebAsset[0].siteUrl, permissionLevel: 'siteOwner' }];
        throw Object.assign(Error('unconfigured'), { code: 'broker_discovery_scope_unconfigured' });
      },
      assertLegacyAllowed: async () => { throw Object.assign(Error('closed'), { code: 'google_oauth_legacy_closed' }); } },
    '../services/scopeConnectionResolver.service': { resolveGoogleConnectionForScope: async options => {
      assert.equal(options.metadataOnly, true); return { connection: { id: 81 }, scope: { scopeKey: 'clinic:71' } };
    } },
    '../lib/oauthMarketingScopeAccess': require('../../lib/oauthMarketingScopeAccess'),
    '../lib/marketingScopeAccess': { hasMarketingClinicScopeAccess: async () => f.state.permission },
    '../services/googleLegacyCredentials.service': { load: failLegacy, request: failLegacy },
    '../services/jobRequests.service': { enqueueUniqueJobRequest: failLegacy },
    '../services/jobScheduler.service': { triggerImmediate: failLegacy }, axios: { get: failLegacy, post: failLegacy },
  });
  async function invoke(route, method, body = {}) {
    const layer = router.stack.find(item => item.route?.path === route && item.route.methods[method]); assert(layer);
    const req = { headers: { authorization: 'Bearer FICTITIOUS' }, userData: { userId: 501 }, query: { clinic_id: '71', assignment_scope: 'clinic' }, body,
      marketingConnectionScopeAuthorization: { requested: true, clinicIds: [71] } };
    const result = { status: 200, headers: {} };
    const res = { set(k,v) { result.headers[k] = v; return this; }, status(code) { result.status = code; return this; },
      json(value) { result.body = value; return value; } };
    await layer.route.stack[0].handle(req, res); return result;
  }
  // Clinic lookup used by the existing explicit scope validator, not a new resolver.
  f.models.Clinica.findByPk = async () => ({ grupoClinicaId: null });
  const inventory = await invoke('/google/assets', 'get'); assert.equal(inventory.status, 200, JSON.stringify(inventory));
  assert.equal(inventory.body.inventory_mode, 'broker_grants'); assert.equal(inventory.body.total, 1);
  assert.equal(inventory.body.assets[0].siteUrl, f.entry.siteUrl); assert.equal(inventory.body.bootstrap_id, undefined);
  const mapped = await invoke('/google/map-assets', 'post', { ...f.payload, replace_existing: false });
  assert.equal(mapped.status, 200, JSON.stringify(mapped)); assert.equal(mapped.body.mapped, 1);
  assert.equal(mapped.body.inventory_mode, 'broker_grants');
  const rejected = await invoke('/google/map-assets', 'post', { ...f.payload, replace_existing: true });
  assert.equal(rejected.status, 409); assert.equal(rejected.body.error, 'broker_binding_invalid');
  // Once the reviewed capability expires, the original registered inventory
  // still succeeds; it obtains no authority from that expired descriptor.
  f.state.registeredInventory = true; f.state.time = f.entry.expiresAtEpochMs;
  const readsBefore = f.state.reads.length;
  const registered = await invoke('/google/assets', 'get'); assert.equal(registered.status, 200, JSON.stringify(registered));
  assert.equal(registered.body.total, 1); assert.equal(registered.body.assets[0].siteUrl, f.state.tables.ClinicWebAsset[0].siteUrl);
  assert.equal(f.state.reads.length, readsBefore);
  const expiredMap = await invoke('/google/map-assets', 'post', f.payload); assert.equal(expiredMap.status, 409);
});
test('operator descriptor loader uses fixed no-follow file, exact Root ownership and one verified byte buffer', () => {
  const { createRequire } = require('node:module');
  const filename = path.resolve(__dirname, '../../services/googleReviewedSearchConsoleMapping.service.js');
  const realRequire = createRequire(filename); const f = fixture();
  const bytes = Buffer.from(JSON.stringify({ schema: 'clinicaclick-reviewed-search-console-properties/1', entries: [f.entry] }));
  function load(change = {}) {
    let reads = 0; let stats = 0; let closes = 0;
    const stat = { uid: 0n, gid: 1000n, mode: 0o100640n, nlink: 1n, size: BigInt(bytes.length),
      dev: 1n, ino: 2n, mtimeNs: 1n, ctimeNs: 1n, isFile: () => true, ...change };
    const fakeFs = { constants: fs.constants,
      lstatSync: p => { assert(p === '/' || p === '/etc' || p === '/etc/clinicaclick-google-search-console');
        return { uid: 0, mode: 0o750, isDirectory: () => true, isSymbolicLink: () => false }; },
      openSync: (p, flags) => { assert.equal(p, '/etc/clinicaclick-google-search-console/reviewed-properties.json');
        assert(flags & fs.constants.O_NOFOLLOW); return 7; },
      fstatSync: fd => { assert.equal(fd, 7); stats++; return stat; }, readFileSync: fd => { assert.equal(fd, 7); reads++; return bytes; },
      closeSync: fd => { assert.equal(fd, 7); closes++; } };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename,'utf8'), { module, exports: module.exports, Buffer, TextDecoder,
      require: name => name === 'node:fs' ? fakeFs : realRequire(name), process: { env: {} } }, { filename, timeout: 1000 });
    return { run: () => module.exports.loadDescriptors(), counts: () => ({ reads, stats, closes }) };
  }
  const good = load(); assert.equal(good.run()[0].siteUrl, f.entry.siteUrl); assert.deepEqual(good.counts(), { reads: 1, stats: 2, closes: 1 });
  for (const bad of [{ uid: 1000n }, { gid: 0n }, { mode: 0o100660n }, { nlink: 2n }, { size: 65537n }]) {
    const instance = load(bad); assert.throws(instance.run, { code: 'broker_configuration_invalid' });
    assert.equal(instance.counts().reads, 0); assert.equal(instance.counts().closes, 1);
  }
});
test('HTTP free approvals cannot authorize missing descriptor; expiry or wrong Sites.get result cannot create partial mappings', async () => {
  const f = fixture(); f.state.descriptorEntries = [];
  await assert.rejects(f.service.map(f.input, { ...f.payload, operatorApproved: true, descriptor: f.entry }), { code: 'broker_discovery_scope_unconfigured' });
  const g = fixture(); g.state.afterRead = () => { g.state.time = g.entry.expiresAtEpochMs; };
  await assert.rejects(g.service.map(g.input, g.payload)); assert.equal(g.state.writes.length, 0);
  const h = fixture(); const service = createReviewedSearchConsoleMapping({ models: h.models, sessions: h.sessions,
    descriptors: () => [h.entry], enabled: () => true, now: () => clock,
    readSite: async () => ({ siteUrl: 'https://foreign.example.invalid/', permissionLevel: 'siteOwner' }) });
  await assert.rejects(service.map(h.input, h.payload), { code: 'provider_failed' }); assert.equal(h.state.writes.length, 0);
});
test('expired descriptors retain structural/TTL validation; expiry during mapping transaction rolls everything back', async () => {
  const f = fixture(); f.state.time = f.entry.expiresAtEpochMs;
  assert.deepEqual(await f.service.inventory(() => assert.fail('Expired capability must not authorize a request')), []);
  f.state.descriptorEntries = [{ ...f.entry, expiresAtEpochMs: f.entry.reviewedAtEpochMs + 900001 }];
  await assert.rejects(f.service.inventory(async () => f.input));
  const g = fixture(); g.state.afterWrite = () => { g.state.time = g.entry.expiresAtEpochMs; };
  await assert.rejects(g.service.map(g.input, g.payload));
  assert.equal(g.state.tables.ClinicWebAsset.length, 1); assert.equal(g.state.tables.SearchConsoleBrokerBinding.length, 1);
});
