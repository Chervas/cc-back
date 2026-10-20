'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const P = require('../../lib/cliniccloud-import/bs-contorno-cor43-closure');
const catalog = require('../../lib/treatment-catalog-contract');
const copy = value => JSON.parse(JSON.stringify(value));

function fixture() {
  return {
    snapshot: { target: 'crm', group_id: 29, clinic_id: 72, captured_at: '2026-10-20T15:00:00.000Z', configuration_sha256: 'c'.repeat(64),
      treatment: { id_tratamiento: 2122, codigo: P.CODE, nombre: P.NAME, origen: 'clinica', clinica_id: 72, grupo_clinica_id: null,
        activo: 0, precio_base: null, duracion_min: 45, sesiones_defecto: 1, color: null, disciplina: 'estetica',
        descripcion: 'Source notes and qualification caveats must remain exactly as received.',
        asignacion_instalacion_tipo: 'cualquiera', instalaciones_habilitadas: null,
        createdAt: '2026-09-27T01:45:20.000Z', updatedAt: '2026-09-27T01:45:20.000Z',
        clinical_config: { catalog_status: 'draft', import_batch: 'cliniccloud-contorno-program-variant/1',
          fiscal_mapping_pending: true, catalog_badge: 'Nuevo', arbitrary_future_field: { must: 'survive' },
          source_price: { mode: 'unresolved', currency: 'EUR', includes_tax: true },
          import_issues: ['PROGRAM_VARIANT_CLINICAL_REVIEW_REQUIRED', 'PROGRAM_VARIANT_CONSENT_REVIEW_REQUIRED'],
          booking_profile: P.expectedProfile(),
          source_program_variant: { version: 1, protocol: 'COR-43', program_codes: ['COR-05'], pdf_pages: [10, 11, 32],
            documentary_gross_price: 145, source_hashes: copy(P.SOURCES), plan_sha256: P.SOURCE_PLAN_SHA256,
            effective_date: '2026-10-01', activation: false, clinical_approval: false, qualification_verified: false,
            grouping: 'Documentary grouping, not a fresh clinical approval.', assignment: 'Provisional source assignment.' } } } },
    decision: { version: 1, scope: P.VERSION, gross_amount: 145, tax_percent: 21, activate: true, actor_id: 1,
      authorized_at: '2026-10-20T14:55:00.000Z', authority_reference: 'Carlos: explicit catalogue closure 20 October 2026',
      authority_text: 'Use the exact documentary 145 EUR standalone COR-43 session and the clinic reply assigning 21 percent VAT to corporal treatments; activate only after canonical resource validation.' },
    sourceEvidence: { version: 1, protocol: 'COR-43', price_pdf_page: 32, standalone_gross_amount: 145,
      currency: 'EUR', source_hashes: copy(P.SOURCES), extracted_source_verified: true, checked_at: '2026-10-20T15:00:30.000Z' },
    createdAt: '2026-10-20T15:01:00.000Z',
  };
}
function validated(input = fixture(), changes = {}) {
  const initial = P.buildPlan(input);
  return { ...input, canonicalValidation: {
    validator: 'validateCatalogResources', ok: true, issues: [], treatment_id: 2122, clinic_id: 72,
    before_sha256: initial.before_sha256, candidate_sha256: initial.activation_candidate_sha256,
    configuration_sha256: initial.configuration_sha256, checked_at: '2026-10-20T15:00:45.000Z', ...changes,
  } };
}

test('one exact COR-43 draft receives its documentary 145 EUR gross / 21 percent review but remains draft without validation', () => {
  const input = fixture(), original = copy(input), plan = P.buildPlan(input);
  assert.deepEqual(input, original);
  assert.equal(plan.treatment_id, 2122); assert.equal(plan.activation, false);
  assert.equal(plan.activation_blocked, 'FRESH_EXACT_CANONICAL_VALIDATION_REQUIRED');
  assert.deepEqual(plan.payload, { precio_base: 145, confirm_imported_price: true, activo: false,
    clinical_config: { catalog_status: 'draft', price_profile: P.PROFILE } });
  assert.equal(plan.after.precio_base, 145); assert.equal(plan.after.clinical_config.fiscal_mapping_pending, false);
  assert.deepEqual(plan.after.clinical_config.imported_price_review, { version: 1, reviewed_at: input.createdAt,
    reviewed_by: 1, gross_amount: 145, price_profile: P.PROFILE });
  P.assertPlan(plan);
});

