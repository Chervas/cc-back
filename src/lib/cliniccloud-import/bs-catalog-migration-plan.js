'use strict';

// Proposal/simulation only. No database, runtime services, SQL or mutation API.
const { hash } = require('./adapter');
const { PDF_SOURCES } = require('./catalog-matrix');
const { SUPPORTED_VERSIONS: PREFLIGHT_VERSIONS, checkedMatrix, reconcileCatalog } = require('./catalog-preflight');
const { grossPrice } = require('./catalog');
const { normalizeProfile } = require('../economicPriceProfile');

const VERSION = 'bs-catalog-migration-offline/1';
const PROFILE = Object.freeze({ schema_version: 1, price_semantics: 'gross_tax_included', tax_percent: 21, exemption_reason: null });
const FIELD_WHITELIST = Object.freeze([
    'precio_base', 'clinical_config.catalog_badge', 'clinical_config.price_profile.schema_version',
    'clinical_config.price_profile.price_semantics', 'clinical_config.price_profile.tax_percent',
    'clinical_config.price_profile.exemption_reason',
]);
const fail = code => { throw Error(code); };
const copy = value => JSON.parse(JSON.stringify(value));
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const json = value => typeof value === 'string' ? JSON.parse(value) : value;
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const count = (rows, key) => rows.reduce((result, row) => {
    const value = key(row); result[value] = (result[value] || 0) + 1; return result;
}, {});

function canonicalRow(row) {
    const result = copy(row);
    result.clinical_config = json(result.clinical_config);
    if (!isObject(result.clinical_config)) fail('BS_PLAN_CONFIG_INVALID');
    return result;
}
// The model owns its update timestamp. All other columns (not just the patch)
// participate in the data CAS, protecting unrelated later human modifications.
function dataProjection(row) {
    const result = canonicalRow(row);
    delete result.updatedAt;
    return result;
}
function cell(row, path) {
    let parent = row;
    const parts = path.split('.');
    for (const part of parts.slice(0, -1)) {
        if (!isObject(parent) || !Object.hasOwn(parent, part)) return { present: false };
        parent = parent[part];
    }
    const key = parts[parts.length - 1];
    return isObject(parent) && Object.hasOwn(parent, key) ? { present: true, value: copy(parent[key]) } : { present: false };
}
function proposeCell(after, changes, path, value) {
    if (!FIELD_WHITELIST.includes(path)) fail('BS_PLAN_FIELD_NOT_WHITELISTED');
    const before = cell(after, path), next = { present: true, value: copy(value) };
    if (hash(before) === hash(next)) return;
    let parent = after;
    const parts = path.split('.');
    for (const part of parts.slice(0, -1)) {
        if (parent[part] == null) parent[part] = {};
        if (!isObject(parent[part])) fail('BS_PLAN_PATCH_PARENT_INVALID');
        parent = parent[part];
    }
    parent[parts[parts.length - 1]] = copy(value);
    changes.push({ path, before, after: next, before_sha256: hash(before), after_sha256: hash(next) });
}
function protectedProjection(row) {
    const result = dataProjection(row);
    delete result.precio_base;
    delete result.clinical_config.catalog_badge;
    const profile = result.clinical_config.price_profile;
    if (profile == null) delete result.clinical_config.price_profile;
    if (isObject(profile)) {
        for (const key of Object.keys(PROFILE)) delete profile[key];
        if (!Object.keys(profile).length) delete result.clinical_config.price_profile;
    }
    return result;
}
function fixedAmount(row) {
    const raw = row.october_gross_amount;
    if (row.october_price_mode !== 'fixed' || !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(raw)) return null;
    const amount = Number(raw), parsed = grossPrice(row.october_price_raw);
    if (!Number.isFinite(amount) || amount > 99999999.99 || Math.round(amount * 100) / 100 !== amount
        || parsed.mode !== 'fixed' || parsed.gross_amount !== amount
        || row.effective_from !== '2026-10-01' || Number(row.vat_rate) !== 21
        || ![true, 'true'].includes(row.gross_includes_tax)) return null;
    const refs = json(row.source_references_json);
    const tariff = refs.filter(ref => ref.field === 'october_price');
    if (!tariff.length || tariff.some(ref => ref.role !== 'primary'
        || !PDF_SOURCES.some(source => source.role === 'tariff' && source.file === ref.file
            && source.sha256 === ref.file_sha256 && Number.isInteger(ref.page) && ref.page >= 1 && ref.page <= source.pages)
        || !sha(ref.page_sha256) || !Number.isInteger(ref.line) || ref.line < 1
        || typeof ref.quote !== 'string' || !ref.quote.trim())) return null;
    return { amount, references: tariff };
}

