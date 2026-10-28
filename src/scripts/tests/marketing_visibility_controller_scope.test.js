'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const roles = require('../../lib/role-helpers');
const { harness, forbidden } = require('./helpers/marketingOfflineHarness');

function fixture() {
  const calls = [];
  const memberships = [
    [9, 72, 'agencia', 'aceptada'], [9, 73, 'agencia', 'pendiente'],
    [10, 72, 'personaldeclinica', 'aceptada'], [11, 72, 'paciente', 'aceptada'],
    [12, 72, 'propietario', 'aceptada'], [12, 73, 'propietario', 'aceptada'],
    [13, 72, 'propietario', 'rechazada'],
  ];
  const groups = { 31: [72, 73], 32: [72] };
  const core = harness({
    models: {
      Clinica: { async findAll() { return [{ id_clinica: 72 }, { id_clinica: 73 }]; } },
      GrupoClinica: { async findByPk(id) { return groups[id] ? { id, clinicas: groups[id].map(id_clinica => ({ id_clinica })) } : null; } },
      UsuarioClinica: { async findAll({ where }) {
        assert.ok(where[Op.or].some(item => item.estado_invitacion === 'aceptada'));
        return memberships.filter(([user, clinic, role, invitation]) => user === where.id_usuario
          && where.id_clinica[Op.in].includes(clinic) && where.rol_clinica[Op.in].includes(role)
          && (invitation === 'aceptada' || invitation == null)).map(([, id_clinica]) => ({ id_clinica }));
      } },
    },
    mocks: { './role-helpers': roles },
  });
  const record = name => async (...args) => {
    calls.push({ name, args }); return { success: true, reused: false, id: 8 };
  };
  const service = Object.fromEntries([
    'listCompetition', 'suggestCompetitors', 'getLocalRankingHeatmap', 'listLocalHeatmapSearches',
    'saveLocalHeatmapSearch', 'deleteLocalHeatmapSearch', 'updateCompetitor', 'deactivateCompetitor',
  ].map(name => [name, record(name)]));
  const http = harness({ mocks: {
    '../lib/clinicScope': core.load('lib/clinicScope.js'),
    '../lib/marketingScopeAccess': core.load('lib/marketingScopeAccess.js'),
    '../lib/role-helpers': roles,
    '../services/marketingAiVisibility.service': {
      getOverview: record('getOverview'), getRun: record('getRun'), enqueueTypicalRun: record('enqueueTypicalRun'),
    },
    '../services/marketingCompetition.service': service,
    '../services/jobRequests.service': { enqueueUniqueJobRequest: forbidden('real job') },
    '../services/jobScheduler.service': { triggerImmediate: forbidden('real scheduler') },
  } });
  const ai = http.load('controllers/marketingAiVisibility.controller.js');
  const competition = http.load('controllers/marketingCompetition.controller.js');
  async function request(controller, action, { clinicId = '72', userId = 9, body = {}, query = {}, params = {} } = {}) {
    const req = { query: { ...(clinicId == null ? {} : { clinicId }), ...query }, body,
      params: { runId: '8', searchId: '5', competitorId: '6', ...params }, userData: { userId } };
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    await controller[action](req, res); return res;
  }
  return { ai, competition, calls, request };
}

test('IA rejects missing, global, group and multiple clinics before any service call', async () => {
  for (const clinicId of [null, 'all', 'group:31', 'group:32', '72,73', 'invalid']) {
    const f = fixture();
    for (const action of ['getOverview', 'createRun', 'getRun']) {
      const res = await f.request(f.ai, action, { clinicId, userId: 1 });
      assert.equal(res.statusCode, 400, `${action}: ${clinicId}`);
      assert.equal(res.body.error, 'AI_VISIBILITY_SINGLE_CLINIC_REQUIRED');
    }
    assert.equal(f.calls.length, 0);
  }
});

