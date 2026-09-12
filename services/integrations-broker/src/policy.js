'use strict';

const Ajv = require('ajv');
const { createPublicKey } = require('node:crypto');
const { ref } = require('./contracts');
const { fail } = require('./errors');
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const strings = { type: 'array', minItems: 1, uniqueItems: true, items: ref };
const validate = new Ajv({ strict: true }).compile(object({
  audience: ref, version: ref, maxBacklog: { type: 'integer', minimum: 2, maximum: 100000 },
  principals: { type: 'array', maxItems: 100, items: object({ id: ref, keyId: ref, enabled: { type: 'boolean' },
    publicKey: { type: 'string', maxLength: 1024 }, maxPerMinute: { type: 'integer', minimum: 1, maximum: 600 } }) },
  connections: { type: 'array', maxItems: 10000, items: object({ connectionRef: ref, provider: ref,
    initialState: { enum: ['active', 'blocked', 'revoked', 'expired'] },
    expiresAt: { type: ['integer', 'null'], minimum: 0 }, secretArn: { type: 'string', maxLength: 2048 } }, ['connectionRef', 'provider', 'initialState']) },
  grants: { type: 'array', maxItems: 100000, items: object({ principalId: ref, tenantRef: ref, connectionRef: ref, assetRef: ref, operations: strings }) },
}));
function validatePolicy(policy) {
  if (!validate(policy)) fail('invalid_request');
  for (const [rows, key] of [[policy.principals, 'id'], [policy.principals, 'keyId'], [policy.connections, 'connectionRef']]) {
    if (new Set(rows.map(row => row[key])).size !== rows.length) fail('invalid_request');
  }
  try { for (const row of policy.principals) if (createPublicKey(row.publicKey).asymmetricKeyType !== 'ed25519') fail('invalid_request'); }
  catch { fail('invalid_request'); }
  for (const grant of policy.grants) {
    if (!policy.principals.some(row => row.id === grant.principalId) || !policy.connections.some(row => row.connectionRef === grant.connectionRef)) fail('invalid_request');
  }
  return policy;
}
module.exports = { validatePolicy };
