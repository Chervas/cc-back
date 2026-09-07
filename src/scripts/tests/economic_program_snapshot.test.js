'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const disabledByDefault = require('../../lib/economicProgramSnapshot');
// Pure/stub tests below simulate future compatible promotion explicitly;
// never change process.env and never connect to a database.
const contract = { ...disabledByDefault,
  assertIntegrationEnabled: (lines) => disabledByDefault.assertIntegrationEnabled(lines, { enabled: true }),
  resolveLines: (lines, options) => disabledByDefault.resolveLines(lines, { ...options, integrationEnabled: true }),
};
const source = fs.readFileSync(require.resolve('../../services/patientEconomics.service'), 'utf8');
const definition = () => ({ id: 'd7bda3c1-a6c0-4882-88e7-f33ee77fa19b', version: 1, kind: 'program', status: 'active', name: 'Programa prueba', total_price: 620,
  summary: { issues: [], appointment_count: 4, duration_minutes: 120 },
  appointments: [0, 7, 14, 28].map((day, index) => ({ key: `visit-${index}`, label: `Cita ${index + 1}`, offset_days: day, treatment_ids: [20], duration_minutes: 30,
    treatments: [{ id: 20, name: 'Tratamiento prueba', duration_minutes: 30, booking_profile: { schema_version: 1, phases: [] } }] })) });
const rawLine = () => ({ key: 'line-1', program_id: definition().id, program_version: 1, quantity: 1, unit_price: 620 });

test('economic integration is closed by default; only an explicit true switch can prepare shared economic rows', async () => {
  assert.equal(disabledByDefault.economicsEnabled({}), false);
  for (const value of ['false', '1', 'TRUE', true, undefined]) assert.equal(disabledByDefault.economicsEnabled({ TREATMENT_PROGRAM_ECONOMICS_ENABLED: value }), false);
  assert.equal(disabledByDefault.economicsEnabled({ TREATMENT_PROGRAM_ECONOMICS_ENABLED: 'true' }), true);
  assert.throws(() => disabledByDefault.assertIntegrationEnabled([rawLine()], { enabled: false }), { code: 'program_economics_disabled' });
  await assert.rejects(disabledByDefault.resolveLines([rawLine()], { integrationEnabled: false, resolve: async () => { throw new Error('must not resolve catalog'); } }), { code: 'program_economics_disabled' });
  await assert.rejects(disabledByDefault.resolveLines([{ name: 'replacement' }], { previousLines: [{ program_snapshot: {} }], integrationEnabled: false }), { code: 'program_economics_disabled' });
  assert.equal(disabledByDefault.integrationCapabilities({ enabled: false, programsAvailable: true }).program_catalog, false);
});

test('program create/update are rejected before context loads, transactions or shared economic writes', async () => {
  let calls = 0;
  const bindings = { economicPrograms: { ...disabledByDefault, assertIntegrationEnabled: (lines) => disabledByDefault.assertIntegrationEnabled(lines, { enabled: false }) },
    loadContext: async () => { calls++; throw new Error('context should not load'); },
    sequelize: { transaction: async () => { calls++; throw new Error('transaction should not start'); } } };
  await assert.rejects(serviceFunction('createBudget', bindings)({ payload: { lines: [rawLine()] } }), { code: 'program_economics_disabled' });
  await assert.rejects(serviceFunction('updateDraftBudget', bindings)({ payload: { lines: [rawLine()] } }), { code: 'program_economics_disabled' });
  assert.equal(calls, 0);
});

