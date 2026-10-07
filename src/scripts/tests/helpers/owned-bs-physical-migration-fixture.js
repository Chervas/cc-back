'use strict';

const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { hash } = require('../../../lib/cliniccloud-import/adapter');
const { preparePhysicalProfileReconciliation } = require('../../../lib/cliniccloud-import/bs-physical-profile-reconciliation');
const { buildBsPhysicalProfileMigrationPlan, REVIEW_VERSION } = require('../../../lib/cliniccloud-import/bs-physical-profile-migration-plan');
const { APPROVAL_VERSION } = require('../../../lib/cliniccloud-import/bs-physical-profile-migration-apply');
const copy = value => JSON.parse(JSON.stringify(value));
const NOW = new Date('2030-01-03T12:10:00.000Z');
const seal = (value, key) => ({ ...value, [key]: hash(value) });
const filename = require.resolve('../bs_physical_profile_reconciliation.test');
const source = fs.readFileSync(filename, 'utf8'), context = { exports: {} };
vm.runInNewContext(source.slice(0, source.indexOf('\ntest(')) + '\nmodule.exports = fixture;', {
    module: context, exports: context.exports, require: createRequire(filename), Date, Map, Set, Buffer,
});
function fixture({ indexes = [0], explicitNull = false, equipment = false } = {}) {
    const h = context.exports();
    for (const index of indexes) {
        if (explicitNull) h.treatments[index].clinical_config.booking_profile = null;
        else delete h.treatments[index].clinical_config.booking_profile;
        h.treatments[index].activo = 0; h.treatments[index].clinical_config.catalog_status = 'draft';
        h.treatments[index].clinical_config.other_clinic_decision = { preserve: 'sí' };
        h.sourceTiming(index, { duration: '—', duration_info: { mode: 'unresolved', minutes: null, raw: '—' } });
    }
    if (equipment) h.resourceMap.cabins_by_clinic[72].C1 = 10;
    h.reseal(); return h;
}
function inputFor(h, { indexes = [0], equipment = false } = {}) {
    h.reseal();
    const input = { ...h.input, snapshotFileSha256: hash(h.input.preflight) };
    input.reconciliation = preparePhysicalProfileReconciliation(h.input);
    const recipes = indexes.map(index => {
        const id = Number(h.snapshot.treatments[index].id_tratamiento), record = input.reconciliation.records.find(row => row.treatment_id === id);
        const candidate = input.reconciliation.proposals.find(row => row.treatment_id === id);
        const profile = copy(candidate.booking_profile);
        if (equipment) { profile.version = 2; profile.phases[0].equipment_requirements = [{ equipment_ids: [5] }]; }
        const evidence = { type: 'synthetic_owned_mysql_qa', reason: 'Acto ficticio revisado expresamente con maquinaria, equipo humano y atención definidos para esta prueba aislada.' };
        return { treatment_id: id, clinic_id: record.clinic_id, matrix_key: record.matrix_key, source: copy(record.source),
            treatment_before_sha256: record.treatment_before_sha256, booking_profile: profile, approved: true,
            reviewer_identity: 'Revisor ficticio de fixture', reviewed_at: '2030-01-03T12:00:00.000Z',
            evidence, evidence_sha256: hash(evidence), decisions: { equipment: equipment ? 'explicit_inventory' : 'explicit_none',
                clinical_team_approved: true, staff_attention_approved: true, existing_inventory_attention_preserved: true,
                no_unquantified_attention: true, source_recipe_is_one_visit: true, no_activation_or_snapshot_changes: true } };
    });
    input.recipeReview = seal({ version: REVIEW_VERSION, reconciliation_plan_sha256: input.reconciliation.plan_sha256,
        physical_recipe_only: true, activation_approved: false, recipes }, 'review_sha256');
    return input;
}
function authorization(plan, database = 'fictitious_physical_qa', direction = 'forward') {
    const backup = { verified: true, target: 'crm', group_id: 29, clinic_ids: [66, 72], database,
        manifest_file_sha256: hash('owned synthetic backup manifest'), backup_sha256: hash('owned synthetic backup bytes'),
        generated_at: '2030-01-03T12:00:00.000Z' };
    const approval = { version: APPROVAL_VERSION, target: 'crm', group_id: 29, clinic_ids: [66, 72], database,
        direction, plan_sha256: plan.plan_sha256, field_whitelist: plan.field_whitelist,
        recipe_review_sha256: plan.recipe_review_sha256, matrix_file_sha256: plan.matrix_file_sha256,
        snapshot_file_sha256: plan.snapshot_file_sha256, physical_profiles_only: true, missing_profiles_only: true,
        no_activation_or_appointment_history_changes: true, operator_identity: 'Operador ficticio de MySQL aislado',
        created_at: '2030-01-03T12:05:00.000Z', expires_at: '2030-01-03T13:00:00.000Z',
        backup_manifest_sha256: backup.manifest_file_sha256 };
    return { approval, backup };
}
module.exports = { fixture, inputFor, authorization, buildBsPhysicalProfileMigrationPlan, NOW, seal, copy };
