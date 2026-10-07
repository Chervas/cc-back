'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const { WORKBOOK_SHA } = require('../../lib/cliniccloud-import/catalog-matrix');
const { VERSION: PREFLIGHT_VERSION, reconcileCatalog } = require('../../lib/cliniccloud-import/catalog-preflight');
const { preparePhysicalProfileReconciliation: prepare, verifyPhysicalProfileReconciliation: verify, physicalMapping } = require('../../lib/cliniccloud-import/bs-physical-profile-reconciliation');
const { csv } = require('../bs-physical-profile-reconciliation-offline');
const { normalizeBookingProfile } = require('../../lib/booking-profile');
const { resolveBookingProfileDuration } = require('../../lib/booking-profile-duration');
const { solveBookingProfile, occupancyForSolution } = require('../../lib/booking-profile-solver');
const { assertOperationalBookingProfile } = require('../../services/treatmentBookingProfile.service');
const clone = value => JSON.parse(JSON.stringify(value));
const seal = (body, key) => ({ ...body, [key]: hash(body) });
const bookingProfile = (room = 9, equipment = null) => ({ version: equipment ? 2 : 1, phases: [{ key: 'one', label: '', duration_minutes: 30,
    installation_ids: [room], professionals: { mode: 'any', ids: [5], preferred_id: 5 },
    ...(equipment ? { equipment_requirements: [{ equipment_ids: [equipment] }] } : {}) }] });

function fixture() {
    const rows = [], sources = [], treatments = [];
    for (let index = 0; index < 167; index++) {
        const category = 'Consulta ficticia', name = `Acto ficticio ${index}`, sheet = 'Tratamientos individuales';
        const raw_cells = { A: category, B: name, C: '30 min', D: '90 €', G: '1', H: 'Profesional ficticio' };
        const key = hash([sheet, category, name]), provenance = { file_sha256: WORKBOOK_SHA, sheet, source_row: index + 2, row_sha256: hash(raw_cells) };
        sources.push({ category, name, detail: '', sheet, source_row: index + 2, raw_cells, provenance,
            source_catalog_key: key, proposed_code: `BS26-${key.slice(0, 20)}`, clinic_id: 72,
            duration: '30 min', duration_info: { mode: 'fixed', minutes: 30 }, cabin: '1', cabin_keys: ['C1'],
            professional: 'Profesional ficticio', required_professionals: ['Profesional ficticio'], professional_mode: 'any',
            source_price: { mode: 'fixed' }, client_reply_evidence: [], issues: [] });
        rows.push({ record_type: 'concept', kind: 'treatment', matrix_key: key, code: `BS26-${key.slice(0, 20)}`,
            clinic: 'BS Medical', name, source_references_json: JSON.stringify([provenance]), pending_json: '[]',
            duration_raw: '30 min', duration_json: JSON.stringify(sources[index].duration_info), room_raw: '1', staff_raw: 'Profesional ficticio' });
        treatments.push({ id_tratamiento: 100 + index, clinica_id: 72, codigo: rows[index].code, nombre: name, activo: 1,
            clinical_config: { source_catalog_key: key, source_catalog: provenance, catalog_status: 'active', booking_profile: bookingProfile() } });
    }
    while (rows.length < 895) rows.push({ record_type: 'source_manifest', matrix_key: hash(['ficticio', rows.length]) });
    const snapshot = { clinics: [{ id_clinica: 66, grupoClinicaId: 29 }, { id_clinica: 72, grupoClinicaId: 29 }],
        triggers: [], treatments, installations: [9, 10, 11, 12].map(id => ({ id, clinica_id: id === 11 ? 66 : 72, activo: 1, nombre: `Sala ficticia ${id}`, profesionales_permitidos: null })),
        professionals: [5, 6].map(id => ({ id: id + 100, doctor_id: id, clinica_id: 72, activo: 1, recibe_citas: 1 })),
        physical_aliases: [{ installation_id: 11, canonical_installation_id: 10, group_id: 29 }],
        equipment: [{ id: 5, owner_clinic_id: 72, group_id: 29, family_key: 'emshape', name: 'Equipo ficticio', status: 'available', mobility: 'fixed', home_installation_id: 10,
            turnaround_minutes: 0, attention_policy: { mode: 'start_end', start_minutes: 5, start_window_minutes: 10, end_minutes: 5, end_window_minutes: 10 } }],
        equipment_memberships: [{ equipment_id: 5, clinic_id: 72 }], equipment_room_policies: [],
        consent_requirements: [], protocols: [], appointment_counts: [], voucher_counts: [] };
    const resourceMap = { version: 2, source_account: 'cliniccloud-5880', professionals: { 'Profesional ficticio': 5 }, cabins_by_clinic: { 72: { C1: 9, C2: 10 } } };
    const preflight = { version: PREFLIGHT_VERSION, target: 'crm', mode: 'read_only', group_id: 29,
        created_at: '2026-10-07T00:00:00Z', matrix_file_sha256: hash('ficticio-matrix'), snapshot, policy: {
            database_written: false, patient_rows_exported: false, application_bootstrapped: false, reminders_sent: false,
            protocols_approved: false, treatments_activated: false, existing_entitlements_unchanged: true } };
    const input = { matrixRows: rows, matrixFileSha256: preflight.matrix_file_sha256, preflight, resourceMap, resourceMapSha256: hash(resourceMap) };
    const reseal = () => { input.sourcePlan = seal({ version: 1, mode: 'catalog_dry_run_only', clinics: { medical: 72, capilar: 66 }, workbook_sha256: WORKBOOK_SHA, rows: sources }, 'plan_sha256');
        preflight.snapshot_sha256 = hash(snapshot); preflight.reconciliation = reconcileCatalog(rows, snapshot); input.resourceMapSha256 = hash(resourceMap); };
    const sourceTiming = (index, value) => { Object.assign(sources[index], value); Object.assign(rows[index], {
        duration_raw: sources[index].duration, duration_json: JSON.stringify(sources[index].duration_info),
        room_raw: sources[index].cabin, staff_raw: sources[index].professional }); };
    reseal(); return { input, rows, sources, treatments, snapshot, resourceMap, preflight, reseal, sourceTiming };
}

