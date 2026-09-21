'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fiscal = require('../../lib/economicFiscalPriceSource');
const fs = require('node:fs');
const vm = require('node:vm');
const profile = rate => ({ schema_version: 1, price_semantics: 'gross_tax_included', tax_percent: rate,
  exemption_reason: rate === 0 ? 'Exención sintética de prueba' : null });
function line(key, total, rate = 21) {
  return { key, name: `Concepto ${key}`, treatment_id: Number(key), total,
    price_snapshot: { schema_version: 1, source: { kind: 'treatment', id: Number(key) }, profile: profile(rate) } };
}
function args(lines = [line('1', 145)], accepted = 145) {
  return { version: { version_number: 2, lines, totals: { total: accepted } },
    acceptance: { version_number: 2, metadata: { accepted_line_keys: lines.map(l => l.key), accepted_amount: accepted } } };
}
const payment = allocations => ({ amount: allocations.reduce((n, l) => n + l.amount, 0), application: { allocations } });

test('gross final price is split, never taxed a second time', () => {
  const result = fiscal.project(fiscal.buildSource(args()));
  assert.deepEqual(result.totals, { currency: 'EUR', taxable_base: 119.83, taxes: 25.17, total: 145 });
  assert.equal(result.lines[0].price_semantics, 'gross_tax_included');
  assert.equal(result.lines[0].unit_price, 145);
});
test('accepted amount owns global/selected discounts, partial acceptance excludes unaccepted concepts', () => {
  const input = args([line('1', 261), line('2', 70, 0)], 234.9);
  input.acceptance.metadata.accepted_line_keys = ['1'];
  const result = fiscal.project(fiscal.buildSource(input));
  assert.deepEqual(result.totals, { currency: 'EUR', taxable_base: 194.13, taxes: 40.77, total: 234.9 });
  assert.deepEqual(result.lines.map(l => l.source_line_key), ['1']);
});
test('all partial documents conserve the original tax cents including the last cent', () => {
  const source = fiscal.buildSource(args());
  const first = fiscal.project(source, 50);
  const second = fiscal.project(source, 50, first.lines);
  const last = fiscal.project(source, null, [...first.lines, ...second.lines]);
  assert.equal(last.totals.total, 45);
  for (const [key, expected] of [['total', 14500], ['taxes', 2517], ['taxable_base', 11983]]) {
    assert.equal([first, second, last].reduce((n, p) => n + Math.round(p.totals[key] * 100), 0), expected);
  }
  assert.throws(() => fiscal.project(source, 46, [...first.lines, ...second.lines]), { code: 'fiscal_source_amount_exceeded' });
});
test('many tiny partials never lose or create a cent', () => {
  for (let n = 1; n <= 40; n++) {
    const input = args([line('1', n / 100), line('2', (n + 5) / 100, 0)], (2 * n + 5) / 100);
    const source = fiscal.buildSource(input), used = [];
    for (let i = 0; i < 2 * n + 5; i++) used.push(...fiscal.project(source, 0.01, used).lines);
    assert.equal(used.reduce((a, l) => a + Math.round(l.total * 100), 0), 2 * n + 5);
    assert.equal(used.reduce((a, l) => a + Math.round(l.tax_amount * 100), 0),
      source.lines.reduce((a, l) => a + Math.round(l.tax_amount * 100), 0));
  }
});
test('payment allocated to a homogeneous budget retains gross tax profile', () => {
  const input = { ...args(), payment: payment([{ target_type: 'budget', amount: 50 }]) };
  const result = fiscal.project(fiscal.buildSource(input));
  assert.equal(result.totals.total, 50); assert.equal(result.totals.taxes, 8.68);
});
test('mixed tax payment requires explicit concepts; never assigns a tax rate to wallet deposits', () => {
  const input = args([line('1', 145), line('2', 70, 0)], 215);
  assert.throws(() => fiscal.buildSource({ ...input, payment: payment([{ target_type: 'budget', amount: 50 }]) }),
    { code: 'fiscal_payment_mixed_tax_allocation_required' });
  const source = fiscal.buildSource({ ...input, payment: payment([
    { target_type: 'budget_line', line_key: '1', amount: 25 }, { target_type: 'budget_line', line_key: '2', amount: 25 },
  ]) });
  const result = fiscal.project(source);
  assert.equal(result.totals.total, 50); assert.equal(result.lines[1].tax_amount, 0);
  for (const allocation of [{ target_type: 'wallet', amount: 10 }, { target_type: 'budget_line', line_key: 'unknown', amount: 10 }]) {
    assert.throws(() => fiscal.buildSource({ ...input, payment: payment([allocation]) }), { code: 'fiscal_payment_allocation_required' });
  }
});
test('missing acceptance, stale version, mixed unknown or corrupt source fail closed', () => {
  const input = args();
  assert.equal(fiscal.buildSource({ version: { lines: [{ key: 'old', total: 145 }] } }), null);
  assert.throws(() => fiscal.buildSource({ ...input, acceptance: null }), { code: 'fiscal_source_acceptance_required' });
  assert.throws(() => fiscal.buildSource({ ...input, acceptance: { ...input.acceptance, version_number: 1 } }), { code: 'fiscal_source_acceptance_required' });
  const mixed = args([line('1', 145), { key: '2', total: 20 }], 165);
  assert.throws(() => fiscal.buildSource(mixed), { code: 'fiscal_source_profile_pending' });
  assert.throws(() => fiscal.project({ schema_version: 1, lines: [] }), { code: 'fiscal_source_snapshot_invalid' });
  const source = fiscal.buildSource(input);
  assert.throws(() => fiscal.project(source, -1), { code: 'fiscal_source_amount_invalid' });
  assert.throws(() => fiscal.project(source, 10, [{ key: '1', total: 50 }]), { code: 'fiscal_source_previous_review_required' });
});
test('snapshots survive MySQL JSON key order and explicit profiles do not infer tax exemptions', () => {
  const input = args([line('1', 70, 0)], 70);
  input.version.lines = JSON.stringify(input.version.lines);
  input.acceptance.metadata = JSON.stringify(input.acceptance.metadata);
  const source = fiscal.buildSource(input);
  const result = fiscal.project(JSON.parse(JSON.stringify(source)));
  assert.equal(result.totals.total, 70); assert.equal(result.totals.taxes, 0);
  assert.equal(result.lines[0].exemption_reason, 'Exención sintética de prueba');
  source.lines[0].profile.exemption_reason = null;
  assert.throws(() => fiscal.project(source), { code: 'price_profile_exemption_invalid' });
});

