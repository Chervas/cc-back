'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), { createRequire } = require('node:module');
const policy = require('../../lib/treatment-commercial-policy');
const financial = require('../../lib/economic-commercial-policy');
const prices = require('../../lib/economicPriceProfile');
const snapshots = require('../../lib/economicProgramSnapshot');
const { mergeClinicalConfig, catalogDto } = require('../../lib/treatment-catalog-contract');
const { validateCatalogResources } = require('../../lib/treatment-catalog-resources');
const treatment = (extra = {}) => ({ id_tratamiento: 42, origen: 'clinica', clinica_id: 72, grupo_clinica_id: null,
  activo: true, precio_base: null, clinical_config: { catalog_status: 'active', fiscal_mapping_pending: true,
    source_catalog: { row: 'synthetic' }, source_price: { mode: 'included', gross_amount: null }, commercial: { sale_mode: 'program_component_only' } }, ...extra });
const approved = () => { const value = treatment(); value.clinical_config = policy.approveComponent(value, { confirm: true, actorId: 7, now: new Date('2026-10-04T12:00:00Z') }); return value; };
const tax = rate => ({ schema_version: 1, price_semantics: 'gross_tax_included', tax_percent: rate, exemption_reason: rate ? null : 'Motivo sintético validado' });
const source = fs.readFileSync(require.resolve('../../services/patientEconomics.service'), 'utf8');
const serviceRequire = createRequire(require.resolve('../../services/patientEconomics.service'));
function serviceFunction(name, bindings = {}) {
  const declaration = new RegExp(`(?:^|\\n)(?:async )?function ${name}\\(`).exec(source);
  assert(declaration, name); const rest = source.slice(declaration.index + 1), end = rest.search(/\n(?:async )?function \w+/);
  return vm.runInNewContext(`${end < 0 ? rest : rest.slice(0, end)}\n${name}`, { require: serviceRequire, crypto: require('node:crypto'), ...bindings });
}