test('all exact profiles are preserved deterministically; catalogue structure is not a real free slot or clinical approval', () => {
    const h = fixture(), before = JSON.stringify(h.input), plan = prepare(h.input);
    assert.equal(plan.summary.preserved_existing_profiles, 167);
    assert.equal(plan.summary.current_by_status.current_standalone_profile_structurally_ready, 167);
    assert.equal(plan.summary.actual_slots_verified, 0);
    assert.equal(plan.summary.current_equipment_definition.legacy_no_inventory_requirement_machine_free_not_inferred, 167);
    assert(plan.records.every(row => row.physical_aliases_verified && !row.available_slot_declared && !row.clinical_capacity_declared_complete));
    assert.equal(plan.proposals.length, 0);
    assert.equal(JSON.stringify(h.input), before);
    assert.deepEqual(prepare(h.input), plan);
    assert.equal(verify(plan, h.input), true);
    for (const value of Object.values(plan.policy)) assert.equal(value, false);
});

test('historical v1 capture is retained but never retroactively credits physical aliases', () => {
    const h = fixture(); h.preflight.version = 'bs-catalog-preflight-readonly/1';
    const result = prepare(h.input);
    assert(result.records.every(row => !row.physical_aliases_verified));
    assert(result.records[0].technical_preparation.includes('CURRENT_PHYSICAL_ALIASES_NOT_CAPTURED'));
    assert.equal(result.summary.preserved_existing_profiles, 167);
});