test('active proposal requires an exact fresh canonical resource-validation proof', () => {
  const input = validated(), plan = P.buildPlan(input);
  assert.equal(plan.activation, true); assert.equal(plan.after.activo, true);
  assert.equal(plan.payload.clinical_config.catalog_status, 'active'); assert.equal(plan.activation_blocked, null);
  assert.equal(plan.write_contract.endpoint_has_atomic_cas, false);
  assert.equal(plan.write_contract.application_mode, 'scoped_operator_transaction_required');
  assert.deepEqual(plan.write_contract.canonical_helpers, ['mergeClinicalConfig', 'applyImportedPriceReview', 'validateCatalogResources']);
  P.assertPlan(plan);
});

test('does not activate when authority asks for fiscal review only, even with a valid proof', () => {
  const input = fixture(); input.decision.activate = false;
  const plan = P.buildPlan(validated(input));
  assert.equal(plan.activation, false); assert.equal(plan.activation_blocked, null); assert.equal(plan.payload.activo, false);
});

test('price source is COR-43 not COR-42 or the separate Contorno entry programmes', () => {
  const plan = P.buildPlan(fixture());
  assert.equal(plan.source.protocol, 'COR-43'); assert.equal(plan.source.programme_code, 'COR-05');
  assert.equal(plan.source.price_pdf_page, 32); assert.equal(plan.source.standalone_gross_amount, 145);
  assert.deepEqual(plan.source.programme_days, [0, 7, 14, 21, 28, 35, 42, 49]);
  assert.deepEqual(plan.source.programme_minutes, [45, 55, 45, 45, 55, 45, 45, 55]);
  assert.equal(plan.source.programme_minutes.reduce((sum, value) => sum + value), 390);
  assert.match(plan.source.not_cor42, /75-minute \/ 180/);
  assert.equal(plan.policy.programmes_changed, false);
});

test('canonical update helpers reproduce exactly the proposed config without rewriting source, phases or flags', () => {
  const input = validated(), before = input.snapshot.treatment, plan = P.buildPlan(input);
  const actual = catalog.applyImportedPriceReview(before.clinical_config,
    catalog.mergeClinicalConfig(before.clinical_config, plan.payload.clinical_config), {
      confirm: plan.payload.confirm_imported_price, amount: plan.payload.precio_base,
      actorId: input.decision.actor_id, now: new Date(input.createdAt),
    });
  assert.deepEqual(actual, plan.after.clinical_config);
  const allowed = new Set(['catalog_status', 'price_profile', 'fiscal_mapping_pending', 'imported_price_review']);
  for (const [key, value] of Object.entries(before.clinical_config)) if (!allowed.has(key)) assert.deepEqual(plan.after.clinical_config[key], value, key);
  for (const key of ['codigo', 'nombre', 'descripcion', 'duracion_min', 'instalaciones_habilitadas', 'asignacion_instalacion_tipo']) assert.deepEqual(plan.after[key], before[key], key);
  assert.equal(plan.after.clinical_config.catalog_badge, 'Nuevo');
  assert.equal(plan.after.clinical_config.source_program_variant.clinical_approval, false);
  assert.equal(plan.after.clinical_config.source_program_variant.qualification_verified, false);
  assert.equal(plan.after.clinical_config.source_program_variant.activation, false); // original source evidence, not a live switch.
});

for (const [label, mutate] of [
  ['other treatment ID', v => v.id_tratamiento = 2123], ['other clinic', v => v.clinica_id = 66],
  ['other code', v => v.codigo = 'BS26-COR42-PROGRAM'], ['renamed identity', v => v.nombre += ' edited'],
  ['75 minute session', v => v.duracion_min = 75], ['programme units', v => v.sesiones_defecto = 8],
  ['group scope', v => { v.origen = 'grupo'; v.grupo_clinica_id = 29; }],
  ['different import', v => v.clinical_config.import_batch = 'other-import'],
  ['different source price', v => v.clinical_config.source_program_variant.documentary_gross_price = 180],
  ['different source protocol', v => v.clinical_config.source_program_variant.protocol = 'COR-42'],
  ['Contorno Arranque', v => v.clinical_config.source_program_variant.program_codes = ['COR-13']],
  ['missing source pages', v => delete v.clinical_config.source_program_variant.pdf_pages],
  ['source byte hash changed', v => v.clinical_config.source_program_variant.source_hashes[Object.keys(P.SOURCES)[0]] = 'a'.repeat(64)],
  ['new machine', v => v.clinical_config.booking_profile.phases[0].equipment_requirements[0].equipment_ids = [11]],
  ['new room', v => v.clinical_config.booking_profile.phases[0].installation_ids = [82]],
  ['different professional', v => v.clinical_config.booking_profile.phases[0].professionals.ids.push(222)],
  ['different phase timing', v => v.clinical_config.booking_profile.phases[0].duration_minutes = 30],
]) test(`exact documentary binding rejects ${label}`, () => {
  const input = fixture(); mutate(input.snapshot.treatment);
  assert.throws(() => P.buildPlan(input), /COR43_/);
});

