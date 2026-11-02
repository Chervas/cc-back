'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const express = require('express');
const { connectionForTestServer } = require('./fixtures/campaign_offline_runtime.cjs');
const { createGoogleReviewAiDraft, safeError } = require('../../services/googleReviewAiDraft.service');

function load(file, dependencies = {}, otherwise) {
  const filename = path.join(__dirname, '../../', file), local = createRequire(filename), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, process, console,
    setTimeout, clearTimeout, Buffer,
    require: name => Object.hasOwn(dependencies, name) ? dependencies[name] : otherwise ? otherwise(name, local) : local(name),
  }, { filename });
  return module.exports;
}
const plain = value => JSON.parse(JSON.stringify(value));

async function fixture(t) {
  const state = { read: true, write: true, shared: true, infer: 0, config: { prompt: '', configured: false, version: 0, updatedAt: null } };
  const settings = {
    read: async () => state.config,
    status: async () => ({ configured: state.config.configured }),
    get: async () => ({ success: true, settings: state.config }),
    put: async input => {
      if (input.expectedVersion !== state.config.version) throw Object.assign(Error(), { code: 'review_reply_settings_version_conflict', status: 409 });
      state.config = { prompt: input.prompt, configured: !!input.prompt, version: state.config.version + 1, updatedAt: '2026-11-02T00:00:00Z' };
      return { success: true, settings: state.config };
    },
  };
  const service = createGoogleReviewAiDraft({ settings, assertRuntime() {}, assertAllowed: async () => {}, verifySession: async () => {},
    loadSource: async ({ clinicId, reviewId }) => ({ review: { id: reviewId, comment: 'Buen servicio', star_rating: 5 },
      clinicName: 'Clínica ficticia', groupId: null, authority: { clinicIds: [clinicId], mappingId: 5 } }),
    analyze: async () => { state.infer++; return { disposition: 'draft', professionalName: 'absent', offensiveOrHurtful: 'absent', confidence: 0.99, draft: 'Gracias por tu opinión.' }; },
  });
  const controller = load('controllers/googleReviewAiDraft.controller.js', {
    '../services/googleReviewAiDraft.service': { ...service, safeError }, '../services/reviewReplySettings.service': settings,
  });
  const unused = new Proxy({}, { get: () => () => { throw Error('UNRELATED_ACTION_FORBIDDEN'); } });
  const auth = (req, res, next) => {
    if (!req.headers['x-user']) return res.status(401).json({ error: 'auth_required' });
    req.userData = { userId: Number(req.headers['x-user']) }; return next();
  };
  const dependencies = {
    express, './auth.middleware': auth, '../controllers/googleReviewAiDraft.controller': controller,
    '../lib/marketingScopeAccess': { hasMarketingClinicScopeAccess: async ({ access }) => access === 'write' ? state.write : state.read },
    '../services/googleLocalLinks.service': {},
    '../services/businessProfileLocal.service': { resolveEffectiveLocations: async () => ({ locations: [{ id: 5 }] }),
      resolveReviewMutationLocation: async () => ({ id: 5 }) },
    '../services/businessProfileMutations.service': unused,
    '../services/businessProfileMutationScope.service': { mutationScope: async () => {
      if (!state.shared) throw Object.assign(Error('scope_denied'), { code: 'scope_denied' });
      return { clinicIds: [7, 9] };
    } },
    '../services/googleSpecialHoursAutomation.service': unused,
    '../../models': {},
  };
  const app = express(); app.use(express.json());
  app.use('/api/local', load('routes/local.routes.js', dependencies));
  app.use('/api/metasync', load('routes/metasync.routes.js', dependencies, (name, local) =>
    name === '../lib/role-helpers' ? local(name) : unused));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const agent = new http.Agent(); agent.createConnection = connectionForTestServer(server);
  t.after(() => agent.destroy());
  t.after(() => new Promise(resolve => server.close(resolve)));
  function request(method, url, user = 21, body) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path: url,
        agent,
        headers: { ...(user ? { 'x-user': String(user) } : {}), 'content-type': 'application/json' } }, res => {
        let text = ''; res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) }));
      });
      req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  return { state, request };
}
const statusUrl = '/api/local/clinica/7/reviews/ai-draft/status';
const draftUrl = '/api/local/clinica/7/reviews/11/ai-draft';
const settingsUrl = '/api/metasync/jobs/usage/ai-runtime/review-reply-settings';