function validateInputs(matrixRows, preflight, matrixFileSha256) {
    const concepts = checkedMatrix(matrixRows);
    // v1 is still valid commercial evidence, not proof of physical aliases.
    // Preserve historical source bytes/plan hashes; accept only these two
    // explicitly supported captures, never future versions by prefix.
    if (!PREFLIGHT_VERSIONS.includes(preflight?.version) || preflight.target !== 'crm' || preflight.mode !== 'read_only'
        || preflight.group_id !== 29 || !sha(matrixFileSha256) || matrixFileSha256 !== preflight.matrix_file_sha256
        || !isObject(preflight.snapshot) || hash(preflight.snapshot) !== preflight.snapshot_sha256
        || !Number.isFinite(Date.parse(preflight.created_at))) fail('BS_PLAN_PREFLIGHT_INVALID');
    const expected = { database_written: false, patient_rows_exported: false, application_bootstrapped: false,
        reminders_sent: false, protocols_approved: false, treatments_activated: false, existing_entitlements_unchanged: true };
    if (Object.entries(expected).some(([key, value]) => preflight.policy?.[key] !== value)
        || preflight.snapshot.clinics?.length !== 2
        || ![66, 72].every(id => preflight.snapshot.clinics.some(c => Number(c.id_clinica) === id && Number(c.grupoClinicaId) === 29))
        || preflight.snapshot.triggers?.length) fail('BS_PLAN_SCOPE_OR_POLICY_CHANGED');
    const reconciled = reconcileCatalog(matrixRows, preflight.snapshot);
    if (reconciled.records.length !== 167 || reconciled.records.some(record => record.status !== 'exact_existing_source')
        || hash(reconciled.records) !== hash(preflight.reconciliation?.records)
        || new Set(reconciled.records.map(record => record.treatment_id)).size !== 167) fail('BS_PLAN_EXACT_EXISTING_SOURCES_REQUIRED');
    return { concepts, reconciled };
}

function legacyVisibilityAnalysis(matrixRows, snapshot, reusedIds) {
    const other = snapshot.treatments.filter(row => !reusedIds.has(Number(row.id_tratamiento)));
    return {
        mode: 'analysis_only_no_retirement_operations',
        inventory: other.map(row => {
            let config = {}; try { config = json(row.clinical_config) || {}; } catch { /* report, do not fix */ }
            return { treatment_id: Number(row.id_tratamiento), code: row.codigo || null, name: row.nombre,
                clinic_id: Number(row.clinica_id), active: Number(row.activo) === 1,
                catalog_status: config.catalog_status || null, product_type: config.product_type || null,
                source_code_family: row.codigo?.startsWith('BS26-') ? 'other_bs26_concept_not_this_migration' : row.codigo?.startsWith('CCLOUD-') ? 'cliniccloud' : 'other',
                before_row_sha256: hash(row), equivalence_to_new_individual: 'not_inferred', retirement_candidate: false };
        }),
        explicit_customer_references: matrixRows.filter(row => row.record_type === 'legacy_reference' && row.proposed_action !== 'no_write').map(row => ({
            matrix_key: row.matrix_key, source_name: row.name, customer_request: row.proposed_action,
            references: json(row.source_references_json), resolved_treatment_ids: [],
            pending: 'EXACT_LEGACY_SOURCE_ID_BINDING_REQUIRED_NOT_A_NAME_MATCH',
        })),
        proposed_contract_not_implemented: {
            field: 'clinical_config.booking_visibility', proposed_value: 'continuation_only',
            absent_semantics: 'existing_behavior', active_and_catalog_status_unchanged: true,
            new_booking: 'exclude_from_picker_and_reject_new_create_server_side',
            continuation: 'require_server_verified_existing_entitlement_with_same_patient_clinic_treatment_and_remaining_units',
            existing_appointment: 'retain_identity_snapshot_and_normal_reschedule_cancel_restore_checks',
            client_intent_is_not_authority: true, clinical_and_resource_validation_remain_required: true,
            existing_hidden_and_obsolete_cases_require_separate_review: true,
        },
        consumer_evidence: [
            { file: 'src/lib/appointment-booking-catalog.js', symbol: 'individualBookingEligible', finding: 'New booking projection excludes inactive/hidden rows and nonindividual commercial concepts.' },
            { file: 'src/services/treatmentBookingProfile.service.js', symbol: 'loadScopedTreatment', finding: 'eliminado_por_clinica denies lookup even for a purchased voucher; do not reuse as new-only visibility.' },
            { file: 'src/services/treatmentBookingProfile.service.js', symbol: 'requireOperationalProfile', finding: 'obsolete/draft/inactive is rejected unless an explicit caller allows it; not a new-only switch.' },
            { file: 'src/services/patientVoucherAppointments.service.js', symbol: 'buildPlan', finding: 'Purchased continuation uses loadScopedTreatment plus requireOperationalProfile without allowObsolete; obsolete/inactive can block it.' },
            { file: 'src/services/appointmentBookingCommand.service.js', symbol: 'mutateAppointmentBooking', finding: 'Existing appointments preserve frozen booking requirements; scoped treatment lookup still happens before snapshot reuse.' },
            { file: 'src/lib/treatment-catalog-contract.js', symbol: 'assertCatalogEditable', finding: 'Obsolete makes catalogue immutable; leave status unchanged in this plan.' },
            { file: 'src/controllers/tratamientos.controller.js', symbol: 'getTratamientos', finding: 'booking=true is a separate catalogue projection; editor still sees drafts/history.' },
        ],
    };
}

