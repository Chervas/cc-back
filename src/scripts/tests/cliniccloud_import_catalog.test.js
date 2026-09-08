'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCatalogPlan, grossPrice, durationInfo, kindOf } = require('../../lib/cliniccloud-import/catalog');
test('catalog gross prices distinguish fixed/from/included and do not add tax', () => {
  assert.equal(grossPrice('1.050 €').gross_amount, 1050);
  assert.equal(grossPrice('250,50 €').gross_amount, 250.5);
  assert.equal(grossPrice('Desde 2.500 €').mode, 'from');
  assert.equal(grossPrice('Incluida').gross_amount, null);
  assert.equal(grossPrice('Gratuita').gross_amount, 0);
});
test('multiple appointments and quantity/additional duration are not flattened', () => {
  assert.deepEqual(durationInfo('3 × 30 min'), { mode: 'multiple_appointments', count: 3, minutes: 30 });
  assert.equal(durationInfo('+15 min').mode, 'additional');
  assert.equal(durationInfo('1,5 jornadas de quirófano').minutes, null);
  assert.equal(durationInfo('30-40 min').mode, 'range');
});
test('prosthesis surgery is not confused with the separately sold prosthesis', () => {
  assert.equal(kindOf({ category: 'Aumento mamario', name: 'Prótesis redondas', sheet: 'Cirugía plástica · tarifa' }), 'treatment');
  assert.equal(kindOf({ category: 'Prótesis', name: 'Prótesis redondas · si se factura por separado', sheet: 'Cirugía plástica · tarifa' }), 'product');
  assert.equal(kindOf({ category: 'Pruebas', name: 'Analítica prequirúrgica', sheet: 'Cirugía plástica · tarifa' }), 'treatment');
});
test('cabina same number is only candidate; combinations ignored; source gross never becomes precio_base', () => {
  const sheets = [{ name: 'Tratamientos individuales', rows: [{ source_row: 2, cells: { A: 'Corporal', B: 'Tratamiento sintético', C: '30 min', D: '121 €', G: '1', H: 'Dr. Sintético' } }] }, { name: 'Combinación de programas', rows: [{ source_row: 2, cells: { B: 'Ignore', E: '100 €' } }] }];
  const local = { installations: [{ id: 8, clinic_id: 72, name: 'Cabina 1', active: true }], professionals: [{ id: 7, clinic_id: 72, name: 'Sintético', active: true, receives_appointments: true }], treatments: [] };
  const plan = buildCatalogPlan({ sheets, workbookHash: 'synthetic', local });
  assert.equal(plan.rows.length, 1); assert.equal(plan.rows[0].ready_for_booking, false);
  assert.equal(plan.rows[0].installation_resolution[0].candidates[0].id, 8);
  assert.equal(plan.rows[0].source_price.gross_amount, 121); assert.equal(plan.rows[0].precio_base, undefined);
  assert.equal(plan.rows[0].do_not_write_price_base, true);
  const resolved = buildCatalogPlan({ sheets, workbookHash: 'synthetic', local, resourceMap: { cabins: { C1: 8 }, professionals: { 'Dr. Sintético': 7 } } });
  assert.equal(resolved.rows[0].ready_for_booking, true);
  assert.equal(resolved.rows[0].proposed_clinical_config.catalog_status, 'draft');
});
test('hair surgery requires both professionals and never assumes hours per surgical day', () => {
  const plan = buildCatalogPlan({ workbookHash: 'synthetic', sheets: [{ name: 'Capilar · sesiones y bonos', rows: [{ source_row: 15, cells: { A: 'Injerto capilar', B: 'Una sesión', C: '1 jornada de quirófano', D: '4.390 €', G: '6 QX', H: 'Dr. Loza' } }] }] });
  assert.equal(plan.rows[0].clinic_id, 66); assert.equal(plan.rows[0].professional_mode, 'all');
  assert.deepEqual(plan.rows[0].required_professionals, ['Dr. Loza', 'Aux. Ainhoa']);
  assert.equal(plan.rows[0].duration_info.minutes, null);
});
