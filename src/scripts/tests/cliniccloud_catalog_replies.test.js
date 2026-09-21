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

test('client body assessment overrides both duplicate source locations but never guesses a missing cabin', () => {
  const reply = clientReplies([{ name: 'Tratamientos', rows: [{ source_row: 16, cells: {
    B: 'Estudio Corporal BS', E: 'LO HACE LA DRA.CAMACHO Y CON 15 M. MAXIMO' } }] }], 'reply-fixture');
  const p = buildCatalogPlan({ workbookHash: 'fixture', replies: reply, sheets: [
    { name: 'Tratamientos individuales', rows: [{ source_row: 2, cells: { A: 'CONSULTAS', B: 'Estudio Corporal BS · bioimpedancia, medición, foto e informe', C: '30 min', D: '50 €', G: '7', H: 'Dr. Camacho' } }] },
    { name: 'Programas y mantenimientos', rows: [{ source_row: 2, cells: { A: 'Arranque y fidelización', B: 'Estudio Corporal BS', C: '1 cita. Mediciones', D: '30 min', E: '50 €', F: '', G: 'Aux. Piedad' } }] },
  ] });
  assert(p.rows.every(r => r.duration_info.minutes === 15 && r.professional === 'Dr. Camacho'));
  assert.equal(p.rows[0].raw_cells.C, '30 min'); assert.equal(p.rows[1].raw_cells.G, 'Aux. Piedad');
  assert.equal(p.rows[1].cabin, ''); assert(p.rows[1].issues.includes('CABIN_NOT_SPECIFIED'));
  assert(p.rows.every(r => r.client_reply_evidence[0].source_row === 16));
});

test('corporal answer does not assign an auxiliary to facial or capilar procedures', () => {
  const reply = clientReplies([{ name: 'Tratamientos', rows: [{ source_row: 13, cells: {
    B: 'Carboxiterapia / mesoterapia lipolítica / bioestimulación', E: 'LO HACE PIEDAD Y LA DURACION 10 MINUTOS' } }] }], 'reply-fixture');
  const p = buildCatalogPlan({ workbookHash: 'fixture', replies: reply, sheets: [
    { name: 'Tratamientos individuales', rows: [{ source_row: 2, cells: { A: 'INYECTABLES CORPORALES', B: 'Bioestimulación corporal · por zona', C: '45 min', D: '80 €', G: '11', H: 'Aux. Piedad' } }] },
    { name: 'Facial · tratamientos', rows: [{ source_row: 2, cells: cells('Carboxiterapia facial', 'Sesión suelta · 1 zona', '20-30 min', '80 €') }] },
    { name: 'Capilar · sesiones y bonos', rows: [{ source_row: 2, cells: { A: 'Carboxiterapia capilar', B: 'Sesión suelta', C: '10 min', D: '80 €', G: '10', H: 'Aux. Ainhoa' } }] },
  ] });
  assert.equal(p.rows[0].duration_info.minutes, 10);
  assert(p.rows[0].issues.includes('INJECTABLE_STAFF_REQUIRES_CLINICAL_VALIDATION'));
  assert.equal(p.rows[1].duration, '20-30 min'); assert.equal(p.rows[1].professional, 'Dr. Camacho');
  assert.equal(p.rows[2].professional, 'Aux. Ainhoa'); assert.equal(p.rows[2].client_reply_evidence.length, 0);
});

test('Mar answer resolves the named surgical nursing visit only, never capilar nursing', () => {
  const reply = clientReplies([{ name: 'Tratamientos', rows: [{ source_row: 17, cells: {
    B: 'Primera visita de enfermería', E: 'MAR UNOS 45 MINUTOS' } }] }], 'reply-fixture');
  const p = buildCatalogPlan({ workbookHash: 'fixture', replies: reply, sheets: [
    { name: 'Cirugía plástica · tarifa', rows: [{ source_row: 2, cells: { A: 'Consultas', B: 'Primera visita · enfermería', D: '45 min', E: '50 €', F: '3', G: '' } }] },
    { name: 'Capilar · sesiones y bonos', rows: [{ source_row: 2, cells: { A: 'Consultas', B: 'Consulta de valoración capilar · enfermería', C: '30 min', D: '50 €', G: '1', H: 'Aux. Ainhoa' } }] },
  ] });
  assert.equal(p.rows[0].professional, 'Mar'); assert.equal(p.rows[0].duration_info.minutes, 45);
  assert.equal(p.rows[0].professional_resolution[0].confirmed_id, null);
  assert.equal(p.rows[1].professional, 'Aux. Ainhoa'); assert.equal(p.rows[1].duration_info.minutes, 30);
});

test('combined administrative answers cover gastroscopy, bypass and balloon types without making followups administrative', () => {
  const reply = clientReplies([{ name: 'Tratamientos', rows: [
    { source_row: 38, cells: { B: 'Pruebas cruzadas / gastroscopia', E: 'CITA ADMINISTRATIVA' } },
    { source_row: 39, cells: { B: 'Balón ingerible / balón 6 meses / balón 12 meses', E: 'CITA ADMINISTRATIVA' } },
    { source_row: 40, cells: { B: 'Gastrectomía tubular / bypass gástrico', E: 'CITA ADMINISTRATIVA' } },
  ] }], 'reply-fixture');
  const p = buildCatalogPlan({ workbookHash: 'fixture', replies: reply, sheets: [{ name: 'Obesidad · tarifa', rows: [
    ['Pruebas', 'Gastroscopia'], ['Cirugía bariátrica', 'Bypass gástrico'], ['Balón intragástrico', 'Balón · 6 meses'],
    ['Incluido en el balón', 'Seguimiento médico · balón 6 meses · 9 sesiones'],
  ].map(([A, B], i) => ({ source_row: i + 2, cells: { A, B, C: '—', D: '100 €', G: '7', H: 'Dr. Camacho' } })) }] });
  assert(p.rows.slice(0, 3).every(r => r.booking_mode === 'administrative_review' && !r.ready_for_booking));
  assert.equal(p.rows[3].booking_mode, undefined); assert.equal(p.rows[3].kind, 'program');
});
