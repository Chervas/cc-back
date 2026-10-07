'use strict';

// Fixtures may execute an isolated flow, but can never acquire a real delivery
// right. Inspect explicit structured markers, never names, phone numbers or
// message text. Import releases and manual retries do not override this rule.
const CONTAINERS = ['metadata', 'import_metadata', 'context', 'appointment', 'import',
  'cliniccloud_reconciliation', 'cliniccloud_source_booking'];
const MARKERS = ['qa_demo', 'synthetic_data_only', '__simulation', 'is_test'];
const CODE = 'synthetic_communication_forbidden';
const marked = value => value !== undefined && value !== null && value !== false
  && value !== 0 && value !== '' && value !== '0' && value !== 'false';
function isSyntheticData(value, depth = 0, seen = new Set()) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return false; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (depth > 8 || seen.has(value)) return true;
  seen.add(value);
  if (MARKERS.some(key => marked(value[key]))) return true;
  const result = CONTAINERS.some(key => value[key] != null && isSyntheticData(value[key], depth + 1, seen));
  seen.delete(value);
  return result;
}
function assertNoSyntheticDispatch(...values) {
  if (values.some(value => isSyntheticData(value))) throw Object.assign(Error(CODE), {
    code: CODE, retryable: false, preserveFlowState: true,
  });
}
module.exports = { CODE, isSyntheticData, assertNoSyntheticDispatch };
