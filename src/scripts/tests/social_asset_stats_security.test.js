'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { createRequire } = require('node:module');
const { randomBytes } = require('node:crypto');
const { Sequelize, DataTypes, Op } = require('sequelize');
const express = require('express');
const jwt = require('jsonwebtoken');
const { connectionForTestServer } = require('./fixtures/campaign_offline_runtime.cjs');
const root = path.resolve(__dirname, '../..');
const PRIVATE = 'SENTINEL_NOT_A_VALID_PROVIDER_CREDENTIAL';

function load(relative, overrides, globals = {}) {
  const filename = path.join(root, relative);
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, Date, Object,
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : localRequire(name), ...globals,
  }, { filename });
  return module.exports;
}

async function fixture(t, options = {}) {
  const calls = { assets: [], stats: [], memberships: [], assignments: [], groups: [], logs: [] };
  const sql = new Sequelize('offline', 'offline', 'not-a-secret', { dialect: 'mysql', logging: false });
  t.after(() => sql.close());
  const Asset = require('../../../models/ClinicMetaAsset')(sql, DataTypes);
  const modelAsset = Asset.build({ id: 22, clinicaId: 55, grupoClinicaId: null, assetType: 'facebook_page',
    metaAssetId: 'fixture-page', metaAssetName: 'Fixture page', isActive: true,
    pageAccessToken: PRIVATE, waAccessToken: PRIVATE, metaConnectionId: 123,
    additionalData: { nested: { refreshToken: PRIVATE, apiKey: PRIVATE } }, ...options.asset });
  const membershipRows = options.memberships || [
    { id_usuario: 701, id_clinica: 55, rol_clinica: 'propietario', estado_invitacion: 'aceptada' },
    { id_usuario: 702, id_clinica: 55, rol_clinica: 'personaldeclinica', estado_invitacion: null },
    { id_usuario: 703, id_clinica: 66, rol_clinica: 'propietario', estado_invitacion: 'aceptada' },
  ];
  const models = {
    ClinicMetaAsset: { findByPk: async (id, query) => {
      calls.assets.push({ id, query });
      if (options.failAsset) throw Error(PRIVATE);
      return id === 22 ? modelAsset : null; // Deliberately ignore projection to also exercise response allowlisting.
    } },
    UsuarioClinica: { findAll: async query => {
      calls.memberships.push(query);
      if (options.failMembership) throw Error(PRIVATE);
      const where = query.where;
      return membershipRows.filter(row => row.id_usuario === where.id_usuario
        && where.id_clinica[Op.in].includes(row.id_clinica) && where.rol_clinica[Op.in].includes(row.rol_clinica)
        && where[Op.or].some(clause => clause.estado_invitacion === row.estado_invitacion));
    } },
    GroupAssetClinicAssignment: { findAll: async query => {
      calls.assignments.push(query); return options.assignments || [];
    } },
    Clinica: { findAll: async query => {
      calls.groups.push(query); return (options.groupClinics || []).map(id_clinica => ({ id_clinica }));
    } },
    SocialStatsDaily: { findAll: async query => {
      calls.stats.push(query);
      if (options.failStats) throw Object.assign(Error(PRIVATE), { config: { accessToken: PRIVATE }, sql: PRIVATE });
      return [{ date: '2026-09-11', impressions: 30, reach: 20, followers: 10, clicks: 3,
        week: 202637, month: '2026-09', start_date: '2026-09-11', end_date: '2026-09-11',
        pageAccessToken: PRIVATE, newSecretField: PRIVATE, nested: { waAccessToken: PRIVATE } }];
    } },
  };
  const access = load('lib/marketingScopeAccess.js', { '../../models': models });
  const controller = load('controllers/socialstats.controller.js', {
    '../../models': models, '../lib/clinicScope': {}, '../lib/marketingScopeAccess': access,
    '../services/notifications.service': {},
  }, { console: { error: (...args) => calls.logs.push(args) } });
  const secret = randomBytes(32);
  const auth = load('routes/auth.middleware.js', { '../services/accessSession.service': {
    ...require('../../services/accessSession.service'),
    ...require('../../services/accessSession.service').createService({ models: () => assert.fail('legacy auth must not load models'),
      config: () => ({ mode: 'legacy', ttl: 43200, secret }) }),
  } });
  const unrelated = new Proxy({}, { get: () => () => assert.fail('Unrelated controller called') });
  const router = load('routes/metasync.routes.js', {
    './auth.middleware': auth,
    '../controllers/socialstats.controller': controller,
    '../controllers/metasync.controller': unrelated,
    '../controllers/metasync.diagnostic': unrelated,
    '../controllers/metasync.jobs.controller': unrelated,
  });
  const app = express(); app.use('/api/metasync', router);
  const server = http.createServer(app);
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const agent = new http.Agent({ keepAlive: false });
  agent.createConnection = connectionForTestServer(server); t.after(() => agent.destroy());
  const tokens = Object.fromEntries([1, 701, 702, 703, 704].map(id => [id, jwt.sign({ userId: id }, secret, { expiresIn: 60 })]));
  tokens.expired = jwt.sign({ userId: 701 }, secret, { expiresIn: -1 });
  tokens.wrong = jwt.sign({ userId: 701 }, randomBytes(32), { expiresIn: 60 });
  tokens.missingActor = jwt.sign({ isAdmin: true }, secret, { expiresIn: 60 });
  tokens.forgedAdmin = jwt.sign({ userId: 703, isAdmin: true, clinicId: 55 }, secret, { expiresIn: 60 });
  const request = async (actor = 701, params = {}, id = '22') => {
    const query = new URLSearchParams({ startDate: '2026-09-11', endDate: '2026-09-11', ...params });
    const reply = await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: server.address().port, agent,
        path: `/api/metasync/asset/${encodeURIComponent(id)}/stats?${query}`,
        headers: tokens[actor] ? { authorization: `Bearer ${tokens[actor]}` } : {},
      }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
          body: JSON.parse(Buffer.concat(chunks).toString()) }));
      }); req.on('error', reject);
    });
    assert.ok(!JSON.stringify(reply).includes(PRIVATE), 'No credential sentinel in any HTTP response');
    assert.ok(!JSON.stringify(calls.logs).includes(PRIVATE), 'No credential sentinel in error logs');
    return reply;
  };
  return { request, calls, modelAsset };
}

