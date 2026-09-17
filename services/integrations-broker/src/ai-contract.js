'use strict';

const Ajv = require('ajv');
const { fail } = require('./errors');
const { MAX_FILE_BYTES, OPERATIONS } = require('./ai-limits');
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const text = { type: 'string', minLength: 1, maxLength: 1024 * 1024 };
const model = { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' };
const optionalId = { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,200}$' };
const bindingSchema = object({ models: { type: 'array', minItems: 1, maxItems: 30, uniqueItems: true, items: model },
  organization: optionalId, project: optionalId }, ['models']);
const USE_CASES = Object.freeze({ openai: ['accounting_ocr', 'web_content', 'visibility_openai'],
  gemini: ['visibility_gemini'], groq: ['whatsapp_audio'] });
const dataUrl = kind => ({ type: 'string', maxLength: Math.ceil(MAX_FILE_BYTES / 3) * 4 + 100,
  pattern: kind === 'pdf' ? '^data:application/pdf;base64,[A-Za-z0-9+/]+={0,2}$'
    : '^data:image/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$' });
const content = { anyOf: [text, { type: 'array', minItems: 1, maxItems: 50, items: { anyOf: [
  object({ type: { const: 'input_text' }, text }),
  object({ type: { const: 'input_image' }, image_url: dataUrl('image'), detail: { enum: ['auto', 'low', 'high'] } }, ['type', 'image_url']),
  object({ type: { const: 'input_file' }, filename: { type: 'string', minLength: 1, maxLength: 255 }, file_data: dataUrl('pdf') }),
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
const groq = object({ model, response_format: { const: 'verbose_json' },
  mimeType: { type: 'string', pattern: '^(audio|video)/[a-z0-9.+-]{1,64}$' },
  fileName: { type: 'string', minLength: 1, maxLength: 255, pattern: '^[^\\r\\n\\u0000]+$' },
  fileBase64: { type: 'string', minLength: 4, maxLength: Math.ceil(MAX_FILE_BYTES / 3) * 4, pattern: '^[A-Za-z0-9+/]+={0,2}$' } });
const ajv = new Ajv({ strict: true });
const validators = Object.fromEntries(Object.entries({ openai, gemini, groq }).map(([provider, body]) => [provider, ajv.compile(object({
  useCase: { enum: USE_CASES[provider] }, timeoutMs: { type: 'integer', minimum: 1, maximum: 180000 }, body,
}))]));
function canonicalBase64(value) {
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > MAX_FILE_BYTES || bytes.toString('base64') !== value) fail('invalid_request');
  return bytes;
}
function validate(provider, payload) {
  if (!validators[provider]?.(payload)) fail('invalid_request');
  if (provider === 'groq') canonicalBase64(payload.body.fileBase64).fill(0);
  if (provider === 'openai' && Array.isArray(payload.body.input)) {
    let total = 0;
    for (const message of payload.body.input) for (const part of Array.isArray(message.content) ? message.content : []) {
      const data = part.file_data || part.image_url;
      if (data) { const bytes = canonicalBase64(data.slice(data.indexOf(',') + 1)); total += bytes.length; bytes.fill(0); }
    }
    if (total > MAX_FILE_BYTES) fail('invalid_request');
  }
  return payload;
}
function authorize(provider, { request, binding }) {
  if (binding.provider !== `ai_${provider}` || request.operation !== OPERATIONS[provider]
    || request.assetRef !== `ai:${request.payload.useCase}` || !binding.ai?.models?.includes(request.payload.body.model)) fail('scope_denied');
}
module.exports = { bindingSchema, USE_CASES, validate, authorize, canonicalBase64 };
