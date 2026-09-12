'use strict';

const Ajv = require('ajv');
const { fail } = require('./errors');
const ajv = new Ajv({ strict: true, allErrors: false, coerceTypes: false, removeAdditional: false });
const ref = { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$' };
const uuid = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' };
const object = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const validateRequest = ajv.compile(object({
  version: { const: 1 }, audience: ref, requestId: uuid, nonce: uuid,
  issuedAt: { type: 'integer', minimum: 0 }, operation: ref,
  connectionRef: ref, assetRef: ref, tenantRef: ref,
  payload: { type: 'object' },
}));
const actionNames = ['integration.requested', 'integration.completed', 'integration.failed',
  'integration.denied', 'connection.blocked', 'audit.accessed'];
const validateAudit = ajv.compile(object({
  version: { const: 1 }, eventId: uuid, occurredAt: { type: 'string', pattern: '^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$' },
  actorType: { enum: ['service', 'operator'] }, actorId: ref,
  tenantRef: ref, action: { enum: actionNames }, resourceRef: ref,
  result: { enum: ['accepted', 'success', 'denied', 'failed', 'unknown'] },
  reason: ref, correlationId: uuid, policyVersion: ref,
}));
function request(body) { if (!validateRequest(body)) fail('invalid_request'); return body; }
function audit(event) { if (!validateAudit(event)) fail('invalid_request'); return event; }
function schema(properties) { const check = ajv.compile(object(properties)); return value => { if (!check(value)) fail('invalid_request'); return value; }; }
module.exports = { request, audit, schema, ref };