test('real route and JWT middleware reject absent, expired, forged and actorless sessions before data access', async t => {
  const f = await fixture(t);
  for (const actor of ['none', 'expired', 'wrong', 'missingActor']) assert.equal((await f.request(actor)).status, 401);
  assert.equal(f.calls.assets.length, 0); assert.equal(f.calls.stats.length, 0);
});

test('cross-clinic staff and a caller-supplied admin/scope cannot read an asset', async t => {
  const f = await fixture(t);
  for (const actor of [703, 'forgedAdmin']) {
    const r = await f.request(actor, { clinicId: '66', clinicaId: '55', userId: '701', scope: 'all' });
    assert.equal(r.status, 403); assert.equal(r.headers['cache-control'], 'private, no-store');
  }
  assert.equal(f.calls.stats.length, 0);
});

test('owner, clinic staff and global administrator receive only public fields with valid metrics', async t => {
  const f = await fixture(t);
  for (const actor of [701, 702, 1]) {
    const r = await f.request(actor);
    assert.equal(r.status, 200); assert.equal(r.body.stats[0].impressions, 30);
    assert.equal(r.body.asset.id, 22); assert.equal(r.body.asset.metaAssetName, 'Fixture page');
    assert.deepEqual(Object.keys(r.body.asset).sort(), ['id', 'clinicaId', 'grupoClinicaId', 'assignmentScope',
      'assetType', 'metaAssetId', 'metaAssetName', 'isActive'].sort());
    assert.equal(r.headers['cache-control'], 'private, no-store');
    assert.equal(r.body.stats[0].newSecretField, undefined);
  }
  for (const { query } of f.calls.assets) {
    assert.equal(query.raw, true);
    assert.ok(!query.attributes.some(name => /token|additional|connection/i.test(name)));
  }
  for (const query of f.calls.stats) assert.deepEqual(Array.from(query.where.clinica_id[Op.in]), [55]);
});

