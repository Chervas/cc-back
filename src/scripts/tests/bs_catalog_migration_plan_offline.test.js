'use strict';
// Fictional catalogue fixtures only. No database, browser, network or writes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const { WORKBOOK_SHA, PDF_SOURCES } = require('../../lib/cliniccloud-import/catalog-matrix');
const { VERSION: PREFLIGHT_VERSION, reconcileCatalog } = require('../../lib/cliniccloud-import/catalog-preflight');
const { PROFILE, FIELD_WHITELIST, buildBsCatalogMigrationPlan, assessCommercialOperation } = require('../../lib/cliniccloud-import/bs-catalog-migration-plan');
const copy = value => JSON.parse(JSON.stringify(value));

function fixture() {
    const pdf = PDF_SOURCES.find(source => source.role === 'tariff');
    const matrixRows = Array.from({ length: 167 }, (_, index) => {
        const key = hash(['fictitious-concept', index]);
        return { record_type: 'concept', kind: 'treatment', matrix_key: key, code: `BS26-${key.slice(0, 20)}`,
            clinic: index % 2 ? 'BS Capilar' : 'BS Medical', name: `Tratamiento ficticio ${index}`,
            source_references_json: JSON.stringify([
                { file_sha256: WORKBOOK_SHA, sheet: 'Ficha ficticia', source_row: index + 3, row_sha256: hash(['source-row', index]) },
                { field: 'october_price', role: 'primary', file: pdf.file, file_sha256: pdf.sha256,
                    page: 1, page_sha256: hash('literal page'), line: index + 1, quote: '80 €', label: `Ficticio ${index}` },
            ]), pending_json: index === 1 ? '["DURATION_REQUIRES_CONFIGURATION"]' : '[]',
            october_price_mode: 'fixed', october_gross_amount: '80', october_price_raw: '80 €',
            effective_from: '2026-10-01', vat_rate: '21', gross_includes_tax: 'true' };
    });
    const treatments = matrixRows.map((row, index) => ({ id_tratamiento: 10000 + index, codigo: row.code,
        clinica_id: index % 2 ? 66 : 72, grupo_clinica_id: null, origen: 'clinica', nombre: row.name,
        descripcion: 'Descripción conservada', duracion_min: 30, sesiones_defecto: 1,
        precio_base: '80.00', activo: 1, createdAt: '2030-01-01 00:00:00', updatedAt: '2030-01-02 00:00:00',
        appointment_automation_template_key: 'existing_binding_unchanged',
        clinical_config: { source_catalog_key: row.matrix_key, source_catalog: JSON.parse(row.source_references_json)[0],
            source_price: { mode: 'fixed', gross_amount: 80, currency: 'EUR', includes_tax: true },
            catalog_status: 'active', fiscal_mapping_pending: false, price_profile: { ...PROFILE },
            imported_price_review: { version: 1, reviewed_by: 99, gross_amount: 80 },
            booking_profile: { version: 1, phases: [{ key: 'care', duration_minutes: 30, installation_ids: [9],
                professionals: { mode: 'any', ids: [8], preferred_id: 8 } }] },
            clinic_owned_unknown_configuration: { marker: 'preserved', nested: [1, 2] } } }));
    treatments[0].precio_base = '70.00';
    treatments[0].clinical_config.imported_price_review.gross_amount = 70;
    treatments[1].precio_base = null; treatments[1].activo = 0;
    treatments[1].clinical_config.catalog_status = 'draft'; treatments[1].clinical_config.fiscal_mapping_pending = true;
    delete treatments[1].clinical_config.price_profile; delete treatments[1].clinical_config.imported_price_review;
    Object.assign(matrixRows[2], { october_price_mode: 'from', october_price_raw: 'Desde 50 €', october_gross_amount: '50' });
    Object.assign(matrixRows[3], { october_price_mode: 'included', october_price_raw: 'Incluido', october_gross_amount: '' });
    Object.assign(matrixRows[4], { october_price_mode: '', october_price_raw: '50 a 70 €', october_gross_amount: '' });
    treatments[5].clinical_config.catalog_badge = 'Etiqueta clínica propia';
    treatments[6].clinical_config.price_profile = { ...PROFILE, tax_percent: 0, exemption_reason: 'Decisión explícita anterior' };
    treatments[6].precio_base = '70.00';
    delete treatments[7].clinical_config.source_catalog_key;
    while (matrixRows.length < 895) matrixRows.push({ record_type: 'source_manifest', matrix_key: hash(['inventory', matrixRows.length]) });
    const snapshot = { clinics: [{ id_clinica: 66, grupoClinicaId: 29 }, { id_clinica: 72, grupoClinicaId: 29 }],
        triggers: [], treatments, consent_requirements: [{ id: 1, tratamiento_id: 10000 }],
        protocols: [{ id: 2, treatment_ids: '[10000]' }] };
    const preflight = { version: PREFLIGHT_VERSION, target: 'crm', mode: 'read_only', group_id: 29,
        created_at: '2030-01-03T12:00:00.000Z', matrix_file_sha256: hash('fixture-matrix'), snapshot,
        snapshot_sha256: hash(snapshot), reconciliation: reconcileCatalog(matrixRows, snapshot),
        policy: { database_written: false, patient_rows_exported: false, application_bootstrapped: false,
            reminders_sent: false, protocols_approved: false, treatments_activated: false, existing_entitlements_unchanged: true } };
    return { matrixRows, preflight, matrixFileSha256: preflight.matrix_file_sha256, snapshotFileSha256: hash(preflight) };
}
const build = input => buildBsCatalogMigrationPlan(input || fixture());

