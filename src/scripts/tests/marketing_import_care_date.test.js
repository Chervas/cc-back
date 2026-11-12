'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseImportedCareDate: parse, inferCareDateColumn: infer, readImportedCareDate: read } = require('../../lib/marketing-import-care-date');
const now = new Date('2026-11-12T12:00:00Z');
const options = { now };

test('Spanish day-first is deterministic; MDY is selected once per file', () => {
  assert.equal(parse('05/06/2026', options).date, '2026-06-05');
  assert.equal(parse('05/06/2026', { ...options, format: 'mdy' }).date, '2026-05-06');
  assert.equal(parse('23/06/2026', options).date, '2026-06-23');
  assert.equal(parse('23/06/2026', { ...options, format: 'mdy' }).status, 'invalid');
});
test('ISO, Excel and Spanish text preserve the civil day without guessing an attendance time', () => {
  for (const [value, expected] of [['2026-06-05', '2026-06-05'], ['2026-06-05T23:45:12Z', '2026-06-05'],
    ['05/06/2026 10:30', '2026-06-05'], ['5 de septiembre de 2026', '2026-09-05'],
    [46023, '2026-01-01'], ['46023.75', '2026-01-01']]) {
    assert.equal(parse(value, options).date, expected, String(value));
    assert.equal(parse(value, options).status, 'valid');
  }
  assert.equal(parse(44561, { ...options, excelDateSystem: '1904' }).date, '2026-01-01');
  assert.equal(parse(1, options).date, '1900-01-01');
  assert.equal(parse(60, options).status, 'invalid');
});
test('missing, impossible and future values remain separate row-level outcomes', () => {
  for (const value of [null, undefined, '', ' ']) assert.equal(parse(value, options).status, 'missing');
  for (const value of ['31/02/2026', '2026-02-30', '31/04/2026', '05/09/26', '2026', 'fecha', '2026-01-01 25:90', {}, NaN]) {
    assert.equal(parse(value, options).status, 'invalid', String(value));
  }
  assert.equal(parse('13/11/2026', options).status, 'future');
  assert.equal(parse('12/11/2026', options).status, 'valid');
  assert.equal(parse('13/11/2026', { now: new Date('2026-11-12T23:30:00Z') }).status, 'valid', 'today is Madrid civil day');
});
test('only explicit care headers auto-map; generic and non-care dates need conscious mapping', () => {
  for (const column of ['Fecha nacimiento', 'Fecha pago', 'Fecha cita', 'Fecha próxima cita', 'Fecha inicio tratamiento', 'Fecha']) {
    assert.equal(infer([column]), null, column);
    assert.equal(read({ [column]: '05/06/2026' }, {}, {}, now).status, 'unmapped');
  }
  assert.equal(infer(['Fecha último tratamiento']), 'Fecha último tratamiento');
  assert.equal(read({ Fecha: '05/06/2026' }, { last_visit_at: 'Fecha' }, {}, now).date, '2026-06-05');
  assert.equal(read({ 'Fecha tratamiento': '05/06/2026' }, { last_visit_at: null }, {}, now).status, 'unmapped');
});
test('a file-wide format and Excel epoch are revalidated rather than trusting client display values', () => {
  assert.equal(read({ Fecha: '05/06/2026' }, { last_visit_at: 'Fecha' }, { import_date_format: 'mdy' }, now).date, '2026-05-06');
  assert.equal(read({ Fecha: 44561 }, { last_visit_at: 'Fecha' }, { import_excel_date_system: '1904' }, now).date, '2026-01-01');
  assert.equal(parse('05/06/2026', { ...options, format: 'unknown' }).status, 'invalid');
});
