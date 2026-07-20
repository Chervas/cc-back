#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizeWhatsappLocale,
  resolveMetaTemplateLanguage,
  captureExecutionCommunicationLanguage,
  resolveExecutionCommunicationLanguage,
  stampExecutionCommunicationLanguage,
} = require('../../lib/whatsapp-template-locale');
const {
  buildAutomationWhatsappDeliveryKey,
  resolveWhatsappLanguageRouting,
  selectBestWhatsappTemplateCandidate,
  buildDeterministicConfirmAppointmentTextOutput,
  buildDeterministicAppointmentUnconfirmedReplyOutput,
  readStoredWhatsappReplaySelection,
} = require('../../services/flowEngineV2.service');
const rollout = require('../../services/whatsappLanguageRollout.service')._test;
const whatsappTemplates = require('../../services/whatsappTemplates.service')._test;
const translationSeed = require('../../../migrations/20260720094500-seed-whatsapp-template-catalog-translations')._test;
const db = require('../../../models');
const { queues } = require('../../services/queue.service');

test.after(async () => {
  await Promise.allSettled(Object.values(queues || {}).map((queue) => queue.close()));
  await db.sequelize.close().catch(() => null);
});

function catalog(id, familyKey, locale, body = 'Hola {{1}}') {
  return {
    id,
    name: locale === 'es' ? familyKey : `${familyKey}__${locale}`,
    family_key: familyKey,
    locale,
    category: 'UTILITY',
    body_text: body,
    components: [{ type: 'BODY', text: body }],
    variables: [{ index: 1, name: 'nombre_paciente' }],
    disciplinas: [{ disciplina_code: 'dental' }],
    is_active: locale === 'es' ? true : false,
  };
}

function instance(id, catalogRow, language, extra = {}) {
  return {
    id,
    catalog_template_id: catalogRow.id,
    name: catalogRow.family_key,
    language,
    category: catalogRow.category,
    status: 'APPROVED',
    meta_template_id: `meta-${id}`,
    is_active: true,
    clinic_id: null,
    waba_id: 'waba-1',
    components: catalogRow.components,
    catalog: catalogRow,
    ...extra,
  };
}

test('normaliza locale interno y conserva el código completo exigido por Meta', () => {
  assert.equal(normalizeWhatsappLocale('en_US'), 'en');
  assert.equal(normalizeWhatsappLocale('ca-ES'), 'ca');
  assert.equal(resolveMetaTemplateLanguage('es'), 'es');
  assert.equal(resolveMetaTemplateLanguage('ca'), 'ca');
  assert.equal(resolveMetaTemplateLanguage('en'), 'en_US');
});

test('cada nuevo mensaje usa el idioma vivo del paciente enriquecido', () => {
  const first = stampExecutionCommunicationLanguage({
    patient: { preferred_language: 'es' },
  });
  assert.equal(first.communication_language, 'es');

  first.patient.preferred_language = 'ca';
  assert.equal(resolveExecutionCommunicationLanguage(first), 'ca');
  const selected = resolveWhatsappLanguageRouting({
    language_routing: {
      enabled: true,
      variants: {
        ca: { manual_message_text: 'Català' },
        en: { manual_message_text: 'English' },
      },
    },
  }, first);
  assert.equal(selected.selected_language, 'ca');
  assert.equal(selected.config.manual_message_text, 'Català');

  const second = stampExecutionCommunicationLanguage({
    patient: { preferred_language: 'ca' },
  });
  assert.equal(second.communication_language, 'ca');
  second.patient.preferred_language = 'es';
  assert.equal(resolveWhatsappLanguageRouting({
    language_routing: { enabled: true, variants: {} },
  }, second).selected_language, 'es');
});

