'use strict';
const { schema } = require('./contracts'); const { subject } = require('./google-oauth-secrets'); const { fail } = require('./errors');
const PREFIX = 'google.business_profile.oauth.';
const OPERATIONS = Object.freeze(Object.fromEntries(['begin','finish','activate','status','abort'].map(name => [name, PREFIX + name + '.v1'])));
const UUID = { type: 'string', pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' };
const STATE = { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' };
const validators = { begin: schema({ state: STATE }), finish: schema({ flowId: UUID, state: STATE, code: { type: 'string', minLength: 1, maxLength: 4096, pattern: '^[\\x21-\\x7e]+$' } }),
  activate: schema({ flowId: UUID }), status: schema({ flowId: UUID }), abort: schema({ flowId: UUID }) };
const SCOPES = Object.freeze(['openid', 'email', 'profile', 'https://www.googleapis.com/auth/business.manage',
  'https://www.googleapis.com/auth/webmasters.readonly', 'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/adwords', 'https://www.googleapis.com/auth/datamanager']);
const bindingSchema = { type: 'object', additionalProperties: false, required: ['subject','redirectUri','scopes'], properties: {
  subject: { type: 'string', minLength: 1, maxLength: 128 }, redirectUri: { type: 'string', maxLength: 512 },
  scopes: { type: 'array', minItems: 4, maxItems: SCOPES.length, uniqueItems: true, items: { enum: SCOPES } },
} };
function bindingFor(binding) {
  const cfg = binding?.oauth;
  if (!cfg || !subject(cfg.subject) || !Array.isArray(cfg.scopes) || cfg.scopes.some(s => !SCOPES.includes(s))
    || new Set(cfg.scopes).size !== cfg.scopes.length || SCOPES.slice(0,4).some(s => !cfg.scopes.includes(s))) fail('invalid_request');
  try {
    const uri = new URL(cfg.redirectUri);
    if (uri.protocol !== 'https:' || uri.username || uri.password || uri.search || uri.hash || uri.port
      || uri.pathname !== '/oauth/google/callback' || uri.href !== cfg.redirectUri) fail('invalid_request');
  } catch { fail('invalid_request'); }
  return binding;
}
const normalizeScopes = values => [...new Set(values.map(s => s === 'https://www.googleapis.com/auth/userinfo.email' ? 'email'
  : s === 'https://www.googleapis.com/auth/userinfo.profile' ? 'profile' : s))].sort();
module.exports = { PREFIX, OPERATIONS, validators, SCOPES, bindingSchema, bindingFor, normalizeScopes };