test('HTTP routes enforce auth, clinic read/write/shared authority and root-only settings', async t => {
  const f = await fixture(t);
  for (const [method, url] of [['GET', statusUrl], ['POST', draftUrl], ['GET', settingsUrl], ['PUT', settingsUrl]]) {
    assert.equal((await f.request(method, url, null)).status, 401);
  }
  const status = await f.request('GET', statusUrl); assert.deepEqual(status.body, { configured: false });
  assert.equal(status.headers['cache-control'], 'no-store');
  f.state.read = false; assert.equal((await f.request('GET', statusUrl)).status, 403); f.state.read = true;
  f.state.write = false; assert.equal((await f.request('POST', draftUrl, 21, { requestId: randomUUID() })).status, 403); f.state.write = true;
  f.state.shared = false;
  assert.equal((await f.request('POST', draftUrl, 21, { requestId: randomUUID() })).body.error, 'business_profile_asset_in_use');
  f.state.shared = true;
  for (const method of ['GET', 'PUT']) assert.equal((await f.request(method, settingsUrl, 21, { prompt: 'forged', expectedVersion: 0 })).status, 403);
  const admin = await f.request('GET', settingsUrl, 1);
  assert.equal(admin.status, 200); assert.equal(admin.body.settings.prompt, ''); assert.equal(f.state.infer, 0);
});

test('HTTP definitive contract: requestId body, status never exposes prompt, admin save/clear, no publication', async t => {
  const f = await fixture(t), body = { requestId: randomUUID() };
  assert.equal((await f.request('POST', draftUrl, 21, body)).body.error, 'review_ai_prompt_not_configured');
  assert.equal((await f.request('PUT', settingsUrl, 1, { prompt: 'FICTITIOUS PROMPT', expectedVersion: 0 })).status, 200);
  assert.deepEqual((await f.request('GET', statusUrl)).body, { configured: true });
  const first = await f.request('POST', draftUrl, 21, body);
  assert.equal(first.status, 200); assert.equal(first.body.success, true); assert.equal(first.body.reviewId, 11);
  assert.equal(first.body.reused, false); assert.equal(first.body.disposition, 'draft'); assert.equal(typeof first.body.expiresAt, 'string');
  assert.deepEqual(Object.keys(first.body).sort(), ['success', 'reviewId', 'draft', 'disposition', 'reasons', 'reused', 'expiresAt'].sort());
  assert.equal((await f.request('POST', draftUrl, 21, body)).body.reused, true); assert.equal(f.state.infer, 1);
  assert.equal((await f.request('POST', draftUrl, 21, { ...body, prompt: 'override' })).status, 400);
  assert.equal((await f.request('PUT', settingsUrl, 1, { prompt: '', expectedVersion: 0 })).status, 409);
  assert.equal((await f.request('PUT', settingsUrl, 1, { prompt: '', expectedVersion: 1 })).status, 200);
  assert.deepEqual((await f.request('GET', statusUrl)).body, { configured: false });
  assert.equal((await f.request('POST', draftUrl, 21, body)).body.error, 'review_ai_prompt_not_configured');
});