test('does not overwrite a concurrent/previous fiscal review, standalone amount or component-only conversion', () => {
  for (const mutate of [v => v.precio_base = '145.00', v => v.activo = 1,
    v => v.clinical_config.fiscal_mapping_pending = false,
    v => v.clinical_config.catalog_status = 'active', v => v.clinical_config.price_profile = copy(P.PROFILE),
    v => v.clinical_config.imported_price_review = { reviewed_by: 9 },
    v => v.clinical_config.commercial = { sale_mode: 'program_component_only' }]) {
    const input = fixture(); mutate(input.snapshot.treatment);
    assert.throws(() => P.buildPlan(input), { code: 'COR43_EXISTING_COMMERCIAL_REVIEW_REQUIRES_REPLAN' });
  }
});

test('unverified price, document fingerprint, copied 180 EUR or other protocol do not authorize this tariff', () => {
  for (const patch of [{ extracted_source_verified: false }, { protocol: 'COR-42' }, { standalone_gross_amount: 180 },
    { price_pdf_page: 26 }, { currency: 'USD' }, { source_hashes: {} }, { checked_at: '2026-10-20T15:02:00.000Z' }]) {
    const input = fixture(); Object.assign(input.sourceEvidence, patch);
    assert.throws(() => P.buildPlan(input), { code: 'COR43_EXACT_PRICE_SOURCE_REQUIRED' });
  }
});

test('snapshot and explicit dated authority cannot fall back to an old generic import approval', () => {
  for (const mutate of [v => v.decision.gross_amount = 0, v => v.decision.tax_percent = 0,
    v => v.decision.actor_id = null, v => v.decision.activate = 'yes', v => v.decision.authority_text = 'activate',
    v => v.decision.authorized_at = '2026-10-19T10:00:00.000Z',
    v => v.decision.authorized_at = '2026-10-20T15:02:00.000Z']) {
    const input = fixture(); mutate(input); assert.throws(() => P.buildPlan(input), { code: 'COR43_EXPLICIT_AUTHORITY_REQUIRED' });
  }
  for (const patch of [{ target: 'dev' }, { clinic_id: 66 }, { group_id: 30 }, { captured_at: '2026-10-20T14:00:00.000Z' },
    { captured_at: '2026-10-20T16:00:00.000Z' }, { configuration_sha256: null }]) {
    const input = fixture(); Object.assign(input.snapshot, patch);
    assert.throws(() => P.buildPlan(input), { code: 'COR43_SNAPSHOT_INVALID_OR_STALE' });
  }
});

test('stale, mismatched or unsuccessful canonical validation never turns on an active proposal', () => {
  for (const changes of [{ ok: false }, { issues: ['room-incompatible'] }, { validator: 'invented' },
    { before_sha256: 'b'.repeat(64) }, { candidate_sha256: 'a'.repeat(64) }, { configuration_sha256: 'd'.repeat(64) },
    { treatment_id: 1974 }, { clinic_id: 66 }, { checked_at: '2026-10-20T14:59:00.000Z' }, { checked_at: '2026-10-20T16:00:00.000Z' }]) {
    const plan = P.buildPlan(validated(fixture(), changes));
    assert.equal(plan.activation, false); assert.equal(plan.payload.activo, false);
  }
});

test('full-row guard catches changed unrelated columns/configuration and expires the plan', () => {
  const input = validated(), plan = P.buildPlan(input), before = input.snapshot.treatment;
  const options = { configurationSha256: input.snapshot.configuration_sha256, now: '2026-10-20T15:02:00.000Z' };
  assert(P.assertPrecondition(plan, before, options));
  for (const mutate of [v => v.color = '#ffffff', v => v.clinical_config.catalog_badge = 'Other',
    v => v.updatedAt = '2026-10-20T15:01:30.000Z', v => v.nombre += ' later edit']) {
    const current = copy(before); mutate(current);
    assert.throws(() => P.assertPrecondition(plan, current, options), { code: 'COR43_FULL_ROW_OR_CONFIGURATION_CHANGED' });
  }
  assert.throws(() => P.assertPrecondition(plan, before, { ...options, configurationSha256: 'd'.repeat(64) }), /COR43_FULL_ROW_OR_CONFIGURATION_CHANGED/);
  assert.throws(() => P.assertPrecondition(plan, before, { ...options, now: '2026-10-20T15:17:00.000Z' }), /COR43_FULL_ROW_OR_CONFIGURATION_CHANGED/);
});