test('included NULL approval is authenticated, scope/identity/source bound, not a clinical or tax approval', async () => {
  const value = approved(); assert(policy.componentApproved(value));
  assert(policy.componentApproved({ toJSON: () => value }));
  assert.equal(value.precio_base, null); assert.equal(value.clinical_config.fiscal_mapping_pending, true);
  assert.equal(value.clinical_config.price_profile, undefined);
  const dto = catalogDto(value); assert.equal(dto.catalog_price.amount, null); assert.equal(dto.standalone_sellable, false);
  for (const changed of [{ precio_base: 0 }, { precio_base: '0' }, { id_tratamiento: 43 }, { clinica_id: 73 }, { origen: 'grupo', grupo_clinica_id: 9 }]) assert.equal(policy.componentApproved({ ...value, ...changed }), false);
  const invalid = structuredClone(value); invalid.clinical_config.source_price.mode = 'fixed'; assert.equal(policy.componentApproved(invalid), false);
  await validateCatalogResources(value, {}); // No clinical resources are invented by the commercial approval.
  await assert.rejects(validateCatalogResources(treatment(), {}), { code: 'component_approval_required' });
  for (const actorId of [null, undefined, 0, 'invalid']) assert.throws(() => policy.approveComponent(treatment(), { confirm: true, actorId }), { code: 'component_actor_required' });
  assert.throws(() => policy.approveComponent(treatment(), { confirm: 'true', actorId: 7 }), { code: 'component_confirmation_invalid' });
  assert.throws(() => policy.approveComponent(treatment({ precio_base: 0 }), { confirm: true, actorId: 7 }), { code: 'component_standalone_price_forbidden' });
  const fixed = treatment(); fixed.clinical_config.source_price = { mode: 'fixed', gross_amount: 90 };
  assert.throws(() => policy.approveComponent(fixed, { confirm: true, actorId: 7 }), { code: 'component_import_source_invalid' });
});
test('HTTP merge cannot inject, replace or clear review/provenance; notes do not classify fiscal purpose', () => {
  const value = approved(), original = value.clinical_config;
  const merged = mergeClinicalConfig(original, { commercial: { sale_mode: 'program_component_only', component_review: { approved_by: 999 } }, notes: 'therapeutic', source_price: { mode: 'fixed', gross_amount: 1 } });
  assert.deepEqual(merged.commercial.component_review, original.commercial.component_review);
  assert.deepEqual(merged.source_price, original.source_price); assert.equal(merged.price_profile, undefined);
  assert.equal(mergeClinicalConfig(null, { commercial: { sale_mode: 'program_component_only', component_review: original.commercial.component_review } }).commercial.component_review, undefined);
  assert.throws(() => policy.assertNoClientImportEvidence(null, { source_price: { mode: 'included' } }), { code: 'component_import_source_untrusted' });
  assert.doesNotThrow(() => policy.assertNoClientImportEvidence(original, { source_price: null }));
  const invalid = structuredClone(value); invalid.clinical_config.commercial.component_review.approved_by = 0; assert.equal(policy.componentApproved(invalid), false);
  const clone = { ...value, id_tratamiento: 99 }; assert.equal(policy.componentApproved(clone), false);
});
test('all individual economic aliases and client price overrides remain blocked, including draft preserved refs', async () => {
  const resolveTreatments = async () => new Map([[42, approved()]]);
  for (const product_type of ['treatment', 'pack', 'voucher']) for (const reference of [{ treatment_id: 42 }, { catalogoId: 42 }]) for (const unit_price of [0, 90]) {
    await assert.rejects(financial.assertCommercialLines([{ ...reference, product_type, unit_price }], { resolveTreatments, selling: false }), { code: 'treatment_program_component_only' });
  }
  await assert.rejects(financial.assertCommercialLines([{ treatment_id: 42 }], { resolveTreatments: async () => new Map() }), { code: 'budget_treatment_unavailable' });
  let reads = 0; await financial.assertCommercialLines([{ treatment_id: 42 }], { historicalPurchase: true, resolveTreatments: () => { reads++; } }); assert.equal(reads, 0);
});
test('NULL is undefined, explicit zero is free; no unit price alias silently becomes zero', () => {
  const bindings = { economicPrices: prices, roundMoney: n => Math.round(Number(n) * 100) / 100,
    domainError: (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code }), cleanString: v => String(v || '').trim(),
    optionalPositiveInteger: v => Number(v) || null, PRODUCT_TYPES: new Set(['treatment', 'voucher', 'pack']), cloneJson: structuredClone };
  const normalize = serviceFunction('normalizeLine', bindings);
  for (const alias of ['unit_price', 'precio_unitario', 'precioUnitario']) for (const blank of [null, '', '   ', '\t', false, true, {}, [], 'abc', NaN, Infinity]) assert.throws(() => normalize({ name: 'Synthetic', quantity: 1, [alias]: blank }, 0), { code: 'budget_line_price_invalid' });
  assert.equal(normalize({ name: 'Synthetic free', quantity: 1, unit_price: 0 }, 0).unit_price, 0);
});
test('programme own fiscal profile wins over NULL/mixed components and freezes one gross financial concept', async () => {
  const definition = { id: 'synthetic-program', version: 3, kind: 'program', status: 'active', total_price: 690, name: 'Synthetic', price_profile: tax(21), summary: { issues: [] },
    appointments: [0, null].map((offset_days, i) => ({ key: `a${i}`, label: 'Visit', offset_days, treatment_ids: [42], duration_minutes: 30,
      treatments: [{ id: 42, name: 'Included', duration_minutes: 30, sale_mode: 'program_component_only', price_profile: i ? tax(0) : null, booking_profile: {} }] })) };
  const [line] = await snapshots.resolveLines([{ key: 'p', program_id: definition.id, program_version: 3, unit_price: 690, quantity: 1, price_profile: tax(0) }], { integrationEnabled: true, resolve: async () => definition });
  assert.equal(line.program_snapshot.price_profile.tax_percent, 21); assert.equal(line.program_snapshot.price_profile_source, 'program');
  const resolver = async () => new Map([[42, approved()]]);
  await financial.assertCommercialLines([line], { resolveTreatments: resolver });
  const fiscal = await prices.resolveBudgetPriceProfiles([line], { resolveTreatments: resolver });
  const split = prices.budgetBreakdown(fiscal.map(l => ({ ...l, total: 690 })), 690);
  assert.equal(split.total, 690); assert.equal(split.tax_base, 570.25); assert.equal(split.taxes, 119.75);
  const frozen = structuredClone(line.program_snapshot); definition.price_profile = tax(0);
  const [preserved] = await snapshots.resolveLines([{ ...line, price_profile: tax(0) }], { integrationEnabled: true, previousLines: [line], resolve: () => { throw Error('must not reprice'); } });
  assert.deepEqual(preserved.program_snapshot, frozen);
  const missing = { ...definition, price_profile: null };
  const [draft] = await snapshots.resolveLines([{ key: 'p', program_id: missing.id, program_version: 3, unit_price: 690, quantity: 1 }], { integrationEnabled: true, resolve: async () => missing });
  await financial.assertCommercialLines([draft], { resolveTreatments: resolver, selling: false });
  await assert.rejects(financial.assertCommercialLines([draft], { resolveTreatments: resolver }), { code: 'program_price_profile_required' });
});
test('scoped bulk guard reads server rows and refuses foreign treatment even for preserved same-key lines', async () => {
  const { Op } = require('sequelize'), seen = [];
  const guard = serviceFunction('assertBudgetCommercial', { Op, commercialPolicy: financial, Clinica: {},
    Tratamiento: { findAll: async query => { seen.push(query); return [approved(), { ...approved(), id_tratamiento: 43, clinica_id: 999 }]; } },
    treatmentIsAvailableForClinic: (t, context) => t.clinica_id === context.clinicId,
    domainError: (statusCode, code) => Object.assign(new Error(code), { statusCode, code }) });
  await assert.rejects(guard([{ key: 'preserved', treatment_id: 43 }], { clinic: { id_clinica: 72 }, selling: false }), { code: 'budget_treatment_unavailable' });
  assert.equal(seen.length, 1); assert.equal(seen[0].where[Op.or][1].clinica_id, 72);
});
