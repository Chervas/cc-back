'use strict';

const { OPERATIONS } = require('./ai-limits');
const contract = require('./ai-contract');
const { fail } = require('./errors');
function createAiOperations({ http }) {
  return Object.fromEntries(Object.entries(OPERATIONS).map(([provider, operation]) => [operation, {
    provider: `ai_${provider}`, persistResult: false,
    validate: value => contract.validate(provider, value),
    authorize: input => contract.authorize(provider, input),
    async execute({ payload, binding, secret, signal, assertActive }) {
      assertActive();
      return http({ provider, payload, binding, token: secret, signal });
    },
    project(value) {
      // Preserve model output, references and usage; the broker never persists this content.
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('provider_failed');
      return value;
    },
  }]));
}
module.exports = { createAiOperations };