function buildBsCatalogMigrationPlan({ matrixRows, preflight, matrixFileSha256, snapshotFileSha256, badge = 'Nuevo' }) {
    if (!sha(snapshotFileSha256) || typeof badge !== 'string' || !badge.trim() || badge.trim().length > 32
        || /[\u0000-\u001f\u007f]/.test(badge)) fail('BS_PLAN_OPTIONS_INVALID');
    const { concepts, reconciled } = validateInputs(matrixRows, preflight, matrixFileSha256);
    const operations = [], clinicalPending = [], commercialPending = [], commercialReview = [];
    const rows = preflight.snapshot.treatments;
    for (const concept of concepts) {
        const identity = reconciled.records.find(record => record.matrix_key === concept.matrix_key);
        const observed = rows.find(row => Number(row.id_tratamiento) === identity.treatment_id);
        const before = canonicalRow(observed), after = copy(before), changes = [], config = before.clinical_config;
        if (config.catalog_badge == null || config.catalog_badge === '' || config.catalog_badge === badge.trim()) {
            proposeCell(after, changes, 'clinical_config.catalog_badge', badge.trim());
        } else commercialPending.push({ treatment_id: identity.treatment_id, matrix_key: concept.matrix_key, code: 'EXISTING_CUSTOM_BADGE_PRESERVED' });
        const fixed = fixedAmount(concept);
        let priceStage = 'no_fixed_price_change';
        const mode = config.commercial?.sale_mode || 'standalone';
        if (!fixed) commercialPending.push({ treatment_id: identity.treatment_id, matrix_key: concept.matrix_key,
            code: ['from', 'included'].includes(concept.october_price_mode) ? 'NONFIXED_COMMERCIAL_PRICE_CONTRACT_REQUIRED' : 'EXACT_OCTOBER_FIXED_PRICE_ASSOCIATION_REQUIRED' });
        else if (mode !== 'standalone' || config.historical_reference) commercialPending.push({ treatment_id: identity.treatment_id,
            matrix_key: concept.matrix_key, code: 'CURRENT_NONSTANDALONE_POLICY_PRESERVED' });
        else {
            let profile = null;
            try { profile = normalizeProfile(config.price_profile); } catch { /* existing fiscal choices are not reset */ }
            if (config.price_profile != null && (!profile || hash(profile) !== hash(PROFILE))) {
                commercialPending.push({ treatment_id: identity.treatment_id, matrix_key: concept.matrix_key, code: 'EXISTING_FISCAL_DECISION_REQUIRES_REVIEW' });
            } else {
                const amount = typeof before.precio_base === 'string' ? fixed.amount.toFixed(2) : fixed.amount;
                proposeCell(after, changes, 'precio_base', amount);
                for (const [key, value] of Object.entries(PROFILE)) proposeCell(after, changes, 'clinical_config.price_profile.' + key, value);
                priceStage = config.fiscal_mapping_pending === true ? 'documented_draft_price_preparation_fiscal_hold_preserved' : 'existing_gross_policy_october_update_proposal';
                if (config.fiscal_mapping_pending === true) commercialPending.push({ treatment_id: identity.treatment_id,
                    matrix_key: concept.matrix_key, code: 'EXISTING_FISCAL_HOLD_NOT_CLEARED_DISPLAY_NOT_YET_EFFECTIVE' });
                if (config.imported_price_review?.gross_amount !== undefined && config.imported_price_review.gross_amount !== fixed.amount) {
                    commercialPending.push({ treatment_id: identity.treatment_id, matrix_key: concept.matrix_key, code: 'PREVIOUS_PRICE_REVIEW_IS_HISTORICAL_NOT_REAPPROVED' });
                }
            }
        }
        const sourcePending = json(concept.pending_json);
        if (!Array.isArray(sourcePending)) fail('BS_PLAN_PENDING_INVALID');
        clinicalPending.push({ treatment_id: identity.treatment_id, matrix_key: concept.matrix_key,
            catalog_status: config.catalog_status || null, active_unchanged: Number(before.activo) === 1,
            profile_version_unchanged: config.booking_profile?.version || null, source_configuration_pending: sourcePending,
            source_notes_require_current_configuration_reconciliation_not_runtime_failures: true,
            consent_links_unchanged: identity.consent_requirement_ids.length, protocol_links_unchanged: identity.protocol_ids.length,
            activation_authorized_by_plan: false, source_identity_field_missing_preserved: identity.source_identity_field_missing });
        commercialReview.push({ treatment_id: identity.treatment_id, matrix_key: concept.matrix_key,
            price_stage: priceStage, october_price_mode: concept.october_price_mode || 'unlinked',
            source_price_unchanged: true, approval_records_unchanged: true });
        if (!changes.length) continue;
        if (hash(protectedProjection(before)) !== hash(protectedProjection(after))) fail('BS_PLAN_PROTECTED_DATA_CHANGED');
        const operation = { kind: 'propose_existing_treatment_commercial_patch', treatment_id: identity.treatment_id,
            clinic_id: identity.clinic_id, code: identity.code, matrix_key: identity.matrix_key,
            before, after, changes, observed_before_row_sha256: hash(observed),
            before_sha256: hash(dataProjection(before)), after_sha256: hash(dataProjection(after)),
            protected_data_sha256: hash(protectedProjection(before)), hash_scope: 'all_treatment_columns_except_model_owned_updatedAt_canonical_json',
            evidence: { october_tariff: fixed?.references || [], effective_from: fixed ? '2026-10-01' : null,
                price_semantics: 'gross_tax_included_not_net_plus_vat', provisional_tax_not_therapeutic_classification: true,
                badge_is_offline_proposal_only: true }, price_stage: priceStage,
            cas: { forward: 'full_current_observed_row_sha_must_equal_observed_before_row_sha256',
                replay: 'after_data_sha_matches_means_no_write',
                rollback: 'requires_matching_operation_and_durable_applied_full_row_receipt_no_later_change',
                timestamps: 'future_writer_generates_and_records_model_timestamp_not_part_of_this_patch',
                on_mismatch: 'stop_this_operation_no_overwrite_no_rebase' } };
        operation.operation_sha256 = hash(operation);
        operations.push(operation);
    }
    const reusedIds = new Set(reconciled.records.map(record => record.treatment_id));
    const legacy = legacyVisibilityAnalysis(matrixRows, preflight.snapshot, reusedIds);
    const summary = { individual_sources: concepts.length, exact_existing_treatments_reused: reusedIds.size,
        treatments_created: 0, commercial_operation_proposals: operations.length,
        proposals_by_field: count(operations.flatMap(operation => operation.changes), change => change.path),
        proposals_by_price_stage: count(commercialReview, row => row.price_stage),
        october_price_modes: count(commercialReview, row => row.october_price_mode),
        commercial_pending_by_code: count(commercialPending, row => row.code),
        source_configuration_pending_by_code: count(clinicalPending.flatMap(row => row.source_configuration_pending), code => code),
        early_source_keys_missing_preserved: clinicalPending.filter(row => row.source_identity_field_missing_preserved).length,
        other_catalogue_rows_inventory_only: legacy.inventory.length,
        other_catalogue_rows_by_status: count(legacy.inventory, row => row.catalog_status || 'unspecified'),
        explicit_legacy_customer_requests_unresolved: legacy.explicit_customer_references.length,
        legacy_retirement_operations: 0, database_read: false, database_written: false,
        patient_rows_read: false, catalogue_activated: false, clinical_approval_inferred: false,
        programs_changed: false, purchased_entitlements_changed: false };
    const body = { version: VERSION, mode: 'offline_proposal_only_no_applicator', target: 'crm', group_id: 29,
        derived_from_snapshot_at: preflight.created_at, matrix_file_sha256: matrixFileSha256,
        snapshot_file_sha256: snapshotFileSha256, snapshot_sha256: preflight.snapshot_sha256,
        badge_proposal: badge.trim(), field_whitelist: [...FIELD_WHITELIST], operations, commercial_review: commercialReview,
        commercial_pending: commercialPending, clinical_pending: clinicalPending, legacy_visibility_analysis: legacy,
        policy: { requires_separate_operator_review_before_any_apply: true, activation_permitted: false,
            server_owned_provenance_and_approvals_unchanged: true, fiscal_holds_unchanged: true,
            all_unrelated_clinical_config_unchanged: true, prices_from_october_fixed_links_only: true,
            vat_added_on_top_of_gross: false, price_from_ranges_or_from_quotes: false,
            human_approval_attributed: false, physical_resources_or_times_inferred: false,
            protocol_and_consent_links_changed: false, automation_changed: false,
            source_pending_are_unreconciled_document_notes_not_runtime_failures: true,
            historical_ids_renamed_reassigned_or_deleted: false, continuation_visibility_implemented: false }, summary };
    return { ...body, plan_sha256: hash(body) };
}

