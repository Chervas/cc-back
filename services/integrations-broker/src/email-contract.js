'use strict';

const Ajv = require('ajv');
const { fail } = require('./errors');
const L = require('./email-limits');
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const list = items => ({ type: 'array', uniqueItems: true, maxItems: 100, items });
const address = { type: 'string', minLength: 3, maxLength: 320, pattern: '^[^\\s<>@,;]+@[^\\s<>@,;]+\\.[^\\s<>@,;]+$' };
const header = { type: 'string', minLength: 1, maxLength: 512, pattern: '^[^\\r\\n\\x00]+$' };
const content = { type: 'string', maxLength: L.MAX_REQUEST_BYTES };
const outbox = { type: 'string', pattern: '^em_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' };
const check = new Ajv({ strict: true }).compile(object({
  outboxId: outbox, attempt: { type: 'integer', minimum: 1, maximum: 100 },
  timeoutMs: { type: 'integer', minimum: 1000, maximum: L.MAX_PROVIDER_TIMEOUT_MS },
  templateKey: { enum: L.TEMPLATES }, stream: { const: 'transactional' },
  recipientPolicy: { enum: ['allowlist', 'registered-account'] },
  to: address, from: header, replyTo: { anyOf: [header, { type: 'null' }] },
  configurationSet: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
  subject: { ...header, maxLength: 160 }, text: content, html: content,
}));
const bindingSchema = object({
  region: { const: L.REGION }, fromAddresses: { ...list(header), minItems: 1 },
  replyToAddresses: list(header), configurationSets: { ...list({ type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' }), minItems: 1 },
  templates: { ...list({ enum: L.TEMPLATES }), minItems: 1 }, recipientAllowlist: list(address),
  registeredAccountTemplates: list({ enum: L.AUTH_TEMPLATES }),
});
function validate(payload) {
  if (!check(payload) || payload.to !== payload.to.trim().toLowerCase()
    || !payload.text && !payload.html
    || Buffer.byteLength(JSON.stringify(payload)) + 2048 > L.MAX_REQUEST_BYTES) fail('invalid_request');
  return payload;
}
function authorize({ request, binding }) {
  const p = request.payload, b = binding.email;
  if (request.operation !== L.OPERATION || binding.provider !== L.PROVIDER || !b || b.region !== L.REGION
    || request.assetRef !== `email:${p.templateKey}` || !b.templates.includes(p.templateKey)
    || !b.fromAddresses.includes(p.from) || p.replyTo !== null && !b.replyToAddresses.includes(p.replyTo)
    || !b.configurationSets.includes(p.configurationSet)) fail('scope_denied');
  if (p.recipientPolicy === 'allowlist' ? !b.recipientAllowlist.includes(p.to)
    : !L.AUTH_TEMPLATES.includes(p.templateKey) || !b.registeredAccountTemplates.includes(p.templateKey)) fail('scope_denied');
}
function commandInput(p) {
  validate(p);
  return {
    FromEmailAddress: p.from, Destination: { ToAddresses: [p.to] }, ConfigurationSetName: p.configurationSet,
    Content: { Simple: { Subject: { Data: p.subject, Charset: 'UTF-8' }, Body: {
      Text: { Data: p.text, Charset: 'UTF-8' }, ...(p.html ? { Html: { Data: p.html, Charset: 'UTF-8' } } : {}),
    } } },
    EmailTags: [{ Name: 'stream', Value: p.stream }, { Name: 'template', Value: p.templateKey.replace(/\./g, '_') },
      { Name: 'cc_outbox', Value: p.outboxId }],
    ...(p.replyTo ? { ReplyToAddresses: [p.replyTo] } : {}),
  };
}
module.exports = { validate, authorize, commandInput, bindingSchema };
