'use strict';

const { OPERATIONS } = require('./ai-limits');
const contract = require('./ai-contract');
const { fail } = require('./errors');
function createAiOperations({ http }) {
  return Object.fromEntries(Object.entries(OPERATIONS).map(([provider, operation]) => [operation, {
    provider: `ai_${provider}`, persistResult: false,
    validate: value => contract.validate(provider, value),
    authorize: input => contract.authorize(provider, input),
    async execute({ requestId, tenantRef, payload, binding, secret, signal, assertActive }) {
      assertActive();
      const data = await http({ provider, payload, binding, token: secret, signal, requestId, environment: tenantRef.slice('platform:'.length) });
      // A provider may echo its input. Capabilities must never reach UI, usage
      // telemetry or persisted model output, including escaped/encoded URLs.
      const serialized = JSON.stringify(data);
      for (const ref of contract.references(provider, payload)) {
        const token = ref.url.slice(ref.url.lastIndexOf('/') + 1);
        if (serialized.includes(token) || serialized.includes(encodeURIComponent(ref.url))) fail('provider_failed');
      }
      return data;
    },
    project(value) {
      // Preserve model output, references and usage; the broker never persists this content.
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('provider_failed');
      return value;
    },
  }]));
}
module.exports = { createAiOperations };
