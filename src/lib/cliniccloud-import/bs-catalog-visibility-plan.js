'use strict';

// Offline only. This is not retirement: no activation/status, price, resource,
// snapshot, entitlement or appointment is changed or re-bound.
const { hash } = require('./adapter');
const { SOURCE_BATCH } = require('./catalog-retirement');
const { buildBsCatalogMigrationPlan, dataProjection } = require('./bs-catalog-migration-plan');
const VERSION = 'bs-catalog-continuation-visibility-offline/1';
const LEGACY_SERVICES_SHA = '7c94c59517c108f4ec7f7eb165035ae5d78ab83273f18c51cb0b4c530620a266';
const FIELD_WHITELIST = Object.freeze(['clinical_config.booking_visibility']);
const copy = value => JSON.parse(JSON.stringify(value));
const fail = code => { throw Error(code); };
function protectedProjection(row) {
    const result = dataProjection(row); delete result.clinical_config.booking_visibility; return result;
}
function buildBsCatalogVisibilityPlan(input) {
    const { preflight, legacyServices, legacyServicesFileSha256 } = input;
    // Re-use exact current 167-source reconciliation. Never classify the other
    // rows as old merely because they were not selected as new individuals.
    const commercial = buildBsCatalogMigrationPlan(input);
    if (legacyServicesFileSha256 !== LEGACY_SERVICES_SHA || !Array.isArray(legacyServices)
        || legacyServices.length !== 186 || new Set(legacyServices.map(r => r.values?.idServicio)).size !== 186
        || legacyServices.some(r => !Number.isSafeInteger(r.source_row) || r.source_row < 2
            || !/^\d+$/.test(r.values?.idServicio || '') || r.values.idEmpresa !== '5880')) fail('BS_VISIBILITY_ORIGINAL_SOURCE_INVALID');
    const newer = new Set(commercial.clinical_pending.map(r => r.treatment_id));
    const operations = [], pending = [], inventory = [];
    for (const observed of preflight.snapshot.treatments) {
        const row = copy(observed);
        if (typeof row.clinical_config === 'string') row.clinical_config = JSON.parse(row.clinical_config);
        const cfg = row.clinical_config || {};
        let family = 'manual_or_other_unproven';
        if (newer.has(row.id_tratamiento)) family = 'new_167_exact_individual_source';
        else if (cfg.catalog_status === 'historical_reference') family = 'historical_reference_preserve';
        else if (row.codigo?.startsWith('BS26-')) family = 'other_bs26_not_individual';
        else if (row.codigo?.startsWith('CCIMP-')) family = 'demo_not_canonical_legacy';
        else if (row.codigo?.startsWith('CCLOUD-')) family = 'canonical_cliniccloud_candidate';
        inventory.push({ treatment_id: row.id_tratamiento, clinic_id: row.clinica_id, family,
            active_unchanged: row.activo, catalog_status_unchanged: cfg.catalog_status || null });
        if (family !== 'canonical_cliniccloud_candidate') continue;
        const serviceId = cfg.raw?.idServicio;
        const matches = legacyServices.filter(r => r.values.idServicio === serviceId);
        const exact = [66, 72].includes(row.clinica_id) && row.origen === 'clinica'
            && cfg.source_system === 'cliniccloud' && cfg.source_batch === SOURCE_BATCH
            && /^\d+$/.test(serviceId || '') && cfg.raw?.idEmpresa === '5880'
            && row.codigo === `CCLOUD-${serviceId}` && cfg.source_reference === `service:${serviceId}`
            && matches.length === 1 && hash(cfg.raw) === hash(matches[0].values);
        if (!exact) {
            pending.push({ treatment_id: row.id_tratamiento, clinic_id: row.clinica_id,
                code: 'LEGACY_ORIGINAL_SOURCE_NOT_EXACT_NO_NAME_FALLBACK' }); continue;
        }
        inventory[inventory.length - 1].family = 'canonical_cliniccloud_original_verified';
        if (Number(row.activo) !== 1 || ['obsolete', 'draft', 'historical_reference'].includes(cfg.catalog_status)) continue;
        if (cfg.booking_visibility === 'continuation_only') continue;
        if (Object.hasOwn(cfg, 'booking_visibility')) {
            pending.push({ treatment_id: row.id_tratamiento, clinic_id: row.clinica_id,
                code: 'EXISTING_VISIBILITY_DECISION_PRESERVED' }); continue;
        }
        const before = copy(row), after = copy(row); after.clinical_config.booking_visibility = 'continuation_only';
        const change = { path: FIELD_WHITELIST[0], before: { present: false }, after: { present: true, value: 'continuation_only' } };
        change.before_sha256 = hash(change.before); change.after_sha256 = hash(change.after);
        const op = { kind: 'propose_existing_treatment_continuation_visibility_patch', treatment_id: row.id_tratamiento,
            clinic_id: row.clinica_id, code: row.codigo, before, after, changes: [change],
            observed_before_row_sha256: hash(observed), before_sha256: hash(dataProjection(before)),
            after_sha256: hash(dataProjection(after)), protected_data_sha256: hash(protectedProjection(before)),
            hash_scope: 'all_treatment_columns_except_model_owned_updatedAt_canonical_json',
            evidence: { source_file_sha256: legacyServicesFileSha256, source_row: matches[0].source_row,
                source_row_sha256: hash(matches[0].values), source_service_id: serviceId,
                source_system: cfg.source_system, source_batch: cfg.source_batch, source_reference: cfg.source_reference,
                original_raw_matches_in_full: true, name_similarity_used: false,
                replacement_or_equivalence_inferred: false, existing_continuation_requires_server_owned_proof: true } };
        op.operation_sha256 = hash(op); operations.push(op);
    }
    const body = { version: VERSION, mode: 'offline_proposal_only_no_activation', target: 'crm', group_id: 29,
        derived_from_snapshot_at: preflight.created_at, matrix_file_sha256: input.matrixFileSha256,
        snapshot_file_sha256: input.snapshotFileSha256, snapshot_sha256: preflight.snapshot_sha256,
        legacy_services_file_sha256: legacyServicesFileSha256, field_whitelist: [...FIELD_WHITELIST], operations, inventory, pending,
        policy: { hides_only_new_offers: true, activation_permitted: false, obsolete_and_inactive_unchanged: true,
            clinical_profiles_and_resources_unchanged: true, original_source_and_approvals_unchanged: true,
            prices_unchanged: true, appointment_and_purchased_snapshots_unchanged: true,
            ids_and_links_not_reassigned: true, references_with_missing_original_provenance_not_hidden: true },
        summary: { total_inventory: inventory.length, new_individual_sources_preserved: newer.size,
            original_legacy_sources_verified: inventory.filter(r => r.family === 'canonical_cliniccloud_original_verified').length,
            historical_references_preserved: inventory.filter(r => r.family === 'historical_reference_preserve').length,
            visibility_proposals: operations.length, pending_source_or_decision: pending.length,
            database_read: false, database_written: false, clinical_activation: false } };
    return { ...body, plan_sha256: hash(body) };
}
module.exports = { VERSION, LEGACY_SERVICES_SHA, FIELD_WHITELIST, buildBsCatalogVisibilityPlan };
