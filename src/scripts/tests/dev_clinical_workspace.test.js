'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');
const { KEY, AREAS, buildPlan, assertEnvironment, assertPreserved, PROTECTED } = require('../qa/prepare-dev-clinical-workspace');

const env = () => ({ QA_DEV_WORKSPACE_WRITES: KEY, DB_NAME: 'clinicaclick_dev_isolated', DB_USERNAME: 'cc_dev_api', DB_HOST: '127.0.0.1' });
test('the fixture permits only explicit isolated DEV credentials', () => {
  assert.doesNotThrow(() => assertEnvironment(env()));
  assert.doesNotThrow(() => assertEnvironment({ ...env(), DB_HOST: 'localhost' }));
});
for (const [key, value] of [['QA_DEV_WORKSPACE_WRITES', undefined], ['QA_DEV_WORKSPACE_WRITES', 'yes'],
  ['DB_NAME', 'clinicaclick'], ['DB_USERNAME', 'root'], ['DB_HOST', 'remote.example.invalid'],
  ['DATABASE_URL', 'mysql://override'], ['DB_URL', 'mysql://override']]) {
  test(`refuses unsafe ${key} before model loading`, () => assert.throws(() => assertEnvironment({ ...env(), [key]: value })));
}
for (const input of [undefined, 'tomorrow', '2026-02-30', '2026-09-29', '2026-09-28T00:00:00Z']) {
  test(`rejects non-explicit Monday ${input}`, () => assert.throws(() => buildPlan(input)));
}
test('the same explicit Monday produces identical bounded data', () => {
  const a = buildPlan('2026-09-28'), b = buildPlan('2026-09-28');
  assert.deepEqual(a, b); assert.equal(a.patients.length, 24); assert.equal(a.appointments.length, 48);
  assert.equal(new Set(a.patients.map(p => p.public_id)).size, 24);
  assert.equal(new Set(a.appointments.map(p => p.source_reference)).size, 48);
  assert.equal(AREAS.length, 6);
});
test('all identities are explicitly synthetic and unreachable', () => {
  for (const p of buildPlan('2026-09-28').patients) {
    assert.match(p.nombre, /DEMO/);
    for (const key of ['email', 'telefono_movil', 'telefono_secundario', 'dni']) assert.equal(p[key], null);
    assert.match(p.antecedentes, /ficticios/);
  }
});
test('every appointment has HOLD and historic/future states are kept distinct', () => {
  for (const a of buildPlan('2026-09-28').appointments) {
    assert.equal(a.source_system, 'clinicaclick_demo');
    assert.equal(a.import_metadata.synthetic_data_only, true);
    assert.equal(a.import_metadata.automation_policy, 'hold');
    assert.deepEqual(a.import_metadata.notification_suppression, { appointment_details: true, day_before: true, same_day: true });
    assert.equal(a.estado, a.source_reference.endsWith(':past') ? 'completada' : 'pendiente');
    assert.match(a.nota, /ficticios/);
  }
});
for (const monday of ['2026-09-28', '2026-10-26', '2027-03-29']) {
  test(`appointments respect Madrid time and never overlap for the same professional: ${monday}`, () => {
    const rows = buildPlan(monday).appointments;
    for (const a of rows) {
      const start = DateTime.fromISO(a.inicio).setZone('Europe/Madrid');
      const end = DateTime.fromISO(a.fin).setZone('Europe/Madrid');
      assert(start.weekday <= 5); assert(start.hour >= 10 && end.hour <= 18);
      assert.equal(end.diff(start, 'minutes').minutes, AREAS[a.areaIndex][2]);
      for (const b of rows) if (a !== b && a.areaIndex % 2 === b.areaIndex % 2) {
        assert(new Date(a.fin) <= new Date(b.inicio) || new Date(a.inicio) >= new Date(b.fin));
      }
    }
    assert.equal(DateTime.fromISO(rows.find(a => a.source_reference.endsWith(':next')).inicio).setZone('Europe/Madrid').hour, 10);
  });
}
test('a new week reuses patient IDs but cannot collide with prior appointment references', () => {
  const a = buildPlan('2026-09-28'), b = buildPlan('2026-10-12');
  assert.deepEqual(a.patients, b.patients);
  const refs = new Set(a.appointments.map(r => r.source_reference));
  assert(b.appointments.every(r => !refs.has(r.source_reference)));
});
test('readback rejects changes/removal of existing records, including credentials and signatures', () => {
  const db = Object.fromEntries(PROTECTED.map(name => [name, { primaryKeyAttributes: ['id'] }]));
  const before = Object.fromEntries(PROTECTED.map(name => [name, [{ id: 1, value: 'preserved' }]]));
  const after = structuredClone(before);
  for (const name of PROTECTED) after[name].push({ id: 2, value: 'new fixture' });
  assert.doesNotThrow(() => assertPreserved(db, before, after));
  assert.throws(() => assertPreserved(db, before, after, true));
  for (const name of PROTECTED) {
    const changed = structuredClone(before); changed[name][0].value = 'overwritten';
    assert.throws(() => assertPreserved(db, before, changed));
    const removed = structuredClone(before); removed[name] = [];
    assert.throws(() => assertPreserved(db, before, removed));
  }
  assert.doesNotThrow(() => assertPreserved(db, before, before, true));
});
