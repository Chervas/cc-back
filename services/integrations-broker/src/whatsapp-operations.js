'use strict';
const C = require('./whatsapp-contract'); const { fail } = require('./errors');
function createWhatsappOperations({ http, secrets }) {
  const sends = Object.fromEntries(C.OPERATIONS.map(operation => [operation, Object.freeze({
    provider: C.PROVIDER, effect: 'write', persistResult: true,
    validate: payload => C.validate(operation, payload),
    authorize: ({ request, binding }) => C.authorize(binding, request),
    async execute({ payload, binding, assetRef, secret, signal, assertActive }) {
      const meta = C.bindingFor(binding); const template = C.authorize(binding, { assetRef, operation, payload });
      let json;
      if (template) {
        await secrets.withTemplateReader(binding, async reader => {
          const raw = await http({ action: 'template', id: template.id, token: reader,
            proof: secrets.proof(reader, binding.connectionRef, 'read'), signal });
          C.verifyTemplate(raw, template);
          return { verified: true };
        }, { signal });
        json = { messaging_product: 'whatsapp', recipient_type: 'individual', to: payload.to, type: 'template',
          template: { name: template.name, language: { code: template.language }, ...(payload.parameters.length ? {
            components: [{ type: 'body', parameters: payload.parameters.map(text => ({ type: 'text', text })) }],
          } : {}) } };
      } else json = { messaging_product: 'whatsapp', recipient_type: 'individual', to: payload.to, type: 'text',
        text: { body: payload.body, preview_url: payload.previewUrl } };
      if (signal.aborted) fail('provider_timeout');
      // A template lookup can await several external calls. Check durable
      // revocations again immediately before the write, including another
      // local operator process writing the same broker store.
      assertActive();
      return C.projectResult(await http({ action: 'send', id: meta.phoneId, token: secret,
        proof: secrets.proof(secret, binding.connectionRef, 'send'), json, signal }));
    },
    project(value) {
      if (!value || Object.keys(value).join(',') !== 'messageId' || typeof value.messageId !== 'string'
        || !/^wamid\.[A-Za-z0-9+/=_-]{2,512}$/.test(value.messageId)) fail('provider_failed');
      return { messageId: value.messageId };
    },
  })]));
  return Object.freeze({ ...sends, [C.REVOKE]: Object.freeze({ provider: C.PROVIDER, control: 'revoke_asset',
    validate: payload => C.validate(C.REVOKE, payload), authorize: ({ request, binding }) => C.authorize(binding, request) }) });
}
module.exports = { createWhatsappOperations };