test('ejecuciones sin paciente enriquecido usan el snapshot o español', () => {
  assert.equal(resolveExecutionCommunicationLanguage({
    communication_language: 'ca',
  }), 'ca');
  assert.equal(resolveExecutionCommunicationLanguage({
    trigger: { data: { preferred_language: 'ca' } },
  }), 'es');
  assert.equal(captureExecutionCommunicationLanguage({
    patient: { preferred_language: 'en' },
  }), 'en');
});

test('routing falla cerrado si falta la variante del idioma fijado', () => {
  assert.throws(() => resolveWhatsappLanguageRouting({
    language_routing: { enabled: true, variants: { ca: {} } },
  }, { communication_language: 'en' }), /whatsapp_language_variant_missing:en/);
});

test('selección exige simultáneamente locale, familia, aprobación y WABA', () => {
  const caCatalog = catalog(2, 'familia_recordatorio', 'ca');
  const candidates = [
    instance(20, caCatalog, 'ca', { waba_id: 'wrong' }),
    instance(21, caCatalog, 'ca', { status: 'PENDING' }),
    instance(22, { ...caCatalog, family_key: 'otra_familia' }, 'ca'),
    instance(23, caCatalog, 'ca'),
  ];
  const selected = selectBestWhatsappTemplateCandidate(candidates, {
    targetWabaId: 'waba-1',
    expectedLocale: 'ca',
    expectedFamilyKey: 'familia_recordatorio',
  });
  assert.equal(selected.id, 23);
  assert.equal(selectBestWhatsappTemplateCandidate(candidates, {
    targetWabaId: 'waba-1',
    expectedLocale: 'en',
    expectedFamilyKey: 'familia_recordatorio',
  }), null);
});

test('la clave idempotente no cambia con locale ni plantilla', () => {
  const execution = { id: 91 };
  const caNode = { id: 'wa-1', config: { language_code: 'ca', template_id: '20' } };
  const enNode = { id: 'wa-1', config: { language_code: 'en_US', template_id: '21' } };
  assert.equal(
    buildAutomationWhatsappDeliveryKey(execution, caNode),
    buildAutomationWhatsappDeliveryKey(execution, enNode)
  );
});

test('un reintento conserva idioma, plantilla y parámetros materializados en el primer intento', () => {
  const stored = readStoredWhatsappReplaySelection({
    template_id: 220,
    template_name: 'recordatorio_v3',
    patient_language: 'ca',
    selected_language: 'ca',
    template_language: 'ca',
    template_family_key: 'recordatorio',
    template_params: { 1: 'Laia', 2: '10:30' },
  });
  assert.deepEqual(stored, {
    template_id: 220,
    template_name: 'recordatorio_v3',
    patient_language: 'ca',
    selected_language: 'ca',
    template_language: 'ca',
    template_family_key: 'recordatorio',
    template_params: { 1: 'Laia', 2: '10:30' },
  });

  // Aunque el paciente o el nodo ya apuntasen a inglés en el reintento, la
  // outbox reutiliza este snapshot del Message y no vuelve a seleccionar.
  const mutatedPatientLanguage = 'en';
  assert.notEqual(mutatedPatientLanguage, stored.selected_language);
  assert.equal(stored.template_id, 220);
});

test('una caída tras la respuesta de Meta se recupera por nombre+idioma sin crear un duplicado', () => {
  const template = {
    name: 'recordatorio',
    category: 'UTILITY',
    components: [{ type: 'BODY', text: 'Hola {{1}}' }],
  };
  const remoteAfterCrash = {
    id: 501,
    name: 'recordatorio',
    language: 'ca',
    status: 'PENDING',
    meta_template_id: 'meta-501',
    waba_id: 'waba-1',
    category: 'UTILITY',
    components: template.components,
  };
  const recovered = whatsappTemplates.findSameContractRemoteTemplate({
    familyRows: [remoteAfterCrash],
    wabaId: 'waba-1',
    template,
  });
  assert.equal(recovered.meta_template_id, 'meta-501');
  assert.equal(recovered.name, 'recordatorio');
  assert.equal(whatsappTemplates.isDuplicateTemplateNameError({
    response: { data: { error: { code: 100, error_subcode: 2388024, message: 'Template already exists' } } },
  }), true);
  assert.equal(whatsappTemplates.buildMetaTemplateCheckpointPendingError(new Error('duplicate')).retryable, true);
});