test('catalog opt-in cannot expose selectable program offers while shared-runtime gate is closed', async () => {
  let programReads = 0;
  const list = serviceFunction('listCatalog', {
    loadContext: async () => ({ clinic: { id_clinica: 72, configuracion: {} }, patient: { id_paciente: 1 } }),
    parseJson: (value, fallback) => value || fallback, optionalPositiveInteger: (value) => Number(value) || null,
    normalizeAreaCode: (value) => value || '', cleanString: (value) => String(value || '').trim(),
    Op: { or: Symbol('or'), and: Symbol('and'), in: Symbol('in'), like: Symbol('like') },
    Tratamiento: { findAll: async () => [] }, mapCatalogItem: () => {},
    mapPatientSnapshot: () => ({}), mapClinicSnapshot: () => ({}), PRODUCT_TYPES: new Set(['treatment', 'voucher', 'pack']),
    economicPrograms: { ...disabledByDefault, economicsEnabled: () => false,
      integrationCapabilities: (options) => disabledByDefault.integrationCapabilities({ ...options, enabled: false }) },
    treatmentPrograms: { list: async () => { programReads++; return { items: [definition()], total: 1 }; } },
  });
  const result = await list({ clinicId: 72, patientIdentifier: 1, query: { include_programs: '1' } });
  assert.equal(result.items.length, 0); assert.equal(programReads, 0);
  assert.equal(result.capabilities.program_catalog, false);
  assert.equal(result.capabilities.program_definitions_preparation_only, true);
  assert.equal(result.capabilities.program_integration_reason, 'shared_runtime_compatibility_pending');
});

