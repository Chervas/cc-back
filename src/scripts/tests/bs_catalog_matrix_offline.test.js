'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const { buildCatalogMatrix, tariffEvidence, matrixCsv, PDF_SOURCES } = require('../../lib/cliniccloud-import/catalog-matrix');

const sheet = (name, rows) => ({ name, rows: rows.map(([source_row, cells]) => ({ source_row, cells })) });
const fixture = () => ({ sheets: [sheet('Facial · tratamientos', [[54, { A: 'Polinucleótidos coreanos Rejuran', B: '1 vial · sesión suelta', C: '30-40 min', D: '390 €', G: '7', H: 'Dra. Camacho' }]])], workbookHash: 'synthetic',
    replySheets: [sheet('Precios y documentos', [[8, { B: 'Rejuran · sesión suelta', E: '250 € sesión' }]])], repliesHash: 'reply',
    pdfs: [{ file: 'synthetic.pdf', sha256: 'pdf', area: 'facial', role: 'tariff', pages: [' POLINUCLEÓTIDOS REJURAN\n                         390 €\n Por vial · bono de 3: 1.050 €\n'] }],
    bindings: [{ sheet: 'Facial · tratamientos', row: 54, file: 'synthetic.pdf', page: 1, label: 'POLINUCLEÓTIDOS REJURAN', role: 'primary', units: null }] });