test('malformed cross-group, missing-room and chained aliases cannot bless physical capacity', () => {
    for (const mutation of [h => h.snapshot.physical_aliases[0].group_id = 99,
        h => h.snapshot.physical_aliases[0].canonical_installation_id = 999,
        h => h.snapshot.physical_aliases.push({ installation_id: 10, canonical_installation_id: 12, group_id: 29 })]) {
        const h = fixture(); mutation(h); h.reseal(); const mapping = physicalMapping(h.preflight);
        assert(mapping.errors.length); assert.equal(prepare(h.input).records[0].physical_aliases_verified, false);
    }
});

test('membership existence is the actual equipment-clinic schema; fixed equipment uses canonical shared-room identity', () => {
    const h = fixture(); h.treatments[0].clinical_config.booking_profile = bookingProfile(10, 5); h.reseal();
    const record = prepare(h.input).records[0];
    assert.equal(record.current_status, 'current_standalone_profile_structurally_ready');
    assert.equal(record.current_resource_check.phases[0].installations[0].equipment_compatible, true);
    h.snapshot.equipment_memberships = []; h.reseal();
    assert(prepare(h.input).records[0].pending.includes('CURRENT_EQUIPMENT_NOT_AVAILABLE_IN_CLINIC'));
});

test('physical machinery conflict and team incompatibility have concrete causes, not a fictitious closure', () => {
    const h = fixture(); h.treatments[0].clinical_config.booking_profile = bookingProfile(9, 5); h.reseal();
    assert(prepare(h.input).records[0].pending.includes('CURRENT_EQUIPMENT_NO_COMPATIBLE_PHYSICAL_ROOM'));
    h.snapshot.installations.find(row => row.id === 9).profesionales_permitidos = [6]; h.reseal();
    assert(prepare(h.input).records[0].pending.includes('CURRENT_ROOM_STAFF_NO_VALID_ASSIGNMENT'));
});

test('included components, administrative acts and inactive drafts are not sold as new standalone visits', () => {
    const h = fixture(); h.treatments[0].clinical_config.commercial = { sale_mode: 'program_component_only' };
    h.treatments[1].activo = 0; h.treatments[1].clinical_config.catalog_status = 'draft';
    delete h.treatments[2].clinical_config.booking_profile; h.treatments[2].clinical_config.booking_mode = 'administrative_review'; h.reseal();
    const result = prepare(h.input);
    assert.equal(result.records[0].current_status, 'current_continuation_only_profile');
    assert.equal(result.records[1].current_status, 'catalogue_draft_profile_preserved');
    assert.equal(result.records[2].target_status, 'administrative_separate_not_a_slot');
    assert(!result.proposals.some(row => row.treatment_id === 102));
});

test('quantity formula and range need source constraints beyond the supported individual duration contract', () => {
    const h = fixture(); delete h.treatments[0].clinical_config.booking_profile; delete h.treatments[1].clinical_config.booking_profile;
    h.sourceTiming(0, { duration: '2 min', duration_info: { mode: 'per_unit', minutes: 2 } });
    h.treatments[0].clinical_config.quantity_duration = { per_unit_minutes: 2, preparation_minutes: 5, quantity_required: true };
    h.sourceTiming(1, { duration: '20-30 min', duration_info: { mode: 'range', minutes: null, raw: '20-30 min' } }); h.reseal();
    const result = prepare(h.input);
    assert.equal(result.records[0].target_status, 'quantity_formula_authoring_required_resources_complete');
    assert.equal(result.records[1].target_status, 'bounded_duration_authoring_required_resources_complete');
    for (const row of result.records.slice(0, 2)) {
        assert.equal(row.duration.individual_booking_contract_supported, false);
        assert.equal(row.duration.per_appointment_duration_materialization_supported, true);
        assert.equal(row.duration.source_constraint_enforcement_supported, false);
        assert(!row.technical_preparation.includes('INDIVIDUAL_REQUEST_DURATION_CONTRACT_REQUIRED'));
        assert.equal(row.authoring_readiness.manual_null_duration_template_can_be_prepared_offline, false);
        assert.equal(row.duration.fixed_minutes, null); assert.equal(row.clinical_decisions.length, 0);
    }
    assert.deepEqual(result.records[0].duration.formula, { per_unit_minutes: 2, preparation_minutes: 5, quantity_required: true });
    assert.deepEqual(result.records[1].duration.documented_bounds, { minimum_minutes: 20, maximum_minutes: 30 });
    assert.equal(result.proposals.length, 0);
});

