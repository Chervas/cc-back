'use strict';

const crypto = require('node:crypto');
const parse = (value, fallback = {}) => {
  try {
    const decoded = typeof value === 'string' ? JSON.parse(value) : value;
    return decoded && typeof decoded === 'object' && !Array.isArray(decoded) ? decoded : fallback;
  } catch { return fallback; }
};
const cents = value => Math.round((Number(value) + Number.EPSILON) * 100);
const approvalStatuses = new Set(['pending_approval', 'approved', 'rejected']);
const fail = (code, message, statusCode = 400) => { throw Object.assign(new Error(message), { code, statusCode }); };
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function hash(value) { return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
function command(payload) {
  const fields = ['expected_version', 'expected_financing_revision', 'idempotency_key', 'approval_status', 'financed_amount', 'reference', 'notes'];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => !fields.includes(key))) fail('financing_invalid', 'Revisa el seguimiento de financiación.');
  if (!Number.isSafeInteger(payload.expected_version) || payload.expected_version < 1
    || !Number.isSafeInteger(payload.expected_financing_revision) || payload.expected_financing_revision < 0) fail('financing_version_required', 'Actualiza el presupuesto antes de guardar el seguimiento.', 428);
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(payload.idempotency_key || '')) fail('financing_request_required', 'Falta la identidad de esta actualización.');
  if (!approvalStatuses.has(payload.approval_status)) fail('financing_approval_invalid', 'Selecciona un estado de aprobación válido.');
  const amount = payload.financed_amount;
  if (amount != null && (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > 1e10 || Math.abs(amount * 100 - cents(amount)) > 0.00001)) fail('financing_amount_invalid', 'Indica un importe válido con un máximo de dos decimales.');
  if (payload.approval_status === 'approved' && amount == null) fail('financing_amount_required', 'Indica qué importe debe ingresar la financiera.');
  for (const [key, max] of [['reference', 120], ['notes', 2000]]) if (payload[key] != null && (typeof payload[key] !== 'string' || payload[key].length > max)) fail('financing_text_invalid', 'Revisa la referencia y las observaciones.');
  return { expected_version: payload.expected_version, expected_financing_revision: payload.expected_financing_revision,
    idempotency_key: payload.idempotency_key, approval_status: payload.approval_status, financed_amount: amount == null ? null : cents(amount) / 100,
    reference: (payload.reference || '').trim(), notes: (payload.notes || '').trim() };
}
function summary(budget, version, events = [], payments = []) {
  if (!['accepted', 'partially_accepted'].includes(budget.status)) return null;
  const current = events.filter(event => Number(event.version_number ?? event.version) === Number(budget.current_version));
  const acceptance = [...current].reverse().find(event => ['accepted', 'partially_accepted'].includes(event.event_type));
  const metadata = parse(acceptance?.metadata);
  if (metadata.selected_payment_mode !== 'external_financing') return null;
  const changes = current.filter(event => event.event_type === 'financing_updated')
    .sort((left, right) => (Number(parse(left.metadata).revision) || 0) - (Number(parse(right.metadata).revision) || 0));
  const last = changes.at(-1), tracking = parse(last?.metadata);
  const legacy = String(metadata.financing_status || 'pending_approval');
  const approval = approvalStatuses.has(tracking.approval_status) ? tracking.approval_status
    : legacy === 'paid_by_finance' ? 'approved' : approvalStatuses.has(legacy) ? legacy : 'pending_approval';
  const proposal = parse(version?.payment_proposal);
  const option = (Array.isArray(proposal.financing_options) ? proposal.financing_options : []).find(item => item && Number(item.months) === Number(metadata.selected_financing_months)
    && (!metadata.financing_provider || item.provider === metadata.financing_provider));
  const accepted = cents(budget.accepted_amount), offered = option?.option_amount;
  // A partial acceptance does not tell us how much the lender approved. Offer
  // a default only when the complete persisted offer and entry are unambiguous.
  const proposed = option && offered != null && cents(offered) === accepted && Number.isFinite(Number(option.entry))
    && cents(option.entry) >= 0 && cents(option.entry) <= accepted ? Math.max(0, accepted - cents(option.entry)) / 100 : null;
  const expected = tracking.financed_amount == null ? null : cents(tracking.financed_amount);
  const received = payments.filter(payment => payment.status === 'confirmed' && payment.method === 'financing')
    .reduce((total, payment) => {
      const allocations = parse(payment.application).allocations;
      return total + (Array.isArray(allocations) ? allocations : [])
        .filter(allocation => allocation && ['budget', 'budget_line'].includes(allocation.target_type))
        .reduce((sum, allocation) => sum + cents(allocation.amount), 0);
    }, 0);
  return { revision: Number(tracking.revision) || 0, approval_status: approval, financed_amount: expected == null ? null : expected / 100,
    proposed_amount: proposed, received_amount: received / 100, pending_amount: expected == null ? null : Math.max(0, expected - received) / 100,
    payout_status: expected == null ? received > 0 ? 'recorded_unreconciled' : 'not_configured' : expected === 0 ? 'not_due'
      : received >= expected ? 'received' : received > 0 ? 'partial' : 'pending',
    reference: tracking.reference || null, notes: tracking.notes || null,
    provider: metadata.financing_provider || option?.provider || null, months: metadata.selected_financing_months || null,
    legacy_status: legacy === 'paid_by_finance' ? legacy : null,
    review_required: approval === 'rejected' && received > 0 || expected != null && received > expected,
    updated_at: last?.created_at || acceptance?.created_at || null, actor_id: last?.actor_id || acceptance?.actor_id || null };
}
module.exports = { command, hash, summary, fail };
