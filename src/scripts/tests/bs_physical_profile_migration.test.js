'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const { buildBsPhysicalProfileMigrationPlan: build, verifyPhysicalPlan, validatePhysicalStoragePatch } = require('../../lib/cliniccloud-import/bs-physical-profile-migration-plan');
const { verifyPlan: verifyCommercialPlan } = require('../../lib/cliniccloud-import/bs-catalog-migration-apply');
const { executeBsPhysicalProfileMigration, verifyPhysicalAuthorization } = require('../../lib/cliniccloud-import/bs-physical-profile-migration-apply');
const { fixture, inputFor, authorization, NOW, seal, copy } = require('./helpers/owned-bs-physical-migration-fixture');

test('dedicated plan preserves every field except a truly missing physical profile, including explicit JSON null', () => {
    for (const explicitNull of [false, true]) {
        const h = fixture({ explicitNull }), input = inputFor(h), before = hash(input), plan = build(input);
        assert.equal(verifyPhysicalPlan(plan, input), true); assert.equal(hash(input), before);
        assert.equal(plan.operations.length, 1); const op = plan.operations[0];
        assert.deepEqual(plan.field_whitelist, ['clinical_config.booking_profile']);
        assert.equal(op.after.activo, 0); assert.equal(op.after.clinical_config.catalog_status, 'draft');
        assert.deepEqual(op.after.clinical_config.other_clinic_decision, { preserve: 'sí' });
        assert.equal(op.after.clinical_config.booking_profile.phases[0].duration_minutes, null);
        assert.deepEqual(op.changes[0].before, explicitNull ? { present: true, value: null } : { present: false });
        assert.throws(() => verifyCommercialPlan(plan, input), /BS_CATALOG_PLAN_VERSION_INVALID/);
    }
});
test('matrix file labels augment provenance without changing the four exact workbook/sheet/row/hash identity fields', () => {
    const h = fixture(), refs = JSON.parse(h.rows[0].source_references_json);
    refs[0].file = 'BASE_DE_DATOS_TRATAMIENTOS_BS_MEDICAL_v2.xlsx'; h.rows[0].source_references_json = JSON.stringify(refs);
    assert.equal(build(inputFor(h)).operations.length, 1);
});
test('v5 readiness/proposals can_apply=false cannot authorize physical writes without an explicit recipe review', async () => {
    const input = inputFor(fixture()); delete input.recipeReview;
    assert.equal(input.reconciliation.proposals[0].policy.can_apply, false);
    assert.throws(() => build(input), /BS_PHYSICAL_RECIPE_APPROVAL_REQUIRED/);
    let called = false;
    await assert.rejects(executeBsPhysicalProfileMigration({ plan: input.reconciliation, sourceInputs: input,
        store: { verifyScope() { called = true; } } }), /BS_PHYSICAL_/);
    assert.equal(called, false);
});
test('recipe approval binds exact row, source, reviewer, equipment, team and attention without activation', () => {
    for (const edit of [r => { r.approved = false; }, r => { r.source.source_row++; },
        r => { r.decisions.equipment = 'inferred_none'; }, r => { r.decisions.clinical_team_approved = false; },
        r => { r.decisions.staff_attention_approved = false; }, r => { r.decisions.no_activation_or_snapshot_changes = false; },
        r => { r.evidence.reason = 'Sin prueba'; r.evidence_sha256 = hash(r.evidence); },
        r => { r.booking_profile.phases[0].installation_ids = [999]; }, r => { r.booking_profile.phases[0].duration_minutes = 30; }]) {
        const input = inputFor(fixture()); edit(input.recipeReview.recipes[0]);
        const { review_sha256, ...body } = input.recipeReview; input.recipeReview = seal(body, 'review_sha256');
        assert.throws(() => build(input), /BS_PHYSICAL_/);
    }
});
test('existing profiles and unsupported quantity, range, multiday or included recipes cannot be migrated through this contract', () => {
    for (const kind of ['quantity_formula', 'bounded_manual_duration', 'surgical_visit_plan', 'included_component_visit_definition']) {
        const input = inputFor(fixture()); input.reconciliation.records[0].authoring_readiness.recipe_kind = kind;
        const { plan_sha256, ...body } = input.reconciliation; input.reconciliation = seal(body, 'plan_sha256');
        const { review_sha256, ...review } = input.recipeReview; review.reconciliation_plan_sha256 = input.reconciliation.plan_sha256;
        input.recipeReview = seal(review, 'review_sha256'); assert.throws(() => build(input), /RECONCILIATION_NOT_REPRODUCIBLE/);
    }
    const input = inputFor(fixture()); input.preflight.snapshot.treatments[0].clinical_config.booking_profile = { version: 1, phases: [] };
    assert.throws(() => build(input), /BS_PHYSICAL_/);
});
test('machinery uses exact current inventory and existing attention cannot be silently weakened', () => {
    const h = fixture({ equipment: true }), input = inputFor(h, { equipment: true }); assert.equal(build(input).operations.length, 1);
    input.recipeReview.recipes[0].booking_profile.version = 4;
    Object.assign(input.recipeReview.recipes[0].booking_profile.phases[0], { start_offset_minutes: 0,
        staff_attention: [{ mode: 'start_only', start_minutes: 5, start_window_minutes: 10 }] });
    const { review_sha256, ...body } = input.recipeReview; input.recipeReview = seal(body, 'review_sha256');
    assert.throws(() => build(input), /EXISTING_ATTENTION_NOT_PRESERVED/);
    const invalid = fixture({ equipment: true });
    invalid.snapshot.equipment[0].attention_policy = { mode: 'start_end', start_minutes: null };
    assert.throws(() => build(inputFor(invalid, { equipment: true })), /EXISTING_ATTENTION_POLICY_INVALID/);
});
test('self-rehashed readiness cannot turn an unquantified source into invented fixed minutes', () => {
    const input = inputFor(fixture());
    Object.assign(input.reconciliation.records[0].duration, { kind: 'fixed', fixed_minutes: 60 });
    input.reconciliation.records[0].authoring_readiness.recipe_kind = 'fixed_duration_act';
    const { plan_sha256, ...body } = input.reconciliation; input.reconciliation = seal(body, 'plan_sha256');
    const { review_sha256, ...review } = input.recipeReview; review.reconciliation_plan_sha256 = input.reconciliation.plan_sha256;
    review.recipes[0].booking_profile.phases[0].duration_minutes = 60; input.recipeReview = seal(review, 'review_sha256');
    assert.throws(() => build(input), /RECONCILIATION_NOT_REPRODUCIBLE/);
});
test('rehashing a changed plan or attempting an activation/provenance patch cannot bypass verification', () => {
    const input = inputFor(fixture()), plan = build(input);
    const changed = copy(plan); changed.operations[0].after.activo = 1;
    const { operation_sha256, ...operation } = changed.operations[0]; changed.operations[0] = seal(operation, 'operation_sha256');
    const { plan_sha256, ...body } = changed; const forged = seal(body, 'plan_sha256');
    assert.throws(() => verifyPhysicalPlan(forged, input), /NOT_REPRODUCIBLE/);
    assert.throws(() => validatePhysicalStoragePatch({ op: forged.operations[0], current: plan.operations[0].before,
        target: forged.operations[0].after, direction: 'forward' }), /BS_PHYSICAL_STORAGE_/);
});
test('the direct physical storage boundary rejects a resealed malformed after-profile', () => {
    const plan = build(inputFor(fixture())), op = copy(plan.operations[0]);
    op.after.clinical_config.booking_profile = { arbitrary: 'malformed' };
    op.changes[0].after.value = copy(op.after.clinical_config.booking_profile);
    op.changes[0].after_sha256 = hash(op.changes[0].after);
    const { operation_sha256, ...body } = op;
    assert.throws(() => validatePhysicalStoragePatch({ op: seal(body, 'operation_sha256'), current: op.before,
        target: op.after, direction: 'forward' }), /BS_PHYSICAL_STORAGE_STRICT_PROFILE_REQUIRED/);
});
test('fresh scoped execution approval is separate from recipe review and commercial approval', () => {
    const plan = build(inputFor(fixture())), auth = authorization(plan);
    assert.doesNotThrow(() => verifyPhysicalAuthorization({ plan, ...auth, direction: 'forward', now: NOW }));
    for (const edit of [a => { a.approval.version = 'bs-catalog-operator-approval/1'; },
        a => { a.approval.recipe_review_sha256 = hash('another review'); }, a => { a.approval.no_activation_or_appointment_history_changes = false; },
        a => { a.backup.database = 'other'; }, a => { a.approval.expires_at = NOW.toISOString(); }]) {
        const value = copy(auth); edit(value);
        assert.throws(() => verifyPhysicalAuthorization({ plan, ...value, direction: 'forward', now: NOW }), /SCOPED_APPROVAL/);
    }
    assert.throws(() => verifyPhysicalAuthorization({ plan, ...auth, direction: 'forward', now: NOW, recovery: true }), /SCOPED_APPROVAL/);
});
test('CLI physical modes retain offline default and validate original inputs and scoped authority before live connection', () => {
    const cli = fs.readFileSync(require.resolve('../bs-catalog-migration-apply'), 'utf8');
    const authorization = cli.indexOf('authorize({ plan, approval, backup'), connection = cli.indexOf("connectOperatorDatabase('crm')");
    assert(authorization > 0 && authorization < connection);
    assert(cli.includes("const mode = o['--mode'] || 'dry-run'"));
    assert(cli.includes('physical.verifyPhysicalPlan'));
    for (const option of ['--physical-reconciliation', '--physical-recipe-review', '--physical-source-plan', '--physical-resource-map']) assert(cli.includes(option));
    assert(!cli.includes('dotenv.config'));
});