test('unknown duration with explicit complete resources is a legitimate manual choice, not a guessed 30-minute visit', () => {
    const h = fixture(); delete h.treatments[0].clinical_config.booking_profile;
    h.sourceTiming(0, { duration: '—', duration_info: { mode: 'unresolved', minutes: null, raw: '—' } }); h.reseal();
    const plan = prepare(h.input), row = plan.records[0];
    assert.equal(row.target_status, 'manual_single_act_template_resources_complete');
    assert(row.technical_preparation.includes('VISIT_DURATION_REQUIRES_PROFESSIONAL_CHOICE'));
    assert.equal(row.duration.individual_booking_contract_supported, true);
    assert.equal(row.current_duration_minutes, null); assert.equal(row.duration.fixed_minutes, null);
    const proposal = plan.proposals[0];
    assert.equal(proposal.kind, 'offline_candidate_manual_duration_template_missing_profile_only');
    assert.equal(proposal.policy.can_apply, false);
    assert.equal(proposal.policy.equipment_definition_requires_review, true);
    assert.equal(proposal.booking_profile.phases[0].duration_minutes, null);
    assert.deepEqual(proposal.booking_profile.phases[0].installation_ids, [9]);
    assert.deepEqual(proposal.booking_profile.phases[0].professionals.ids, [5]);
    assert.deepEqual(proposal.physical_resource_keys, ['installation:9']);
    assert.throws(() => resolveBookingProfileDuration(proposal.booking_profile), { code: 'booking_duration_required' });
    const selected = resolveBookingProfileDuration(proposal.booking_profile, { durationSelection: { duration_minutes: 47 } });
    assert.equal(selected.profile.phases[0].duration_minutes, 47);
    assert.equal(proposal.booking_profile.phases[0].duration_minutes, null);
    assert.equal(plan.migration_writer.physical_profiles_supported, false);
});

test('jornadas and an included component cannot become a single free-duration NULL template', () => {
    const h = fixture(); delete h.treatments[0].clinical_config.booking_profile; delete h.treatments[1].clinical_config.booking_profile;
    h.sourceTiming(0, { duration: '1,5 jornadas de quirófano', duration_info: { mode: 'surgical_days', minutes: null } });
    h.sourceTiming(1, { duration: '—', duration_info: { mode: 'unresolved', minutes: null } });
    h.treatments[1].clinical_config.commercial = { sale_mode: 'program_component_only' }; h.reseal();
    const plan = prepare(h.input);
    assert.equal(plan.records[0].target_status, 'surgical_visit_plan_authoring_required_resources_complete');
    assert.equal(plan.records[0].duration.documented_jornadas, 1.5);
    assert.equal(plan.records[0].duration.fixed_minutes, null);
    assert.equal(plan.records[1].target_status, 'included_component_visit_definition_required');
    assert(plan.records[1].authoring_readiness.remaining_capabilities.includes('INCLUDED_COMPONENT_ACTS_AND_ENTITLEMENT_LINK_REQUIRED'));
    assert(plan.records.slice(0, 2).every(row => !row.authoring_readiness.manual_null_duration_template_can_be_prepared_offline));
    assert.equal(plan.proposals.length, 0);
});

test('per-unit duration without complete quantity evidence is not mistaken for an unquantified manual act', () => {
    const h = fixture(); delete h.treatments[0].clinical_config.booking_profile;
    h.sourceTiming(0, { duration: '2 min', duration_info: { mode: 'per_unit', minutes: 2 } }); h.reseal();
    const plan = prepare(h.input);
    assert.equal(plan.records[0].duration.kind, 'documented_quantity_formula_incomplete');
    assert.equal(plan.records[0].authoring_readiness.recipe_kind, 'quantity_formula');
    assert.equal(plan.proposals.length, 0);
});

