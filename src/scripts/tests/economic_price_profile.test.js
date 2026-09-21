'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const prices = require('../../lib/economicPriceProfile');
const catalog = require('../../lib/treatment-catalog-contract');
const programs = require('../../lib/economicProgramSnapshot');
const profile = (rate = 21) => ({ schema_version: 1, price_semantics: 'gross_tax_included', tax_percent: rate, exemption_reason: rate ? null : 'Asistencia sanitaria exenta, art. 20.Uno.3 LIVA' });
const treatment = (id, priceProfile = profile()) => ({ id_tratamiento: id, clinical_config: { price_profile: priceProfile } });
const line = (id = 4, total = 145) => ({ key: `t${id}`, treatment_id: id, name: 'Tratamiento ficticio', quantity: 1, unit_price: total, total });
const resolver = async ids => new Map(ids.map(id => [id, treatment(id)]));
const resolved = async (lines = [line()], options = {}) => prices.resolveBudgetPriceProfiles(lines, { resolveTreatments: resolver, ...options });

test('explicit gross profile validates rate and exemption instead of inferring by specialty', () => {
  assert.equal(prices.normalizeProfile(null), null);
  assert.deepEqual(prices.normalizeProfile(profile()), profile());
  assert.deepEqual(prices.normalizeProfile(profile(0)), profile(0));
  for (const tax_percent of ['21', null, NaN, Infinity, -1, 101, 1.234]) assert.throws(() => prices.normalizeProfile({ ...profile(), tax_percent }), { code: 'price_profile_tax_invalid' });
  for (const raw of [{}, [], { ...profile(), schema_version: 2 }, { ...profile(), price_semantics: 'net' }]) assert.throws(() => prices.normalizeProfile(raw), { code: 'price_profile_invalid' });
  assert.throws(() => prices.normalizeProfile({ ...profile(0), exemption_reason: ' ' }), { code: 'price_profile_exemption_invalid' });
  assert.throws(() => prices.normalizeProfile({ ...profile(), exemption_reason: 'exento' }), { code: 'price_profile_exemption_invalid' });
  assert.equal(prices.profileFromTreatment({ disciplina: 'estetica', clinical_config: {} }), null);
});
test('catalog merge keeps older client configuration and validates explicit changes', () => {
  const previous = { source_price: { gross_amount: 145 }, fiscal_mapping_pending: true, price_profile: profile() };
  assert.deepEqual(catalog.mergeClinicalConfig(previous, { catalog_status: 'draft' }).price_profile, profile());
  assert.throws(() => catalog.mergeClinicalConfig(previous, { price_profile: { ...profile(0), exemption_reason: '' } }));
  assert.equal(catalog.mergeClinicalConfig(previous, { price_profile: null }).price_profile, undefined);
  assert.equal(catalog.catalogPrice({ precio_base: 145, clinical_config: { price_profile: profile() } }).label, 'IVA 21% incluido');
  assert.equal(catalog.catalogPrice({ precio_base: 145, clinical_config: previous }).review_required, true);
});
test('145 final splits to 119.83 plus 25.17, never 175.45 or 119.83 payable', () => {
  assert.deepEqual(prices.breakdown(145, profile()), { price_semantics: 'gross_tax_included', tax_percent: 21, exemption_reason: null, taxable_base: 119.83, tax_amount: 25.17, total: 145 });
  assert.equal(prices.breakdown(620, profile()).total, 620);
  assert.equal(prices.breakdown(620, profile()).taxable_base, 512.4);
  assert.equal(prices.breakdown(0.03, profile()).tax_amount, 0.01);
  assert.equal(prices.breakdown(0, profile()).total, 0);
  assert.equal(prices.breakdown(70, profile(0)).tax_amount, 0);
  for (const value of [NaN, Infinity, -1, '145', 1e20]) assert.throws(() => prices.breakdown(value, profile()), { code: 'price_amount_invalid' });
});
test('program inherits only an identical explicitly configured profile for every included treatment', () => {
  assert.deepEqual(prices.commonProfile([profile(), profile()]), profile());
  for (const profiles of [[], [null], [profile(), null], [profile(), profile(0)]]) assert.equal(prices.commonProfile(profiles), null);
});
test('budget ignores forged client fiscal fields and resolves catalog in one unique bulk read', async () => {
  let calls = 0;
  const result = await resolved([{ ...line(), price_snapshot: { forged: true }, price_profile: profile(0), tax_percent: 0, price_semantics: 'net' }, { ...line(), key: 'second' }], {
    resolveTreatments: async ids => { calls++; assert.deepEqual(ids, [4]); return resolver(ids); },
  });
  assert.equal(calls, 1); assert.deepEqual(result[0].price_snapshot.profile, profile());
  assert.equal(result[0].price_profile, undefined); assert.equal(result[0].tax_percent, undefined); assert.equal(result[0].unit_price, 145);
  assert.notEqual(result[0].price_snapshot, result[1].price_snapshot);
});
test('changing catalog later never changes the saved fiscal policy of a budget line', async () => {
  const previousLines = await resolved();
  const result = await resolved([{ ...line(), notes: 'edición', price_snapshot: { forged: true } }], { previousLines, resolveTreatments: async () => { throw Error('must not reload'); } });
  assert.deepEqual(result[0].price_snapshot, previousLines[0].price_snapshot);
  result[0].price_snapshot.profile.tax_percent = 10;
  assert.equal(previousLines[0].price_snapshot.profile.tax_percent, 21);
});
test('old unclassified budgets remain unclassified and manual lines cannot inject profiles', async () => {
  const [legacy] = await resolved([line()], { previousLines: [line()], resolveTreatments: async () => { throw Error('must not reload'); } });
  assert.equal(legacy.price_snapshot, undefined);
  const [manual] = await resolved([{ ...line(), treatment_id: null, price_snapshot: { profile: profile() } }]);
  assert.equal(manual.price_snapshot, undefined);
});
test('new reference must be available in the scoped catalog and imported fiscal review is not bypassable', async () => {
  await assert.rejects(resolved([line()], { resolveTreatments: async () => new Map() }), { code: 'budget_treatment_unavailable' });
  await assert.rejects(resolved([line()], { resolveTreatments: async () => new Map([[4, { ...treatment(4), clinical_config: { price_profile: profile(), fiscal_mapping_pending: true } }]]) }), { code: 'imported_treatment_fiscal_review_pending' });
  const previousLines = await resolved();
  const [next] = await resolved([line(5)], { previousLines });
  assert.equal(next.price_snapshot.source.id, 5);
  await assert.rejects(resolved([line(), line()]), { code: 'budget_duplicate_line_key' });
});
test('tampered persisted fiscal references fail closed instead of attributing another treatment tax policy', async () => {
  const previousLines = await resolved(); previousLines[0].price_snapshot.source.id = 999;
  await assert.rejects(resolved([line()], { previousLines }), { code: 'budget_price_snapshot_invalid' });
});
test('MySQL reordered JSON keys preserve treatment and program snapshot identities', async () => {
  const previousLines = await resolved();
  previousLines[0].price_snapshot.source = { id: 4, kind: 'treatment' };
  const [result] = await resolved([line()], { previousLines });
  assert.equal(result.price_snapshot.profile.tax_percent, 21);
  assert.equal(prices.budgetBreakdown(previousLines, 145).taxes, 25.17);
  const program = { schema_version: 1, source: { version: 3, id: 'program', kind: 'program' }, profile: profile() };
  assert.equal(prices.normalizeSnapshot(program, { kind: 'program', id: 'program', version: 3 }).source.version, 3);
  assert.throws(() => prices.normalizeSnapshot(program, { kind: 'program', id: 'program', version: 4 }), { code: 'budget_price_snapshot_invalid' });
});
test('global discount allocation preserves every cent before splitting mixed tax rates', async () => {
  const lines = await resolved([line(4, 145), line(5, 70)], { resolveTreatments: async () => new Map([[4, treatment(4)], [5, treatment(5, profile(0))]]) });
  const result = prices.budgetBreakdown(lines, 193.5);
  assert.equal(result.total, 193.5); assert.equal(result.tax_breakdown_status, 'complete');
  assert.deepEqual(result.lines.map(l => l.gross_after_global_discount), [130.5, 63]);
  assert.equal(result.tax_base, 170.85); assert.equal(result.taxes, 22.65);
  const pennies = await resolved([line(1, 0.03), line(2, 0.03), line(3, 0.03)]);
  const pennyResult = prices.budgetBreakdown(pennies, 0.08);
  assert.deepEqual(pennyResult.lines.map(l => l.total), [0.03, 0.03, 0.02]);
  assert.equal(pennyResult.tax_base + pennyResult.taxes, pennyResult.total);
});
test('legacy amounts are labelled unclassified, never silently certified exempt', async () => {
  const known = await resolved();
  const result = prices.budgetBreakdown([...known, line(5, 70)], 215);
  assert.equal(result.tax_breakdown_status, 'partial');
  assert.equal(result.lines[1].tax_amount, null); assert.equal(result.lines[1].taxable_base, null);
  assert.equal(result.tax_base, 189.83); assert.equal(result.taxes, 25.17);
  assert.equal(prices.budgetBreakdown([line()], 145).tax_breakdown_status, 'unclassified');
  assert.throws(() => prices.budgetBreakdown(known, 200), { code: 'budget_tax_total_invalid' });
});
test('cent reconciliation holds across many amounts, discounts and configured rates', async () => {
  for (let n = 1; n <= 120; n++) {
    const lines = await resolved([line(1, n * 1.27), line(2, n * 0.31), line(3, n * 0.43)]);
    const total = Math.round(lines.reduce((sum, l) => sum + Math.round(l.total * 100), 0) * 0.87) / 100;
    const result = prices.budgetBreakdown(lines, total);
    assert.equal(Math.round((result.tax_base + result.taxes) * 100), Math.round(total * 100));
    assert.equal(result.lines.reduce((sum, l) => sum + Math.round(l.total * 100), 0), Math.round(total * 100));
    for (const l of result.lines) assert.equal(Math.round((l.taxable_base + l.tax_amount) * 100), Math.round(l.total * 100));
  }
});