test('inactive assets retain authorized history but never bypass clinic permissions', async t => {
  const f = await fixture(t, { asset: { isActive: false } });
  assert.equal((await f.request(703)).status, 403);
  const r = await f.request(701); assert.equal(r.status, 200); assert.equal(r.body.asset.isActive, false);
});

test('unassigned and orphaned assets fail closed, including for global admin', async t => {
  for (const asset of [{ assignmentScope: 'unassigned' }, { clinicaId: null }, { assignmentScope: 'group', grupoClinicaId: null }]) {
    const f = await fixture(t, { asset });
    assert.equal((await f.request(1)).status, 403); assert.equal(f.calls.stats.length, 0);
  }
});

test('shared asset requires read membership in every clinic, not just one member or the owner', async t => {
  const f = await fixture(t, { assignments: [{ clinicaId: 66 }] });
  assert.equal((await f.request(701)).status, 403); assert.equal((await f.request(703)).status, 403);
  assert.equal(f.calls.stats.length, 0);
  assert.equal((await f.request(1)).status, 200);
  assert.deepEqual(Array.from(f.calls.stats[0].where.clinica_id[Op.in]).sort(), [55, 66]);
  assert.equal(f.calls.assignments[0].where.assetType, 'meta.facebook_page');
});

test('group asset checks all group members even without explicit child assignments', async t => {
  const memberships = [55, 66].map(id_clinica => ({ id_usuario: 704, id_clinica,
    rol_clinica: 'agencia', estado_invitacion: 'aceptada' }));
  memberships.push({ id_usuario: 701, id_clinica: 55, rol_clinica: 'propietario', estado_invitacion: 'aceptada' });
  const f = await fixture(t, { asset: { assignmentScope: 'group', grupoClinicaId: 5, clinicaId: null }, groupClinics: [55, 66], memberships });
  assert.equal((await f.request(701, { clinicId: '55' })).status, 403);
  assert.equal((await f.request(704)).status, 200);
  assert.equal(f.calls.groups[0].where.grupoClinicaId, 5);
});

test('pending, cancelled, rejected memberships and patient roles do not authorize access', async t => {
  for (const state of ['pendiente', 'cancelada', 'rechazada']) {
    const f = await fixture(t, { memberships: [{ id_usuario: 701, id_clinica: 55,
      rol_clinica: 'propietario', estado_invitacion: state }] });
    assert.equal((await f.request()).status, 403); assert.equal(f.calls.stats.length, 0);
  }
  const f = await fixture(t, { memberships: [{ id_usuario: 701, id_clinica: 55,
    rol_clinica: 'paciente', estado_invitacion: 'aceptada' }] });
  assert.equal((await f.request()).status, 403);
});

test('week and month retain aggregates without serializing nested or new secret fields', async t => {
  const f = await fixture(t);
  for (const period of ['week', 'month']) {
    const r = await f.request(701, { period }); assert.equal(r.status, 200);
    assert.equal(r.body.stats[0].reach, 20); assert.ok(r.body.stats[0][period]);
    assert.equal(r.body.stats[0].date, undefined); assert.equal(r.body.stats[0].nested, undefined);
    assert.equal(f.calls.stats.at(-1).group[0], period);
  }
});

test('invalid identifiers and dates fail before lookup; a missing asset has no metrics', async t => {
  const f = await fixture(t);
  for (const id of ['0', '-1', '22x', '22.5', '9007199254740992', '22 OR 1=1']) assert.equal((await f.request(701, {}, id)).status, 400);
  for (const params of [{ period: 'other' }, { startDate: '2026-02-30' }, { endDate: 'nonsense' }]) assert.equal((await f.request(701, params)).status, 400);
  assert.equal(f.calls.assets.length, 0);
  assert.equal((await f.request(701, {}, '23')).status, 404); assert.equal(f.calls.stats.length, 0);
});

test('database and authorization failures redact credential-bearing errors and never return success', async t => {
  for (const option of ['failAsset', 'failMembership', 'failStats']) {
    const f = await fixture(t, { [option]: true });
    const r = await f.request(); assert.equal(r.status, 500);
    assert.equal(r.body.error, 'asset_stats_read_failed'); assert.equal(f.calls.logs.length, 1);
  }
});
