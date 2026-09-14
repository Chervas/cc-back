'use strict';
// First security stage: all Meta/WhatsApp egress remains quarantined. This is
// deliberately independent of legacy connection, mapping and rate-limit rows.
// Releasing it requires a reviewed code cut with the credential broker ready.
// No environment switch, browser input or deletion of application data opens it.
function error() { return Object.assign(Error('meta_security_quarantine'), {
  code: 'meta_security_quarantine', httpStatus: 503, status: 503, retryable: false,
}); }
function assertMetaAvailable() { throw error(); }
async function request() { throw error(); }
const transport = Object.assign(request, Object.fromEntries(
  ['request', 'get', 'post', 'put', 'patch', 'delete', 'head', 'options'].map(method => [method, request])));
transport.create = () => transport;
transport.assertMetaAvailable = assertMetaAvailable;
transport.middleware = (_req, res) => res.status(503).json({ success: false, error: 'meta_security_quarantine' });
module.exports = Object.freeze(transport);