test('October price overrides only linked price; identity and unknown/range duration survive', () => {
    const input = fixture(); const before = JSON.stringify(input); const matrix = buildCatalogMatrix(input); const row = matrix.rows[0];
    assert.equal(row.source_gross_amount, 250); assert.equal(row.october_gross_amount, 390); assert.equal(row.effective_from, '2026-10-01');
    assert.equal(row.vat_rate, 21); assert.equal(JSON.parse(row.duration_json).minutes, null);
    assert.equal(row.proposed_action, 'preflight_required_no_write'); assert.equal(matrix.summary.ready_for_activation, false);
    const withoutPdf = buildCatalogMatrix({ ...input, pdfs: [], bindings: [] }); assert.equal(row.code, withoutPdf.rows[0].code);
    assert.equal(JSON.stringify(input), before); assert.equal(matrixCsv(matrix), matrixCsv(buildCatalogMatrix(input)));
});
test('line and page hashes trace the selected price; raw workbook/reply remain provenance', () => {
    const matrix = buildCatalogMatrix(fixture()); const refs = JSON.parse(matrix.rows[0].source_references_json);
    assert.equal(refs.length, 3); assert.equal(refs[2].page, 1); assert.equal(refs[2].line, 2);
    assert.equal(refs[2].page_sha256, hash(fixture().pdfs[0].pages[0])); assert.match(refs[2].quote, /390 €/);
    assert.equal(matrix.summary.coverage.price_evidence_lines, 2); assert.equal(matrix.summary.coverage.linked_price_evidence_lines, 1);
});
test('session and bono are separate units; additional offers never add a second treatment', () => {
    const input = { sheets: [sheet('Tratamientos individuales', [[18, { A: 'INDIBA', B: 'Corporal', C: '45 min', D: '90 €', E: '380 €', F: '720 €', G: '1', H: 'Aux. Persona' }]])], workbookHash: 'synthetic',
        pdfs: [{ file: 'body.pdf', sha256: 'body', area: 'corporal', role: 'tariff', pages: [' INDIBA CORPORAL (45 MINUTOS)\n       90 €\n Bono 5: 380 € · bono 10: 720 €\n'] }],
        bindings: [null, 5, 10].map(units => ({ sheet: 'Tratamientos individuales', row: 18, file: 'body.pdf', page: 1, label: 'INDIBA CORPORAL', role: units ? 'voucher' : 'primary', units })) };
    const matrix = buildCatalogMatrix(input); const rows = matrix.rows.filter(r => ['concept', 'voucher_offer'].includes(r.record_type));
    assert.deepEqual(rows.map(r => r.october_gross_amount), [90, 380, 720]); assert.equal(matrix.summary.by_concept_kind.treatment, 1);
    assert.deepEqual(rows.map(r => r.quantity), ['', 5, 10]); assert.equal(matrix.summary.coverage.offers_with_october_price, 2);
});
test('dated duration is literal evidence, not a silent override of the earlier clinical answer', () => {
    const input = fixture(); input.sheets[0].rows[0].cells.C = '15 min'; input.replySheets = [];
    input.pdfs[0].pages[0] = ' POLINUCLEÓTIDOS REJURAN (30 MINUTOS)\n          390 €\n';
    const row = buildCatalogMatrix(input).rows[0]; assert.equal(JSON.parse(row.duration_json).minutes, 15);
    assert.equal(JSON.parse(row.october_duration_evidence_json)[0].raw, '30 MINUTOS');
    assert.ok(JSON.parse(row.pending_json).includes('OCTOBER_DOCUMENTED_DURATION_REQUIRES_RECONCILIATION'));
});
test('unknown and included prices are not zero; old price absence does not retire a concept', () => {
    const input = fixture(); input.sheets[0].rows[0].cells.D = 'Pendiente'; input.replySheets = [];
    input.pdfs[0].pages = [' OTRO SERVICIO\n       190 €\n']; const row = buildCatalogMatrix(input).rows[0];
    assert.equal(row.source_gross_amount, ''); assert.equal(row.october_gross_amount, ''); assert.equal(row.proposed_action, 'preflight_required_no_write');
    input.pdfs[0].pages = [' POLINUCLEÓTIDOS REJURAN\n           Incluida\n']; const included = buildCatalogMatrix(input).rows[0];
    assert.equal(included.october_price_mode, 'included'); assert.equal(included.october_gross_amount, '');
    assert.ok(JSON.parse(included.pending_json).includes('INCLUDED_IS_NOT_STANDALONE_FREE'));
});
test('before/after, variants, discounts and multiple table columns are not guessed', () => {
    const pdf = { file: 'table.pdf', sha256: 'table', pages: ['SERVICIO\n Antes 250 € · ahora 390 €\n FAC-02   Ácido hialurónico   30 min   230 / 250 / 300 €   Por vial\n FAC-08   Rejuran   30-40 min   390 €   1.050 €\n -100 €\n'] };
    const rows = tariffEvidence(pdf); assert.equal(rows.length, 4);
    assert.equal(rows[0].primary, null); assert.equal(rows[1].primary, null); assert.equal(rows[2].primary.price.gross_amount, 390); assert.equal(rows[3].primary, null);
});
test('inline included/free fields and coded free row retain their own heading, not a preceding treatment', () => {
    const pdf = { file: 'table.pdf', sha256: 'table', pages: ['CONSULTAS\n CONSULTA DE REVISIÓN (15 MINUTOS)          Incluida\n FAC-01   Consulta médica   15 min   Gratuita   —\n'] };
    const rows = tariffEvidence(pdf); assert.equal(rows.length, 2);
    assert.equal(rows[0].label, 'CONSULTA DE REVISIÓN (15 MINUTOS)'); assert.equal(rows[0].primary.price.mode, 'included');
    assert.equal(rows[1].label, 'Consulta médica'); assert.equal(rows[1].primary.price.gross_amount, 0);
});
test('conflicting linked prices are explicit pending, never first wins', () => {
    const input = fixture(); input.pdfs[0].pages[0] += ' POLINUCLEÓTIDOS REJURAN\n          410 €\n'; const row = buildCatalogMatrix(input).rows[0];
    assert.equal(row.october_gross_amount, ''); assert.ok(JSON.parse(row.pending_json).includes('OCTOBER_PRICE_CONFLICT_OR_VARIANT'));
});
test('legacy withdrawal does not imply equivalence or deletion; Groupon retains sold entitlement', () => {
    const input = fixture(); input.replySheets = [sheet('Nombres antiguos', [[10, { A: 'Vieja', B: 'Banda gástrica', D: 'ELIMINAR' }],
        [14, { B: 'Groupon 3', D: 'QUEDAN 23 VENDIDOS Y YA ESTAMOS DE BAJA CON ELLOS' }], [52, { B: 'Injerto capilar', D: 'NO ENTIENDO' }]])];
    const rows = buildCatalogMatrix(input).rows.filter(r => r.record_type === 'legacy_reference');
    assert.equal(rows[0].equivalent_new_name, ''); assert.match(rows[0].proposed_action, /^explicit_offer_retirement/);
    assert.match(rows[1].proposed_action, /keep_sold_entitlements/); assert.equal(rows[2].proposed_action, 'no_write');
    assert.ok(rows.every(r => r.scope === 'history_and_entitlements_preserved'));
});
test('an unanchored "lo mismo" reply never invents retirement or a sold entitlement', () => {
    const input = fixture(); input.replySheets = [sheet('Nombres antiguos', [[15, { B: 'Otro tratamiento', D: 'LO MISMO' }]])];
    const row = buildCatalogMatrix(input).rows.find(r => r.record_type === 'legacy_reference'); assert.equal(row.proposed_action, 'no_write');
});
test('CSV quotes every cell, preserves quotes/newlines and blocks formula injection', () => {
    const matrix = { rows: [{ record_type: 'concept', name: '=HYPERLINK("x")\nsegunda;línea' }] }; const csv = matrixCsv(matrix);
    assert.ok(csv.startsWith('\ufeff')); assert.match(csv, /"'=HYPERLINK\(""x""\)\nsegunda;línea"/);
});
test('programmes excluded, manuals inventoried without turning old annex into price', () => {
    const input = fixture(); input.sheets = [sheet('Facial · programas', [[3, { A: 'Programas', B: 'Programa X', C: '3 citas', D: '3 × 30 min', E: '250 €', F: '7', G: 'Dra. Persona' }]])];
    input.pdfs.push({ file: 'manual.pdf', sha256: 'manual', role: 'manual', area: 'facial', pages: [' Programa X 99 €\n'] }); input.bindings = [];
    const matrix = buildCatalogMatrix(input); assert.equal(matrix.rows[0].scope, 'excluded_new_programs'); assert.equal(matrix.rows[0].october_gross_amount, '');
    assert.equal(matrix.summary.coverage.manual_pages_inventoried, 1); assert.equal(matrix.summary.coverage.price_evidence_lines, 2);
});
test('patient sources prohibited and CLI has no runtime/database/network pathway', () => {
    assert.throws(() => buildCatalogMatrix({ sheets: [sheet('Pacientes', [])], workbookHash: 'x' }), /PATIENT_SOURCE_FORBIDDEN/);
    assert.throws(() => buildCatalogMatrix({ sheets: [{ name: 'Tratamientos individuales', rows: [{ patient_id: 1, cells: {} }] }], workbookHash: 'x' }), /PATIENT_SOURCE_FORBIDDEN/);
    const cli = fs.readFileSync(path.resolve(__dirname, '../bs-catalog-matrix-offline.js'), 'utf8');
    assert.doesNotMatch(cli, /require\(['"](?:sequelize|mysql2|axios|https?|.*operator-database|.*models\/)/);
    assert.match(cli, /O_EXCL \| fs.constants.O_NOFOLLOW/); assert.equal(PDF_SOURCES.filter(s => s.role === 'tariff').reduce((n, s) => n + s.pages, 0), 49);
    assert.equal(PDF_SOURCES.filter(s => s.role === 'manual').reduce((n, s) => n + s.pages, 0), 204);
});