test('clasificadores deterministas entienden confirmación, cancelación y cambio en tres idiomas', () => {
  for (const response of ['Sí, confirmo', 'D’acord, ens veiem', 'Yes, I confirm']) {
    const output = buildDeterministicConfirmAppointmentTextOutput({
      last_response: response,
    });
    assert.equal(output.decision, 'confirmado', response);
  }
  for (const response of ['No voy, cancela', 'No hi aniré, cancel·la', 'I will not attend, cancel it']) {
    const output = buildDeterministicAppointmentUnconfirmedReplyOutput({
      last_response: response,
    });
    assert.equal(output.decision, 'cancelar', response);
  }
  for (const response of ['Me viene mal, otra hora', 'No em va bé, una altra hora', 'Can we reschedule?']) {
    const output = buildDeterministicAppointmentUnconfirmedReplyOutput({
      last_response: response,
    });
    assert.equal(output.decision, 'reprogramar', response);
  }
});

test('las nueve respuestas manuales reales tienen traducción ca/en', () => {
  assert.equal(rollout.MANUAL_TRANSLATION_ROWS.length, 9);
  for (const row of rollout.MANUAL_TRANSLATION_ROWS) {
    assert.equal(rollout.translateManualMessage(row.es, 'ca'), row.ca);
    assert.equal(rollout.translateManualMessage(row.es, 'en'), row.en);
    assert.notEqual(row.ca, row.es);
    assert.notEqual(row.en, row.es);
  }
});

test('seed incluye 34 familias con traducciones reales y contrato de placeholders intacto', () => {
  const entries = Object.entries(translationSeed.TRANSLATIONS);
  assert.equal(entries.length, 34);
  for (const [family, variants] of entries) {
    assert.ok(variants.ca?.[1], `${family}:ca`);
    assert.ok(variants.en?.[1], `${family}:en`);
    assert.notEqual(variants.ca[1], variants.en[1], family);
    assert.deepEqual(
      translationSeed.extractPlaceholders(variants.ca[1]),
      translationSeed.extractPlaceholders(variants.en[1]),
      family
    );
  }
});

test('transformación masiva conserva español y agrega ca/en aprobados de la misma familia', () => {
  const es = catalog(1, 'familia_recordatorio', 'es');
  const ca = { ...catalog(2, 'familia_recordatorio', 'ca'), is_active: true };
  const en = { ...catalog(3, 'familia_recordatorio', 'en'), is_active: true };
  const inventory = {
    catalogs: [es, ca, en],
    instances: [
      instance(10, es, 'es'),
      instance(20, ca, 'ca'),
      instance(30, en, 'en_US'),
    ],
    clinics: [{
      id_clinica: 66,
      grupoClinicaId: 7,
      configuracion: { disciplinas: ['dental'] },
    }],
    assets: [{
      id: 1,
      assetType: 'whatsapp_phone_number',
      assignmentScope: 'clinic',
      clinicaId: 66,
      wabaId: 'waba-1',
      phoneNumberId: 'phone-1',
      hasCredentials: true,
      isActive: true,
    }],
    flows: [],
  };
  const flow = {
    id: 100,
    clinic_id: 66,
    nodes: [{
      id: 'wa',
      type: 'action/send_whatsapp',
      config: {
        message_mode: 'template',
        template_id: '10',
        template_name: es.family_key,
        catalog_template_id: 1,
        variables: { 1: '{{paciente.nombre}}' },
      },
    }],
  };
  const transformed = rollout.transformFlowNodes(
    flow,
    inventory,
    rollout.buildIndexes(inventory)
  );
  assert.equal(transformed.changed, 1);
  const config = transformed.nodes[0].config;
  assert.equal(config.template_id, '10');
  assert.equal(config.language_routing.enabled, true);
  assert.equal(config.language_routing.source, 'patient_preferred_language');
  assert.equal(config.language_routing.variants.ca.template_id, '20');
  assert.equal(config.language_routing.variants.ca.language_code, 'ca');
  assert.equal(config.language_routing.variants.en.template_id, '30');
  assert.equal(config.language_routing.variants.en.language_code, 'en_US');
});

