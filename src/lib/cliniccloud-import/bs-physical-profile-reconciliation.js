'use strict';

// An offline assessment, not a migration or a green-slot calculator. Existing
// profiles, prices, clinical decisions and appointment snapshots are untouched.
const { hash } = require('./adapter');
const { VERSION: PREFLIGHT_VERSION } = require('./catalog-preflight');
const { validatePinnedTreatmentSources } = require('./bs-documentation-reconciliation');
const { bookingProfileDurationMinutes, pendingAttentionRequirements } = require('../booking-profile');
const { normalizeProgramProfile } = require('../program-booking');
const { installationAllowsStaff } = require('../installation-professionals');
const { equipmentFitsRoom, normalizeRoomEquipmentPolicy } = require('../booking-equipment');
const commercialMigration = require('./bs-catalog-migration-plan');
const visibilityMigration = require('./bs-catalog-visibility-plan');

const VERSION = 'bs-physical-profile-reconciliation-offline/2';
const fail = code => { throw Error(code); };
const json = value => typeof value === 'string' ? JSON.parse(value) : value;
const copy = value => JSON.parse(JSON.stringify(value));
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const active = value => value === true || value === 1;
const counts = (rows, key) => rows.reduce((out, row) => { const value = key(row); out[value] = (out[value] || 0) + 1; return out; }, {});

function physicalMapping(preflight) {
    const snapshot = preflight.snapshot, rooms = new Map(snapshot.installations.map(row => [Number(row.id), row]));
    const captured = preflight.version === PREFLIGHT_VERSION && Array.isArray(snapshot.physical_aliases);
    if (!captured) return { captured: false, rooms, keys: new Map(), errors: ['CURRENT_PHYSICAL_ALIASES_NOT_CAPTURED'] };
    const aliases = new Map(), errors = [];
    for (const row of snapshot.physical_aliases) {
        const source = Number(row.installation_id), target = Number(row.canonical_installation_id);
        if (!Number.isSafeInteger(source) || !Number.isSafeInteger(target) || source < 1 || target < 1
            || Number(row.group_id) !== 29 || !rooms.has(source) || !rooms.has(target) || source === target
            || aliases.has(source) || ![66, 72].includes(Number(rooms.get(source).clinica_id))
            || ![66, 72].includes(Number(rooms.get(target).clinica_id))) {
            errors.push('CURRENT_PHYSICAL_ALIAS_INVALID'); continue;
        }
        aliases.set(source, target);
    }
    if ([...aliases.values()].some(id => aliases.has(id))) errors.push('CURRENT_PHYSICAL_ALIAS_CHAIN_UNSUPPORTED');
    return { captured: true, rooms, keys: new Map([...rooms.keys()].map(id => [id, `installation:${aliases.get(id) || id}`])),
        errors: [...new Set(errors)] };
}

function scopeResources(snapshot, clinicId, profile, mapping) {
    const errors = [], phases = [];
    for (const phase of profile.phases) {
        const professionals = phase.professionals.ids.map(id => {
            const matches = snapshot.professionals.filter(row => Number(row.doctor_id) === id && Number(row.clinica_id) === clinicId);
            const verified = matches.length === 1 && active(matches[0].activo) && active(matches[0].recibe_citas);
            return { doctor_id: id, membership_verified: verified, membership_id: matches.length === 1 ? Number(matches[0].id) : null };
        });
        const equipment = (phase.equipment_requirements || []).map(group => group.equipment_ids.map(id => {
            const matches = snapshot.equipment.filter(row => Number(row.id) === id);
            const unit = matches.length === 1 ? matches[0] : null;
            const membership = snapshot.equipment_memberships.filter(row => Number(row.equipment_id) === id && Number(row.clinic_id) === clinicId);
            const verified = !!unit && unit.status === 'available' && Number(unit.group_id) === 29
                && membership.length === 1;
            return { equipment_id: id, available_in_clinic: verified, unit };
        }));
        const installations = phase.installation_ids.map(id => {
            const room = mapping.rooms.get(id), resourceKey = mapping.keys.get(id);
            const verified = !!room && Number(room.clinica_id) === clinicId && active(room.activo);
            const eligible = professionals.filter(row => row.membership_verified && installationAllowsStaff(room, [row.doctor_id]));
            const staffCompatible = phase.professionals.mode === 'all'
                ? professionals.every(row => row.membership_verified) && installationAllowsStaff(room, phase.professionals.ids)
                : eligible.length > 0;
            let policy = null;
            const policies = snapshot.equipment_room_policies.filter(row => Number(row.installation_id) === Number(resourceKey?.split(':')[1]));
            if (policies.length === 1) {
                try { policy = normalizeRoomEquipmentPolicy({ mode: policies[0].mode, equipment_ids: json(policies[0].equipment_ids) }); }
                catch { /* Invalid room policy is not permissive. */ }
            }
            const equipmentCompatible = equipment.every(group => group.some(entry => entry.available_in_clinic && mapping.captured
                && equipmentFitsRoom({ ...entry.unit, id: entry.equipment_id,
                    fixed_resource_key: mapping.keys.get(Number(entry.unit.home_installation_id)) },
                { resource_key: resourceKey, equipment_policy: policy })));
            return { installation_id: id, name: room?.nombre || null, resource_key: resourceKey || null,
                clinic_active_verified: verified, professionals_compatible: staffCompatible,
                equipment_compatible: equipment.length ? equipmentCompatible : null,
                eligible_professional_ids: eligible.map(row => row.doctor_id) };
        });
        if (!installations.some(row => row.clinic_active_verified && row.professionals_compatible)) errors.push('CURRENT_ROOM_STAFF_NO_VALID_ASSIGNMENT');
        if (equipment.length && !equipment.every(group => group.some(entry => entry.available_in_clinic))) errors.push('CURRENT_EQUIPMENT_NOT_AVAILABLE_IN_CLINIC');
        if (equipment.length && mapping.captured && !installations.some(row => row.clinic_active_verified
            && row.professionals_compatible && row.equipment_compatible)) errors.push('CURRENT_EQUIPMENT_NO_COMPATIBLE_PHYSICAL_ROOM');
        phases.push({ phase_key: phase.key, duration_minutes: phase.duration_minutes,
            professionals_mode: phase.professionals.mode, professionals, installations,
            equipment_groups: equipment.map(group => group.map(({ unit, ...entry }) => ({ ...entry,
                family_key: unit?.family_key || null, attention_policy: unit?.attention_policy || null,
                turnaround_minutes: unit?.turnaround_minutes ?? null }))),
            explicit_staff_attention: copy(phase.staff_attention || null) });
    }
    return { errors: [...new Set(errors)], phases };
}

