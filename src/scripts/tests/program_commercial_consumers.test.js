'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), { createRequire } = require('node:module');
const source = fs.readFileSync(require.resolve('../../services/patientEconomics.service'), 'utf8');
const serviceRequire = createRequire(require.resolve('../../services/patientEconomics.service'));
const financial = require('../../lib/economic-commercial-policy');
const commercial = require('../../lib/treatment-commercial-policy');
const economicPrices = require('../../lib/economicPriceProfile');
const component = { id_tratamiento: 42, clinica_id: 72, origen: 'clinica', activo: true, precio_base: null,
  clinical_config: { commercial: { sale_mode: 'program_component_only' } } };
const lines = [{ key: 'same-key', treatment_id: 42, product_type: 'voucher', unit_price: 99, quantity: 1 }];
const parseJson = (v, fallback) => v == null ? fallback : typeof v === 'string' ? JSON.parse(v) : v;
const guard = list => financial.assertCommercialLines(list, { resolveTreatments: async () => new Map([[42, component]]) });
const cleanString = v => String(v || '').trim();
const domainError = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code });
function fn(name, bindings = {}) {
  const declaration = new RegExp(`(?:^|\\n)(?:async )?function ${name}\\(`).exec(source); assert(declaration, name);
  const rest = source.slice(declaration.index + 1), end = rest.search(/\n(?:async )?function \w+/);
  return vm.runInNewContext(`${end < 0 ? rest : rest.slice(0, end)}\n${name}`, { require: serviceRequire, crypto: require('node:crypto'), parseJson, cleanString, domainError, economicPrices, ...bindings });
}
const transaction = { LOCK: { UPDATE: 'update' } };
const sequelize = { transaction: async cb => cb(transaction) };
test('new and preserved same-key lines cannot bypass createVersion through price overrides', async () => {
  let writes = 0, profileReads = 0;
  const create = fn('createVersion', { economicPrograms: { resolveLines: async l => l }, assertBudgetCommercial: guard,
    economicPrices: { resolveBudgetPriceProfiles: async () => { profileReads++; } },
    EconomicBudgetVersion: { findOne: async () => ({ lines }), create: async () => { writes++; } } });
  for (const versionNumber of [1, 2]) await assert.rejects(create({ budget: { id: 1, status: 'draft' }, payload: { lines }, clinic: { id_clinica: 72 }, versionNumber }), { code: 'treatment_program_component_only' });
  assert.equal(writes, 0); assert.equal(profileReads, 0);
});
test('new ordinary budget reference is checked before first persisted write', async () => {
  let writes = 0;
  const create = fn('createBudget', { sequelize, loadContext: async () => ({ patient: { id_paciente: 1 }, clinic: { id_clinica: 72 } }),
    economicPrograms: { assertIntegrationEnabled() {}, integrationCapabilities: () => ({ program_batch_booking: true }) },
    assertBudgetCommercial: guard, Clinica: { findByPk: async () => ({}) }, EconomicBudget: { create: async () => { writes++; } } });
  await assert.rejects(create({ payload: { lines } }), { code: 'treatment_program_component_only' }); assert.equal(writes, 0);
});
test('revising an accepted purchase creates a NEW offer but never changes the accepted version', async () => {
  let writes = 0;
  const original = { id: 1, status: 'accepted', current_version: 1, clinic_id: 72, patient_id: 8 };
  const revise = fn('reviseBudget', { sequelize, loadBudgetByPublicId: async () => original,
    EconomicBudgetVersion: { findOne: async () => ({ lines }), create: async () => { writes++; } },
    EconomicBudget: { create: async () => { writes++; } }, Paciente: { findByPk: async () => ({}) }, Clinica: { findByPk: async () => ({ id_clinica: 72 }) },
    economicPrograms: { assertIntegrationEnabled() {} }, assertBudgetCommercial: guard });
  await assert.rejects(revise({ publicId: 'original' }), { code: 'treatment_program_component_only' });
  assert.equal(writes, 0); assert.equal(original.status, 'accepted'); assert.equal(original.current_version, 1);
});
test('presentation, re-presentation and both acceptance modes reject before status, history or voucher writes', async () => {
  for (const action of ['present', 'present_again', 'accept', 'accept_partial']) {
    let writes = 0;
    const budget = { id: 1, status: action === 'present' ? 'draft' : 'presented', clinic_id: 72, current_version: 1, update: async () => { writes++; } };
    const transition = fn('transitionBudget', { sequelize, loadBudgetByPublicId: async () => budget,
      EconomicBudgetVersion: { findOne: async () => ({ lines }) }, economicPrograms: { assertOperational() {} }, assertBudgetCommercial: guard });
    await assert.rejects(transition({ publicId: 'budget', action, payload: { expected_version: 1 } }), { code: 'treatment_program_component_only' });
    assert.equal(writes, 0);
  }
  // API-only preview is not registered in the gateway entrypoint.
  if (source.includes('async function previewBudgetAcceptance(')) {
  const preview = fn('previewBudgetAcceptance', { loadBudgetByPublicId: async () => ({ id: 1, status: 'presented', current_version: 1, clinic_id: 72 }),
    EconomicBudgetVersion: { findOne: async () => ({ lines }) }, economicPrograms: { assertOperational() {} }, assertBudgetCommercial: guard });
  await assert.rejects(preview({ payload: { expected_version: 1, action: 'accept' } }), { code: 'treatment_program_component_only' });
  }
});
test('signature creation refuses included individual concept before request, transaction or provider send', async () => {
  let writes = 0;
  const create = fn('createBudgetSignatureRequest', { loadBudgetSignatureContext: async () => ({ budget: { status: 'draft' }, version: { lines }, clinic: { id_clinica: 72 } }),
    economicPrograms: { assertOperational() {} }, assertBudgetCommercial: guard,
    sequelize: { transaction: async () => { writes++; } }, sendBudgetSignatureWhatsapp: async () => { writes++; } });
  await assert.rejects(create({}), { code: 'treatment_program_component_only' }); assert.equal(writes, 0);
});
test('public signature POST revalidates persisted ownership/version before acceptance writes', async () => {
  let writes = 0;
  const request = { id: 1, budget_id: 2, status: 'sent', budget_version: 1, update: async () => { writes++; } };
  const budget = { id: 2, current_version: 1, status: 'presented', clinic_id: 72, update: async () => { writes++; } };
  const accept = fn('applyBudgetSignatureAcceptance', { sequelize, EconomicBudgetSignatureRequest: { findOne: async () => request },
    EconomicBudget: { findOne: async () => budget }, EconomicBudgetVersion: { findOne: async () => ({ lines }) },
    economicPrograms: { assertOperational() {} }, assertBudgetCommercial: guard });
  await assert.rejects(accept({ request }), { code: 'treatment_program_component_only' }); assert.equal(writes, 0);
});
test('old pending public link cannot become viewed/presented with an included individual concept', async () => {
  let writes = 0;
  const request = { status: 'sent', budget_id: 2, budget_version: 1, update: async () => { writes++; } };
  const find = fn('findBudgetSignatureRequestFromToken', { verifyBudgetSignatureToken: () => ({ request_public_id: 'request' }),
    EconomicBudgetSignatureRequest: { findOne: async () => request }, EconomicBudget: { findByPk: async () => ({ id: 2, current_version: 1, status: 'presented', clinic_id: 72 }) },
    EconomicBudgetVersion: { findOne: async () => ({ lines }) }, assertBudgetCommercial: guard });
  await assert.rejects(find('synthetic', { markViewed: true }), { code: 'treatment_program_component_only' }); assert.equal(writes, 0);
});
test('voucher direct-ID resolver blocks positive overrides; manual and sold voucher endpoints cannot bypass it', async () => {
  const resolver = fn('resolveCatalogItemForClinic', { Tratamiento: { findByPk: async () => component }, treatmentIsAvailableForClinic: () => true });
  await assert.rejects(resolver(42, {}), { code: 'treatment_program_component_only' });
  let writes = 0;
  const context = { clinicId: 72, clinic: { id_clinica: 72 }, patient: { id_paciente: 8 } };
  const create = fn('createVoucher', { loadContext: async () => context, optionalPositiveInteger: Number, roundMoney: Number, sequelize,
    resolveCatalogItemForClinic: resolver, Paciente: { findByPk: async () => ({}) }, PatientVoucher: { create: async () => { writes++; } } });
  await assert.rejects(create({ payload: { treatment_id: 42, total_units: 1, name: 'Synthetic', sold_amount: 99 } }), { code: 'treatment_program_component_only' });
  const sell = fn('sellVoucher', { loadContext: async () => context, optionalPositiveInteger: Number, resolveCatalogItemForClinic: resolver,
    EconomicBudget: { findOne: async () => null }, createBudget: async () => { writes++; } });
  await assert.rejects(sell({ payload: { treatment_id: 42, sold_amount: 99 } }), { code: 'treatment_program_component_only' }); assert.equal(writes, 0);
});
test('sold voucher undefined and whitespace tariffs are never interpreted as a free sale', async () => {
  let writes = 0;
  const sell = fn('sellVoucher', { loadContext: async () => ({ clinicId: 72, patient: { id_paciente: 8 } }), optionalPositiveInteger: Number,
    EconomicBudget: { findOne: async () => null }, resolveCatalogItemForClinic: async () => ({ name: 'Synthetic', default_units: 1, base_price: null }),
    roundMoney: Number, createBudget: async () => { writes++; } });
  for (const sold_amount of [undefined, null, '', '   ', '\t', 'abc', false, true, {}, [], NaN, Infinity]) await assert.rejects(sell({ payload: { treatment_id: 42, sold_amount } }), { code: 'voucher_price_required' });
  assert.equal(writes, 0);
});
test('historical manual voucher replay is patient-scoped and never consults current catalogue policy', async () => {
  let catalogueReads = 0;
  const receipt = { id: 9, patient_id: 8, treatment_id: 42, sold_amount: 90, status: 'active' };
  const context = { clinicId: 72, patient: { id_paciente: 8 } };
  const create = fn('createVoucher', { loadContext: async () => context, optionalPositiveInteger: Number, roundMoney: Number, sequelize,
    resolveCatalogItemForClinic: async () => { catalogueReads++; throw Error('must not reprice'); }, Paciente: { findByPk: async () => ({}) },
    PatientVoucher: { findOne: async () => receipt }, PatientVoucherMovement: { findAll: async () => [] }, serializeVoucher: v => v });
  const args = { clinicId: 72, payload: { treatment_id: 42, name: 'Synthetic', total_units: 1, source_reference: 'previous' } };
  assert.equal(await create(args), receipt); assert.equal(catalogueReads, 0); assert.equal(receipt.sold_amount, 90);
  context.patient.id_paciente = 99; await assert.rejects(create(args), { code: 'voucher_source_conflict' });
});
test('accepted sold voucher replay uses frozen cents/profile and permits collecting its existing debt', async () => {
  let catalogueReads = 0, writes = 0, collections = 0;
  const receipt = { id: 5, public_id: 'sold-budget', clinic_id: 72, patient_id: 8, status: 'accepted', current_version: 1, accepted_amount: 140 };
  const frozen = { key: 'voucher-synthetic', treatment_id: 42, name: 'Original name', description: 'Original notes', quantity: 6, unit_price: 23.33, total: 139.98,
    product_type: 'voucher', price_snapshot: { schema_version: 1, source: { kind: 'treatment', id: 42 }, profile: { schema_version: 1, price_semantics: 'gross_tax_included', tax_percent: 21, exemption_reason: null } } };
  const version = { lines: [frozen], version_number: 1 };
  const voucher = { id: 10, treatment_id: 42, sold_amount: 140, setDataValue() {} };
  const context = { clinicId: 72, clinic: { id_clinica: 72 }, patient: { id_paciente: 8 } };
  const historicalPayment = { id: 'existing-payment', amount: 140, status: 'confirmed' };
  let existingPayment = historicalPayment;
  const sell = fn('sellVoucher', { loadContext: async () => context, optionalPositiveInteger: Number, roundMoney: Number, numberValue: Number,
    resolveCatalogItemForClinic: async () => { catalogueReads++; throw Error('must not consult current catalogue'); },
    EconomicBudget: { findOne: async () => receipt }, EconomicBudgetVersion: { findOne: async () => version },
    PatientVoucher: { findOne: async () => voucher }, PatientVoucherMovement: { findAll: async () => [] },
    EconomicPayment: { findOne: async () => existingPayment },
    serializeBudget: (b, v) => ({ id: b.public_id, status: b.status, accepted_amount: b.accepted_amount, current: v }),
    serializeVoucher: v => v, serializePayment: p => p,
    createBudget: async () => { writes++; throw Error('must not reconstruct purchase'); },
    createPayment: async args => { collections++; assert.equal(args.payload.amount, 140); return { amount: 140 }; } });
  const args = { clinicId: 72, payload: { treatment_id: 42, sale_reference: 'synthetic', collect_now: true } };
  let result = await sell(args); assert.equal(result.payment, historicalPayment); assert.equal(collections, 0);
  assert.equal(result.budget.accepted_amount, 140); assert.equal(result.budget.current.lines[0].unit_price, 23.33);
  assert.equal(result.budget.current.lines[0].price_snapshot.profile.tax_percent, 21);
  existingPayment = null; result = await sell(args); assert.equal(collections, 1); assert.equal(result.payment.amount, 140);
  assert.equal(catalogueReads, 0); assert.equal(writes, 0); assert.equal(voucher.sold_amount, 140);
  await assert.rejects(sell({ ...args, payload: { ...args.payload, treatment_id: 99 } }), { code: 'voucher_request_conflict' });
  context.patient.id_paciente = 99; await assert.rejects(sell(args), { code: 'budget_source_conflict' });
});