test('four-appointment program is one financial concept, not four times its global price', async () => {
  const item = contract.catalogItem(definition());
  assert.equal(item.default_units, 1); assert.equal(item.base_price, 620); assert.equal(item.entitlement_units, 4);
  const [line] = await contract.resolveLines([rawLine()], { resolve: async () => definition() });
  assert.equal(line.quantity * line.unit_price, 620); assert.equal(line.entitlement_units, 4);
  assert.equal(line.treatment_id, null); assert.equal(line.product_type, 'pack');
  assert.equal(line.activation_rule, 'on_acceptance');
});
test('client snapshot cannot forge names, clinics, resources or appointment counts', async () => {
  const [line] = await contract.resolveLines([{ ...rawLine(), entitlement_units: 999, program_snapshot: { name: 'forged', appointments: [] } }], { resolve: async () => definition() });
  assert.equal(line.program_snapshot.name, 'Programa prueba'); assert.equal(line.entitlement_units, 4);
  assert.equal(line.program_snapshot.sha256.length, 64);
  await assert.rejects(contract.resolveLines([{ key: 'x', program_snapshot: {} }], { resolve: async () => definition() }), { code: 'budget_program_reference_required' });
});
test('server budget snapshot survives future catalog edits and is cloned, never mutated', async () => {
  const [original] = await contract.resolveLines([rawLine()], { resolve: async () => definition() });
  const [edited] = await contract.resolveLines([{ ...rawLine(), notes: 'Changed commercial note' }], { previousLines: [original], resolve: async () => { throw new Error('must not reload current catalog'); } });
  assert.deepEqual(edited.program_snapshot, original.program_snapshot);
  edited.program_snapshot.appointments[0].treatments[0].name = 'changed copy';
  assert.equal(original.program_snapshot.appointments[0].treatments[0].name, 'Tratamiento prueba');
});
test('new selection rejects stale versions, draft definitions and multiply-counted purchases', async () => {
  await assert.rejects(contract.resolveLines([rawLine()], { resolve: async () => ({ ...definition(), version: 2 }) }), { code: 'budget_program_version_conflict' });
  await assert.rejects(contract.resolveLines([rawLine()], { resolve: async () => ({ ...definition(), status: 'draft' }) }), { code: 'budget_program_not_sellable' });
  await assert.rejects(contract.resolveLines([{ ...rawLine(), quantity: 4 }], { resolve: async () => definition() }), { code: 'budget_program_quantity_invalid' });
  await assert.rejects(contract.resolveLines([rawLine(), rawLine()], { resolve: async () => definition() }), { code: 'budget_duplicate_line_key' });
  await assert.rejects(contract.resolveLines([rawLine(), { ...rawLine(), key: ' line-1 ' }], { resolve: async () => definition() }), { code: 'budget_duplicate_line_key' });
});
test('homogeneous voucher retains base treatment but still sells one entire offer', async () => {
  const [line] = await contract.resolveLines([rawLine()], { resolve: async () => ({ ...definition(), kind: 'voucher' }) });
  assert.equal(line.treatment_id, 20); assert.equal(line.product_type, 'voucher'); assert.equal(line.entitlement_units, 4);
});
test('acceptance shows pending composition without inferring payment or pretending any reservations', async () => {
  const lines = await contract.resolveLines([rawLine()], { resolve: async () => definition() });
  const [plan] = contract.programPlans({ budget: { status: 'accepted' }, lines });
  assert.equal(plan.purchase_status, 'accepted'); assert.equal(plan.can_schedule, false);
  assert.equal(plan.appointments[0].scheduling_status, 'pending_planning'); assert.equal(plan.appointment_count, 4);
  assert.equal('paid' in plan, false); assert.equal('reserved_at' in plan.appointments[0], false);
  assert.equal(contract.programPlans({ budget: { status: 'partially_accepted' }, lines, events: [{ event_type: 'partially_accepted', metadata: { accepted_line_keys: ['other'] } }] })[0].purchase_status, 'not_accepted');
});
test('request hash is order-stable but changed price or composition is a different request', () => {
  assert.equal(contract.requestHash({ lines: [rawLine()], notes: 'a' }), contract.requestHash({ notes: 'a', lines: [{ ...rawLine(), program_snapshot: { forged: true } }] }));
  assert.notEqual(contract.requestHash({ lines: [rawLine()] }), contract.requestHash({ lines: [{ ...rawLine(), unit_price: 1 }] }));
  assert.notEqual(contract.requestHash({ lines: [rawLine()] }), contract.requestHash({ lines: [{ ...rawLine(), program_version: 2 }] }));
});
test('gross program prices cannot receive additional VAT or be fiscally issued before configuration', async () => {
  const lines = await contract.resolveLines([rawLine()], { resolve: async () => definition() });
  assert.doesNotThrow(() => contract.assertFiscalReady({ lines, status: 'draft', fiscalLines: [{ unit_price: 620, tax_percent: 0 }] }));
  assert.throws(() => contract.assertFiscalReady({ lines, status: 'draft', fiscalLines: [{ unit_price: 620, tax_percent: 21 }] }), { code: 'program_fiscal_configuration_pending' });
  assert.throws(() => contract.assertFiscalReady({ lines, status: 'issued', fiscalLines: [{ unit_price: 620, tax_percent: 0 }] }), { code: 'program_fiscal_configuration_pending' });
  assert.doesNotThrow(() => contract.assertFiscalReady({ lines: [{ name: 'Existing normal concept' }], status: 'issued', fiscalLines: [{ tax_percent: 21 }] }));
});
test('program draft is preparation only and cannot be presented, signed or sold before booking/consumption support', () => {
  assert.throws(() => contract.assertOperational([rawLine()]), { code: 'program_preparation_only' });
  assert.throws(() => contract.assertOperational([{ program_snapshot: {} }]), { code: 'program_preparation_only' });
  assert.doesNotThrow(() => contract.assertOperational([{ name: 'Existing normal treatment' }]));
});

