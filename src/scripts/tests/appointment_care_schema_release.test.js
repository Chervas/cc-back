'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { digest, expectedRows, assertBefore, assertAfter, privatePath } = require('../appointment-care-schema-release');
const values = ['pendiente','info_enviada','info_confirmada','recordatorio_enviado','recordatorio_confirmado',
  'cambio_solicitado','completada','no_asistio','cancelada','reprogramada'];
const column = states => ({ COLUMN_NAME: 'estado', COLUMN_TYPE: `enum(${states.map(s => `'${s}'`).join(',')})` });
const before = { columns: [{ COLUMN_NAME: 'id_cita' }, column(values)], metadata: [], count: 2,
  expected_row_sha256: digest([{ id_cita: 1, estado: 'ha_acudido' }, { id_cita: 2, estado: 'pendiente' }]), doctors_sha256: 'unchanged-personal', legacy_count: 1 };
function after() {
  return { rows: [{ id_cita: 1, estado: 'ha_acudido', care_legacy_attendance: 1 }, { id_cita: 2, estado: 'pendiente', care_legacy_attendance: 0 }],
    summary: { ...before, row_sha256: before.expected_row_sha256,
      columns: [{ COLUMN_NAME: 'id_cita' }, column([...values,'ha_acudido','en_atencion']),
        ...['care_completed_at','care_completed_by','care_legacy_attendance'].map(COLUMN_NAME => ({ COLUMN_NAME }))] } };
}
test('projection retains every ordinary field and distinguishes history from current care', () => {
  const date = '2026-10-08 09:00:00';
  const rows = [{ id_cita: 1, estado: 'completada', updated_at: date, source: 'import' },
    { id_cita: 2, estado: 'recordatorio_confirmado', inicio: date, care_schedule_start: date, arrived_at: date },
    { id_cita: 3, estado: 'info_confirmada', inicio: date, care_schedule_start: date, arrived_at: date, care_started_at: date },
    { id_cita: 4, estado: 'pendiente', inicio: date, care_schedule_start: 'other', arrived_at: date }];
  const result = expectedRows(rows);
  assert.deepEqual(result.map(r => r.estado), ['ha_acudido','ha_acudido','en_atencion','pendiente']);
  assert.equal(result[0].updated_at, date); assert.equal(result[0].source, 'import');
  assert.equal(rows[0].estado, 'completada');
});
test('preflight accepts only the exact old enum and an entirely unapplied cut', () => {
  assert.doesNotThrow(() => assertBefore(before));
  for (const change of [{ metadata: ['20261008150000-appointment-care-lifecycle.js'] },
    { columns: [...before.columns, { COLUMN_NAME:'care_completed_at' }] },
    { columns: [column([...values].reverse())] }]) {
    assert.throws(() => assertBefore({ ...before,...change }), /EXISTING_OR_PARTIAL/);
  }
});
test('postflight accepts the projected states with untouched Personal and no fabricated finish', () => assert.doesNotThrow(() => assertAfter(before, after())));
for (const change of ['lost-row','ordinary-data','piedad-grant','ordinal','fake-finish','wrong-legacy']) {
  test(`postflight rejects ${change}`, () => {
    const current = after();
    if (change === 'lost-row') current.summary.count--;
    if (change === 'ordinary-data') current.summary.row_sha256 = 'changed';
    if (change === 'piedad-grant') current.summary.doctors_sha256 = 'changed';
    if (change === 'ordinal') current.summary.columns[1] = column([...values,'en_atencion','ha_acudido']);
    if (change === 'fake-finish') current.rows[1].care_completed_at = '2026-10-08';
    if (change === 'wrong-legacy') current.rows[0].care_legacy_attendance = 0;
    assert.throws(() => assertAfter(before,current), /CARE_SCHEMA_/);
  });
}
test('operator refuses public, relative or traversal evidence paths', () => {
  for (const filename of ['/tmp/plan.json','plan.json','/home/ubuntu/secure-imports/../plan.json']) assert.throws(() => privatePath(filename), /PRIVATE_PATH/);
});
