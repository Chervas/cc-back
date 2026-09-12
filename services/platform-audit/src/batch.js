'use strict';
const { unpack, receiptFor, fail } = require('./event');
const { ACCOUNT } = require('./s3');
const WRITER_ROLE = `arn:aws:iam::${ACCOUNT}:role/clinicaclick-audit-prod-writer-role`;
const ERROR_CODES = new Set(['audit_unavailable', 'audit_reconciliation_required', 'audit_integrity_invalid',
  'audit_identity_invalid', 'audit_configuration_invalid', 'audit_batch_invalid', 'audit_receipt_invalid', 'audit_event_invalid']);
const safeError = error => ERROR_CODES.has(error?.code) ? error.code : 'audit_unavailable';
function exact(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))) fail('audit_batch_invalid');
}
function sourceRole(value) {
  if (typeof value !== 'string' || value.length > 2048
    || !new RegExp(`^arn:aws:iam::${ACCOUNT}:role/(?:[A-Za-z0-9_+=,.@-]+/)*[A-Za-z0-9_+=,.@-]{1,64}$`).test(value)
    || value.includes('AWSReservedSSO_') || value.includes('aws-reserved/') || value === WRITER_ROLE) fail('audit_configuration_invalid');
  return value;
}
function identityFor(identity, roleArn) {
  const name = roleArn.slice(roleArn.lastIndexOf('/') + 1);
  const prefix = `arn:aws:sts::${ACCOUNT}:assumed-role/${name}/`;
  if (identity?.Account !== ACCOUNT || typeof identity.Arn !== 'string' || !identity.Arn.startsWith(prefix)
    || !/^[A-Za-z0-9_+=,.@-]{2,64}$/.test(identity.Arn.slice(prefix.length))) fail('audit_identity_invalid');
}
function inputFor(value) {
  exact(value, ['version', 'sourceRoleArn', 'records']);
  if (value.version !== 1 || !Array.isArray(value.records) || !value.records.length || value.records.length > 50) fail('audit_batch_invalid');
  sourceRole(value.sourceRoleArn); const ids = new Set();
  for (const record of value.records) {
    exact(record, ['body', 'digest']); const row = unpack(record);
    if (ids.has(row.event.eventId)) fail('audit_batch_invalid'); ids.add(row.event.eventId);
  }
  return value;
}
function resultFor(input, value) {
  inputFor(input); exact(value, ['version', 'results']);
  if (value.version !== 1 || !Array.isArray(value.results) || value.results.length !== input.records.length) fail('audit_batch_invalid');
  return { version: 1, results: value.results.map((result, index) => {
    const row = input.records[index]; const id = unpack(row).event.eventId;
    if (!result || result.eventId !== id || result.digest !== row.digest) fail('audit_batch_invalid');
    if (result.status === 'delivered') {
      exact(result, ['eventId', 'digest', 'status', 'receipt']);
      return { eventId: id, digest: row.digest, status: 'delivered', receipt: receiptFor(row, result.receipt) };
    }
    exact(result, ['eventId', 'digest', 'status', 'error']);
    if (!['pending', 'reconcile'].includes(result.status) || !ERROR_CODES.has(result.error)
      || (result.status === 'reconcile') !== (result.error === 'audit_reconciliation_required')) fail('audit_batch_invalid');
    return { eventId: id, digest: row.digest, status: result.status, error: result.error };
  }) };
}
async function writeBatch(input, api) {
  inputFor(input); identityFor(await api.sourceIdentity(), input.sourceRoleArn);
  // Target credentials/clients are created only after validating the separately assigned runtime principal.
  const target = await api.assumeWriter();
  try {
    identityFor(await target.identity(), WRITER_ROLE);
    const results = new Array(input.records.length); let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, input.records.length) }, async () => {
      for (;;) {
        const index = next++; if (index >= input.records.length) return;
        const row = input.records[index]; const eventId = unpack(row).event.eventId;
        try {
          const receipt = receiptFor(row, await target.writer.write(row));
          results[index] = { eventId, digest: row.digest, status: 'delivered', receipt };
        } catch (error) {
          const code = safeError(error);
          results[index] = { eventId, digest: row.digest, status: code === 'audit_reconciliation_required' ? 'reconcile' : 'pending', error: code };
        }
      }
    }));
    return resultFor(input, { version: 1, results });
  } finally { target.close(); }
}
module.exports = { WRITER_ROLE, sourceRole, identityFor, inputFor, resultFor, writeBatch, safeError };
