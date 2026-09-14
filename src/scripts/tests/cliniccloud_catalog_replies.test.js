'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCatalogPlan, kindOf } = require('../../lib/cliniccloud-import/catalog');
const { clientReplies } = require('../../lib/cliniccloud-import/catalog-replies');
const replies = clientReplies([
  { name: 'Precios y documentos', rows: [
    { source_row: 17, cells: { B: 'Polinucleótidos coreanos Rejuran · 1 vial · sesión suelta', E: '250 € SESION' } },
    { source_row: 18, cells: { B: 'Polinucleótidos coreanos Rejuran · Bono 3 sesiones', E: '690 € BONO' } },
    { source_row: 19, cells: { B: 'Exosomas · Sesión suelta', E: '160 € SESION' } },
    { source_row: 20, cells: { B: 'Exosomas · Bono 3 sesiones', E: '420 € SESION' } },
  ] },
  { name: 'Tratamientos', rows: [{ source_row: 12, cells: { B: 'PRP facial / polinucleótidos Rejuran', E: '30 MINUTOS' } }] },
], 'fictitious-reply-hash');
const cells = (A, B, C, D) => ({ A, B, C, D, G: '7', H: 'Dr. Camacho' });
test('specific client prices override old tariff without changing its source evidence', () => {
  const raw = cells('Polinucleótidos coreanos Rejuran', '1 vial · sesión suelta', '30-40 min', '390 €');
  const p = buildCatalogPlan({ workbookHash: 'fictitious-tariff', replies, repliesHash: 'fictitious-reply-hash', sheets: [{ name: 'Facial · tratamientos', rows: [
    { source_row: 54, cells: raw }, { source_row: 55, cells: cells('Polinucleótidos coreanos Rejuran', 'Bono 3 sesiones', '30-40 min', '1.050 €') },
    { source_row: 57, cells: cells('Exosomas', 'Sesión suelta', '30 min', '190 €') },
  ] }] });
  assert.deepEqual(p.rows.map(r => r.source_price.gross_amount), [250, 690, 160]);
  assert.equal(raw.D, '390 €'); assert.equal(p.rows[0].raw_cells.D, '390 €');
  assert.equal(p.rows[0].duration_info.minutes, 30);
  assert.equal(p.rows[0].client_reply_evidence.length, 2);
  assert.equal(p.rows[0].do_not_write_price_base, true); assert.equal(p.rows[0].ready_for_booking, false);
});
test('ambiguous voucher reply cannot silently restore old price or be treated as a session price', () => {
  const p = buildCatalogPlan({ workbookHash: 'fixture', replies, sheets: [{ name: 'Facial · tratamientos', rows: [{ source_row: 58, cells: cells('Exosomas', 'Bono 3 sesiones', '30 min', '510 €') }] }] });
  assert.equal(p.rows[0].source_price.gross_amount, null); assert(p.rows[0].issues.includes('PRICE_REQUIRES_REVIEW'));
  assert(p.rows[0].client_reply_decisions.includes('CLIENT_VOUCHER_PRICE_UNIT_AMBIGUOUS'));
});
test('new facial programs are inventoried; combination worksheets remain ignored', () => {
  const p = buildCatalogPlan({ workbookHash: 'fixture', sheets: [
    { name: 'Facial · programas', rows: [{ source_row: 3, cells: { A: 'Acné juvenil', B: 'BS ACNÉ · INICIO', C: '4 sesiones y 2 peelings', D: '45 min', E: '420 €' } }] },
    { name: 'Combinación de programas', rows: [{ source_row: 2, cells: { B: 'Do not import', E: '100 €' } }] },
  ] });
  assert.equal(p.rows.length, 1); assert.equal(p.rows[0].kind, 'program');
  assert.equal(p.rows[0].source_price.gross_amount, 420); assert(p.ignored_sheets.includes('Combinación de programas'));
});
test('sheet location does not turn an individual maintenance or an add-on into a program', () => {
  assert.equal(kindOf({ sheet: 'Programas y mantenimientos', category: 'Mantenimientos', name: 'Tono · 1 sesión cada 4–6 semanas', duration: '30 min' }), 'treatment');
  assert.equal(kindOf({ sheet: 'Programas y mantenimientos', category: 'Programas', name: 'BS Tono · segunda zona', duration: '+15 min' }), 'addon');
  assert.equal(kindOf({ sheet: 'Programas y mantenimientos', category: 'Arranque', name: 'Estudio', detail: '1 cita. Mediciones', duration: '30 min' }), 'treatment');
});