function literalResources(source, snapshot, resourceMap, mapping) {
    // Only approved exact map keys can resolve an identity. No token/name match.
    const roomIds = (source.cabin_keys || []).map(key => Number(resourceMap.cabins_by_clinic?.[source.clinic_id]?.[key]));
    const staffIds = (source.required_professionals || []).map(label => Number(resourceMap.professionals?.[label]));
    const rooms = roomIds.filter(id => snapshot.installations.some(room => Number(room.id) === id
        && Number(room.clinica_id) === source.clinic_id && active(room.activo)));
    const staff = staffIds.filter(id => snapshot.professionals.filter(row => Number(row.doctor_id) === id
        && Number(row.clinica_id) === source.clinic_id && active(row.activo) && active(row.recibe_citas)).length === 1);
    const allResolved = roomIds.length > 0 && rooms.length === roomIds.length && staffIds.length > 0 && staff.length === staffIds.length;
    const staffCompatible = allResolved && rooms.every(id => {
        const room = snapshot.installations.find(row => Number(row.id) === id);
        return source.professional_mode === 'all' ? installationAllowsStaff(room, staff) : staff.some(id => installationAllowsStaff(room, [id]));
    });
    return { room_ids: rooms, professional_ids: staff, professional_mode: source.professional_mode,
        room_physical_keys: rooms.map(id => mapping.keys.get(id) || null),
        professional_membership_ids: staff.map(id => Number(snapshot.professionals.find(row => Number(row.doctor_id) === id
            && Number(row.clinica_id) === source.clinic_id && active(row.activo) && active(row.recibe_citas)).id)),
        exact_identity_mapping_complete: allResolved, staff_room_compatible: staffCompatible,
        full_physical_definition: allResolved && staffCompatible && rooms.length === 1,
        multiple_written_rooms_are_not_alternatives: rooms.length > 1 };
}

