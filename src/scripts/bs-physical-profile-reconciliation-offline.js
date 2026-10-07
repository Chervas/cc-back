#!/usr/bin/env node
'use strict';

// Local input files only. No ORM/bootstrap, database connection, env or network.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { hash } = require('../lib/cliniccloud-import/adapter');
const { parseCsv } = require('../lib/cliniccloud-import/csv');
const { buildCatalogPlan } = require('../lib/cliniccloud-import/catalog');
const { clientReplies } = require('../lib/cliniccloud-import/catalog-replies');
const { WORKBOOK_SHA, REPLIES_SHA, ARCHIVE_SHA, COLUMNS } = require('../lib/cliniccloud-import/catalog-matrix');
const { MATRIX_FILE_SHA } = require('../lib/cliniccloud-import/catalog-preflight');
const { readBytes, parseArgs, writePrivateJson } = require('../lib/cliniccloud-import/io');
const { pdfSources, writePrivateCsv } = require('./bs-catalog-matrix-offline');
const { preparePhysicalProfileReconciliation } = require('../lib/cliniccloud-import/bs-physical-profile-reconciliation');

const RESOURCE_MAP_FILE_SHA = 'edbe7c8c1c1b9e477f707fda7cffab4d9d88de8273a2a503c8676b02cebb32c7';
const PRIOR_RECONCILIATION_FILE_SHA = 'be496d44ed6e5a65468bec5e4523c210379a10a98024788516f866a893a9c73c';
const CONSUMER_SOURCE_FILES = ['src/lib/booking-profile-duration.js', 'src/lib/treatment-catalog-contract.js',
    'src/services/appointmentBookingAvailability.service.js', 'src/services/appointmentBookingCommand.service.js',
    'src/services/treatmentBookingProfile.service.js', 'src/lib/cliniccloud-import/bs-catalog-migration-apply.js'];
