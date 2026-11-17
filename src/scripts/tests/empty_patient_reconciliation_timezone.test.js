'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), { spawnSync } = require('node:child_process');
const file = require.resolve('../../lib/empty-patient-identity-reconciliation');
const worker = `const {sqlUtcTimestamp}=require(${JSON.stringify(file)}); console.log(JSON.stringify([
  sqlUtcTimestamp('2026-11-23 11:35:00'),sqlUtcTimestamp('2026-11-23 11:35:00.123'),
  sqlUtcTimestamp('2026-11-23T11:35:00Z'),sqlUtcTimestamp(new Date('2026-11-23T11:35:00Z'))]));`;
for (const zone of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) test('repair SQL timestamps represent UTC independently of host ' + zone, () => {
  const result = spawnSync('/usr/bin/node', ['-e', worker], { cwd: __dirname, env: { PATH: '/usr/bin:/bin', TZ: zone }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), [1795433700000, 1795433700123, 1795433700000, 1795433700000]);
});