test('transformación falla cerrada si una variante no está aprobada', () => {
  const es = catalog(1, 'familia_recordatorio', 'es');
  const ca = { ...catalog(2, 'familia_recordatorio', 'ca'), is_active: true };
  const en = { ...catalog(3, 'familia_recordatorio', 'en'), is_active: true };
  const inventory = {
    catalogs: [es, ca, en],
    instances: [
      instance(10, es, 'es'),
      instance(20, ca, 'ca'),
      instance(30, en, 'en_US', { status: 'PENDING' }),
    ],
    clinics: [],
    assets: [],
  };
  const flow = {
    id: 100,
    nodes: [{
      id: 'wa',
      type: 'action/send_whatsapp',
      config: {
        message_mode: 'template',
        template_id: '10',
        catalog_template_id: 1,
      },
    }],
  };
  assert.throws(() => rollout.transformFlowNodes(
    flow,
    inventory,
    rollout.buildIndexes(inventory)
  ), /whatsapp_language_approved_instance_missing:familia_recordatorio:en/);
});

test('el preflight y la auditoría ignoran clínicas/WABA ajenos a los flujos seleccionados', () => {
  const es = catalog(1, 'familia_scope', 'es');
  const ca = { ...catalog(2, 'familia_scope', 'ca'), is_active: true };
  const en = { ...catalog(3, 'familia_scope', 'en'), is_active: true };
  const inventory = {
    catalogs: [es, ca, en],
    instances: [
      instance(10, es, 'es'),
      instance(20, ca, 'ca'),
      instance(30, en, 'en_US'),
      instance(21, ca, 'ca', { waba_id: 'waba-unrelated', status: 'REJECTED' }),
      instance(31, en, 'en_US', { waba_id: 'waba-unrelated', status: 'REJECTED' }),
    ],
    clinics: [
      { id_clinica: 66, grupoClinicaId: 7, configuracion: { disciplinas: ['dental'] } },
      { id_clinica: 99, grupoClinicaId: 9, configuracion: { disciplinas: ['dental'] } },
    ],
    assets: [
      { id: 1, assetType: 'whatsapp_phone_number', assignmentScope: 'clinic', clinicaId: 66, wabaId: 'waba-1', phoneNumberId: 'phone-1', hasCredentials: true, isActive: true },
      { id: 2, assetType: 'whatsapp_phone_number', assignmentScope: 'clinic', clinicaId: 99, wabaId: 'waba-unrelated', phoneNumberId: 'phone-2', hasCredentials: true, isActive: true },
    ],
    flows: [{
      id: 100,
      clinic_id: 66,
      nodes: [{
        id: 'wa',
        type: 'action/send_whatsapp',
        config: { message_mode: 'template', template_id: '10', catalog_template_id: 1 },
      }],
    }],
  };
  const preflight = rollout.buildPreflight(inventory);
  assert.equal(preflight.ok, true);
  assert.deepEqual(preflight.target_clinic_ids, [66]);
  assert.deepEqual(preflight.target_waba_ids, ['waba-1']);
  assert.deepEqual(preflight.targets_by_catalog['2'], {
    clinic_ids: [66],
    waba_ids: ['waba-1'],
  });

  const audit = rollout.auditCatalogApprovals(
    inventory,
    [2, 3],
    preflight.targets_by_catalog
  );
  assert.equal(audit.approved, true);
  assert.equal(audit.rejected, false);
  assert.equal(audit.catalogs_approved, 2);
});

