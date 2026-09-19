'use strict';

const Ajv = require('ajv');
const { fail } = require('./errors');
const { OPERATIONS } = require('./ai-limits');
const referenceContract = require('./ai-file-reference');
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const text = { type: 'string', minLength: 1, maxLength: 1024 * 1024 };
const model = { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' };
const optionalId = { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,200}$' };
const bindingSchema = object({ models: { type: 'array', minItems: 1, maxItems: 30, uniqueItems: true, items: model },
  organization: optionalId, project: optionalId, fileTransferOrigin: { type: 'string', maxLength: 255 } }, ['models']);
const USE_CASES = Object.freeze({ openai: ['accounting_ocr', 'web_content', 'visibility_openai'],
  gemini: ['visibility_gemini'], groq: ['whatsapp_audio'] });
const fileRef = object({ version: { const: 1 }, environment: { enum: ['dev', 'staging'] },
  requestId: { type: 'string', pattern: referenceContract.UUID.source }, useCase: { enum: referenceContract.PURPOSES },
  url: { type: 'string', maxLength: 512 }, expiresAt: { type: 'integer' }, mimeType: { type: 'string', maxLength: 80 },
  fileName: { type: 'string', minLength: 1, maxLength: 255 }, sizeBytes: { type: 'integer', minimum: 1, maximum: referenceContract.MAX_FILE_BYTES },
  sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' } });
const content = { anyOf: [text, { type: 'array', minItems: 1, maxItems: 50, items: { anyOf: [
  object({ type: { const: 'input_text' }, text }),
  object({ type: { const: 'input_image' }, file_ref: fileRef, detail: { enum: ['auto', 'low', 'high'] } }, ['type', 'file_ref']),
  object({ type: { const: 'input_file' }, file_ref: fileRef }),
] } }] };
const webSearch = object({ type: { const: 'web_search' }, search_context_size: { enum: ['low', 'medium', 'high'] },
  external_web_access: { type: 'boolean' }, user_location: object({ type: { const: 'approximate' },
    country: { type: 'string', pattern: '^[A-Z]{2}$' }, city: text, region: text, timezone: { type: 'string', maxLength: 128 } }, ['type']) }, ['type']);
const openai = object({ model, store: { const: false },
  reasoning: object({ effort: { enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] } }),
  max_output_tokens: { type: 'integer', minimum: 1, maximum: 64000 },
  input: { anyOf: [text, { type: 'array', minItems: 1, maxItems: 100, items: object({
    role: { enum: ['system', 'developer', 'user', 'assistant'] }, content }) }] },
  text: object({ format: object({ type: { const: 'json_schema' }, name: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,128}$' },
    strict: { const: true }, schema: { type: 'object' } }) }),
  tools: { type: 'array', minItems: 1, maxItems: 1, items: webSearch },
  tool_choice: { enum: ['auto', 'required', 'none'] },
  include: { type: 'array', maxItems: 1, uniqueItems: true, items: { const: 'web_search_call.action.sources' } },
}, ['model', 'store', 'input', 'max_output_tokens']);
const gemini = object({ model, store: { const: false }, input: text,
  tools: { type: 'array', minItems: 1, maxItems: 1, items: object({ type: { const: 'google_search' } }) } });
const groq = object({ model, response_format: { const: 'verbose_json' }, fileRef });
const ajv = new Ajv({ strict: true });
const validators = Object.fromEntries(Object.entries({ openai, gemini, groq }).map(([provider, body]) => [provider, ajv.compile(object({
  useCase: { enum: USE_CASES[provider] }, timeoutMs: { type: 'integer', minimum: 1, maximum: 180000 }, body,
}))]));
function references(provider, payload) {
  if (provider === 'groq') return [payload.body.fileRef];
  if (provider !== 'openai' || !Array.isArray(payload.body.input)) return [];
  return payload.body.input.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.file_ref).map(part => part.file_ref) : []);
}
function validate(provider, payload) {
  if (!validators[provider]?.(payload)) fail('invalid_request');
  const refs = references(provider, payload);
  // Current binary workflows contain exactly one document/audio. No inline
  // files or caller-selected URLs are accepted by this transport.
  if (refs.length > 1 || (payload.useCase === 'accounting_ocr' || provider === 'groq') && refs.length !== 1
    || refs.length && !['accounting_ocr', 'whatsapp_audio'].includes(payload.useCase)) fail('invalid_request');
  if (provider === 'openai' && Array.isArray(payload.body.input)) {
    for (const message of payload.body.input) for (const part of Array.isArray(message.content) ? message.content : []) {
      if (part.file_ref && (part.type === 'input_file' ? part.file_ref.mimeType !== 'application/pdf' : !part.file_ref.mimeType.startsWith('image/'))) fail('invalid_request');
    }
  }
  return payload;
}
function authorizeReferences(provider, { payload, binding, requestId, environment, now }) {
  for (const ref of references(provider, payload)) {
    try { referenceContract.reference(ref, { expectedOrigin: binding.ai.fileTransferOrigin, environment, requestId, useCase: payload.useCase, now }); }
    catch { fail('scope_denied'); }
  }
}
function authorize(provider, { request, binding }) {
  if (binding.provider !== `ai_${provider}` || request.operation !== OPERATIONS[provider]
    || request.assetRef !== `ai:${request.payload.useCase}` || !binding.ai?.models?.includes(request.payload.body.model)) fail('scope_denied');
  authorizeReferences(provider, { payload: request.payload, binding, requestId: request.requestId, environment: request.tenantRef.slice('platform:'.length) });
}
module.exports = { bindingSchema, USE_CASES, validate, authorize, authorizeReferences, references };
