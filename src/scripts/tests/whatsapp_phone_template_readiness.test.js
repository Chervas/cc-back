'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture({ group = false, canReadGroup = true } = {}) {
  const source = fs.readFileSync(path.resolve(__dirname, '../../controllers/whatsapp.controller.js'), 'utf8');
  const start = source.indexOf('exports.listPhones =');
  const end = source.indexOf('exports.updateClinicPhoneRoutingBinding =', start);
  assert(start >= 0 && end > start);
  const Op = Object.fromEntries(['and', 'or', 'in', 'ne'].map(key => [key, Symbol(key)]));
  const queries = [];
  const bindingQueries = [];
  const rows = [
    { waba_id: '301', status: 'APPROVED', count: '2' },
    { waba_id: '301', status: 'PENDING', count: '3' },
    { waba_id: '301', status: 'IN_REVIEW', count: '1' },
    { waba_id: '301', status: 'REJECTED', count: '4' },
    { waba_id: '302', status: 'PENDING', count: '5' },
  ];
  const phone = (id, wabaId) => ({ id, wabaId, phoneNumberId: String(400 + id),
    clinicaId: 71, assignmentScope: 'clinic', isActive: true, additionalData: {} });
  const groupPhone = { ...phone(4, '301'), clinicaId: null, grupoClinicaId: 7, assignmentScope: 'group' };
  const binding = (id, clinic_id, asset_id, role) => ({ id, clinic_id, asset_id, role, secret: 'never-projected' });
  const serviceFile = path.resolve(__dirname, '../../services/whatsappChannelBindings.service.js');
  const bindingsModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(serviceFile, 'utf8'), {
    module: bindingsModule,
    require: name => {
      if (name === 'sequelize') return { Op };
      if (name === '../lib/whatsapp-channel-role') return require('../../lib/whatsapp-channel-role');
      if (name === '../../models') return { WhatsappChannelBinding: { findAll: async query => {
        bindingQueries.push(query);
        return [binding(1, 71, 4, 'secondary'), binding(2, 72, 4, 'primary'), binding(3, 71, 1, 'primary'),
          binding(4, 72, 2, 'secondary'), binding(5, 73, 4, 'secondary'), binding(6, 71, 66, 'primary')];
      } } };
      throw Error('Unexpected dependency: ' + name);
    },
  });
  const context = {
    exports: {}, Op, PREVERIFIED_ENABLED: false,
    getUserClinics: async () => ({ clinicIds: [71], isAggregateAllowed: false }),
    getUserGroupIds: async () => [7],
    assertWhatsappTemplateClinicAccess: async ({ clinicId }) => {
      if (clinicId !== 71) throw Object.assign(Error('denied'), { statusCode: 403 });
    },
    Clinica: { findOne: async () => ({ grupoClinicaId: 7 }), findAll: async () => [{ id_clinica: 71 }, { id_clinica: 72 }] },
    hasMarketingClinicScopeAccess: async (_scope) => canReadGroup, isWhatsappGlobalAdmin: () => false,
    GrupoClinica: {}, MetaConnection: {},
    ClinicMetaAsset: { findAll: async query => query.where.assetType === 'whatsapp_phone_number'
      ? [phone(1, '301'), phone(2, '302'), phone(3, '303'), ...(group ? [groupPhone] : [])] : [] },
    WhatsappTemplate: { findAll: async query => { queries.push(query); return rows; } },
    db: { sequelize: { fn: (...args) => args, col: value => value } },
    whatsappChannelBindingsService: { listClinicBindings: async () => [], listGroupPhoneAssignments: bindingsModule.exports.listGroupPhoneAssignments },
    whatsappPermissionInventoryService: { read: async () => new Map() },
    whatsappPaymentStatusService: { derivePaymentSnapshot: () => ({}) },
    whatsappService: { getOutboundUsageForPhone: async () => ({}) },
    resolveWhatsappRouting: () => ({ role: 'primary', purposes: [] }),
    whatsappAccountComplianceService: { summarizeCompliance: () => ({}) },
    whatsappAccountHealthService: { summarizeAssetHealth: () => ({}) },
    safeProfilePictureUrl: require('../../../services/integrations-broker/src/whatsapp-profile-picture').profilePictureUrl,
    require: name => {
      if (name.endsWith('/whatsappAuthorizedBrokerClient')) return { configuration: () => null, binding: async () => { throw Error('closed'); } };
      if (name.endsWith('/whatsappManualDisconnect')) return { current: () => null };
      if (name.endsWith('/whatsappConfigurationTestEvidence.service')) return { forAssets: async () => new Map() };
      throw Error('Unexpected dependency: ' + name);
    },
  };
  vm.runInNewContext(source.slice(start, end), context);
  const call = async input => {
    let status = 200, body;
    const res = { status(value) { status = value; return this; }, json(value) { body = value; return this; } };
    const query = Number.isInteger(input) ? { clinic_id: String(input) } : input;
    await context.exports.listPhones({ userData: { userId: 501 }, query }, res);
    return { status, body };
  };
  return { call, queries, bindingQueries, Op };
}

