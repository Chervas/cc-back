'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test'); const assert = require('node:assert/strict'); const sequelize = require('sequelize');
const { loadDiscoverySource } = require('./fixtures/business_profile_discovery.fixture');
const { createGooglePropertyInventoryScope } = require('../../services/googlePropertyInventoryScope.service');
function fixture(kind) {
  const scope = { clinicId: 72, groupId: 9, assignmentScope: 'clinic' }; const queries = [];
  const state = { rows: [{ id: 91, clinicaId: 71, googleConnectionId: 81, siteUrl: 'sc-domain:example.invalid', propertyName: 'properties/123',
    isActive: true, updated_at: '2026-09-01T00:00:00Z' }],
    assignments: [{ grupoClinicaId: 9, clinicaId: 72, assetType: 'google.' + kind, assetId: 91 }],
    owners: [{ id_clinica: 71, grupoClinicaId: 9 }] };
  const blocked = new Proxy({}, { get: () => () => assert.fail('Unrelated models/credentials must not be queried') });
  const target = { findAll: async options => {
    queries.push(options); assert.equal(options.where.googleConnectionId, 81); assert.equal(options.where.isActive, true);
    assert.equal(options.limit, 1001); assert(options.attributes.includes('id')); assert(options.attributes.includes('updated_at'));
    assert(!options.attributes.some(name => /token|secret/i.test(name))); return state.rows;
  } };
  const models = { IntakeConfig: blocked, MetaConnection: blocked, ClinicMetaAsset: blocked, ClinicGoogleAdsAccount: blocked, ClinicBusinessLocation: blocked,
    ClinicWebAsset: kind === 'search_console' ? target : blocked, ClinicAnalyticsProperty: kind === 'analytics' ? target : blocked,
    GrupoClinica: { findByPk: async (id, options) => { assert.equal(id, 9); assert.equal(options.attributes.length, 7);
      return { id_grupo: 9, search_console_assignment_mode: 'clinic', analytics_assignment_mode: 'clinic' }; } },
    GroupAssetClinicAssignment: { findAll: async options => {
      assert.equal(options.where.assetType, 'google.' + kind); assert.equal(options.where.grupoClinicaId, 9); assert.equal(options.where.clinicaId, 72);
      assert.equal(options.limit, 1001); assert.equal(options.attributes.length, 4); return state.assignments;
    } },
    Clinica: { findAll: async options => { assert.deepEqual(options.where.id_clinica[sequelize.Op.in], [71]);
      assert.deepEqual(options.attributes, ['id_clinica', 'grupoClinicaId']); return state.owners; } },
  };
  const selector = loadDiscoverySource('services/effectiveMarketingAssets.service.js', { '../../models': models, sequelize });
  const service = createGooglePropertyInventoryScope({ models: () => models, normalizeScope: async () => scope, listProperties: selector.listScopedGoogleProperties });
  return { state, queries, service, input: { kind, scopeInput: { clinicIdRaw: 72 }, clinicIds: [72], connectionId: 81 } };
}
for (const kind of ['search_console', 'analytics']) {
  test(kind + ' uses actual property selection with bounded, projected queries and no unrelated provider or intake reads', async () => {
    const f = fixture(kind); const rows = await f.service.resolve(f.input);
    assert.deepEqual(rows, [{ mapping_id: 91, clinic_id: 71, connection_id: 81, resource: kind === 'search_console' ? 'sc-domain:example.invalid' : 'properties/123' }]);
    assert.equal(f.queries.length, 1);
  });
  test(kind + ' missing, foreign and ambiguous owner groups reject the effective shared reference', async () => {
    for (const owners of [[], [{ id_clinica: 71, grupoClinicaId: 10 }], [{ id_clinica: 71, grupoClinicaId: 9 }, { id_clinica: 71, grupoClinicaId: 9 }]]) {
      const f = fixture(kind); f.state.owners = owners; await assert.rejects(f.service.resolve(f.input), { code: 'google_discovery_scope_forbidden' });
    }
  });
  test(kind + ' candidate ceilings fail before accepting truncated or partial mapping inventories', async () => {
    for (const field of ['rows', 'assignments']) {
      const f = fixture(kind); f.state[field] = Array.from({ length: 1001 }, () => f.state[field][0]);
      await assert.rejects(f.service.resolve(f.input), { code: 'broker_discovery_limit' });
    }
  });
}