test('a configured program is one financial concept and its frozen profile owns the total', () => {
  const program = { key: 'program', name: 'Programa ficticio 6 sesiones', program_id: 'qa-program', program_version: 3,
    program_snapshot: { appointment_count: 6 }, quantity: 1, total: 620,
    price_snapshot: { schema_version: 1, source: { kind: 'program', id: 'qa-program', version: 3 }, profile: profile(21) } };
  const result = fiscal.project(fiscal.buildSource(args([program], 620)));
  assert.equal(result.lines.length, 1); assert.equal(result.totals.total, 620); assert.equal(result.totals.taxes, 107.6);
});

test('real PDF renderer uses persisted totals, labels gross prices, escapes exemption reasons and leaves legacy semantics', () => {
  const source = fs.readFileSync(require.resolve('../../services/economicDocumentPdf.service'), 'utf8');
  const code = source.slice(source.indexOf('function fiscalHtml('), source.indexOf('async function render('));
  const fiscalHtml = vm.runInNewContext(`${code}; fiscalHtml`, {
    parse: (v, fallback) => v || fallback, baseStyles: () => '', assetUrl: () => '',
    escapeHtml: v => String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    date: () => '21/09/2026', money: n => Number(n).toFixed(2),
  });
  const projection = fiscal.project(fiscal.buildSource(args()));
  const document = { document_type: 'receipt', number: 'QA', issuer_snapshot: { name: 'Clínica ficticia' },
    recipient_snapshot: { name: 'Paciente ficticio' }, ...projection };
  const html = fiscalHtml(document);
  assert.match(html, /Precio final/); assert.match(html, /IVA incluido/);
  for (const amount of ['119.83', '25.17', '145.00']) assert(html.includes(amount));
  assert(!html.includes('175.45'));
  const exempt = structuredClone(document); exempt.lines[0].exemption_reason = '<script>QA</script>';
  assert(fiscalHtml(exempt).includes('Exento: &lt;script&gt;QA&lt;/script&gt;'));
  const legacy = structuredClone(document); delete legacy.lines[0].price_semantics;
  assert(!fiscalHtml(legacy).includes('IVA incluido')); assert(!fiscalHtml(legacy).includes('Precio final'));
});
