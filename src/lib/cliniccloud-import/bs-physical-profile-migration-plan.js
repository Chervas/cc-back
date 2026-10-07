'use strict';

// A separate, reviewed missing-profile contract. No SQL, activation or patient
// mutation. The offline readiness report alone is never a recipe approval.
const { hash } = require('./adapter');
const { VERSION: PREFLIGHT_VERSION, checkedMatrix, reconcileCatalog } = require('./catalog-preflight');
const { physicalMapping, scopeResources, preparePhysicalProfileReconciliation } = require('./bs-physical-profile-reconciliation');
const { normalizeProgramProfile } = require('../program-booking');
const { pendingAttentionRequirements } = require('../booking-profile');
const { normalizeAttentionPolicy } = require('../booking-attention');
const { materializedRow, dataSha, fullSha } = require('./bs-catalog-migration-apply');

const VERSION = 'bs-physical-profile-migration-offline/1';
const REVIEW_VERSION = 'bs-physical-profile-recipe-review/1';
const FIELD_WHITELIST = Object.freeze(['clinical_config.booking_profile']);
const RESOURCE_KEYS = Object.freeze(['installations', 'physical_aliases', 'professionals', 'equipment',
    'equipment_memberships', 'equipment_room_policies']);
const copy = value => JSON.parse(JSON.stringify(value));
const same = (a, b) => hash(a) === hash(b);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = code => { throw Error(code); };
function sealed(value, key, code) {
    const { [key]: digest, ...body } = value || {};
    if (!sha(digest) || hash(body) !== digest) fail(code);
    return body;
}
function resourceSnapshot(snapshot) {
    if (!snapshot || RESOURCE_KEYS.some(key => !Array.isArray(snapshot[key]))) fail('BS_PHYSICAL_RESOURCE_SNAPSHOT_REQUIRED');
    return Object.fromEntries(RESOURCE_KEYS.map(key => [key, copy(snapshot[key])]));
}
function profileCell(row) {
    const config = materializedRow(row).clinical_config;
    return Object.hasOwn(config, 'booking_profile') ? { present: true, value: copy(config.booking_profile) } : { present: false };
}
function protectedSha(row) {
    const value = materializedRow(row); delete value.updatedAt; delete value.clinical_config.booking_profile;
    return hash(value);
}
function validateApprovedProfile(recipe, record, snapshot) {
    if (record.current_profile != null || !['single_manual_duration_act', 'fixed_duration_act'].includes(record.authoring_readiness?.recipe_kind)
        || record.administrative || record.included_only || record.pending.length || record.clinical_decisions.length
        || !record.physical_aliases_verified || !record.source_resources.full_physical_definition)
        fail('BS_PHYSICAL_RECIPE_SCOPE_OR_DEFINITION_INCOMPLETE');
    const profile = normalizeProgramProfile(recipe.booking_profile, { allowMissingDuration: true });
    if (!profile || !same(profile, recipe.booking_profile) || profile.phases.length !== 1
        || pendingAttentionRequirements(profile).length) fail('BS_PHYSICAL_STRICT_RECIPE_PROFILE_REQUIRED');
    const phase = profile.phases[0], literal = record.source_resources;
    if (!same(phase.installation_ids, literal.room_ids) || !same(phase.professionals.ids, literal.professional_ids)
        || phase.professionals.mode !== literal.professional_mode
        || (record.duration.kind === 'fixed' ? phase.duration_minutes !== record.duration.fixed_minutes : phase.duration_minutes !== null))
        fail('BS_PHYSICAL_RECIPE_LITERAL_RESOURCES_OR_DURATION_CHANGED');
    const decisions = recipe.decisions;
    if (!decisions || !['explicit_none', 'explicit_inventory'].includes(decisions.equipment)
        || decisions.clinical_team_approved !== true || decisions.staff_attention_approved !== true
        || decisions.existing_inventory_attention_preserved !== true || decisions.no_unquantified_attention !== true
        || decisions.source_recipe_is_one_visit !== true || decisions.no_activation_or_snapshot_changes !== true)
        fail('BS_PHYSICAL_RECIPE_APPROVAL_REQUIRED');
    const units = (phase.equipment_requirements || []).flatMap(group => group.equipment_ids);
    if ((decisions.equipment === 'explicit_inventory') !== (units.length > 0)) fail('BS_PHYSICAL_EQUIPMENT_REVIEW_MISMATCH');
    // An explicit phase policy may add requirements; it cannot silently erase
    // a machine's existing setup/check/end/continuous policy.
    for (const id of units) {
        const unit = snapshot.equipment.find(row => Number(row.id) === id);
        const input = typeof unit?.attention_policy === 'string' ? JSON.parse(unit.attention_policy) : unit?.attention_policy;
        let policy;
        try { policy = normalizeAttentionPolicy(input); }
        catch { fail('BS_PHYSICAL_EXISTING_ATTENTION_POLICY_INVALID'); }
        if (phase.staff_attention?.length && !phase.staff_attention.some(value => same(value, policy)))
            fail('BS_PHYSICAL_EXISTING_ATTENTION_NOT_PRESERVED');
    }
    const mapping = physicalMapping({ version: PREFLIGHT_VERSION, snapshot });
    if (!mapping.captured || mapping.errors.length) fail('BS_PHYSICAL_PHYSICAL_ALIAS_CONTRACT_INVALID');
    const resourceCheck = scopeResources(snapshot, record.clinic_id, profile, mapping);
    if (resourceCheck.errors.length) fail('BS_PHYSICAL_LIVE_RECIPE_RESOURCES_INVALID');
    return profile;
}
function buildBsPhysicalProfileMigrationPlan(input = {}) {
    const { matrixRows, matrixFileSha256, preflight, snapshotFileSha256, reconciliation, recipeReview } = input;
    const concepts = checkedMatrix(matrixRows);
    if (preflight?.version !== PREFLIGHT_VERSION || preflight.target !== 'crm' || preflight.mode !== 'read_only'
        || preflight.group_id !== 29 || !sha(matrixFileSha256) || matrixFileSha256 !== preflight.matrix_file_sha256
        || !sha(snapshotFileSha256) || hash(preflight.snapshot) !== preflight.snapshot_sha256
        || preflight.policy?.database_written !== false || preflight.policy?.treatments_activated !== false
        || preflight.snapshot.triggers?.length || preflight.snapshot.clinics?.length !== 2
        || ![66, 72].every(id => preflight.snapshot.clinics.some(row => Number(row.id_clinica) === id && Number(row.grupoClinicaId) === 29)))
        fail('BS_PHYSICAL_PINNED_PREFLIGHT_REQUIRED');
    const exact = reconcileCatalog(matrixRows, preflight.snapshot).records;
    if (exact.some(row => row.status !== 'exact_existing_source') || new Set(exact.map(row => row.treatment_id)).size !== 167
        || !same(exact, preflight.reconciliation?.records)) fail('BS_PHYSICAL_EXACT_SOURCE_IDENTITY_REQUIRED');
    sealed(reconciliation, 'plan_sha256', 'BS_PHYSICAL_RECONCILIATION_INTEGRITY_INVALID');
    if (reconciliation.version !== 'bs-physical-profile-reconciliation-offline/2' || reconciliation.target !== 'offline_only'
        || reconciliation.group_id !== 29 || reconciliation.matrix_file_sha256 !== matrixFileSha256
        || reconciliation.source_preflight_snapshot_sha256 !== preflight.snapshot_sha256
        || reconciliation.records.length !== 167 || new Set(reconciliation.records.map(row => row.treatment_id)).size !== 167)
        fail('BS_PHYSICAL_RECONCILIATION_SCOPE_INVALID');
    // A checksum is not source authority. Re-derive operational interpretation
    // from the original source plan, pinned matrix and approved identity map.
    const rebuilt = preparePhysicalProfileReconciliation(input);
    if (!same(rebuilt.records, reconciliation.records) || !same(rebuilt.proposals, reconciliation.proposals)
        || rebuilt.source_plan_sha256 !== reconciliation.source_plan_sha256
        || rebuilt.resource_map_sha256 !== reconciliation.resource_map_sha256)
        fail('BS_PHYSICAL_RECONCILIATION_NOT_REPRODUCIBLE');
    for (const identity of exact) {
        const record = reconciliation.records.find(row => row.treatment_id === identity.treatment_id);
        const concept = concepts.find(row => row.matrix_key === identity.matrix_key);
        const refs = typeof concept.source_references_json === 'string' ? JSON.parse(concept.source_references_json) : concept.source_references_json;
        if (!record || record.matrix_key !== identity.matrix_key || record.clinic_id !== identity.clinic_id
            || record.treatment_before_sha256 !== identity.current_row_sha256 || !refs.some(ref => same({
                file_sha256: ref.file_sha256, sheet: ref.sheet, source_row: ref.source_row, row_sha256: ref.row_sha256 }, record.source)))
            fail('BS_PHYSICAL_RECONCILIATION_SOURCE_CHANGED');
    }
    sealed(recipeReview, 'review_sha256', 'BS_PHYSICAL_RECIPE_APPROVAL_REQUIRED');
    if (recipeReview.version !== REVIEW_VERSION || recipeReview.reconciliation_plan_sha256 !== reconciliation.plan_sha256
        || recipeReview.physical_recipe_only !== true || recipeReview.activation_approved !== false
        || !Array.isArray(recipeReview.recipes) || !recipeReview.recipes.length || recipeReview.recipes.length > 167
        || new Set(recipeReview.recipes.map(row => row.treatment_id)).size !== recipeReview.recipes.length)
        fail('BS_PHYSICAL_RECIPE_APPROVAL_REQUIRED');
    const snapshot = preflight.snapshot, operations = [];
    for (const recipe of recipeReview.recipes) {
        const record = reconciliation.records.find(row => row.treatment_id === recipe.treatment_id);
        const observed = snapshot.treatments.find(row => Number(row.id_tratamiento) === recipe.treatment_id);
        if (!record || !observed || recipe.clinic_id !== record.clinic_id || recipe.matrix_key !== record.matrix_key
            || !same(recipe.source, record.source) || recipe.treatment_before_sha256 !== hash(observed)
            || recipe.approved !== true || typeof recipe.reviewer_identity !== 'string' || !recipe.reviewer_identity.trim()
            || !Number.isFinite(Date.parse(recipe.reviewed_at)) || !sha(recipe.evidence_sha256)
            || !recipe.evidence || hash(recipe.evidence) !== recipe.evidence_sha256
            || typeof recipe.evidence.reason !== 'string' || recipe.evidence.reason.trim().length < 30)
            fail('BS_PHYSICAL_RECIPE_APPROVAL_REQUIRED');
        const before = materializedRow(observed), beforeCell = profileCell(before);
        if (beforeCell.present && beforeCell.value !== null) fail('BS_PHYSICAL_ONLY_MISSING_PROFILE_ALLOWED');
        const profile = validateApprovedProfile(recipe, record, snapshot), after = copy(before);
        after.clinical_config.booking_profile = profile;
        const afterCell = profileCell(after);
        if (protectedSha(before) !== protectedSha(after)) fail('BS_PHYSICAL_PROTECTED_DATA_CHANGED');
        const change = { path: FIELD_WHITELIST[0], before: beforeCell, after: afterCell,
            before_sha256: hash(beforeCell), after_sha256: hash(afterCell) };
        const body = { kind: 'propose_missing_physical_profile_only', treatment_id: recipe.treatment_id, clinic_id: recipe.clinic_id,
            matrix_key: recipe.matrix_key, source: copy(recipe.source), before, after, changes: [change],
            observed_before_row_sha256: fullSha(before), before_sha256: dataSha(before), after_sha256: dataSha(after),
            protected_data_sha256: protectedSha(before), approved_recipe: copy(recipe) };
        operations.push({ ...body, operation_sha256: hash(body) });
    }
    operations.sort((a, b) => a.treatment_id - b.treatment_id);
    const resources = resourceSnapshot(snapshot), body = { version: VERSION, target: 'crm', group_id: 29,
        matrix_file_sha256: matrixFileSha256, snapshot_file_sha256: snapshotFileSha256,
        snapshot_sha256: preflight.snapshot_sha256, reconciliation_plan_sha256: reconciliation.plan_sha256,
        recipe_review_sha256: recipeReview.review_sha256, field_whitelist: [...FIELD_WHITELIST],
        resource_snapshot: resources, resource_snapshot_sha256: hash(resources), operations,
        policy: { missing_profiles_only: true, activation_permitted: false, existing_profiles_replaced: false,
            appointment_snapshots_changed: false, prices_changed: false, approvals_or_provenance_changed: false },
        summary: { reviewed_missing_profile_operations: operations.length, database_written: false, activation: false } };
    return { ...body, plan_sha256: hash(body) };
}
function verifyPhysicalPlan(plan, input) {
    sealed(plan, 'plan_sha256', 'BS_PHYSICAL_PLAN_INTEGRITY_INVALID');
    if (plan.version !== VERSION || !same(plan, buildBsPhysicalProfileMigrationPlan(input)))
        fail('BS_PHYSICAL_PLAN_NOT_REPRODUCIBLE');
    return true;
}
function validatePhysicalStoragePatch({ op, current, target, direction }) {
    sealed(op, 'operation_sha256', 'BS_PHYSICAL_STORAGE_OPERATION_INVALID');
    const afterCell = profileCell(op.after);
    let strictProfile;
    try { strictProfile = normalizeProgramProfile(afterCell.value, { allowMissingDuration: true }); }
    catch { fail('BS_PHYSICAL_STORAGE_STRICT_PROFILE_REQUIRED'); }
    if (!afterCell.present || !strictProfile || !same(strictProfile, afterCell.value)
        || !same(strictProfile, op.approved_recipe?.booking_profile) || op.approved_recipe?.approved !== true
        || pendingAttentionRequirements(strictProfile).length || dataSha(op.before) !== op.before_sha256
        || dataSha(op.after) !== op.after_sha256 || fullSha(op.before) !== op.observed_before_row_sha256)
        fail('BS_PHYSICAL_STORAGE_STRICT_PROFILE_REQUIRED');
    if (op.kind !== 'propose_missing_physical_profile_only' || !['forward', 'rollback'].includes(direction)
        || op.changes?.length !== 1 || op.changes[0].path !== FIELD_WHITELIST[0]
        || !same(profileCell(op.before), op.changes[0].before) || !same(profileCell(op.after), op.changes[0].after)
        || op.changes[0].before.present && op.changes[0].before.value !== null
        || hash(op.changes[0].before) !== op.changes[0].before_sha256 || hash(op.changes[0].after) !== op.changes[0].after_sha256
        || protectedSha(op.before) !== op.protected_data_sha256 || protectedSha(op.after) !== op.protected_data_sha256
        || dataSha(current) !== dataSha(direction === 'forward' ? op.before : op.after)
        || dataSha(target) !== dataSha(direction === 'forward' ? op.after : op.before)
        || Number(current.id_tratamiento) !== op.treatment_id || Number(current.clinica_id) !== op.clinic_id)
        fail('BS_PHYSICAL_STORAGE_PROTECTED_DATA_CHANGED');
}
module.exports = { VERSION, REVIEW_VERSION, FIELD_WHITELIST, RESOURCE_KEYS, resourceSnapshot, profileCell, protectedSha,
    validateApprovedProfile, buildBsPhysicalProfileMigrationPlan, verifyPhysicalPlan, validatePhysicalStoragePatch };