/** Read-only CAS/replay/rollback decision; never patches the supplied row. */
function assessCommercialOperation(operation, current, { direction = 'forward', appliedReceipt } = {}) {
    const { operation_sha256, ...body } = operation || {};
    if (!sha(operation_sha256) || hash(body) !== operation_sha256 || !['forward', 'rollback'].includes(direction)
        || !operation.changes?.length || operation.changes.some(change => !FIELD_WHITELIST.includes(change.path))
        || hash(dataProjection(operation.before)) !== operation.before_sha256
        || hash(dataProjection(operation.after)) !== operation.after_sha256
        || hash(protectedProjection(operation.before)) !== operation.protected_data_sha256
        || hash(protectedProjection(operation.after)) !== operation.protected_data_sha256) fail('BS_PLAN_OPERATION_INVALID');
    const dataSha = hash(dataProjection(current));
    if (direction === 'forward') {
        if (dataSha === operation.after_sha256) return { decision: 'already_at_proposed_state_no_write', write_permitted: false };
        if (hash(current) !== operation.observed_before_row_sha256 || dataSha !== operation.before_sha256) {
            return { decision: 'current_row_changed_stop', write_permitted: false };
        }
        return { decision: 'before_state_matches_reviewed_proposal', write_permitted: false, cas_matches: true };
    }
    if (dataSha === operation.before_sha256) return { decision: 'already_at_before_state_no_write', write_permitted: false };
    if (appliedReceipt?.operation_sha256 !== operation.operation_sha256 || !sha(appliedReceipt?.after_row_sha256)) {
        return { decision: 'rollback_requires_durable_applied_receipt', write_permitted: false };
    }
    if (hash(current) !== appliedReceipt.after_row_sha256 || dataSha !== operation.after_sha256) {
        return { decision: 'later_row_change_prevents_rollback', write_permitted: false };
    }
    return { decision: 'applied_state_matches_inverse_proposal', write_permitted: false, cas_matches: true };
}

module.exports = { VERSION, PROFILE, FIELD_WHITELIST, buildBsCatalogMigrationPlan, assessCommercialOperation, dataProjection };