test('real source loader uses minimal local review fields, shared reply authority and local revocation without credentials', async () => {
  let allowed = true, revoked = false, shared = true;
  const calls = [];
  const review = { id: 11, comment: 'Public review', star_rating: 5 };
  const location = { id: 5, location_id: 'accounts/123/locations/456', clinica_id: 7, google_connection_id: 8,
    broker_read_connection_ref: 'connection:test', broker_read_asset_ref: 'gbp:123:456' };
  const models = {
    Clinica: { findByPk: async (id, options) => { calls.push(options.attributes); return { id_clinica: id, nombre_clinica: 'Clinic', grupoClinicaId: 2 }; } },
    BusinessProfileBrokerRevocation: { findByPk: async (id, options) => { assert.equal(id, '456'); assert.deepEqual(plain(options.attributes), ['external_location_id']); return revoked ? {} : null; } },
  };
  const service = load('services/googleReviewAiDraft.service.js', {
    './reviewReplySettings.service': {}, '../../models': models,
    '../lib/marketingScopeAccess': { hasMarketingClinicScopeAccess: async ({ access }) => { assert.equal(access, 'write'); return allowed; } },
    './businessProfileLocal.service': { resolveEffectiveLocations: async () => ({ locations: [location] }),
      resolveReviewDraftSource: async () => ({ review, location }) },
    './businessProfileMutationScope.service': { mutationScope: async input => {
      assert.equal(input.models, models); assert.equal(input.mappingId, 5); assert.equal(input.clinicId, 7);
      if (!shared) throw Object.assign(Error(), { code: 'scope_denied' }); return { location, clinicIds: [7, 9] };
    } },
  });
  const get = () => service.__testing.loadAuthorizedSource({ clinicId: 7, reviewId: 11, userId: 21 });
  const result = await get(); assert.equal(result.clinicName, 'Clinic'); assert.deepEqual(plain(result.authority.clinicIds), [7, 9]);
  assert.deepEqual(plain(calls[0]), ['id_clinica', 'nombre_clinica', 'grupoClinicaId']);
  const initial = JSON.stringify(result.authority); location.updated_at = new Date();
  assert.equal(JSON.stringify((await get()).authority), initial, 'routine sync timestamps must not invalidate re-use');
  allowed = false; await assert.rejects(get(), { code: 'scope_write_forbidden' }); allowed = true;
  shared = false; await assert.rejects(get(), { code: 'business_profile_asset_in_use' }); shared = true;
  revoked = true; await assert.rejects(get(), { code: 'business_profile_asset_in_use' });
});

test('real session guard requires the same managed business identity as reply and rejects revocation', async () => {
  let claims = { userId: 21, sessionVersion: 1 }, revoked = false;
  const service = load('services/googleReviewAiDraft.service.js', {
    './reviewReplySettings.service': {}, './accessSession.service': {
      bearer: value => { assert.equal(value, 'Bearer FICTITIOUS'); return 'FICTITIOUS'; },
      verify: async () => { if (revoked) throw Error('revoked'); return claims; },
    },
  });
  const check = () => service.__testing.assertSession({ headers: { authorization: 'Bearer FICTITIOUS' } }, 21);
  await check(); claims = { userId: 22, sessionVersion: 1 }; await assert.rejects(check(), { status: 401 });
  claims = { userId: 21 }; await assert.rejects(check(), { status: 401 });
  claims = { userId: 21, sessionVersion: 1 }; revoked = true; await assert.rejects(check(), { code: 'business_profile_session_required' });
});

test('controller sanitizes unknown errors and emits Retry-After without exposing sensitive contents', async () => {
  let error = Error('PRIVATE_PROVIDER_BODY');
  const controller = load('controllers/googleReviewAiDraft.controller.js', {
    '../services/googleReviewAiDraft.service': { safeError, generate: async () => { throw error; } },
    '../services/reviewReplySettings.service': {},
  });
  const res = { headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(v) { this.code = v; return this; }, json(v) { this.body = v; return this; } };
  const req = { params: {}, userData: {} };
  await controller.generate(req, res); assert.equal(res.code, 503); assert.equal(res.body.error, 'review_ai_unavailable');
  error = Object.assign(Error(), { code: 'review_ai_rate_limited', status: 429, retryAfter: 5 });
  await controller.generate(req, res); assert.equal(res.code, 429); assert.equal(res.headers['Retry-After'], '5');
  assert.doesNotMatch(JSON.stringify(res), /PRIVATE_PROVIDER_BODY/);
});