test('existing strict NULL-duration profiles are retained and require a booking choice, not recreated as invalid', () => {
    const h = fixture(); h.treatments[0].clinical_config.booking_profile.phases[0].duration_minutes = null; h.reseal();
    const plan = prepare(h.input), row = plan.records[0];
    assert.equal(row.current_status, 'current_manual_duration_template_requires_choice');
    assert.equal(row.current_duration_minutes, null);
    assert.equal(row.current_profile_sha256, hash(h.treatments[0].clinical_config.booking_profile));
    assert(!row.pending.includes('CURRENT_PROFILE_INVALID'));
    assert.equal(plan.proposals.length, 0);
});

test('local clinical decisions and uncaptured or invalid physical aliases withhold new templates', () => {
    for (const change of [h => h.treatments[0].clinical_config.source_duration = 'Decisión local explícita',
        h => h.preflight.version = 'bs-catalog-preflight-readonly/1',
        h => h.snapshot.physical_aliases[0].group_id = 99]) {
        const h = fixture(); delete h.treatments[0].clinical_config.booking_profile;
        h.sourceTiming(0, { duration: '—', duration_info: { mode: 'unresolved', minutes: null } }); change(h); h.reseal();
        const plan = prepare(h.input);
        assert.equal(plan.proposals.length, 0);
        assert.equal(plan.records[0].authoring_readiness.manual_null_duration_template_can_be_prepared_offline, false);
    }
});

test('a baseline report can only be superseded when all original identities, rows and profiles remain identical', () => {
    const h = fixture(), { plan_sha256, ...body } = prepare(h.input);
    const previous = seal({ ...body, version: 'bs-physical-profile-reconciliation-offline/1' }, 'plan_sha256');
    h.input.previousReconciliation = { report: previous, file_sha256: hash('private-file-bytes') };
    const plan = prepare(h.input);
    assert.equal(plan.supersedes.unchanged_treatment_source_identities, 167);
    assert.equal(plan.supersedes.unchanged_existing_profiles, 167);
    h.treatments[0].clinical_config.booking_profile.phases[0].duration_minutes = 45; h.reseal();
    assert.throws(() => prepare(h.input), /BS_PHYSICAL_PRIOR_REPORT_BASELINE_CHANGED/);
});

test('multiple written cabins cannot become alternatives; clinical responsibility cannot be inferred from a map', () => {
    const h = fixture(); delete h.treatments[0].clinical_config.booking_profile;
    h.sourceTiming(0, { cabin: '1 y 2', cabin_keys: ['C1', 'C2'] });
    delete h.treatments[1].clinical_config.booking_profile; h.rows[1].pending_json = '["INJECTABLE_STAFF_REQUIRES_CLINICAL_VALIDATION"]'; h.reseal();
    const result = prepare(h.input);
    assert(result.records[0].clinical_decisions.includes('WRITTEN_ROOMS_REQUIRE_ACT_DURATION_DISTRIBUTION'));
    assert(result.records[1].clinical_decisions.includes('INJECTABLE_RESPONSIBILITY_NOT_CLINICALLY_VALIDATED'));
    assert.equal(result.proposals.length, 0);
});

test('missing room remains specifically unresolved, even when treatment names happen to match existing rooms', () => {
    const h = fixture(); delete h.treatments[0].clinical_config.booking_profile;
    h.sourceTiming(0, { cabin: '', cabin_keys: [] }); h.reseal();
    const row = prepare(h.input).records[0];
    assert.equal(row.target_status, 'specific_physical_definition_required');
    assert(row.pending.includes('SOURCE_PHYSICAL_ROOM_NOT_DEFINED_OR_UNRESOLVED'));
    assert.equal(row.source_resources.full_physical_definition, false);
});

