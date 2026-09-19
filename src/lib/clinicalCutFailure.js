'use strict';
const { createHash } = require('node:crypto');
// SQL text, credentials, command stdout/stderr and assertion values never enter
// the control journal. Keep machine codes, safe locations and numeric guards.
function clinicalCutFailure(error) {
  const message = String(error?.message || '');
  const reason = message.match(/\b(?:clinical_cut|meta_cut|meta_schema|schema|active_work)_[A-Za-z_]+\b/)?.[0] || 'unclassified';
  const result = { reason, messageDigest: createHash('sha256').update(message).digest('hex') };
  if (/^[A-Z][A-Z0-9_]{1,80}$/.test(error?.code || '')) result.code = error.code;
  if (Number.isInteger(error?.errno)) result.errno = error.errno;
  if (/^[A-Z0-9]{5}$/.test(error?.sqlState || '')) result.sqlState = error.sqlState;
  if (error?.code === 'ERR_ASSERTION' && Number.isFinite(error.actual) && Number.isFinite(error.expected)) {
    result.actual = error.actual; result.expected = error.expected;
  }
  const locations = [...String(error?.stack || '').matchAll(/\/([A-Za-z0-9_.-]+\.(?:js|cjs)):(\d+):(\d+)\)?(?:\n|$)/g)];
  result.locations = locations.slice(0, 3).map(m => m[1] + ':' + m[2] + ':' + m[3]);
  return result;
}
module.exports = { clinicalCutFailure };
