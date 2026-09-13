'use strict';
const { randomUUID } = require('node:crypto');
function patientReadFixture(overrides = {}) {
  return { version: 6, eventId: randomUUID(), correlationId: randomUUID(), occurredAt: '2026-09-13T12:00:00.000Z',
    action: 'patient.detail.read', stage: 'completed', outcome: 'success', reason: 'response_prepared',
    actor: { type: 'user', id: '501' }, sessionRef: randomUUID(), scope: { type: 'clinic', id: '71' },
    clinicIds: ['71'], patientIds: ['901'], patientCount: 1, resultCount: 1, includesSensitive: true,
    batchIndex: 0, batchCount: 1, resultSetDigest: 'a'.repeat(64),
    authorizationPolicyVersion: 'patient-read-scope-v1', capturePolicy: 'patient-reads-durable-v1', ...overrides };
}
module.exports = { patientReadFixture };
