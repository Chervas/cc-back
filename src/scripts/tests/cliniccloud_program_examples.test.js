'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const { prepareProgramExamples } = require('../../lib/cliniccloud-import/program-examples');
function fixture() {
  const rows = [];
  for (const [name, t, p, price, total] of [['BS Tono', 31, 6, 120, 620], ['BS Suelo Pélvico', 33, 14, 85, 420]]) {
    const common = { clinic_id: 72, cabin: '11', professional: 'Aux. Piedad', duration_info: { mode: 'fixed', minutes: 30 }, provenance: { file_sha256: 'fixture' } };
    rows.push({ ...common, sheet: 'Tratamientos individuales', source_row: t, kind: 'treatment', name: name + ' individual', display_name: name + ' individual', proposed_code: 'code-' + t, source_price: { mode: 'fixed', gross_amount: price }, proposed_clinical_config: { source_price: { gross_amount: price } } });
    rows.push({ ...common, sheet: 'Programas y mantenimientos', source_row: p, kind: 'program', name, detail: '6 citas, 2 por semana en días no consecutivos.', source_catalog_key: 'key-' + p, source_price: { mode: 'fixed', gross_amount: total } });
  }
  const body = { mode: 'catalog_dry_run_only', rows, workbook_sha256: 'fixture' }; return { ...body, plan_sha256: hash(body) };
}
test('real examples preserve gross source prices, two six-session drafts and unresolved resources/tax', () => {
  const examples = prepareProgramExamples(fixture()); assert.equal(examples.length, 2);
  for (const e of examples) { assert.equal(e.treatment.activo, false); assert.equal(e.treatment.precio_base, null); assert.equal(e.program.status, 'draft'); assert.equal(e.program.appointments.length, 6); assert.equal(e.program.appointments[0].offset_days, 0); assert(e.program.appointments.slice(1).every(a => a.offset_days === null)); assert.equal(e.treatment.clinical_config.booking_profile, undefined); }
});
test('tampered plan and changed clinical/commercial evidence stop before writes', () => {
  const p = fixture(); p.rows[0].source_price.gross_amount = 999; assert.throws(() => prepareProgramExamples(p), /INTEGRITY/);
  const { plan_sha256, ...body } = p; assert.throws(() => prepareProgramExamples({ ...body, plan_sha256: hash(body) }), /SOURCE_CHANGED/);
});
