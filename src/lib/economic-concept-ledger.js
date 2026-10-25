'use strict';
const crypto = require('node:crypto'), prices = require('./economicPriceProfile');
const parse = (value, fallback = {}) => typeof value === 'string' ? JSON.parse(value) : value ?? fallback;
const fail = (code, message, statusCode = 409, details) => { throw Object.assign(new Error(message), { code, statusCode, ...(details ? { details } : {}) }); };
const cents = value => { const result = Math.round((Number(value) + Number.EPSILON) * 100); if (!Number.isFinite(Number(value)) || !Number.isSafeInteger(result) || result < 0) fail('economic_amount_invalid', 'Revisa el importe.', 400); return result; };
const money = value => Number(value) / 100;
const stable = value => value instanceof Date ? value.toISOString() : Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, stable(value[key])])) : value;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
function key(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{8,120}$/.test(value)) fail('economic_request_key_required', 'Falta una identidad válida de la operación.', 400); return value; }
function allocate(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (total < 0 || total > sum) fail('economic_funding_exceeds_concept', 'El dinero aplicado supera el importe del concepto. Revisa su aplicación.');
  const values = weights.map(weight => sum ? total * weight / sum : 0), out = values.map(Math.floor);
  const order = values.map((value, i) => ({ i, remainder: value - out[i] })).sort((a, b) => b.remainder - a.remainder || a.i - b.i);
  for (let rest = total - out.reduce((a, b) => a + b, 0), i = 0; rest > 0; rest--, i++) out[order[i].i]++;
  return out;
}
function acceptedLines(budget, version, events) {
  const event = [...events].reverse().find(row => Number(row.version_number) === Number(version.version_number) && ['accepted', 'partially_accepted'].includes(row.event_type));
  if (!event && !['accepted', 'partially_accepted'].includes(budget.status)) return [];
  const metadata = parse(event?.metadata), source = parse(version.lines, []), keys = new Set(metadata.accepted_line_keys || (budget.status === 'accepted' ? source.map(line => line.key) : []));
  const lines = source.filter(line => line.accepted !== false && keys.has(line.key));
  if (!lines.length) return [];
  const amount = metadata.accepted_amount ?? budget.accepted_amount;
  const breakdown = prices.budgetBreakdown(lines, Number(amount)).lines;
  return lines.map((line, i) => ({ ...line, contracted_amount: Number(breakdown[i].gross_after_global_discount),
    profile: line.price_snapshot?.profile || null }));
}
function cancellationCommand(payload, preview = false) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('concept_cancel_invalid', 'Revisa la cancelación del concepto.', 400);
  const allowed = ['expected_version', 'units', 'settlement', 'reason', 'refund_method', ...(preview ? [] : ['expected_concept_revision', 'preview_hash', 'idempotency_key', 'confirmed'])];
  if (Object.keys(payload).some(field => !allowed.includes(field)) || !Number.isSafeInteger(payload.expected_version) || payload.expected_version < 1
    || !Number.isSafeInteger(payload.units) || payload.units < 1 || !['none', 'refund', 'wallet_credit'].includes(payload.settlement)
    || typeof payload.reason !== 'string' || !payload.reason.trim() || payload.reason.length > 1000) fail('concept_cancel_invalid', 'Indica las sesiones pendientes, el motivo y cómo resolver el dinero ya abonado.', 400);
  if (payload.settlement === 'refund' && !['cash', 'card', 'transfer', 'direct_debit', 'bizum', 'financing', 'insurance', 'other'].includes(payload.refund_method)) fail('concept_refund_method_required', 'Indica el medio de la devolución manual.', 400);
  if (!preview && (!Number.isSafeInteger(payload.expected_concept_revision) || payload.expected_concept_revision < 0 || !/^[a-f0-9]{64}$/.test(payload.preview_hash || '') || payload.confirmed !== true)) fail('concept_cancel_confirmation_required', 'Revisa y confirma expresamente la cancelación antes de guardarla.', 400);
  return { expected_version: payload.expected_version, units: payload.units, settlement: payload.settlement, reason: payload.reason.trim(), refund_method: payload.settlement === 'refund' ? payload.refund_method : null,
    ...(!preview ? { expected_concept_revision: payload.expected_concept_revision, preview_hash: payload.preview_hash, idempotency_key: key(payload.idempotency_key), confirmed: true } : {}) };
}
module.exports = { parse, fail, cents, money, hash, key, allocate, acceptedLines, cancellationCommand };