test('IA enforces real Marketing membership and read/write roles before area or query processing', async () => {
  for (const userId of [0, 11, 13]) {
    const f = fixture();
    for (const action of ['getOverview', 'createRun', 'getRun']) {
      const res = await f.request(f.ai, action, { userId, body: { userId: 1, requestedBy: 1 }, query: { medical_area: 'unassigned' } });
      assert.equal(res.statusCode, 403);
    }
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  assert.equal((await f.request(f.ai, 'getOverview', { userId: 10 })).statusCode, 200);
  assert.equal((await f.request(f.ai, 'getRun', { userId: 10 })).statusCode, 200);
  assert.equal((await f.request(f.ai, 'createRun', { userId: 10 })).body.error, 'scope_write_forbidden');
  assert.equal((await f.request(f.ai, 'getOverview', { clinicId: '73' })).statusCode, 403);
  assert.equal((await f.request(f.ai, 'createRun', { userId: 12, body: { medical_area: 'cirugia_estetica' } })).statusCode, 202);
  assert.equal(f.calls.at(-1).args[0].requestedBy, 12);
  assert.equal(f.calls.at(-1).args[0].medicalArea, 'cirugia_estetica');
  assert.equal(f.calls.length, 3);
});

test('competition group/multi require access to every clinic; all/default remains global-admin only', async () => {
  const f = fixture();
  for (const clinicId of ['group:31', '72,73', 'all', null]) {
    const res = await f.request(f.competition, 'getCompetition', { clinicId });
    assert.equal(res.statusCode, 403, String(clinicId));
  }
  assert.equal(f.calls.length, 0);
  for (const clinicId of ['group:31', '72,73']) {
    assert.equal((await f.request(f.competition, 'getCompetition', { clinicId, userId: 12 })).statusCode, 200);
    assert.deepEqual(f.calls.at(-1).args[0].clinicIds, [72, 73]);
  }
  assert.equal((await f.request(f.competition, 'getCompetition', { clinicId: 'group:32' })).statusCode, 200);
  assert.equal((await f.request(f.competition, 'getCompetition', { clinicId: 'group:999', userId: 1 })).statusCode, 404);
  assert.equal((await f.request(f.competition, 'getCompetition', { clinicId: 'invalid' })).statusCode, 400);
  for (const clinicId of ['all', null]) {
    assert.equal((await f.request(f.competition, 'getCompetition', { clinicId, userId: 1 })).statusCode, 200);
    assert.equal(f.calls.at(-1).args[0].isAll, true);
  }
});

test('local endpoints retain read/write ACL and reject all before services; polling does not enqueue', async () => {
  const f = fixture();
  for (const action of ['suggestCompetitors', 'getLocalHeatmap', 'listLocalHeatmapSearches', 'saveLocalHeatmapSearch', 'deleteLocalHeatmapSearch']) {
    const res = await f.request(f.competition, action, { clinicId: 'all', userId: 1 });
    assert.equal(res.statusCode, 400, action);
    const denied = await f.request(f.competition, action, { clinicId: '73', body: { clinicId: '72', userId: 1 } });
    assert.equal(denied.statusCode, 403, action);
  }
  assert.equal(f.calls.length, 0);
  for (const action of ['suggestCompetitors', 'getLocalHeatmap', 'listLocalHeatmapSearches']) {
    const response = await f.request(f.competition, action, { userId: 10, query: { medical_area: 'capilar', cached_only: 'true' } });
    assert.equal(response.statusCode, 200);
    assert.equal(f.calls.at(-1).args[1].medicalArea, 'capilar');
  }
  assert.equal(f.calls.find(call => call.name === 'getLocalRankingHeatmap').args[1].cachedOnly, true);
  for (const action of ['saveLocalHeatmapSearch', 'deleteLocalHeatmapSearch']) {
    const response = await f.request(f.competition, action, { userId: 10 });
    assert.equal(response.body.error, 'scope_write_forbidden');
  }
  assert.equal(f.calls.length, 3);
  assert.equal((await f.request(f.competition, 'saveLocalHeatmapSearch', { userId: 12, body: { medical_area: 'estetica', term: 'medicina estética' } })).statusCode, 201);
  assert.equal((await f.request(f.competition, 'deleteLocalHeatmapSearch', { userId: 12, query: { medical_area: 'estetica' } })).statusCode, 200);
});
