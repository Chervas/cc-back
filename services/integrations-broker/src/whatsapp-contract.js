'use strict';
const { createHash } = require('node:crypto');
const { schema } = require('./contracts'); const { fail } = require('./errors');
const PROVIDER = 'meta_whatsapp'; const COHORT = 'whatsapp-messaging-v1'; const GRAPH_VERSION = 'v24.0';
const TEXT = 'meta.whatsapp.text.send.v1'; const TEMPLATE = 'meta.whatsapp.template.send.v1';
const REVOKE = 'meta.whatsapp.phone.revoke.v1'; const OPERATIONS = Object.freeze([TEXT, TEMPLATE]);
const idSchema = { type: 'string', pattern: '^[1-9][0-9]{0,29}$' };
const pinSchema = { type: 'string', pattern: '^[A-Za-z0-9_-]{32,64}$' };
const hashSchema = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const object = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const templateSchema = object({ key: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,63}$' }, id: idSchema,
  name: { type: 'string', pattern: '^[a-z0-9_]{1,512}$' }, language: { type: 'string', pattern: '^[a-z]{2,3}(?:_[A-Z]{2})?$' },
  contentDigest: hashSchema, bodyParameters: { type: 'integer', minimum: 0, maximum: 20 } });
const bindingSchema = object({ appId: idSchema, subjectId: idSchema, readerSubjectId: idSchema, wabaId: idSchema, phoneId: idSchema,
  tokenVersionId: pinSchema, readerVersionId: pinSchema, appVersionId: pinSchema,
  templates: { type: 'array', maxItems: 100, items: templateSchema } });
const checkBinding = schema(bindingSchema.properties);
const to = { type: 'string', pattern: '^[1-9][0-9]{6,14}$' };
const checkText = schema({ to, body: { type: 'string', minLength: 1, maxLength: 4096 }, previewUrl: { type: 'boolean' } });
const checkTemplate = schema({ to, templateKey: templateSchema.properties.key,
  parameters: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 1024 } } });
const empty = schema({});
function bindingFor(binding) {
  if (binding?.provider !== PROVIDER) fail('scope_denied');
  const meta = checkBinding(binding.whatsapp);
  if (new Set(meta.templates.map(row => row.key)).size !== meta.templates.length
    || new Set(meta.templates.map(row => row.id)).size !== meta.templates.length
    || new Set(meta.templates.map(row => row.name + ':' + row.language)).size !== meta.templates.length) fail('invalid_request');
  return meta;
}
function validate(operation, payload) {
  if (operation === TEXT) return checkText(payload);
  if (operation === TEMPLATE) return checkTemplate(payload);
  if (operation === REVOKE) return empty(payload);
  fail('operation_denied');
}
function authorize(binding, request) {
  const meta = bindingFor(binding);
  if (request.assetRef !== 'wa-phone:' + meta.phoneId) fail('scope_denied');
  validate(request.operation, request.payload);
  if (request.operation === TEMPLATE) {
    const template = meta.templates.find(row => row.key === request.payload.templateKey);
    if (!template || template.bodyParameters !== request.payload.parameters.length) fail('operation_denied');
    return template;
  }
  return null;
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function templateProjection(raw) {
  if (!raw || typeof raw !== 'object' || raw.error || !Array.isArray(raw.components) || raw.components.length < 1 || raw.components.length > 3) fail('provider_failed');
  const projected = [];
  // Initial send cohort supports textual body parameters and static textual
  // header/footer. No buttons, media, flows or provider-discovered templates.
  for (const c of raw.components) {
    if (!c || !['BODY', 'HEADER', 'FOOTER'].includes(c.type) || typeof c.text !== 'string' || !c.text || c.text.length > 4096
      || Object.keys(c).some(key => !['type', 'text', 'format', 'example'].includes(key))
      || c.type === 'HEADER' && c.format !== 'TEXT' || c.type !== 'HEADER' && c.format !== undefined
      || c.type !== 'BODY' && /{{|}}/.test(c.text)) fail('provider_failed');
    projected.push({ type: c.type, text: c.text, ...(c.type === 'HEADER' ? { format: 'TEXT' } : {}) });
  }
  if (new Set(projected.map(c => c.type)).size !== projected.length || !projected.some(c => c.type === 'BODY')) fail('provider_failed');
  return projected;
}
function templateDigest(raw) { return createHash('sha256').update(canonical(templateProjection(raw))).digest('hex'); }
function verifyTemplate(raw, approved) {
  if (raw?.id !== approved.id || raw.name !== approved.name || raw.language !== approved.language || raw.status !== 'APPROVED'
    || templateDigest(raw) !== approved.contentDigest) fail('operation_denied');
  const body = templateProjection(raw).find(c => c.type === 'BODY').text;
  const indexes = [...new Set([...body.matchAll(/{{([1-9][0-9]*)}}/g)].map(m => Number(m[1])))].sort((a, b) => a - b);
  if (indexes.length !== approved.bodyParameters || indexes.some((value, index) => value !== index + 1)
    || /{{|}}/.test(body.replace(/{{[1-9][0-9]*}}/g, ''))) fail('operation_denied');
}
function projectResult(raw) {
  if (raw?.messaging_product !== 'whatsapp' || !Array.isArray(raw.messages) || raw.messages.length !== 1
    || typeof raw.messages[0]?.id !== 'string' || !/^wamid\.[A-Za-z0-9+/=_-]{2,512}$/.test(raw.messages[0].id) || raw.error) fail('provider_failed');
  return { messageId: raw.messages[0].id };
}
module.exports = { PROVIDER, COHORT, GRAPH_VERSION, TEXT, TEMPLATE, REVOKE, OPERATIONS, bindingSchema,
  bindingFor, validate, authorize, templateProjection, templateDigest, verifyTemplate, projectResult };
