'use strict';

const prices = require('./economicPriceProfile');
const parse = (value, fallback) => typeof value === 'string' ? JSON.parse(value) : value ?? fallback;
const invalid = () => Object.assign(new Error('Revisa los importes y conceptos del presupuesto antes de aceptarlo.'), {
  code: 'budget_acceptance_amount_invalid', statusCode: 422,
});
function cents(value) {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === ''
    || !Number.isFinite(Number(value)) || Number(value) < 0) throw invalid();
  const amount = Math.round((Number(value) + Number.EPSILON) * 100);
  if (!Number.isSafeInteger(amount) || amount > 1e12) throw invalid();
  return amount;
}

function discountedAmount(amount, percent = 0) {
  const rate = Number(percent);
  if (!['number', 'string'].includes(typeof percent) || String(percent).trim() === ''
    || !Number.isFinite(rate) || rate < 0 || rate > 100 || Math.round(rate * 100) / 100 !== rate) throw invalid();
  // Basis points and integer cents avoid half-cent floating point errors.
  const numerator = BigInt(cents(amount)) * BigInt(10000 - Math.round(rate * 100));
  return Number((numerator + 5000n) / 10000n) / 100;
}

function acceptedAmount(version, acceptedLineKeys, paymentMode = null) {
  const lines = parse(version.lines, []), totals = parse(version.totals, {});
  if (!Array.isArray(acceptedLineKeys)) throw invalid();
  const keys = new Set(acceptedLineKeys);
  if (!Array.isArray(lines) || !lines.length || !keys.size || lines.length > 500) throw invalid();
  const available = new Set(lines.map(line => line.key));
  if (available.size !== lines.length || [...keys].some(key => !available.has(key))) throw invalid();
  const total = cents(totals.total) / 100;
  const proposal = parse(version.payment_proposal, {});
  let quoted = total;
  if (paymentMode && paymentMode !== 'patient_choice') {
    let stored;
    if (paymentMode === 'single') stored = proposal.single_payment?.amount;
    if (paymentMode === 'clinic_installments') stored = proposal.clinic_installments?.amount;
    if (paymentMode === 'patient_balance') stored = proposal.balance_application?.option_amount;
    if (paymentMode === 'external_financing') {
      const amounts = (proposal.financing_options || []).map(option => option.option_amount).filter(value => value != null);
      if (new Set(amounts.map(cents)).size > 1) throw invalid();
      stored = amounts[0];
    }
    // A saved offer owns its cents, including an older rounding convention.
    quoted = stored == null ? discountedAmount(total, proposal.option_discounts?.[paymentMode] ?? 0) : cents(stored) / 100;
    if (quoted > total) throw invalid();
  }
  // Allocate the chosen stored offer once, including residual cents, across
  // its concepts. Never reprice against today's treatment catalog.
  return prices.budgetBreakdown(lines, quoted).lines.filter(line => keys.has(line.key))
    .reduce((sum, line) => sum + cents(line.gross_after_global_discount), 0) / 100;
}

function payableAmount(budget, version) {
  return cents(['accepted', 'partially_accepted'].includes(budget.status) || Number(budget.accepted_amount) > 0
    ? budget.accepted_amount : parse(version?.totals, {}).total) / 100;
}

module.exports = { acceptedAmount, discountedAmount, payableAmount };
