'use strict';

const Ajv = require('ajv');
const VERSION = 'global-managed-v1';
const validateRequest = new Ajv().compile({
  type: 'object', additionalProperties: false, required: ['quote_version', 'investment', 'goal'],
  properties: {
    quote_version: { const: VERSION }, investment: { type: 'integer', minimum: 100, maximum: 50000 },
    goal: { type: 'string', minLength: 3, maxLength: 500 },
  },
});

function invalid(code) { return Object.assign(new Error(code), { code, httpStatus: 400 }); }

function globalManagedQuote(investment) {
  if (!Number.isSafeInteger(investment) || investment < 100 || investment > 50000) throw invalid('invalid_managed_investment');
  const media = investment * 100;
  const software = 14900;
  const management = media * 20 / 100;
  const reception = media * 50 / 100;
  const subtotal = software + media + management + reception;
  const minimumAdjustment = Math.max(0, 99900 - subtotal);
  // This versioned estimate is not an invoice, payment instruction or authority to launch.
  return { version: VERSION, currency: 'EUR', period: 'monthly', investment,
    software: software / 100, management: management / 100, reception: reception / 100,
    minimum_adjustment: minimumAdjustment / 100, total: (subtotal + minimumAdjustment) / 100,
    binding: false };
}

function globalManagedRequest(input) {
  if (!validateRequest(input) || input.goal.trim().length < 3) throw invalid('invalid_global_managed_request');
  return { goal: input.goal.trim(), quote: globalManagedQuote(input.investment) };
}

function publicRequestedQuote(value) {
  if (value?.version !== VERSION) return null;
  try { return globalManagedQuote(value.investment); } catch { return null; }
}

module.exports = { globalManagedQuote, globalManagedRequest, publicRequestedQuote };