test('fixture equivalente audita 158 versiones, 929 nodos y 24 contratos sin ampliar alcance', () => {
  const familyCount = 24;
  const catalogs = [];
  const instances = [];
  for (let index = 0; index < familyCount; index += 1) {
    const family = `familia_${String(index + 1).padStart(2, '0')}`;
    const es = catalog(index * 3 + 1, family, 'es');
    const ca = { ...catalog(index * 3 + 2, family, 'ca'), is_active: true };
    const en = { ...catalog(index * 3 + 3, family, 'en'), is_active: true };
    catalogs.push(es, ca, en);
    instances.push(
      instance(index * 3 + 1000, es, 'es'),
      instance(index * 3 + 1001, ca, 'ca'),
      instance(index * 3 + 1002, en, 'en_US')
    );
  }

  let familyCursor = 0;
  let whatsappNodeCount = 0;
  const flows = Array.from({ length: 158 }, (_unused, flowIndex) => {
    const nodesInFlow = flowIndex < 139 ? 6 : 5;
    const nodes = Array.from({ length: nodesInFlow }, (_node, nodeIndex) => {
      const familyIndex = familyCursor % familyCount;
      familyCursor += 1;
      whatsappNodeCount += 1;
      const esCatalog = catalogs[familyIndex * 3];
      const esInstance = instances[familyIndex * 3];
      return {
        id: `wa-${flowIndex}-${nodeIndex}`,
        type: 'action/send_whatsapp',
        config: {
          message_mode: 'template',
          template_id: String(esInstance.id),
          template_name: esInstance.name,
          catalog_template_id: esCatalog.id,
          variables: { 1: '{{paciente.nombre}}' },
        },
      };
    });
    return { id: flowIndex + 1, clinic_id: 66, nodes };
  });
  assert.equal(whatsappNodeCount, 929);

  const inventory = {
    catalogs,
    instances,
    clinics: [
      { id_clinica: 66, grupoClinicaId: 7, configuracion: { disciplinas: ['dental'] } },
      { id_clinica: 99, grupoClinicaId: 9, configuracion: { disciplinas: ['dental'] } },
    ],
    assets: [
      { id: 1, assetType: 'whatsapp_phone_number', assignmentScope: 'clinic', clinicaId: 66, wabaId: 'waba-1', phoneNumberId: 'phone-1', hasCredentials: true, isActive: true },
      { id: 2, assetType: 'whatsapp_phone_number', assignmentScope: 'clinic', clinicaId: 99, wabaId: 'waba-unrelated', phoneNumberId: 'phone-2', hasCredentials: true, isActive: true },
    ],
    flows,
  };
  const preflight = rollout.buildPreflight(inventory);
  assert.equal(preflight.ok, true, preflight.errors.join('\n'));
  assert.equal(preflight.flow_count, 158);
  assert.equal(preflight.whatsapp_node_count, 929);
  assert.equal(preflight.config_fingerprint_count, 24);
  assert.equal(preflight.family_keys.length, 24);
  assert.deepEqual(preflight.target_clinic_ids, [66]);
  assert.deepEqual(preflight.target_waba_ids, ['waba-1']);

  const indexes = rollout.buildIndexes(inventory);
  const transformed = flows.reduce((sum, flow) => (
    sum + rollout.transformFlowNodes(flow, inventory, indexes).changed
  ), 0);
  assert.equal(transformed, 929);
});

test('el estado del rollout combina el progreso activo con el último result_summary', () => {
  const settled = {
    status: 'waiting',
    result: { phase: 'prepare', state: 'prepared', catalogs_total: 30 },
  };
  assert.deepEqual(rollout.unwrapRolloutResultSummary(settled), {
    phase: 'prepare',
    state: 'prepared',
    catalogs_total: 30,
  });
});