test('phone readiness counts active templates per exact WABA without mixing approval, pending and rejection', async () => {
  const f = fixture();
  const result = await f.call(71);
  assert.equal(result.status, 200);
  const counts = result.body.phones.map(phone => [phone.wabaId, phone.template_count,
    phone.approved_template_count, phone.pending_template_count, phone.rejected_template_count]);
  assert.equal(JSON.stringify(counts), JSON.stringify([['301', 10, 2, 4, 4], ['302', 5, 0, 5, 0], ['303', 0, 0, 0, 0]]));
  assert.equal(f.queries.length, 1);
  assert.equal(f.queries[0].where.is_active, true);
  assert.equal(JSON.stringify(f.queries[0].where.waba_id[f.Op.in]), JSON.stringify(['301', '302', '303']));
  assert.equal(JSON.stringify(f.queries[0].group), JSON.stringify(['waba_id', 'status']));
});

test('foreign clinic scope is rejected before reading template readiness', async () => {
  const f = fixture();
  const result = await f.call(72);
  assert.equal(result.status, 403);
  assert.equal(result.body.error, 'whatsapp_clinic_scope_forbidden');
  assert.equal(f.queries.length, 0);
});

test('group routing inventory matches the exact authorized clinic and phone in a bounded batch', async () => {
  const f = fixture({ group: true });
  const { status, body } = await f.call({ group_id: '7', include_group_routing: '1' });
  assert.equal(status, 200);
  assert.equal(body.group_routing_included, true);
  assert.deepEqual(JSON.parse(JSON.stringify(body.phones.map(phone => phone.routing_bindings))), [
    [{ id: 3, clinic_id: 71, role: 'primary' }], [], [],
    [{ id: 1, clinic_id: 71, role: 'secondary' }, { id: 2, clinic_id: 72, role: 'primary' }],
  ]);
  assert.equal(f.bindingQueries.length, 1);
  const [query] = f.bindingQueries;
  assert.equal(query.limit, 4);
  assert.equal(JSON.stringify(query.where.clinic_id[f.Op.in]), '[71,72]');
  assert.equal(JSON.stringify(query.attributes), '["id","clinic_id","asset_id","role"]');
});

test('group routing projection is absent for legacy callers and closed for mismatched or unauthorized scopes', async () => {
  const f = fixture({ canReadGroup: false, group: true });
  for (const query of [{ clinic_id: '71', include_group_routing: '1' },
    { group_id: '7', routing_scope_clinic_id: '71', include_group_routing: '1' },
    { group_id: '7', include_group_routing: '0' }]) {
    assert.equal((await f.call(query)).status, 400);
  }
  assert.equal((await f.call({ group_id: '7', include_group_routing: '1' })).status, 403);
  const legacy = await f.call(71);
  assert.equal(legacy.status, 200);
  assert.equal(Object.hasOwn(legacy.body, 'group_routing_included'), false);
  assert(legacy.body.phones.every(phone => !Object.hasOwn(phone, 'routing_bindings')));
  assert.equal(f.bindingQueries.length, 0);
});
