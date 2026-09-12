'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { pack, keyFor } = require('../src/event'); const { fixture } = require('./fixture.cjs');
const { inputFor, resultFor, writeBatch, WRITER_ROLE } = require('../src/batch');
const { ACCOUNT } = require('../src/s3');
const sourceRoleArn = `arn:aws:iam::${ACCOUNT}:role/fictitious-audit-source`;
const identity = role => ({ Account: ACCOUNT, Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/${role.split('/').at(-1)}/fictitious-session` });
const input = count => ({ version: 1, sourceRoleArn, records: Array.from({ length: count }, () => { const row = pack(fixture()); return { body: row.body, digest: row.digest }; }) });
test('validates complete batch and source role before any identity/network operation', async () => {
  const calls = []; const api = { sourceIdentity: () => calls.push('forbidden') };
  for (const value of [{ ...input(1), endpoint: 'https://forbidden.invalid' }, input(0), input(51),
    { ...input(1), sourceRoleArn: `arn:aws:iam::${ACCOUNT}:root` },
    { ...input(1), sourceRoleArn: `arn:aws:iam::${ACCOUNT}:role/AWSReservedSSO_Admin_123` },
    { ...input(1), sourceRoleArn: WRITER_ROLE }]) await assert.rejects(writeBatch(value, api));
  const duplicate = input(1); duplicate.records.push(duplicate.records[0]); assert.throws(() => inputFor(duplicate));
  const bad = input(2); bad.records[1].digest = '0'.repeat(64); await assert.rejects(writeBatch(bad, api));
  assert.equal(calls.length, 0);
});
test('wrong runtime identity prevents role assumption; wrong target identity prevents all puts', async () => {
  let assumed = 0; let written = 0; let closed = 0;
  const target = { identity: async () => identity(sourceRoleArn), writer: { write: async () => written++ }, close: () => closed++ };
  await assert.rejects(writeBatch(input(1), { sourceIdentity: async () => ({ ...identity(sourceRoleArn), Account: '000000000000' }),
    assumeWriter: async () => { assumed++; return target; } }), /audit_identity_invalid/);
  assert.equal(assumed, 0);
  await assert.rejects(writeBatch(input(1), { sourceIdentity: async () => identity(sourceRoleArn),
    assumeWriter: async () => { assumed++; return target; } }), /audit_identity_invalid/);
  assert.equal(written, 0); assert.equal(closed, 1);
});
test('bounded parallel writer returns mixed outcomes in input order and never exposes raw errors', async () => {
  const value = input(9); let active = 0; let maximum = 0; let writes = 0; let closed = false;
  const result = await writeBatch(value, { sourceIdentity: async () => identity(sourceRoleArn), assumeWriter: async () => ({
    identity: async () => identity(WRITER_ROLE), close: () => { closed = true; }, writer: { write: async row => {
      const index = writes++; active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 1)); active--;
      if (index === 2) throw Object.assign(Error('SENTINEL_SECRET'), { code: 'audit_reconciliation_required' });
      if (index === 3) throw Error('SENTINEL_SECRET');
      return { key: keyFor(row), digest: row.digest, versionId: 'fictitious-version' };
    } },
  }) });
  assert.equal(maximum, 4); assert.equal(closed, true);
  assert.equal(result.results.filter(row => row.status === 'delivered').length, 7);
  assert.equal(result.results[2].status, 'reconcile'); assert.equal(result.results[3].status, 'pending');
  assert(!JSON.stringify(result).includes('SENTINEL')); assert(!JSON.stringify(result).includes('actor'));
  assert.equal(resultFor(value, result).results.length, 9);
  const reordered = { ...result, results: [...result.results].reverse() }; assert.throws(() => resultFor(value, reordered));
  const poisoned = structuredClone(result); poisoned.results[0].receipt.digest = '0'.repeat(64); assert.throws(() => resultFor(value, poisoned));
});
