'use strict';

// Pure, server-owned fiscal projection. Inputs are persisted budget versions,
// acceptance events and payment allocations, NEVER request price snapshots.
const prices = require('./economicPriceProfile');
const parse = (value, fallback) => typeof value === 'string' ? JSON.parse(value) : value ?? fallback;
const fail = (code, message) => { throw Object.assign(new Error(message), { statusCode: 422, code }); };
const cents = value => {
  const number = Number(value), result = Math.round((number + Number.EPSILON) * 100);
  if (!Number.isFinite(number) || number < 0 || !Number.isSafeInteger(result) || result > 1e12) {
    fail('fiscal_source_amount_invalid', 'El importe a documentar no es válido.');
  }
  return result;
};
const sum = values => values.reduce((total, value) => total + value, 0);

function allocate(total, weights) {
  const available = sum(weights);
  if (total > available) fail('fiscal_source_amount_exceeded', 'El importe supera la parte pendiente de documentar.');
  const exact = weights.map(weight => available ? total * (weight / available) : 0);
  const result = exact.map(Math.floor);
  const order = exact.map((value, index) => ({ index, remainder: value - result[index] }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  let remaining = total - sum(result);
  for (const row of order) { if (!remaining) break; result[row.index]++; remaining--; }
  return result;
}

function buildSource({ version, acceptance = null, payment = null }) {
  const all = parse(version?.lines, []);
  if (!all.some(line => line.price_snapshot)) return null; // Existing unclassified catalog semantics.
  if (!all.length || all.length > 500) fail('fiscal_source_lines_invalid', 'Revisa los conceptos del presupuesto.');
  const metadata = parse(acceptance?.metadata, {});
  const keys = metadata.accepted_line_keys;
  if (!acceptance || !Array.isArray(keys) || !keys.length || Number(acceptance.version_number) !== Number(version.version_number)) {
    fail('fiscal_source_acceptance_required', 'Acepta el presupuesto antes de documentar sus precios finales.');
  }
  const selected = new Set(keys);
  const lines = all.filter(line => selected.has(line.key));
  if (selected.size !== lines.length || lines.some(line => !line.price_snapshot)) {
    fail('fiscal_source_profile_pending', 'Falta confirmar el impuesto de algún concepto aceptado. Revisa el presupuesto.');
  }
  const accepted = Number(metadata.accepted_amount);
  if (metadata.accepted_amount == null || !cents(accepted)) fail('fiscal_source_amount_invalid', 'Falta el importe aceptado del presupuesto.');
  const breakdown = prices.budgetBreakdown(lines, accepted);
  let rows = breakdown.lines.map((row, index) => ({
    key: row.key, description: lines[index].name,
    profile: prices.normalizeProfile(lines[index].price_snapshot.profile),
    total: row.total, taxable_base: row.taxable_base, tax_amount: row.tax_amount,
  }));
  if (payment) {
    const allocations = parse(payment.application, {}).allocations;
    if (!Array.isArray(allocations) || !allocations.length || allocations.length > 500) {
      fail('fiscal_payment_allocation_required', 'Revisa a qué conceptos corresponde este cobro antes de documentarlo.');
    }
    const amounts = new Map(rows.map(row => [row.key, 0]));
    let generic = 0;
    for (const item of allocations) {
      if (item.target_type === 'budget_line' && amounts.has(item.line_key)) {
        amounts.set(item.line_key, amounts.get(item.line_key) + cents(item.amount));
      } else if (item.target_type === 'budget') generic += cents(item.amount);
      else fail('fiscal_payment_allocation_required', 'Este cobro incluye saldo o conceptos sin asignación fiscal. Revisa su aplicación antes de documentarlo.');
    }
    if (sum([...amounts.values()]) + generic !== cents(payment.amount)) fail('fiscal_payment_allocation_required', 'La aplicación del cobro no coincide con el importe recibido.');
    if (generic && !prices.commonProfile(rows.map(row => row.profile))) {
      fail('fiscal_payment_mixed_tax_allocation_required', 'El cobro reúne conceptos con impuestos distintos. Asígnalo a los conceptos correspondientes antes de documentarlo.');
    }
    const remaining = rows.map(row => cents(row.total) - amounts.get(row.key));
    if (remaining.some(value => value < 0)) fail('fiscal_source_amount_exceeded', 'El cobro supera el importe de uno de sus conceptos.');
    const spread = allocate(generic, remaining);
    rows = rows.map((row, index) => ({ ...row,
      ...prices.breakdown((amounts.get(row.key) + spread[index]) / 100, row.profile),
    })).filter(row => row.total > 0);
  }
  return { schema_version: 1, budget_version: Number(version.version_number),
    source_amount: sum(rows.map(row => cents(row.total))) / 100, lines: rows };
}

function validateSource(source) {
  if (source?.schema_version !== 1 || !Number.isInteger(source.budget_version) || source.budget_version < 1
    || !Array.isArray(source.lines) || !source.lines.length || source.lines.length > 500) {
    fail('fiscal_source_snapshot_invalid', 'No se puede verificar el origen fiscal guardado.');
  }
  const keys = new Set();
  for (const row of source.lines) {
    if (!row.key || keys.has(row.key) || typeof row.description !== 'string' || !row.description.trim()
      || cents(row.taxable_base) + cents(row.tax_amount) !== cents(row.total)) {
      fail('fiscal_source_snapshot_invalid', 'No se puede verificar el origen fiscal guardado.');
    }
    prices.normalizeProfile(row.profile);
    keys.add(row.key);
  }
  if (sum(source.lines.map(row => cents(row.total))) !== cents(source.source_amount)) {
    fail('fiscal_source_snapshot_invalid', 'El origen fiscal guardado no conserva su importe.');
  }
}

function project(source, requestedAmount, previousLines = []) {
  validateSource(source);
  const used = new Map(source.lines.map(row => [row.key, { total: 0, base: 0, tax: 0 }]));
  for (const line of previousLines) {
    const record = used.get(line.source_line_key);
    if (!record || line.price_semantics !== prices.SEMANTICS) fail('fiscal_source_previous_review_required', 'Hay documentos anteriores cuyo desglose debe revisarse antes de continuar.');
    record.total += cents(line.total); record.base += cents(line.taxable_base); record.tax += cents(line.tax_amount);
  }
  const remaining = source.lines.map(row => {
    const record = used.get(row.key);
    const total = cents(row.total) - record.total, base = cents(row.taxable_base) - record.base, tax = cents(row.tax_amount) - record.tax;
    if (Math.min(total, base, tax) < 0 || base + tax !== total) fail('fiscal_source_amount_exceeded', 'El origen ya tiene importes documentados que deben revisarse.');
    return { total, base, tax };
  });
  const available = sum(remaining.map(row => row.total));
  const amount = requestedAmount == null ? available : cents(requestedAmount);
  if (!amount) fail('fiscal_source_amount_invalid', 'No queda importe pendiente de documentar.');
  const allocation = allocate(amount, remaining.map(row => row.total));
  const lines = source.lines.map((row, index) => {
    const gross = allocation[index], rest = remaining[index];
    // Remaining cents, including the final VAT rounding cent, are consumed
    // exactly once across partial documents. No repeated discount or added VAT.
    const base = rest.total ? Math.round(gross * (rest.base / rest.total)) : 0;
    return { key: row.key, source_line_key: row.key, description: row.description, quantity: 1,
      unit_price: gross / 100, discount_percent: 0, price_semantics: prices.SEMANTICS,
      tax_percent: row.profile.tax_percent, exemption_reason: row.profile.exemption_reason,
      taxable_base: base / 100, tax_amount: (gross - base) / 100, total: gross / 100 };
  }).filter(row => row.total > 0);
  return { lines, totals: { currency: 'EUR', taxable_base: sum(lines.map(row => cents(row.taxable_base))) / 100,
    taxes: sum(lines.map(row => cents(row.tax_amount))) / 100, total: amount / 100 },
  source_amount: source.source_amount, available_amount: available / 100,
  price_semantics: prices.SEMANTICS, source_version: source.budget_version };
}

module.exports = { buildSource, project, validateSource };