function durationAssessment(source, config) {
    const info = source.duration_info || {}, quantity = source.quantity_duration || config.quantity_duration;
    if (info.mode === 'per_unit' && quantity && Number.isInteger(quantity.per_unit_minutes) && quantity.per_unit_minutes > 0
        && Number.isInteger(quantity.preparation_minutes) && quantity.preparation_minutes >= 0 && quantity.quantity_required === true) {
        return { kind: 'documented_quantity_formula', fixed_minutes: null, formula: copy(quantity),
            clinical_minutes_invented: false, individual_booking_contract_supported: false,
            per_appointment_duration_materialization_supported: true, source_constraint_enforcement_supported: false,
            quantity_input: { positive_integer_required: true, clinical_maximum_not_defined: true,
                maximum_from_1440_minute_technical_limit: Math.floor((1440 - quantity.preparation_minutes) / quantity.per_unit_minutes) },
            explanation: `Duración documentada: ${quantity.preparation_minutes} min de preparación + ${quantity.per_unit_minutes} min por unidad. El backend ya admite duración elegida por reserva, pero falta pedir y guardar la cantidad y validar esta fórmula; no convertirla en minutos libres ni usar ${quantity.per_unit_minutes} min como cita completa.` };
    }
    if (info.mode === 'per_unit') return { kind: 'documented_quantity_formula_incomplete', fixed_minutes: null,
        clinical_minutes_invented: false, individual_booking_contract_supported: false,
        per_appointment_duration_materialization_supported: true, source_constraint_enforcement_supported: false,
        explanation: 'El origen expresa minutos por unidad, pero falta una fórmula completa y trazable de cantidad/preparación. No convertirlos en duración libre de un único acto.' };
    if (info.mode === 'fixed') return { kind: 'fixed', fixed_minutes: info.minutes,
        individual_booking_contract_supported: true, per_appointment_duration_materialization_supported: true,
        source_constraint_enforcement_supported: true, clinical_minutes_invented: false, explanation: `Origen: ${info.minutes} min por cita.` };
    if (info.mode === 'range') {
        const match = /^(\d+)\s*[-–]\s*(\d+)\s*min$/i.exec(String(source.duration).trim());
        const bounds = match && Number(match[1]) >= 1 && Number(match[2]) <= 1440 && Number(match[1]) <= Number(match[2])
            ? { minimum_minutes: Number(match[1]), maximum_minutes: Number(match[2]) } : null;
        return { kind: 'documented_range_requires_manual_choice', fixed_minutes: null, documented_bounds: bounds,
            individual_booking_contract_supported: false, per_appointment_duration_materialization_supported: true,
            source_constraint_enforcement_supported: false, clinical_minutes_invented: false,
            explanation: `El cliente indica «${source.duration}». El backend admite una elección individual, pero aún falta imponer y guardar los límites documentados de esta receta; no dejarla como duración libre de 1 a 1440 ni elegir automáticamente el mínimo.` };
    }
    if (info.mode === 'surgical_days') {
        const raw = String(source.duration).trim(), match = /^(\d+(?:[,.]\d+)?)\s+jornadas?\s+de\s+quirófano$/i.exec(raw);
        return { kind: 'documented_surgical_day_requires_visit_plan', fixed_minutes: null,
            documented_jornadas: /^media jornada de quirófano$/i.test(raw) ? 0.5 : match ? Number(match[1].replace(',', '.')) : null,
            individual_booking_contract_supported: false, per_appointment_duration_materialization_supported: true,
            source_constraint_enforcement_supported: false, clinical_minutes_invented: false,
            explanation: `El cliente indica «${source.duration}». Hay que definir las visitas, fechas, minutos y equipo completo de cada jornada. El contrato de duración individual no convierte jornadas en minutos ni en una sola cita.` };
    }
    return { kind: 'duration_not_quantified_manual_definition_needed', fixed_minutes: null,
        individual_booking_contract_supported: true, per_appointment_duration_materialization_supported: true,
        source_constraint_enforcement_supported: true, clinical_minutes_invented: false,
        manual_choice: { minimum_minutes: 1, maximum_minutes: 1440, choice_required_per_appointment: true,
            clinical_minutes_not_defined: true },
        explanation: 'No hay duración clínica cuantificada. El backend admite un perfil físico estricto con duración NULL y elección explícita de 1 a 1440 minutos por reserva. El profesional debe definir los minutos de este acto; no hay duración clínica por defecto.' };
}

function authoringReadiness({ source, duration, literal, administrative, included, preservedProfile, profile,
    pending, clinical, attention, physicalAliasesVerified }) {
    const requirements = [];
    let recipeKind;
    if (preservedProfile) {
        recipeKind = 'preserve_existing_profile';
        requirements.push(...pending, ...clinical, ...attention.map(item => item.key));
    } else if (administrative) recipeKind = 'administrative_not_a_physical_recipe';
    else {
        recipeKind = included ? 'included_component_visit_definition'
            : duration.kind === 'documented_surgical_day_requires_visit_plan' ? 'surgical_visit_plan'
                : duration.kind.startsWith('documented_quantity_formula') ? 'quantity_formula'
                    : duration.kind === 'documented_range_requires_manual_choice' ? 'bounded_manual_duration'
                        : duration.kind === 'fixed' ? 'fixed_duration_act' : 'single_manual_duration_act';
        requirements.push(...pending, ...clinical, 'EQUIPMENT_AND_ATTENTION_DEFINITION_REQUIRES_EXPLICIT_REVIEW');
        if (included) requirements.push('INCLUDED_COMPONENT_ACTS_AND_ENTITLEMENT_LINK_REQUIRED');
        if (recipeKind === 'surgical_visit_plan') requirements.push('SURGICAL_DAY_TEAM_AND_TIMELINE_NEED_EXPLICIT_RESERVATION');
        if (recipeKind === 'quantity_formula') requirements.push('QUANTITY_INPUT_FORMULA_VALIDATION_AND_SNAPSHOT_REQUIRED');
        if (recipeKind === 'bounded_manual_duration') requirements.push('SOURCE_DURATION_RANGE_ENFORCEMENT_AND_SNAPSHOT_REQUIRED');
        if (recipeKind === 'single_manual_duration_act') requirements.push('VISIT_DURATION_REQUIRES_PROFESSIONAL_CHOICE');
        if (source.sheet === 'Cirugía plástica · tarifa') requirements.push('SURGICAL_TEAM_AND_ATTENTION_REQUIRES_EXPLICIT_REVIEW');
    }
    const singleManualTemplate = recipeKind === 'single_manual_duration_act' && literal.full_physical_definition
        && physicalAliasesVerified && !pending.length && !clinical.length;
    return { recipe_kind: recipeKind, exact_resources_complete: literal.full_physical_definition,
        remaining_capabilities: [...new Set(requirements)],
        manual_null_duration_template_can_be_prepared_offline: singleManualTemplate,
        existing_profile_preserved: !!preservedProfile,
        future_inventory_definition_review_required: !!profile && !profile.phases.some(phase => phase.equipment_requirements?.length),
        v4_conversion_inferred: false,
        can_apply_with_current_catalog_migration_writer: false,
        activation_ready: false, clinical_definition_complete: false };
}