function serviceFunction(name, bindings) {
  const start = source.indexOf(`async function ${name}(`);
  const end = source.indexOf('\nasync function ', start + 10);
  return vm.runInNewContext(`${source.slice(start, end)}\n${name}`, { ...bindings, crypto });
}
test('existing voucher ledger receives four units once; removed draft entitlement stays as cancelled history', async () => {
  const rows = [];
  const PatientVoucher = {
    findAll: async () => rows.filter((r) => r.source_system === 'treatment_program'),
    findOne: async ({ where }) => rows.find((r) => r.budget_line_key === where.budget_line_key),
    create: async (values) => { const row = { ...values, update: async function (values) { Object.assign(this, values); } }; rows.push(row); return row; },
  };
  const sync = serviceFunction('syncVoucherDefinitions', { economicPrograms: contract, PatientVoucher, parseJson: (value, fallback) => value || fallback });
  const lines = await contract.resolveLines([rawLine()], { resolve: async () => definition() });
  lines[0].total = 620;
  const args = { budget: { id: 8, public_id: 'budget-8', clinic_id: 72, patient_id: 1 }, version: { lines }, actorId: 3, transaction: {} };
  await sync(args); await sync(args);
  assert.equal(rows.length, 1); assert.equal(rows[0].total_units, 4); assert.equal(rows[0].available_units, 4); assert.equal(rows[0].sold_amount, 620);
  await sync({ ...args, version: { lines: [] } }); assert.equal(rows[0].status, 'cancelled');
  await sync(args); assert.equal(rows[0].status, 'pending'); assert.equal(rows.length, 1);
});
test('partial acceptance activates only the accepted new-program line, never inventing a payment', async () => {
  const movements = [];
  const rows = ['selected', 'not-selected'].map((key, i) => ({ id: i + 1, budget_line_key: key, source_system: 'treatment_program', total_units: 4, status: 'pending', update: async function (values) { Object.assign(this, values); } }));
  const activate = serviceFunction('activateVouchers', {
    PatientVoucher: { findAll: async () => rows },
    PatientVoucherMovement: { create: async (movement) => movements.push(movement) },
    EconomicBudgetEvent: { findOne: async () => ({ metadata: { accepted_line_keys: ['selected'] } }) },
    parseJson: (value, fallback) => value || fallback,
  });
  await activate({ budget: { id: 8, status: 'partially_accepted' }, rule: 'on_acceptance', actorId: 3, transaction: {} });
  assert.equal(rows[0].status, 'active'); assert.equal(rows[1].status, 'pending');
  assert.equal(movements.length, 1); assert.equal(movements[0].movement_type, 'activation');
});
test('budget creation retries produce one sale, reject changed request data and never cross patient scope', async () => {
  const budgets = [], versions = [], events = [];
  let serial = Promise.resolve();
  const sequelize = { transaction: (fn) => {
    const result = serial.then(() => fn({ LOCK: { UPDATE: 'update' } }));
    serial = result.catch(() => {}); return result;
  } };
  const create = serviceFunction('createBudget', {
    sequelize, economicPrograms: contract,
    loadContext: async (id) => ({ clinic: { id_clinica: 72 }, patient: { id_paciente: id } }),
    Clinica: { findByPk: async () => ({ id_clinica: 72 }) },
    EconomicBudget: {
      findOne: async ({ where }) => budgets.find((row) => Object.entries(where).every(([key, value]) => row[key] === value)),
      create: async (values) => { const row = { id: budgets.length + 1, ...values }; budgets.push(row); return row; },
    },
    EconomicBudgetVersion: { findOne: async ({ where }) => versions.find((row) => row.budget_id === where.budget_id) },
    EconomicBudgetEvent: { create: async (event) => events.push(event) },
    createVersion: async ({ budget, payload }) => { const row = { budget_id: budget.id, design_config: { program_request_hash: contract.requestHash(payload) } }; versions.push(row); return row; },
    syncVoucherDefinitions: async () => {}, nextBudgetNumber: async () => 'PRES-TEST',
    serializeBudget: (budget) => ({ id: budget.public_id }),
    cleanString: (value) => String(value || '').trim(), dateOrNull: () => null,
    domainError: (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code }),
    parseJson: (value, fallback) => value || fallback,
  });
  const args = { patientIdentifier: 1, clinicId: 72, actorId: 3, payload: { lines: [rawLine()], source_reference: 'request-unique' } };
  const [first, retry] = await Promise.all([create(args), create(args)]);
  assert.equal(first.id, retry.id); assert.equal(budgets.length, 1); assert.equal(events.length, 1);
  await assert.rejects(create({ ...args, patientIdentifier: 2 }), { code: 'budget_source_conflict' });
  await assert.rejects(create({ ...args, payload: { ...args.payload, notes: 'different requested sale' } }), { code: 'budget_request_conflict' });
  await assert.rejects(create({ ...args, payload: { lines: [rawLine()] } }), { code: 'budget_program_request_key_required' });
});