test('only an exact fixed single-room/staff source yields a nonapplicable candidate; repeat planning does not duplicate it', () => {
    const h = fixture(); delete h.treatments[0].clinical_config.booking_profile; h.reseal();
    const plan = prepare(h.input); assert.equal(plan.proposals.length, 1); assert.equal(plan.proposals[0].policy.can_apply, false);
    h.treatments[0].clinical_config.booking_profile = plan.proposals[0].booking_profile; h.reseal();
    assert.equal(prepare(h.input).proposals.length, 0);
    assert.throws(() => verify(plan, h.input), /BS_PHYSICAL_PLAN_CHANGED/);
});

test('forged operational interpretation and changed source identity fail even when a local plan is resealed', () => {
    const h = fixture(); h.sources[0].duration_info.minutes = 5; h.reseal();
    assert.throws(() => prepare(h.input), /BS_PHYSICAL_LITERAL_OPERATIONAL_SOURCE_CHANGED/);
    const changed = fixture(); changed.treatments[0].codigo = 'CCLOUD-name-match'; changed.reseal();
    assert.throws(() => prepare(changed.input), /BS_DOC_EXACT_IDENTITY_REQUIRED/);
});

test('human report has 167 Spanish rows and respects profiles/history with no public patient data', () => {
    const h = fixture(), plan = prepare(h.input), report = csv(plan);
    assert.equal(report.split('\r\n').filter(Boolean).length, 168);
    assert(report.startsWith('\uFEFF')); assert.match(report, /Perfil individual actual preparado estructuralmente/);
    assert.match(report, /No; prueba integrada posterior/); assert.equal(plan.summary.writes, 0);
});

test('real solver keeps 3 × 5 setup in 15, continuous INDIBA and full room/equipment occupancy; pending EMS blocks clinical gate', () => {
    const start = '2030-01-07T09:30:00Z', end = '2030-01-07T10:00:00Z';
    const steps = ['preso', 'ems', 'indiba'].map((key, index) => ({ key, label: '', start_offset_minutes: 0,
        duration_minutes: 30, installation_ids: [9 + index], professionals: { mode: 'any', ids: [5], preferred_id: 5 },
        equipment_requirements: [{ equipment_ids: [1 + index] }],
        staff_attention: [{ mode: key === 'indiba' ? 'start_continuous' : 'start_only', start_minutes: 5, start_window_minutes: 15 }] }));
    const profile = normalizeBookingProfile({ version: 4, phases: steps });
    const resource = { windows: [{ start, end }], busy: [] };
    const context = { doctors: new Map([[5, clone(resource)]]), installations: new Map([9, 10, 11].map(id => [id, clone(resource)])),
        equipment: new Map([1, 2, 3].map(id => [id, { id, status: 'available', turnaround_minutes: 0, installation_ids: new Set([9, 10, 11]), busy: [] }])) };
    const solution = solveBookingProfile({ profile, start, ...context }); assert(solution);
    const occupancy = occupancyForSolution(solution);
    for (const row of occupancy.filter(row => row.resource_kind !== 'doctor')) {
        assert.equal(new Date(row.start_at).getTime(), Date.parse(start)); assert.equal(new Date(row.end_at).getTime(), Date.parse(end));
    }
    assert.equal(solution.phases.find(row => row.key === 'indiba').staff_intervals.at(-1).end_at, new Date(end).toISOString());
    assert.throws(() => assertOperationalBookingProfile(profile, { capabilities: { simple: true, multi: true, relativeSteps: false } }), { code: 'booking_profile_runtime_unavailable' });
    const pending = clone(profile); pending.phases[1].attention_requirements_pending = [{ key: 'check', label: 'Comprobación intermedia pendiente de cuantificar' }];
    assert.throws(() => assertOperationalBookingProfile(normalizeBookingProfile(pending), { capabilities: { simple: true, multi: true, relativeSteps: true } }), { code: 'pending_attention_requirements' });
    assert.equal(prepare(fixture().input).piedad_partial_attention_migration.v4_activation, false);
});