function pinned(filename, expected) {
    const bytes = readBytes(filename);
    if (hash(bytes) !== expected) throw Error('BS_PHYSICAL_PINNED_FILE_CHANGED');
    return bytes;
}
function workbook(filename, expected) {
    pinned(filename, expected);
    const result = spawnSync('python3', ['-B', path.resolve(__dirname, '../lib/cliniccloud-import/xlsx_catalog.py'), filename],
        { encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) throw Error('BS_PHYSICAL_LITERAL_WORKBOOK_EXTRACTION_FAILED');
    return JSON.parse(result.stdout);
}
const statuses = {
    current_standalone_profile_structurally_ready: 'Perfil individual actual preparado estructuralmente',
    current_manual_duration_template_requires_choice: 'Plantilla física actual: elegir minutos por cita',
    current_continuation_only_profile: 'Sólo continuidad; no venta individual',
    catalogue_draft_profile_preserved: 'Borrador con perfil conservado',
    current_profile_resource_conflict: 'Conflicto concreto de recursos del perfil', missing_profile: 'Sin perfil actual',
    invalid_profile_preserved_for_review: 'Perfil inválido conservado para revisar',
    current_v4_profile_requires_runtime_and_clinical_verification: 'Perfil por pasos: verificar compuerta operativa y atención clínica',
    preserve_current_profile_no_recreation: 'Conservar perfil; no recrear',
    preserve_current_review_literal_missing_attention_or_component: 'Conservar perfil y revisar componente/atención documentados',
    administrative_separate_not_a_slot: 'Acto administrativo, separado de citas clínicas automáticas',
    specific_clinical_decision_required: 'Decisión clínica concreta indicada',
    manual_single_act_template_resources_complete: 'Acto manual: forma técnica NULL preparada; revisar y elegir minutos por cita',
    quantity_formula_authoring_required_resources_complete: 'Cantidad: preparar entrada, fórmula y evidencia por reserva',
    bounded_duration_authoring_required_resources_complete: 'Rango: imponer límites documentados y guardar elección',
    surgical_visit_plan_authoring_required_resources_complete: 'Jornadas quirúrgicas: definir visitas, minutos, fechas y equipo',
    included_component_visit_definition_required: 'Componente incluido: definir actos y vínculo al derecho contratado',
    exact_missing_profile_candidate_requires_final_review: 'Candidato técnico trazable; sin activar',
    specific_physical_definition_required: 'Falta definición física concreta indicada',
};
const reasons = {
    SOURCE_PHYSICAL_ROOM_NOT_DEFINED_OR_UNRESOLVED: 'Falta sala explícita en origen o su enlace seguro',
    SOURCE_PROFESSIONAL_NOT_DEFINED_OR_UNRESOLVED: 'Falta profesional explícito o pertenencia activa segura',
    EXACT_SOURCE_RESOURCE_MAPPING_INCOMPLETE: 'No hay definición completa de sala y profesional por identidad exacta',
    WRITTEN_ROOMS_REQUIRE_ACT_DURATION_DISTRIBUTION: 'Se indican varias salas: falta qué acto se realiza en cada una y cuánto dura',
    INJECTABLE_RESPONSIBILITY_NOT_CLINICALLY_VALIDATED: 'Aplicación inyectable asignada a auxiliar: falta validar responsabilidad clínica',
    QUANTITY_INPUT_FORMULA_VALIDATION_AND_SNAPSHOT_REQUIRED: 'Pedir cantidad entera, validar preparación + minutos por unidad y guardar evidencia',
    SOURCE_DURATION_RANGE_ENFORCEMENT_AND_SNAPSHOT_REQUIRED: 'Imponer límites del rango documentado y guardar la duración elegida',
    INCLUDED_COMPONENT_ACTS_AND_ENTITLEMENT_LINK_REQUIRED: 'Definir puesta/retirada como actos expresos con duración y derecho de programa',
    EQUIPMENT_AND_ATTENTION_DEFINITION_REQUIRES_EXPLICIT_REVIEW: 'Revisar maquinaria y atención con definición expresa; ausencia de equipo no significa técnica sin máquina',
    SURGICAL_TEAM_AND_ATTENTION_REQUIRES_EXPLICIT_REVIEW: 'Validar equipo quirúrgico y atención; no inventar personal adicional',
    SURGICAL_DAY_TEAM_AND_TIMELINE_NEED_EXPLICIT_RESERVATION: 'Elegir fechas y horarios de cada jornada quirúrgica y equipo completo',
    VISIT_DURATION_REQUIRES_PROFESSIONAL_CHOICE: 'Profesional debe elegir la duración de esta reserva',
    ADMINISTRATIVE_NOT_AN_AUTOMATIC_TREATMENT_VISIT: 'El cliente lo definió como cita administrativa/external; no crear slot clínico automático',
    CURRENT_ROOM_STAFF_NO_VALID_ASSIGNMENT: 'No hay sala activa compatible con el equipo humano requerido',
    CURRENT_EQUIPMENT_NOT_AVAILABLE_IN_CLINIC: 'Equipo requerido no disponible o no adscrito a la clínica',
    CURRENT_EQUIPMENT_NO_COMPATIBLE_PHYSICAL_ROOM: 'Equipo requerido no cabe en la sala física según configuración real',
    CURRENT_PHYSICAL_ALIASES_NOT_CAPTURED: 'Captura antigua: verificar alias físicos con lector v2',
    CURRENT_PHYSICAL_ALIAS_INVALID: 'Alias físico actual inválido; verificar, no ignorar',
    CURRENT_PHYSICAL_ALIAS_CHAIN_UNSUPPORTED: 'Cadena de alias físicos no soportada; verificar',
    SOURCE_CLIENT_DECISION_CHANGED_REVIEW_NOT_OVERWRITE: 'La definición guardada difiere del origen: conservar decisión local y revisar',
    SOURCE_QUANTITY_FORMULA_CHANGED_REVIEW_NOT_OVERWRITE: 'La fórmula guardada difiere de la respuesta cliente: conservar y revisar',
    EXPLICIT_ATTENTION_REQUIREMENTS_PENDING: 'Hay intervenciones de atención sin tiempo cuantificado',
    CURRENT_PROFILE_INVALID: 'Perfil actual inválido: conservar y revisar',
    V4_RUNTIME_CAPABILITIES_NOT_CAPTURED: 'Las capacidades operativas v4 no están capturadas: no se habilita por este informe',
};
function csv(plan) {
    const cell = value => `"${String(/^[=+@-]/.test(String(value || '').trimStart()) ? `'${value}` : value ?? '').replace(/"/g, '""')}"`;
    const header = ['ID tratamiento', 'Clínica', 'Tratamiento', 'Situación actual', 'Trabajo siguiente', 'Duración cliente',
        'Sala cliente', 'Profesional cliente', 'Duración actual min', 'Salas actuales', 'Equipo humano actual', 'Maquinaria actual',
        'Identidad física de salas cliente', 'Tipo de receta', 'Capacidades de autoría pendientes', 'Forma técnica NULL preparada',
        'Motivos concretos', 'Explicación duración', 'Conservar perfil e histórico', 'Disponibilidad real comprobada'];
    const rows = plan.records.map(row => [row.treatment_id, row.clinic_id === 66 ? 'BS Capilar' : 'BS Medical', row.name,
        statuses[row.current_status], statuses[row.target_status], row.source_duration, row.source_cabin, row.source_professional,
        row.current_duration_minutes, row.current_resource_check?.phases.flatMap(phase => phase.installations.map(room => `${room.installation_id}: ${room.name}`)).join(' | '),
        row.current_resource_check?.phases.flatMap(phase => phase.professionals.map(person => person.doctor_id)).join(' | '),
        row.current_resource_check?.phases.flatMap(phase => phase.equipment_groups.flatMap(group => group.map(unit => `${unit.equipment_id}: ${unit.family_key}`))).join(' | '),
        row.source_resources.room_physical_keys.join(' | '), row.authoring_readiness.recipe_kind,
        row.authoring_readiness.remaining_capabilities.map(code => reasons[code] || code).join(' | '),
        row.authoring_readiness.manual_null_duration_template_can_be_prepared_offline ? 'Sí; sólo privada y sin aplicar' : 'No',
        [...row.pending, ...row.clinical_decisions, ...row.technical_preparation].map(code => reasons[code] || code).concat(row.attention_documentary_pending.map(item => item.label)).join(' | '),
        row.duration.explanation, 'Sí; no se modifica ninguna reserva ni su snapshot', 'No; prueba integrada posterior con agenda y horarios reales']);
    return `\uFEFF${[header, ...rows].map(row => row.map(cell).join(';')).join('\r\n')}\r\n`;
}
async function run(args) {
    const required = ['--matrix', '--snapshot', '--workbook', '--client-replies', '--resource-map', '--archive', '--private-output'];
    const options = parseArgs(args, [...required, '--private-csv', '--previous-report']);
    if (required.some(key => !options[key])) throw Error('BS_PHYSICAL_SEVEN_FILE_OPTIONS_REQUIRED');
    const matrixBytes = pinned(options['--matrix'], MATRIX_FILE_SHA);
    const resourceMap = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(pinned(options['--resource-map'], RESOURCE_MAP_FILE_SHA)));
    const sourcePlan = buildCatalogPlan({ sheets: workbook(options['--workbook'], WORKBOOK_SHA), workbookHash: WORKBOOK_SHA,
        replies: clientReplies(workbook(options['--client-replies'], REPLIES_SHA), REPLIES_SHA), repliesHash: REPLIES_SHA });
    const manualSources = (await pdfSources(pinned(options['--archive'], ARCHIVE_SHA))).filter(source => source.role === 'manual');
    const plan = preparePhysicalProfileReconciliation({
        matrixRows: parseCsv(new TextDecoder('utf-8', { fatal: true }).decode(matrixBytes), { required: COLUMNS }).map(row => row.values),
        matrixFileSha256: hash(matrixBytes), preflight: JSON.parse(readBytes(options['--snapshot']).toString('utf8')),
        sourcePlan, resourceMap, resourceMapSha256: hash(resourceMap), manualSources,
        consumerSourceFiles: CONSUMER_SOURCE_FILES.map(file => ({ file, sha256: hash(readBytes(path.resolve(__dirname, '../..', file))) })),
        previousReconciliation: options['--previous-report'] ? { file_sha256: PRIOR_RECONCILIATION_FILE_SHA,
            report: JSON.parse(pinned(options['--previous-report'], PRIOR_RECONCILIATION_FILE_SHA).toString('utf8')) } : null,
    });
    writePrivateJson(options['--private-output'], plan);
    if (options['--private-csv']) writePrivateCsv(options['--private-csv'], csv(plan));
    return { ...plan.summary, plan_sha256: plan.plan_sha256, applicator_present: false, original_files_modified: false };
}
if (require.main === module) {
    run(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result, null, 2) + '\n')).catch(error => {
        process.stderr.write(/^BS_PHYSICAL_[A-Z0-9_]+$|^BS_DOC_[A-Z0-9_]+$/.test(error.message) ? error.message + '\n' : 'BS_PHYSICAL_OFFLINE_FAILED_NO_WRITES\n'); process.exitCode = 1;
    });
}
module.exports = { run, csv, RESOURCE_MAP_FILE_SHA, PRIOR_RECONCILIATION_FILE_SHA, CONSUMER_SOURCE_FILES };
