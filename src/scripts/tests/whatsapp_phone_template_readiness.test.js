'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const source = fs.readFileSync(path.resolve(__dirname, '../../controllers/whatsapp.controller.js'), 'utf8');
  const start = source.indexOf('exports.listPhones =');
  const end = source.indexOf('exports.updateClinicPhoneRoutingBinding =', start);
  assert(start >= 0 && end > start);
  const Op = Object.fromEntries(['and', 'or', 'in', 'ne'].map(key => [key, Symbol(key)]));
  const queries = [];
  const rows = [
    { waba_id: '301', status: 'APPROVED', count: '2' },
    { waba_id: '301', status: 'PENDING', count: '3' },
    { waba_id: '301', status: 'IN_REVIEW', count: '1' },
    { waba_id: '301', status: 'REJECTED', count: '4' },
    { waba_id: '302', status: 'PENDING', count: '5' },
  ];
  const phone = (id, wabaId) => ({ id, wabaId, phoneNumberId: String(400 + id),
    clinicaId: 71, assignmentScope: 'clinic', isActive: true, additionalData: {} });
  const context = {
    exports: {}, Op, PREVERIFIED_ENABLED: false,
    getUserClinics: async () => ({ clinicIds: [71], isAggregateAllowed: false }),
    getUserGroupIds: async () => [7],
    assertWhatsappTemplateClinicAccess: async ({ clinicId }) => {
      if (clinicId !== 71) throw Object.assign(Error('denied'), { statusCode: 403 });
    },
    Clinica: { findOne: async () => ({ grupoClinicaId: 7 }) }, GrupoClinica: {}, MetaConnection: {},
    ClinicMetaAsset: { findAll: async query => query.where.assetType === 'whatsapp_phone_number'
      ? [phone(1, '301'), phone(2, '302'), phone(3, '303')] : [] },
    WhatsappTemplate: { findAll: async query => { queries.push(query); return rows; } },
    db: { sequelize: { fn: (...args) => args, col: value => value } },
    whatsappChannelBindingsService: { listClinicBindings: async () => [] },
    whatsappPermissionInventoryService: { read: async () => new Map() },
    whatsappPaymentStatusService: { derivePaymentSnapshot: () => ({}) },
    whatsappService: { getOutboundUsageForPhone: async () => ({}) },
    resolveWhatsappRouting: () => ({ role: 'primary', purposes: [] }),
    whatsappAccountComplianceService: { summarizeCompliance: () => ({}) },
    whatsappAccountHealthService: { summarizeAssetHealth: () => ({}) },
    require: name => {
      if (name.endsWith('/whatsappAuthorizedBrokerClient')) return { binding: async () => { throw Error('closed'); } };
      if (name.endsWith('/whatsappManualDisconnect')) return { current: () => null };
      throw Error('Unexpected dependency: ' + name);
    },
  };
  vm.runInNewContext(source.slice(start, end), context);
  const call = async clinicId => {
    let status = 200, body;
    const res = { status(value) { status = value; return this; }, json(value) { body = value; return this; } };
    await context.exports.listPhones({ userData: { userId: 501 }, query: { clinic_id: String(clinicId) } }, res);
    return { status, body };
  };
  return { call, queries, Op };
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