test('planner reuses exact existing identities and is deterministic without changing its inputs', () => {
    const input = fixture(), before = JSON.stringify(input);
    const first = build(input), second = build(input);
    assert.equal(JSON.stringify(first), JSON.stringify(second)); assert.equal(JSON.stringify(input), before);
    assert.equal(first.summary.individual_sources, 167); assert.equal(first.summary.treatments_created, 0);
    assert.equal(first.summary.exact_existing_treatments_reused, 167);
    assert.equal(first.summary.early_source_keys_missing_preserved, 1);
    assert.equal(first.operations.find(op => op.treatment_id === 10007).after.clinical_config.source_catalog_key, undefined);
    assert.equal(first.summary.database_read, false); assert.equal(first.summary.catalogue_activated, false);
    const { plan_sha256, ...body } = first; assert.equal(hash(body), plan_sha256);
});
test('only whitelisted commercial leaves change; every unrelated clinical/identity/approval field remains intact', () => {
    const plan = build();
    for (const op of plan.operations) {
        assert(op.changes.every(change => FIELD_WHITELIST.includes(change.path)));
        for (const key of ['activo', 'codigo', 'nombre', 'duracion_min', 'clinica_id', 'sesiones_defecto', 'appointment_automation_template_key', 'updatedAt']) {
            assert.deepEqual(op.after[key], op.before[key], key);
        }
        for (const key of ['source_catalog', 'source_price', 'source_catalog_key', 'booking_profile', 'catalog_status', 'fiscal_mapping_pending', 'imported_price_review', 'clinic_owned_unknown_configuration']) {
            assert.deepEqual(op.after.clinical_config[key], op.before.clinical_config[key], key);
        }
    }
});
test('October fixed gross amount is authoritative, including zero, never multiplied by provisional VAT', () => {
    const input = fixture();
    Object.assign(input.matrixRows[0], { october_gross_amount: '0', october_price_raw: 'Gratuita' });
    const op = build(input).operations.find(row => row.treatment_id === 10000);
    assert.equal(op.after.precio_base, '0.00'); assert.deepEqual(op.after.clinical_config.price_profile, PROFILE);
    assert.equal(op.after.clinical_config.source_price.gross_amount, 80);
    assert.equal(op.after.clinical_config.imported_price_review.gross_amount, 70, 'do not manufacture a fresh approval');
});
test('fiscal-held draft prices are preparation proposals only; hold, inactivity, profile and unapproved review stay unchanged', () => {
    const op = build().operations.find(row => row.treatment_id === 10001);
    assert.equal(op.after.precio_base, 80); assert.deepEqual(op.after.clinical_config.price_profile, PROFILE);
    assert.equal(op.after.clinical_config.fiscal_mapping_pending, true); assert.equal(op.after.activo, 0);
    assert.equal(op.after.clinical_config.catalog_status, 'draft'); assert.equal(op.after.clinical_config.imported_price_review, undefined);
    assert.equal(op.price_stage, 'documented_draft_price_preparation_fiscal_hold_preserved');
});
test('missing/null price profiles and unrelated future profile properties are handled without collateral deletion', () => {
    const input = fixture(); input.preflight.snapshot.treatments[1].clinical_config.price_profile = null;
    input.preflight.snapshot.treatments[0].clinical_config.price_profile.future_property = { keep: true };
    input.preflight.snapshot_sha256 = hash(input.preflight.snapshot);
    input.preflight.reconciliation = reconcileCatalog(input.matrixRows, input.preflight.snapshot);
    const plan = build(input);
    assert.deepEqual(plan.operations.find(op => op.treatment_id === 10001).after.clinical_config.price_profile, PROFILE);
    assert.deepEqual(plan.operations.find(op => op.treatment_id === 10000).after.clinical_config.price_profile.future_property, { keep: true });
});
test('from, included and range/unlinked evidence never becomes a fixed price', () => {
    const plan = build();
    for (const id of [10002, 10003, 10004]) {
        const op = plan.operations.find(row => row.treatment_id === id);
        assert.equal(op.after.precio_base, op.before.precio_base);
        assert.equal(op.changes.some(change => change.path.includes('precio') || change.path.includes('price_profile')), false);
    }
});
test('human fiscal choices and custom badges are retained, not overwritten by a generic import proposal', () => {
    const plan = build(); assert.equal(plan.operations.some(op => op.treatment_id === 10005), false);
    const op = plan.operations.find(row => row.treatment_id === 10006);
    assert.equal(op.after.precio_base, '70.00'); assert.deepEqual(op.after.clinical_config.price_profile, op.before.clinical_config.price_profile);
    assert(plan.commercial_pending.some(row => row.code === 'EXISTING_FISCAL_DECISION_REQUIRES_REVIEW'));
    assert(plan.commercial_pending.some(row => row.code === 'EXISTING_CUSTOM_BADGE_PRESERVED'));
});
test('wrong or ambiguous tariff reference never falls back to a September fixed source amount', () => {
    for (const mutate of [row => { row.effective_from = '2026-09-01'; }, row => { row.vat_rate = '0'; },
        row => { row.october_price_raw = 'Desde 80 €'; }, row => { row.october_gross_amount = ''; },
        row => { const refs = JSON.parse(row.source_references_json); refs[1].role = 'voucher'; row.source_references_json = JSON.stringify(refs); },
        row => { const refs = JSON.parse(row.source_references_json); refs[1].file_sha256 = hash('changed-document'); row.source_references_json = JSON.stringify(refs); }]) {
        const input = fixture(); mutate(input.matrixRows[0]);
        const op = build(input).operations.find(row => row.treatment_id === 10000);
        assert.equal(op.after.precio_base, '70.00'); assert.equal(op.changes.length, 1);
    }
});
test('nonstandalone policy is never converted or approved by a price proposal', () => {
    const input = fixture(); input.preflight.snapshot.treatments[0].clinical_config.commercial = { sale_mode: 'program_component_only' };
    input.preflight.snapshot_sha256 = hash(input.preflight.snapshot);
    input.preflight.reconciliation = reconcileCatalog(input.matrixRows, input.preflight.snapshot);
    const op = build(input).operations.find(row => row.treatment_id === 10000);
    assert.equal(op.after.precio_base, '70.00'); assert.deepEqual(op.after.clinical_config.commercial, { sale_mode: 'program_component_only' });
});
test('changed inventory hash, reconciliation, identity, target or read-only guarantees fail closed; no treatment is created', () => {
    for (const mutate of [input => { input.preflight.snapshot.treatments[0].nombre = 'Later edit'; },
        input => { input.preflight.reconciliation.records[0].treatment_id++; },
        input => { input.preflight.target = 'dev'; }, input => { input.preflight.policy.database_written = true; },
        input => { input.matrixFileSha256 = hash('wrong-file'); }, input => { input.matrixRows.pop(); },
        input => { input.preflight.snapshot.treatments[0].codigo = 'same-name-not-source'; input.preflight.snapshot_sha256 = hash(input.preflight.snapshot); }]) {
        const input = fixture(); mutate(input); assert.throws(() => build(input));
    }
});
test('forward CAS detects any later row edit and replay is a no-write even after timestamp changes', () => {
    const input = fixture(), op = build(input).operations.find(row => row.treatment_id === 10000);
    const observed = input.preflight.snapshot.treatments[0]; const before = JSON.stringify(observed);
    assert.deepEqual(assessCommercialOperation(op, observed), { decision: 'before_state_matches_reviewed_proposal', write_permitted: false, cas_matches: true });
    for (const edit of [row => { row.descripcion = 'Later human description'; }, row => { row.updatedAt = '2030-01-04 00:00:00'; },
        row => { row.clinical_config.clinic_owned_unknown_configuration.marker = 'later'; }, row => { row.precio_base = '75.00'; }]) {
        const current = copy(observed); edit(current);
        assert.equal(assessCommercialOperation(op, current).decision, 'current_row_changed_stop');
    }
    const applied = copy(op.after); applied.updatedAt = '2030-01-04 00:00:00';
    assert.equal(assessCommercialOperation(op, applied).decision, 'already_at_proposed_state_no_write');
    assert.equal(JSON.stringify(observed), before);
});
test('rollback requires a durable full applied-row receipt and cannot overwrite later human edits, including timestamps', () => {
    const op = build().operations.find(row => row.treatment_id === 10000), applied = copy(op.after);
    applied.updatedAt = '2030-01-04 00:00:00';
    assert.equal(assessCommercialOperation(op, applied, { direction: 'rollback' }).decision, 'rollback_requires_durable_applied_receipt');
    const appliedReceipt = { operation_sha256: op.operation_sha256, after_row_sha256: hash(applied) };
    assert.deepEqual(assessCommercialOperation(op, applied, { direction: 'rollback', appliedReceipt }),
        { decision: 'applied_state_matches_inverse_proposal', write_permitted: false, cas_matches: true });
    for (const edit of [row => { row.updatedAt = '2030-01-05 00:00:00'; }, row => { row.clinical_config.catalog_badge = 'Human badge'; },
        row => { row.clinical_config.booking_profile.phases[0].duration_minutes = 45; }, row => { row.nombre = 'Human name'; }]) {
        const current = copy(applied); edit(current);
        assert.equal(assessCommercialOperation(op, current, { direction: 'rollback', appliedReceipt }).decision, 'later_row_change_prevents_rollback');
    }
    assert.equal(assessCommercialOperation(op, op.before, { direction: 'rollback' }).decision, 'already_at_before_state_no_write');
});
test('operation integrity and whitelist are checked before any simulation decision', () => {
    const op = build().operations[0], changed = copy(op); changed.after.activo = 0;
    assert.throws(() => assessCommercialOperation(changed, op.before), /BS_PLAN_OPERATION_INVALID/);
    const forbidden = copy(op); forbidden.changes.push({ path: 'clinical_config.booking_profile' });
    delete forbidden.operation_sha256; forbidden.operation_sha256 = hash(forbidden);
    assert.throws(() => assessCommercialOperation(forbidden, op.before), /BS_PLAN_OPERATION_INVALID/);
});
test('legacy analysis has no retirement/equivalence operation and describes a server-verified continuation-only contract', () => {
    const input = fixture(); input.preflight.snapshot.treatments.push({ id_tratamiento: 9999, codigo: 'CCLOUD-fixture',
        nombre: 'Antiguo ficticio', clinica_id: 72, activo: 1, clinical_config: {} });
    input.preflight.snapshot_sha256 = hash(input.preflight.snapshot);
    const plan = build(input), legacy = plan.legacy_visibility_analysis;
    assert.equal(legacy.inventory.length, 1); assert.equal(legacy.inventory[0].retirement_candidate, false);
    assert.equal(plan.operations.some(op => op.treatment_id === 9999), false);
    assert.equal(plan.summary.legacy_retirement_operations, 0);
    assert.equal(legacy.proposed_contract_not_implemented.client_intent_is_not_authority, true);
    assert.equal(legacy.proposed_contract_not_implemented.active_and_catalog_status_unchanged, true);
    assert(legacy.consumer_evidence.some(row => /Purchased continuation/.test(row.finding)));
});
test('CLI is offline, outputs aggregates only and reuses exclusive private 0600 creation with no overwrite flag', () => {
    const cli = fs.readFileSync(path.resolve(__dirname, '../bs-catalog-migration-plan-offline.js'), 'utf8');
    const io = fs.readFileSync(path.resolve(__dirname, '../../lib/cliniccloud-import/io.js'), 'utf8');
    assert.doesNotMatch(cli, /require\([^\n]*(?:models|sequelize|mysql|dotenv|services|https?)/i);
    assert.match(cli, /writePrivateJson\(options\['--private-output'\], plan\)/);
    assert.match(cli, /return \{ \.\.\.plan.summary, plan_sha256:/);
    assert.doesNotMatch(cli, /--apply|--overwrite|--force/);
    assert.match(io, /O_EXCL/); assert.match(io, /O_NOFOLLOW, 0o600/);
    const run = require('../bs-catalog-migration-plan-offline').run;
    assert.throws(() => run(['--apply', 'true']), /INVALID_CLI_ARGUMENTS/);
});