test('postcondition allows only exact fiscal/lifecycle fields and actual SQL update clock', () => {
  const plan = P.buildPlan(validated()), after = copy(plan.after), options = { now: '2026-10-20T15:02:00.000Z' };
  after.precio_base = '145.00'; after.activo = 1; after.updatedAt = '2026-10-20T15:01:05.000Z';
  assert(P.verifyAfter(plan, after, options));
  for (const mutate of [v => v.descripcion += ' changed', v => v.codigo = 'COR-42',
    v => v.precio_base = 0, v => v.activo = 0, v => v.clinical_config.catalog_badge = 'Missing',
    v => v.clinical_config.booking_profile.phases.reverse(), v => v.clinical_config.source_program_variant.clinical_approval = true,
    v => v.clinical_config.imported_price_review.reviewed_by = 99, v => v.updatedAt = '2026-10-20T15:03:00.000Z']) {
    const changed = copy(after); mutate(changed);
    assert.throws(() => P.verifyAfter(plan, changed, options), /COR43_/);
  }
});

test('postcondition accepts only the existing MySQL whole-second update-clock precision loss', () => {
  const input = fixture(); input.createdAt = '2026-10-20T15:01:00.321Z';
  const plan = P.buildPlan(validated(input)), after = copy(plan.after);
  after.updatedAt = '2026-10-20T15:01:00.000Z';
  assert(P.verifyAfter(plan, after, { now: '2026-10-20T15:02:00.000Z' }));
  after.updatedAt = '2026-10-20T15:00:59.999Z';
  assert.throws(() => P.verifyAfter(plan, after, { now: '2026-10-20T15:02:00.000Z' }), /COR43_POSTCONDITION_CLOCK_INVALID/);
});

test('resource validation may complete after the exact fiscal audit timestamp without changing its candidate hash', () => {
  const input = fixture(), reviewedAt = '2026-10-20T15:01:00.123Z';
  const initial = P.buildPlan({ ...input, createdAt: reviewedAt, reviewedAt });
  const plan = P.buildPlan({ ...input, reviewedAt, createdAt: '2026-10-20T15:01:03.456Z', canonicalValidation: {
    validator: 'validateCatalogResources', ok: true, issues: [], treatment_id: 2122, clinic_id: 72,
    before_sha256: initial.before_sha256, candidate_sha256: initial.activation_candidate_sha256,
    configuration_sha256: initial.configuration_sha256, checked_at: '2026-10-20T15:01:02.111Z',
  } });
  assert.equal(plan.activation, true);
  assert.equal(plan.after_sha256, initial.activation_candidate_sha256);
  assert.equal(plan.after.clinical_config.imported_price_review.reviewed_at, reviewedAt);
  assert.equal(plan.write_contract.audit_timestamp, reviewedAt);
  assert(P.assertPlan(plan));
  for (const clock of ['2026-10-20T14:59:59.999Z', '2026-10-20T15:01:03.457Z']) {
    assert.throws(() => P.buildPlan({ ...input, createdAt: plan.created_at, reviewedAt: clock }), /COR43_REVIEW_CLOCK_INVALID/);
  }
});

test('a sealed plan cannot be widened to other IDs, fields, VAT or a forged successful validation afterwards', () => {
  const plan = P.buildPlan(fixture());
  for (const mutate of [v => v.payload.precio_base = 180, v => v.payload.activo = true,
    v => v.treatment_id = 2123, v => v.payload.clinical_config.booking_profile = {},
    v => v.policy.programmes_changed = true, v => v.before.descripcion += ' changed']) {
    const changed = copy(plan); mutate(changed);
    assert.throws(() => P.assertPlan(changed), /COR43_/);
  }
});

test('helper remains pure and never scans catalogue, connects, bootstraps models or issues an update', () => {
  const source = fs.readFileSync(require.resolve('../../lib/cliniccloud-import/bs-contorno-cor43-closure'), 'utf8');
  assert.equal(/process\.env|fetch\(|connect\w*\(|\.findAll\(|\.findByPk\(|\.update\(|\.save\(|\.query\(/.test(source), false);
  assert.equal(source.includes("require('../../models')"), false);
});