const serviceSource = fs.readFileSync(require.resolve('../../services/patientEconomics.service'), 'utf8');
function serviceFunction(name, bindings = {}) {
  const start = serviceSource.search(new RegExp(`\n(?:async )?function ${name}\\(`));
  assert(start >= 0);
  const rest = serviceSource.slice(start + 1), next = rest.search(/\n(?:async )?function \w+/);
  return vm.runInNewContext(`${next >= 0 ? rest.slice(0, next) : rest}; ${name}`, bindings);
}
test('actual budget calculator preserves gross totals and records backend tax breakdown', async () => {
  const bindings = { economicPrices: prices, roundMoney: n => Math.round((Number(n) + Number.EPSILON) * 100) / 100,
    domainError: (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code }),
    cleanString: v => String(v || '').trim(), optionalPositiveInteger: v => Number(v) || null,
    PRODUCT_TYPES: new Set(['treatment', 'voucher', 'pack']), cloneJson: structuredClone,
  };
  bindings.normalizeLine = serviceFunction('normalizeLine', bindings);
  const calculate = serviceFunction('calculateBudgetPayload', bindings);
  const lines = await resolved([{ ...line(), quantity: 2, discount_percent: 10 }]);
  const result = calculate({ lines, global_discount_percent: 10 });
  assert.equal(result.totals.subtotal, 261); assert.equal(result.totals.total, 234.9);
  assert.equal(result.totals.tax_base, 194.13); assert.equal(result.totals.taxes, 40.77);
  assert.equal(result.lines[0].price_snapshot.profile.tax_percent, 21);
  const legacy = calculate({ lines: [line()] });
  assert.equal(legacy.totals.total, 145); assert.equal(legacy.totals.taxes, 0);
  assert.equal(legacy.totals.tax_breakdown_status, 'unclassified');
});
test('program snapshot freezes common fiscal profile and client cannot change it', async () => {
  const definition = { id: 'program-test', version: 1, kind: 'program', name: 'Programa ficticio', status: 'active', total_price: 620,
    summary: { issues: [], appointment_count: 2 }, appointments: [0, 3].map((offset_days, i) => ({ key: `a${i}`, offset_days, treatment_ids: [4],
      treatments: [{ id: 4, name: 'Tratamiento', booking_profile: {}, price_profile: profile() }] })) };
  const raw = { key: 'p', program_id: definition.id, program_version: 1, quantity: 1, unit_price: 620 };
  const resolvedPrograms = await programs.resolveLines([raw], { resolve: async () => definition, integrationEnabled: true });
  const [result] = await resolved(resolvedPrograms);
  assert.deepEqual(result.price_snapshot.profile, profile()); assert.equal(result.unit_price, 620);
  definition.appointments[1].treatments[0].price_profile = profile(0);
  assert.equal(programs.snapshot(definition).price_profile, null);
  assert.deepEqual(result.price_snapshot.profile, profile());
  // Fiscal issuance remains closed until the fiscal-document consumer also
  // handles gross values. A prepared budget profile alone must not open it.
  assert.throws(() => programs.assertFiscalReady({ lines: [result], status: 'issued' }), { code: 'program_fiscal_configuration_pending' });
});