function documentaryAttention(source, profile) {
    const literal = [source.category, source.name, source.detail].join(' ');
    const result = [];
    // These checks flag a literal technique absent from a profile; they do not
    // choose an asset, manufacture a stage split, or authorize an intervention.
    if (/LED fotorregenerador/i.test(literal) && !(profile?.phases || []).some(phase =>
        (phase.equipment_requirements || []).some(group => group.equipment_ids.includes(15)))) {
        result.push({ key: 'literal_led_component_not_reserved', label: 'El origen incluye LED fotorregenerador, pero el perfil actual no reserva el equipo LED. No añadirlo a C7 ni inventar el tiempo; necesita distribución física documentada.' });
    }
    if ((profile?.phases || []).some(phase => (phase.equipment_requirements || []).some(group => group.equipment_ids.includes(5)))) {
        result.push({ key: 'ems_intermediate_check_not_quantified', label: 'EMShape/EMS requiere comprobación a mitad de sesión según el manual; no hay minutos cuantificados. Conservar el perfil y política anteriores, pero no declarar completo el futuro reparto parcial v4.' });
    }
    return result;
}

function preparePhysicalProfileReconciliation({ matrixRows, matrixFileSha256, preflight, sourcePlan,
    resourceMap, resourceMapSha256, manualSources = [], consumerSourceFiles = [], previousReconciliation = null }) {
    const { concepts, records, sources } = validatePinnedTreatmentSources(matrixRows, matrixFileSha256, preflight, sourcePlan);
    if (!resourceMap || resourceMap.version !== 2 || !sha(resourceMapSha256) || hash(resourceMap) !== resourceMapSha256
        || resourceMap.source_account !== 'cliniccloud-5880') fail('BS_PHYSICAL_APPROVED_RESOURCE_MAP_REQUIRED');
    const snapshot = preflight.snapshot;
    if (!['installations', 'professionals', 'equipment', 'equipment_memberships', 'equipment_room_policies'].every(key => Array.isArray(snapshot[key]))) fail('BS_PHYSICAL_RESOURCE_INVENTORY_REQUIRED');
    if (!Array.isArray(consumerSourceFiles) || consumerSourceFiles.some(source => !sha(source.sha256) || typeof source.file !== 'string')
        || new Set(consumerSourceFiles.map(source => source.file)).size !== consumerSourceFiles.length) fail('BS_PHYSICAL_CONSUMER_EVIDENCE_INVALID');
    const mapping = physicalMapping(preflight), report = [], proposals = [];
    for (const identity of records) {
        const treatment = snapshot.treatments.find(row => Number(row.id_tratamiento) === identity.treatment_id);
        const config = json(treatment.clinical_config), source = sources.get(identity.matrix_key);
        const concept = concepts.find(row => row.matrix_key === identity.matrix_key);
        if (source.duration !== concept.duration_raw || source.professional !== concept.staff_raw || source.cabin !== concept.room_raw
            || hash(source.duration_info) !== hash(json(concept.duration_json))) fail('BS_PHYSICAL_LITERAL_OPERATIONAL_SOURCE_CHANGED');
        const duration = durationAssessment(source, config), literal = literalResources(source, snapshot, resourceMap, mapping);
        const administrative = config.booking_mode === 'administrative_review' || source.booking_mode === 'administrative_review';
        const included = config.commercial?.sale_mode === 'program_component_only' || source.source_price?.mode === 'included';
        const pending = [], clinical = [], technical = [], preservedProfile = config.booking_profile || null;
        const sourceConfigDiffers = config.source_duration != null && String(config.source_duration) !== String(source.duration)
            || config.source_professional != null && String(config.source_professional) !== String(source.professional);
        let profile = null, resourceCheck = null, currentStatus = 'missing_profile';
        if (preservedProfile) {
            try { profile = normalizeProgramProfile(preservedProfile, { allowMissingDuration: true }); }
            catch (error) { pending.push('CURRENT_PROFILE_INVALID'); }
            if (profile) {
                resourceCheck = scopeResources(snapshot, identity.clinic_id, profile, mapping);
                pending.push(...resourceCheck.errors);
                if (!mapping.captured || mapping.errors.length) technical.push(...mapping.errors);
                currentStatus = Number(treatment.activo) !== 1 || config.catalog_status === 'draft' ? 'catalogue_draft_profile_preserved'
                    : included ? 'current_continuation_only_profile' : resourceCheck.errors.length ? 'current_profile_resource_conflict'
                        : profile.phases.some(phase => phase.duration_minutes == null) ? 'current_manual_duration_template_requires_choice'
                        : 'current_standalone_profile_structurally_ready';
                if (pendingAttentionRequirements(profile).length) pending.push('EXPLICIT_ATTENTION_REQUIREMENTS_PENDING');
                if (profile.version === 4) {
                    technical.push('V4_RUNTIME_CAPABILITIES_NOT_CAPTURED');
                    if (currentStatus === 'current_standalone_profile_structurally_ready') currentStatus = 'current_v4_profile_requires_runtime_and_clinical_verification';
                }
            } else currentStatus = 'invalid_profile_preserved_for_review';
        } else {
            if (administrative) pending.push('ADMINISTRATIVE_NOT_AN_AUTOMATIC_TREATMENT_VISIT');
            else {
                if (!literal.room_ids.length) pending.push('SOURCE_PHYSICAL_ROOM_NOT_DEFINED_OR_UNRESOLVED');
                if (!literal.professional_ids.length) pending.push('SOURCE_PROFESSIONAL_NOT_DEFINED_OR_UNRESOLVED');
                if (!literal.exact_identity_mapping_complete) pending.push('EXACT_SOURCE_RESOURCE_MAPPING_INCOMPLETE');
                if (!literal.staff_room_compatible && literal.exact_identity_mapping_complete) pending.push('SOURCE_TEAM_ROOM_INCOMPATIBLE');
                if (literal.multiple_written_rooms_are_not_alternatives) clinical.push('WRITTEN_ROOMS_REQUIRE_ACT_DURATION_DISTRIBUTION');
                if (json(concept.pending_json).includes('INJECTABLE_STAFF_REQUIRES_CLINICAL_VALIDATION')) clinical.push('INJECTABLE_RESPONSIBILITY_NOT_CLINICALLY_VALIDATED');
                if (duration.kind.startsWith('documented_quantity_formula')) technical.push('QUANTITY_INPUT_FORMULA_VALIDATION_AND_SNAPSHOT_REQUIRED');
                if (duration.kind === 'documented_range_requires_manual_choice') technical.push('SOURCE_DURATION_RANGE_ENFORCEMENT_AND_SNAPSHOT_REQUIRED');
                if (duration.kind === 'documented_surgical_day_requires_visit_plan') technical.push('SURGICAL_DAY_TEAM_AND_TIMELINE_NEED_EXPLICIT_RESERVATION');
                if (duration.kind === 'duration_not_quantified_manual_definition_needed') technical.push('VISIT_DURATION_REQUIRES_PROFESSIONAL_CHOICE');
                if (included) technical.push('INCLUDED_COMPONENT_ACTS_AND_ENTITLEMENT_LINK_REQUIRED');
                if (literal.full_physical_definition && ['fixed', 'duration_not_quantified_manual_definition_needed'].includes(duration.kind)
                    && !included && !clinical.length && !pending.length && !sourceConfigDiffers && mapping.captured && !mapping.errors.length) {
                    const candidate = normalizeProgramProfile({ version: 1, phases: [{ key: 'phase_1', label: source.name.slice(0, 120),
                        duration_minutes: duration.fixed_minutes, installation_ids: literal.room_ids,
                        professionals: { mode: literal.professional_mode, ids: literal.professional_ids,
                            preferred_id: literal.professional_mode === 'any' && literal.professional_ids.length === 1 ? literal.professional_ids[0] : null } }] }, { allowMissingDuration: true });
                    proposals.push({ kind: duration.kind === 'fixed' ? 'offline_candidate_missing_profile_only'
                        : 'offline_candidate_manual_duration_template_missing_profile_only', treatment_id: identity.treatment_id,
                        clinic_id: identity.clinic_id, matrix_key: identity.matrix_key,
                        treatment_before_sha256: hash(treatment), source: copy(source.provenance), booking_profile: candidate,
                        booking_profile_sha256: hash(candidate), before_booking_profile: { present: false },
                        physical_resource_keys: literal.room_physical_keys,
                        duration_choice_required_per_appointment: duration.kind !== 'fixed',
                        policy: { can_apply: false, equipment_definition_requires_review: true,
                            clinical_team_and_attention_requires_review: true, activation: false, prices_changed: false,
                            current_profiles_replaced: false, appointment_snapshots_changed: false } });
                }
            }
        }
        const attention = documentaryAttention(source, profile);
        if (sourceConfigDiffers) pending.push('SOURCE_CLIENT_DECISION_CHANGED_REVIEW_NOT_OVERWRITE');
        if (source.quantity_duration && config.quantity_duration && hash(source.quantity_duration) !== hash(config.quantity_duration))
            pending.push('SOURCE_QUANTITY_FORMULA_CHANGED_REVIEW_NOT_OVERWRITE');
        const aliasesVerified = mapping.captured && !mapping.errors.length;
        const authoring = authoringReadiness({ source, duration, literal, administrative, included,
            preservedProfile, profile, pending, clinical, attention, physicalAliasesVerified: aliasesVerified });
        const targetStatus = preservedProfile ? attention.length ? 'preserve_current_review_literal_missing_attention_or_component'
            : 'preserve_current_profile_no_recreation' : administrative ? 'administrative_separate_not_a_slot'
                : clinical.length ? 'specific_clinical_decision_required'
                    : included ? 'included_component_visit_definition_required'
                        : literal.full_physical_definition && duration.kind === 'documented_surgical_day_requires_visit_plan' ? 'surgical_visit_plan_authoring_required_resources_complete'
                            : literal.full_physical_definition && duration.kind.startsWith('documented_quantity_formula') ? 'quantity_formula_authoring_required_resources_complete'
                                : literal.full_physical_definition && duration.kind === 'documented_range_requires_manual_choice' ? 'bounded_duration_authoring_required_resources_complete'
                                    : authoring.manual_null_duration_template_can_be_prepared_offline ? 'manual_single_act_template_resources_complete'
                        : proposals.some(row => row.treatment_id === identity.treatment_id) ? 'exact_missing_profile_candidate_requires_final_review'
                            : 'specific_physical_definition_required';
        report.push({ treatment_id: identity.treatment_id, matrix_key: identity.matrix_key, clinic_id: identity.clinic_id,
            name: treatment.nombre, treatment_before_sha256: hash(treatment), source: copy(source.provenance),
            client_reply_evidence: copy(source.client_reply_evidence || []), source_duration: source.duration,
            source_professional: source.professional, source_cabin: source.cabin, source_literal: { category: source.category, name: source.name, detail: source.detail },
            current_status: currentStatus, target_status: targetStatus, administrative, included_only: included,
            current_profile: copy(preservedProfile), current_profile_sha256: preservedProfile ? hash(preservedProfile) : null,
            current_duration_minutes: profile ? bookingProfileDurationMinutes(profile) : null, duration, source_resources: literal,
            equipment_definition_status: !profile ? 'profile_missing_not_inferred'
                : profile.phases.some(phase => phase.equipment_requirements?.length) ? 'current_explicit_inventory_requirements_checked'
                    : 'legacy_no_inventory_requirement_machine_free_not_inferred',
            current_resource_check: resourceCheck, physical_aliases_verified: aliasesVerified, authoring_readiness: authoring,
            attention_documentary_pending: attention, clinical_decisions: clinical, technical_preparation: [...new Set(technical)],
            pending: [...new Set(pending)], october_duration_evidence_preserved_no_override: json(concept.october_duration_evidence_json || '[]'),
            available_slot_declared: false, clinical_capacity_declared_complete: false,
            explanation: preservedProfile ? 'Se conserva el perfil exacto y sus reservas históricas. La verificación de catálogo no prueba un hueco real, la vigencia de horarios ni habilita v4.'
                : administrative ? 'Acto administrativo/external: mantenerlo separado; no inventar una cita clínica de duración cero o 30 min.'
                    : literal.full_physical_definition && duration.kind !== 'fixed' ? `Sala y equipo humano identificados. ${duration.explanation}`
                        : 'Completar únicamente los datos concretos de recursos/actos indicados; no recrear ni activar por nombre parecido.' });
    }
    let supersedes = null;
    if (previousReconciliation) {
        const previous = previousReconciliation.report, { plan_sha256: previousSha, ...previousBody } = previous || {};
        if (!sha(previousReconciliation.file_sha256) || !sha(previousSha) || hash(previousBody) !== previousSha
            || previous?.version !== 'bs-physical-profile-reconciliation-offline/1'
            || previous.matrix_file_sha256 !== matrixFileSha256 || previous.resource_map_sha256 !== resourceMapSha256
            || previous.source_preflight_snapshot_sha256 !== preflight.snapshot_sha256 || previous.source_plan_sha256 !== sourcePlan.plan_sha256
            || previous.records.length !== report.length || new Set(previous.records.map(row => row.treatment_id)).size !== report.length
            || previous.records.some(before => { const after = report.find(row => row.treatment_id === before.treatment_id);
                return !after || before.treatment_before_sha256 !== after.treatment_before_sha256
                    || hash(before.source) !== hash(after.source) || before.current_profile_sha256 !== after.current_profile_sha256; }))
            fail('BS_PHYSICAL_PRIOR_REPORT_BASELINE_CHANGED');
        supersedes = { previous_report_file_sha256: previousReconciliation.file_sha256, previous_plan_sha256: previousSha,
            unchanged_treatment_source_identities: report.length,
            unchanged_existing_profiles: report.filter(row => row.current_profile).length,
            reason: 'El contrato individual actual admite duración NULL; las 20 recetas con recursos completos se distinguen por fórmula, rango, jornadas, acto manual y componente incluido.' };
    }
    const body = { version: VERSION, target: 'offline_only', group_id: 29, source_preflight_version: preflight.version,
        source_preflight_snapshot_sha256: preflight.snapshot_sha256, source_plan_sha256: sourcePlan.plan_sha256,
        resource_map_sha256: resourceMapSha256, matrix_file_sha256: matrixFileSha256, supersedes, records: report, proposals,
        summary: { exact_treatments: report.length, current_by_status: counts(report, row => row.current_status),
            target_by_status: counts(report, row => row.target_status), duration_by_kind: counts(report.filter(row => !row.current_profile), row => row.duration.kind),
            preserved_existing_profiles: report.filter(row => row.current_profile).length,
            existing_profile_by_version: counts(report.filter(row => row.current_profile), row => row.current_profile.version),
            missing_profile_by_recipe_kind: counts(report.filter(row => !row.current_profile), row => row.authoring_readiness.recipe_kind),
            current_equipment_definition: counts(report.filter(row => row.current_profile), row => row.equipment_definition_status),
            exact_missing_profile_candidates: proposals.length,
            candidate_by_kind: counts(proposals, row => row.kind),
            manual_null_duration_template_candidates: proposals.filter(row => row.duration_choice_required_per_appointment).length,
            actual_slots_verified: 0, writes: 0 },
        authoring_worklist: Object.fromEntries([...new Set(report.map(row => row.target_status))].map(status => [status,
            report.filter(row => row.target_status === status).map(row => ({ treatment_id: row.treatment_id, clinic_id: row.clinic_id,
                matrix_key: row.matrix_key, source: row.source, recipe_kind: row.authoring_readiness.recipe_kind,
                remaining_capabilities: row.authoring_readiness.remaining_capabilities }))])),
        source_code_capabilities: { evidence_scope: 'current_repository_only_not_deployed_runtime',
            strict_null_duration_physical_template_supported: true, explicit_integer_duration_per_appointment: { minimum: 1, maximum: 1440 },
            quantity_choice_formula_enforcement_supported: false, source_duration_range_enforcement_supported: false,
            surgical_jornadas_to_visit_plan_compiler_supported: false, included_component_act_split_inferred: false,
            live_capabilities_or_flags_captured: false, relative_step_activation_inferred: false },
        migration_writer: { physical_profiles_supported: false,
            accepted_plan_versions: [commercialMigration.VERSION, visibilityMigration.VERSION],
            accepted_field_whitelist: [...commercialMigration.FIELD_WHITELIST, ...visibilityMigration.FIELD_WHITELIST],
            required_new_plan_version: 'dedicated_missing_physical_profile_plan_with_explicit_recipe_review',
            exact_targets_preparable_now: proposals.map(row => row.treatment_id),
            requirements: ['Releer inventario físico y tratamiento actual antes de concretar operaciones; la captura de medianoche sólo acredita este informe.',
                'Crear una versión de plan y whitelist exclusivos para clinical_config.booking_profile; no ampliar silenciosamente el escritor comercial/de visibilidad.',
                'Admitir sólo identidad exacta, hash completo de fila previo y ausencia comprobada de perfil; rechazar edición humana o perfil aparecido después.',
                'Adjuntar decisiones expresas sobre maquinaria, equipo clínico y atención antes de aplicar las ocho formas técnicas de duración NULL.',
                'Mantener activo/catalog_status, precios, documentos, firmas y snapshots históricos fuera de la operación física.',
                'Comparar y escribir con transacción, bloqueo de fila, backup verificado, intención durable y recibo hash; ejecución repetida debe ser no-op.',
                'Rollback sólo sobre la fila posterior que coincide con el recibo; restaurar ausencia de perfil en catálogo sin reescribir las citas materializadas.'],
            can_apply: false, activation_included: false },
        piedad_partial_attention_migration: { status: 'review_blueprint_not_activation', same_visit_start_required: true,
            operational_confirmation: 'Carlos confirmó la operativa de Piedad: preparaciones 5+5+5 durante los primeros 15 minutos, con INDIBA atendida después. No implica aprobación médica de una retirada o comprobación no cuantificadas.',
            original_manual_evidence: [
                { file: 'BS-Medical-Protocolos-V1-Corporal (2) - copia.pdf', pdf_sha256: '5361917f6de9b68d52c18befcde09789fbeb674b7bbb2ec78c2aed27aa7000fc',
                    pdf_page: 6, literal_quote: 'EMShape PRO (BECO)', significance: 'Un activo EMShape; aliases EMS/EMShape ya configurados. No se crea una máquina adicional denominada MAG.' },
                { file: 'BS-Medical-Protocolos-V1-Corporal (2) - copia.pdf', pdf_sha256: '5361917f6de9b68d52c18befcde09789fbeb674b7bbb2ec78c2aed27aa7000fc',
                    pdf_page: 12, literal_quote: 'movimiento continuo.', significance: 'INDIBA mantiene atención continua, no se convierte en máquina desatendida.' },
                { file: 'BS-Medical-Protocolos-V1-Corporal (2) - copia.pdf', pdf_sha256: '5361917f6de9b68d52c18befcde09789fbeb674b7bbb2ec78c2aed27aa7000fc',
                    pdf_page: 16, literal_quote: 'minutos y volver a comprobar a mitad de sesión.', significance: 'La comprobación intermedia existe; no tiene duración propia cuantificada.' },
            ].map(evidence => {
                const manual = manualSources.find(source => source.file === evidence.file && source.sha256 === evidence.pdf_sha256);
                const page = manual?.pages?.[evidence.pdf_page - 1];
                return { ...evidence, original_literal_verified: typeof page === 'string' && page.includes(evidence.literal_quote),
                    literal_page_sha256: typeof page === 'string' ? hash(page) : null };
            }),
            initial_preparations: [{ technique: 'presoterapia', minutes: 5 }, { technique: 'EMS/EMShape, una sola máquina', minutes: 5 }, { technique: 'INDIBA', minutes: 5 }],
            common_start_window_minutes: 15, indiba_after_preparation: 'continuous', room_equipment_reserved_full_phase: true,
            intermediate_ems_check: { minutes: null, status: 'documented_but_not_quantified_blocks_verified_partial_capacity' },
            final_preparation_policy: 'do_not_infer_new_final_and_do_not_silence_existing_start_end_policies',
            current_equipment_policies_preserved: snapshot.equipment.filter(row => [5, 11, 14].includes(Number(row.id))).map(row => ({ equipment_id: Number(row.id), attention_policy: row.attention_policy })),
            v4_activation: false, legacy_snapshot_migration: false },
        consumer_evidence: [
            { file: 'src/lib/booking-profile-duration.js', symbol: 'resolveBookingProfileDuration', finding: 'Instancia una plantilla física estricta con durationSelection explícita de 1..1440; exige todas las fases NULL y conserva tiempos fijos, recursos y atención.' },
            { file: 'src/lib/treatment-catalog-contract.js', symbol: 'mergeClinicalConfig', finding: 'Una configuración activa admite duración NULL mediante normalizeProgramProfile(allowMissingDuration), con sala y profesional completos; sin activar este informe.' },
            { file: 'src/services/appointmentBookingAvailability.service.js', symbol: 'searchTreatmentSlots', finding: 'Recibe durationSelection y busca con la misma duración materializada; ausencia de perfil sigue dando booking_profile_missing.' },
            { file: 'src/services/appointmentBookingCommand.service.js', symbol: 'mutateAppointmentBooking', finding: 'Recibe durationSelection, congela perfil y elección en la cita; cambios posteriores del catálogo no reinterpretan su snapshot.' },
            { file: 'src/services/treatmentBookingProfile.service.js', symbol: 'assertOperationalBookingProfile', finding: 'Compuertas simple/multi/relativeSteps y atención pendiente siguen siendo obligatorias; soporte en código no acredita banderas desplegadas.' },
            { file: 'src/lib/cliniccloud-import/bs-catalog-migration-apply.js', symbol: 'whitelist', finding: 'Sólo acepta versiones comercial y visibilidad; ambas whitelists excluyen clinical_config.booking_profile.' },
        ].map(evidence => ({ ...evidence, source_file_sha256: consumerSourceFiles.find(source => source.file === evidence.file)?.sha256 || null })),
        limitations: ['Horario real y ocupaciones no se exportan en este inventario; usar solver en integración posterior.',
            'Capabilities/env no capturados: ninguna compuerta v4 se activa ni se presume.',
            'El mapa histórico de identidad no sustituye filas actuales de InstallationPhysicalAliases.',
            'Perfiles legacy vigentes se conservan; ausencia de requisito de máquina no acredita que una técnica no use máquina.',
            'No aprobación médica/legal inferida; no comparación de precios ni saldos.'],
        policy: { database_written: false, original_files_modified: false, catalog_activated: false, legacy_profiles_replaced: false,
            appointment_snapshots_changed: false, signatures_changed: false, prices_changed: false, reminders_sent: false } };
    return { ...body, plan_sha256: hash(body) };
}

function verifyPhysicalProfileReconciliation(plan, input) {
    if (hash(plan) !== hash(preparePhysicalProfileReconciliation(input))) fail('BS_PHYSICAL_PLAN_CHANGED');
    return true;
}

module.exports = { VERSION, physicalMapping, scopeResources, durationAssessment,
    authoringReadiness, preparePhysicalProfileReconciliation, verifyPhysicalProfileReconciliation };
