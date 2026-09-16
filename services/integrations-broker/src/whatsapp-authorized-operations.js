'use strict';
const C = require('./whatsapp-authorized-contract'); const { fail } = require('./errors');
function createWhatsappAuthorizedOperations({ http, secrets, registry }) {
  if (typeof http !== 'function' || typeof secrets?.proof !== 'function' || typeof registry?.assert !== 'function') fail('invalid_request');
  return Object.freeze({
    ...require('./whatsapp-template-management').operations({ http, secrets, registry }),
    [C.SEND]: Object.freeze({
      provider: C.PROVIDER, effect: 'write', persistResult: true, validate: C.validateSend,
      authorize: input => registry.authorize(input),
      async execute({ payload, binding, secret, signal, assertActive }) {
        const value = registry.assert(binding); const message = structuredClone(C.validateSend(payload).message);
        if (payload.authorizationId !== value.definition.authorizationId || payload.phoneId !== value.definition.phoneId) fail('scope_denied');
        // Template approval belongs to Meta and the normal CRM catalog. The
        // broker protects credentials and tenant/phone scope, without a second
        // template allowlist, content fingerprint or provider GET before POST.
        if (signal?.aborted) fail('provider_timeout'); assertActive(); registry.assert(binding);
        const result = await http({ action: 'send', id: value.definition.phoneId, token: secret,
          proof: secrets.proof(secret, binding.connectionRef), json: message, signal });
        assertActive(); registry.assert(binding); return C.projectResult(result);
      },
      project: C.projectResult,
    }),
    [C.REVOKE]: Object.freeze({ provider: C.PROVIDER, control: 'revoke_asset',
      validate(payload) { if (!C.keys(payload, [])) fail('invalid_request'); },
      authorize: input => registry.authorize(input),
    }),
  });
}
module.exports = { createWhatsappAuthorizedOperations };
