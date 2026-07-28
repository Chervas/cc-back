#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  FIRST_VISIT_APPOINTMENT_TYPES,
  buildAccessGuidanceTemplateComponents,
  buildAutomationWhatsappTransportJobOptions,
  isAccessGuidanceReminderBranchEnabled,
  selectAccessGuidanceTemplateBranch,
} = require('../../lib/appointment-access-guidance-template');
const {
  buildPositionalBindingsFromNamed,
  buildSystemNamedBindingsForTemplateVariables,
  buildWhatsappTemplateVariableContract,
  normalizeTemplateVariableName,
} = require('../../lib/whatsapp-template-contract');
const {
  buildWhatsappOutboundRetryDecision,
  classifyRetryableWhatsappFailure,
} = require('../../lib/whatsapp-outbound-retry');
const accessGuidanceMigration = require('../../../migrations/20260714120000-seed-access-guidance-appointment-reminder-template');

const VALID_GUIDANCE = Object.freeze({
  enabled: true,
  directions: 'Entra por el pasaje lateral y sube a la primera planta.',
  image_asset_id: 901,
  image_url: 'https://media.clinicaclick.com/clinics/66/access/entrance.jpg',
});

function variantTemplate(status = 'APPROVED', wabaId = 'waba-shared-29') {
  return {
    id: 700,
    name: 'clinicaclick_recordatorio_mismo_dia_primera_visita_acceso_dificil_v1',
    status,
    waba_id: wabaId,
    components: [
      { type: 'HEADER', format: 'IMAGE' },
      { type: 'BODY', text: 'Hola {{1}} {{2}} {{3}} {{4}} {{5}}' },
    ],
  };
}

test('solo los dos tipos de primera visita pueden seleccionar la variante', () => {
  assert.deepEqual(FIRST_VISIT_APPOINTMENT_TYPES, ['primera_sin_trat', 'primera_con_trat']);
  for (const appointmentType of FIRST_VISIT_APPOINTMENT_TYPES) {
    const decision = selectAccessGuidanceTemplateBranch({
      appointmentType,
      accessGuidance: VALID_GUIDANCE,
      variantConfigured: true,
      variantTemplate: variantTemplate(),
      targetWabaId: 'waba-shared-29',
    });
    assert.equal(decision.branch, 'access_guidance');
    assert.equal(decision.variant_used, true);
    assert.equal(decision.fallback_used, false);
  }

  for (const appointmentType of ['continuacion', 'urgencia', 'revision']) {
    const decision = selectAccessGuidanceTemplateBranch({
      appointmentType,
      accessGuidance: VALID_GUIDANCE,
      variantConfigured: true,
      variantTemplate: variantTemplate(),
      targetWabaId: 'waba-shared-29',
    });
    assert.equal(decision.branch, 'base');
    assert.equal(decision.variant_requested, false);
    assert.equal(decision.fallback_used, false);
    assert.equal(decision.fallback_reason, 'appointment_not_first_visit');
  }
});

test('la rama visible solo se habilita si coincide primera visita y flag de clínica', () => {
  assert.equal(isAccessGuidanceReminderBranchEnabled({
    appointmentType: 'primera_sin_trat',
    accessGuidance: VALID_GUIDANCE,
  }), true);
  assert.equal(isAccessGuidanceReminderBranchEnabled({
    appointmentType: 'continuacion',
    accessGuidance: VALID_GUIDANCE,
  }), false);
  assert.equal(isAccessGuidanceReminderBranchEnabled({
    appointmentType: 'primera_con_trat',
    accessGuidance: { ...VALID_GUIDANCE, enabled: false },
  }), false);
});

test('opción desactivada conserva la base y configuración incompleta deja fallback observable', () => {
  const disabled = selectAccessGuidanceTemplateBranch({
    appointmentType: 'primera_sin_trat',
    accessGuidance: { ...VALID_GUIDANCE, enabled: false },
    variantConfigured: true,
    variantTemplate: variantTemplate(),
    targetWabaId: 'waba-shared-29',
  });
  assert.equal(disabled.branch, 'base');
  assert.equal(disabled.fallback_used, false);
  assert.equal(disabled.fallback_reason, 'access_guidance_disabled');

  const incomplete = selectAccessGuidanceTemplateBranch({
    appointmentType: 'primera_con_trat',
    accessGuidance: { ...VALID_GUIDANCE, image_url: null },
    variantConfigured: true,
    targetWabaId: 'waba-shared-29',
  });
  assert.equal(incomplete.branch, 'base');
  assert.equal(incomplete.variant_requested, true);
  assert.equal(incomplete.fallback_used, true);
  assert.equal(incomplete.fallback_reason, 'access_guidance_image_url_missing');

  const tooLong = selectAccessGuidanceTemplateBranch({
    appointmentType: 'primera_sin_trat',
    accessGuidance: { ...VALID_GUIDANCE, directions: 'x'.repeat(501) },
    variantConfigured: true,
    targetWabaId: 'waba-shared-29',
  });
  assert.equal(tooLong.branch, 'base');
  assert.equal(tooLong.fallback_used, true);
  assert.equal(tooLong.fallback_reason, 'access_guidance_directions_too_long');
});

test('estados no aprobados y WABA no efectiva caen a la base con motivo determinista', () => {
  for (const status of ['PENDING', 'PENDING_LOCAL', 'REJECTED', 'SIN_CONECTAR']) {
    const decision = selectAccessGuidanceTemplateBranch({
      appointmentType: 'primera_sin_trat',
      accessGuidance: VALID_GUIDANCE,
      variantConfigured: true,
      variantTemplate: variantTemplate(status),
      targetWabaId: 'waba-shared-29',
    });
    assert.equal(decision.branch, 'base');
    assert.equal(decision.fallback_used, true);
    assert.equal(decision.fallback_reason, `access_guidance_variant_${status.toLowerCase()}`);
  }

  const wrongWaba = selectAccessGuidanceTemplateBranch({
    appointmentType: 'primera_sin_trat',
    accessGuidance: VALID_GUIDANCE,
    variantConfigured: true,
    variantTemplate: variantTemplate('APPROVED', 'waba-other'),
    targetWabaId: 'waba-shared-29',
  });
  assert.equal(wrongWaba.branch, 'base');
  assert.equal(wrongWaba.fallback_reason, 'access_guidance_variant_waba_mismatch');

  const unknownTargetWaba = selectAccessGuidanceTemplateBranch({
    appointmentType: 'primera_sin_trat',
    accessGuidance: VALID_GUIDANCE,
    variantConfigured: true,
    variantTemplate: variantTemplate(),
    targetWabaId: '',
  });
  assert.equal(unknownTargetWaba.branch, 'base');
  assert.equal(unknownTargetWaba.fallback_reason, 'access_guidance_target_waba_unverified');
});

test('contrato semántico conserva el orden real 1..5 sin reutilizar indicaciones', () => {
  const contract = buildWhatsappTemplateVariableContract(variantTemplate());
  assert.deepEqual(
    contract.map((variable) => variable.name),
    [
      'nombre_paciente',
      'hora_cita',
      'direccion_clinica',
      'url_como_llegar_clinica',
      'indicaciones_acceso_clinica',
    ]
  );
  const defaults = buildSystemNamedBindingsForTemplateVariables(contract);
  assert.equal(defaults.indicaciones_acceso_clinica, '{{clinica.indicaciones_acceso}}');
  assert.equal(normalizeTemplateVariableName('indicaciones'), 'url_como_llegar_clinica');
  assert.equal(
    normalizeTemplateVariableName('indicaciones_acceso_clinica'),
    'indicaciones_acceso_clinica'
  );
  assert.deepEqual(
    buildPositionalBindingsFromNamed(defaults, {}, contract),
    {
      1: '{{paciente.nombre}}',
      2: '{{cita.hora}}',
      3: '{{clinica.direccion}}',
      4: '{{clinica.url_como_llegar}}',
      5: '{{clinica.indicaciones_acceso}}',
    }
  );
});

test('contrato de reseñas con variables numéricas de Meta infiere paciente, remitente y clínica', () => {
  const contract = buildWhatsappTemplateVariableContract({
    name: 'cc_solicitud_de_opinion_tras_visita_con_imagen_ms4gsf3r',
    variables: [
      { index: 1, position: 1, name: '1', example: '1', description: 'Variable 1' },
      { index: 2, position: 2, name: '2', example: '2', description: 'Variable 2' },
      { index: 3, position: 3, name: '3', example: '3', description: 'Variable 3' },
    ],
    components: [
      { type: 'HEADER', format: 'IMAGE' },
      {
        type: 'BODY',
        text: '¡Hola {{1}}! Soy {{2}} de {{3}}. ¿Cómo valorarías tu experiencia?',
        example: { body_text: [['1', '2', '3']] },
      },
    ],
  });

  assert.deepEqual(
    contract.map((variable) => variable.name),
    ['nombre_paciente', 'firma_resenas', 'nombre_clinica']
  );
  assert.deepEqual(
    buildPositionalBindingsFromNamed(buildSystemNamedBindingsForTemplateVariables(contract), {}, contract),
    {
      1: '{{paciente.nombre}}',
      2: '{{clinica.firma_resenas}}',
      3: '{{clinica.nombre}}',
    }
  );
});

test('componentes IMAGE conservan cabecera y parámetros BODY ordenados', () => {
  const components = buildAccessGuidanceTemplateComponents({
    imageUrl: VALID_GUIDANCE.image_url,
    templateParams: {
      5: VALID_GUIDANCE.directions,
      2: '10:30',
      1: 'María',
      4: 'https://maps.example.com/clinica',
      3: 'Calle Mayor 123',
    },
  });
  assert.deepEqual(components[0], {
    type: 'header',
    parameters: [{ type: 'image', image: { link: VALID_GUIDANCE.image_url } }],
  });
  assert.deepEqual(
    components[1].parameters.map((parameter) => parameter.text),
    [
      'María',
      '10:30',
      'Calle Mayor 123',
      'https://maps.example.com/clinica',
      VALID_GUIDANCE.directions,
    ]
  );
});

test('job de transporte usa id estable, cinco intentos y backoff exponencial', () => {
  assert.deepEqual(buildAutomationWhatsappTransportJobOptions(501), {
    jobId: 'automation-whatsapp-501',
    attempts: 5,
    backoff: { type: 'exponential', delay: 60000 },
    removeOnComplete: { age: 86400, count: 1000 },
    removeOnFail: { age: 604800, count: 5000 },
  });

  const source = fs.readFileSync(
    path.resolve(__dirname, '../../services/flowEngineV2.service.js'),
    'utf8'
  );
  const enqueueStart = source.indexOf('async function enqueueAutomationWhatsappTransport');
  const enqueueEnd = source.indexOf('\nasync function runScheduledWhatsappSendJob', enqueueStart);
  const enqueueBlock = source.slice(enqueueStart, enqueueEnd);
  assert.match(source, /template_components:\s*templateComponents/);
  assert.match(enqueueBlock, /templateComponents:\s*Array\.isArray\(metadata\.template_components\)/);
  assert.match(enqueueBlock, /retryOnFailure:\s*retryOnFailure === true/);
  assert.match(enqueueBlock, /resolveClinicConfigAtSend:\s*true/);
  assert.match(enqueueBlock, /clinicId:\s*toIntOrNull\(conversation\?\.clinic_id\)/);
  assert.doesNotMatch(enqueueBlock, /clinicConfig\s*:/);
  assert.ok(
    enqueueBlock.indexOf('await msg.update') < enqueueBlock.indexOf("queues.outboundWhatsApp.add('send'"),
    'el snapshot y el job id deben persistirse antes de publicar el trabajo'
  );
});

test('worker solo reintenta el transporte opt-in ante fallos transitorios', () => {
  const transientFailures = [
    Object.assign(new Error('dns temporal'), { code: 'EAI_AGAIN' }),
    { response: { status: 503, data: { error: { code: 131000 } } } },
    { response: { status: 429, data: { error: { code: 130429 } } } },
    { response: { status: 400, data: { error: { code: 131016 } } } },
  ];
  for (const error of transientFailures) {
    const decision = buildWhatsappOutboundRetryDecision({
      error,
      retryOnFailure: true,
      attemptsMade: 0,
      maxAttempts: 5,
    });
    assert.equal(decision.retryable, true);
    assert.equal(decision.should_retry, true);
    assert.equal(decision.attempts_remaining, 4);
  }

  for (const networkCode of ['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED']) {
    const ambiguous = classifyRetryableWhatsappFailure(
      Object.assign(new Error('respuesta de entrega desconocida'), { code: networkCode })
    );
    assert.equal(ambiguous.retryable, false);
    assert.equal(ambiguous.delivery_unknown, true);
    assert.equal(ambiguous.reason, 'delivery_unknown');
  }

  const functionalError = { response: { status: 400, data: { error: { code: 132000 } } } };
  assert.equal(classifyRetryableWhatsappFailure(functionalError).retryable, false);
  assert.equal(buildWhatsappOutboundRetryDecision({
    error: transientFailures[0],
    retryOnFailure: false,
    attemptsMade: 0,
    maxAttempts: 5,
  }).should_retry, false);
  assert.equal(buildWhatsappOutboundRetryDecision({
    error: transientFailures[0],
    retryOnFailure: true,
    attemptsMade: 4,
    maxAttempts: 5,
  }).should_retry, false);

  const workerSource = fs.readFileSync(
    path.resolve(__dirname, '../../workers/queue.workers.js'),
    'utf8'
  );
  assert.match(workerSource, /buildWhatsappOutboundRetryDecision/);
  assert.match(workerSource, /retryDecision\.should_retry\s*\|\|\s*\(retryDecision\.retry_enabled/);
  assert.match(workerSource, /retryOnFailure === true && !providerAccepted/);
  assert.match(workerSource, /throw new UnrecoverableError\(err\?\.message/);
  assert.match(workerSource, /post_acceptance_error:\s*serializeError\(err\)/);
  assert.match(workerSource, /retrying:\s*false,\s*\n\s*exhausted:\s*false/);
});

test('la rama explícita solo exige el fallback base cuando la variante no supera el preflight', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../services/flowEngineV2.service.js'),
    'utf8'
  );
  const explicitStart = source.indexOf('if (explicitAccessGuidanceVariant)');
  const explicitEnd = source.indexOf('\n    } else {\n      const baseTemplate', explicitStart);
  const explicitBlock = source.slice(explicitStart, explicitEnd);
  const decisionIndex = explicitBlock.indexOf('selectAccessGuidanceTemplateBranch');
  const branchIndex = explicitBlock.indexOf('if (accessGuidanceDecision.variant_used)');
  const fallbackLookupIndex = explicitBlock.indexOf("templateIdKey: 'fallback_template_id'");

  assert.ok(explicitStart >= 0 && explicitEnd > explicitStart);
  assert.ok(decisionIndex >= 0 && branchIndex > decisionIndex);
  assert.ok(
    fallbackLookupIndex > branchIndex,
    'la base no debe bloquear una variante válida antes de que se tome la decisión'
  );
});

test('migración publica una versión nueva con condición, dos envíos y join sin mutar el histórico', async () => {
  const publicId = 'flw_same_day_access_test';
  const baseNodes = [
    {
      id: 'N1',
      type: 'trigger/appointment_reminder_window',
      config: {
        schedule_moment: 'same_day',
        schedule_time_mode: 'custom',
        custom_time: '08:00',
        exclude_if_not_confirmed: true,
        exclude_if_booked_same_day: true,
      },
      outputs: { on_success: 'N2' },
      position: { x: 100, y: 120 },
    },
    {
      id: 'N2',
      type: 'action/send_whatsapp',
      config: {
        message_mode: 'template',
        template_id: '433',
        template_name: 'clinicaclick_recordatorio_mismo_dia_primera_visita',
        catalog_template_id: 4,
        variables: { 1: '{{paciente.nombre}}', 2: '{{cita.hora}}' },
        variables_named: { nombre_paciente: '{{paciente.nombre}}', hora_cita: '{{cita.hora}}' },
        quiet_hours_enabled: true,
      },
      outputs: { on_success: 'N3', on_fail: null },
      position: { x: 100, y: 240 },
    },
    {
      id: 'N3',
      type: 'condition/ai_analysis',
      config: { preset_key: 'confirm_appointment' },
      outputs: { on_success: 'N4', on_fail: 'N5' },
      position: { x: 100, y: 360 },
    },
    { id: 'N4', type: 'action/send_whatsapp', config: { message_mode: 'manual' }, outputs: { on_success: null, on_fail: null }, position: { x: 100, y: 480 } },
    { id: 'N5', type: 'action/send_system_notification', config: {}, outputs: { on_success: null, on_fail: null }, position: { x: 100, y: 600 } },
  ];
  const originalNodesJson = JSON.stringify(baseNodes);
  const flowRows = [
    {
      id: 299,
      public_id: publicId,
      template_key: 'same_day_access__clinic_66',
      version: 1,
      engine_version: 'v2',
      name: 'Recordatorio mismo día',
      description: null,
      trigger_type: 'appointment_reminder_window',
      trigger_config: JSON.stringify(baseNodes[0].config),
      is_active: false,
      is_system: false,
      clinic_id: 66,
      group_id: null,
      entry_node_id: 'N1',
      nodes: originalNodesJson,
      published_at: new Date('2026-07-01T08:00:00Z'),
      published_by: 1,
      created_by: 1,
    },
    {
      id: 300,
      public_id: publicId,
      template_key: 'same_day_access__clinic_66',
      version: 2,
      engine_version: 'v2',
      name: 'Recordatorio mismo día',
      description: null,
      trigger_type: 'appointment_reminder_window',
      trigger_config: JSON.stringify(baseNodes[0].config),
      is_active: true,
      is_system: false,
      clinic_id: 66,
      group_id: null,
      entry_node_id: 'N1',
      nodes: originalNodesJson,
      published_at: new Date('2026-07-02T08:00:00Z'),
      published_by: 1,
      created_by: 1,
    },
  ];
  const catalogs = new Map([
    ['clinicaclick_recordatorio_mismo_dia_primera_visita', {
      id: 4,
      name: 'clinicaclick_recordatorio_mismo_dia_primera_visita',
      is_active: true,
    }],
  ]);
  const automationCatalog = {
    id: 11,
    template_key: publicId,
    template_version: 2,
    last_propagated_template_version: 2,
  };
  let nextFlowId = 301;
  let nextCatalogId = 9;

  const flowColumns = Object.fromEntries([
    'public_id', 'template_key', 'version', 'engine_version', 'name', 'description',
    'trigger_type', 'trigger_config', 'is_active', 'is_system', 'clinic_id', 'group_id',
    'entry_node_id', 'nodes', 'published_at', 'published_by', 'created_by', 'created_at', 'updated_at',
  ].map((key) => [key, {}]));
  const catalogColumns = Object.fromEntries([
    'name', 'display_name', 'category', 'body_text', 'variables', 'components', 'is_generic',
    'is_active', 'propagation_state', 'created_at', 'updated_at',
  ].map((key) => [key, {}]));
  const automationCatalogColumns = Object.fromEntries([
    'template_version', 'last_propagated_at', 'last_propagated_template_version', 'updated_at',
  ].map((key) => [key, {}]));

  const queryInterface = {
    sequelize: {
      QueryTypes: { SELECT: 'SELECT' },
      async transaction(callback) {
        return callback({ id: 'tx' });
      },
      async query(sql, options = {}) {
        if (sql.includes('FROM WhatsappTemplateCatalog')) {
          const row = catalogs.get(options.replacements?.name);
          return row ? [{ ...row }] : [];
        }
        if (sql.includes('FROM AutomationFlowTemplatesV2')) {
          return flowRows.map((row) => ({ ...row }));
        }
        throw new Error(`unexpected_query:${sql}`);
      },
    },
    async describeTable(table) {
      if (table === 'WhatsappTemplateCatalog') return catalogColumns;
      if (table === 'AutomationFlowTemplatesV2') return flowColumns;
      if (table === 'AutomationFlowCatalog') return automationCatalogColumns;
      throw new Error(`unexpected_describe:${table}`);
    },
    async bulkInsert(table, rows) {
      if (table === 'WhatsappTemplateCatalog') {
        rows.forEach((row) => catalogs.set(row.name, { id: nextCatalogId++, ...row }));
        return;
      }
      if (table === 'AutomationFlowTemplatesV2') {
        rows.forEach((row) => flowRows.push({ id: nextFlowId++, ...row }));
        return;
      }
      throw new Error(`unexpected_insert:${table}`);
    },
    async bulkUpdate(table, patch, where) {
      if (table === 'WhatsappTemplateCatalog') {
        for (const row of catalogs.values()) {
          if (Number(row.id) === Number(where.id)) Object.assign(row, patch);
        }
        return;
      }
      if (table === 'AutomationFlowTemplatesV2') {
        flowRows.forEach((row) => {
          if (where.id !== undefined && Number(row.id) !== Number(where.id)) return;
          if (where.public_id !== undefined && row.public_id !== where.public_id) return;
          Object.assign(row, patch);
        });
        return;
      }
      if (table === 'AutomationFlowCatalog') {
        if (where.template_key === automationCatalog.template_key) Object.assign(automationCatalog, patch);
        return;
      }
      throw new Error(`unexpected_update:${table}`);
    },
  };

  await accessGuidanceMigration.up(queryInterface);
  assert.equal(flowRows.length, 3);
  const historicalV2 = flowRows.find((row) => Number(row.version) === 2);
  const publishedV3 = flowRows.find((row) => Number(row.version) === 3);
  assert.equal(historicalV2.is_active, false);
  assert.equal(historicalV2.nodes, originalNodesJson);
  assert.equal(publishedV3.is_active, true);
  assert.equal(publishedV3.public_id, publicId);
  assert.equal(automationCatalog.template_version, 3);

  const graph = JSON.parse(publishedV3.nodes);
  assert.equal(graph.every((node) => /^N\d+$/.test(node.id)), true);
  const condition = graph.find((node) => node.type === 'condition/field_check');
  const join = graph.find((node) => node.type === 'control/join');
  const baseSend = graph.find((node) => node.id === 'N2');
  const variantSend = graph.find((node) => node.config?.access_guidance_delivery?.role === 'variant');
  const trigger = graph.find((node) => node.id === 'N1');
  assert.equal(trigger.outputs.on_success, condition.id);
  assert.equal(condition.config.left_ref.path, 'clinica.access_guidance_reminder_enabled');
  assert.equal(condition.outputs.on_true, variantSend.id);
  assert.equal(condition.outputs.on_false, baseSend.id);
  assert.equal(baseSend.outputs.on_success, join.id);
  assert.equal(variantSend.outputs.on_success, join.id);
  assert.equal(join.outputs.on_joined, 'N3');
  assert.equal(baseSend.config.delivery_slot, 'same_day_first_visit_reminder');
  assert.equal(baseSend.config.template_display_name, 'Recordatorio mismo día 8:00 (primera visita)');
  assert.equal(variantSend.config.delivery_slot, baseSend.config.delivery_slot);
  assert.equal(variantSend.config.catalog_template_id, 9);
  assert.equal(variantSend.config.fallback_catalog_template_id, 4);
  assert.equal(variantSend.config.fallback_template_display_name, baseSend.config.template_display_name);
  assert.equal(variantSend.config.template_display_name, 'Recordatorio mismo día 8:00 (primera visita - clínica con difícil acceso)');

  const variant = catalogs.get('clinicaclick_recordatorio_mismo_dia_primera_visita_acceso_dificil');
  assert.equal(variant.is_active, true);
  assert.match(variant.components, /team-example\.jpg/);
  assert.match(variant.body_text, /Si necesitas ayuda, respóndenos por aquí\.$/);
  assert.deepEqual(JSON.parse(variant.variables).map((variable) => variable.name), [
    'nombre_paciente',
    'hora_cita',
    'direccion_clinica',
    'url_como_llegar_clinica',
    'indicaciones_acceso_clinica',
  ]);

  const reverseObjectKeys = (value) => {
    if (Array.isArray(value)) return value.map(reverseObjectKeys);
    if (!value || typeof value !== 'object') return value;
    return Object.keys(value).reverse().reduce((result, key) => {
      result[key] = reverseObjectKeys(value[key]);
      return result;
    }, {});
  };
  variant.variables = JSON.stringify(reverseObjectKeys(JSON.parse(variant.variables)));
  variant.components = JSON.stringify(reverseObjectKeys(JSON.parse(variant.components)));

  const draftV4 = {
    ...publishedV3,
    id: nextFlowId++,
    version: 4,
    name: 'Borrador posterior',
    nodes: originalNodesJson,
    is_active: false,
    published_at: null,
  };
  flowRows.push(draftV4);
  await accessGuidanceMigration.up(queryInterface);
  assert.equal(flowRows.length, 4, 'un segundo up no crea otra versión');
  assert.equal(flowRows.find((row) => Number(row.version) === 3).is_active, true);
  assert.equal(draftV4.published_at, null, 'un re-up no publica ni activa borradores');
  assert.equal(draftV4.nodes, originalNodesJson, 'un re-up no modifica el grafo del borrador');

  await accessGuidanceMigration.down(queryInterface);
  assert.equal(flowRows.find((row) => Number(row.version) === 2).is_active, true);
  assert.equal(flowRows.find((row) => Number(row.version) === 3).is_active, false);
  assert.equal(automationCatalog.template_version, 2);
  assert.equal(variant.is_active, false);

  await accessGuidanceMigration.up(queryInterface);
  assert.equal(flowRows.length, 4, 'up-down-up reutiliza la v3 canónica y conserva el borrador');
  assert.equal(flowRows.find((row) => Number(row.version) === 3).is_active, true);
  assert.equal(variant.is_active, true);

  draftV4.nodes = publishedV3.nodes;
  draftV4.published_at = new Date('2026-07-04T08:00:00Z');
  draftV4.is_active = true;
  publishedV3.is_active = false;
  automationCatalog.template_version = 4;
  await accessGuidanceMigration.up(queryInterface);
  assert.equal(draftV4.is_active, true, 'un re-up conserva la canónica publicada más reciente');
  assert.equal(publishedV3.is_active, false, 'un re-up no degrada de v4 a v3');
  assert.equal(automationCatalog.template_version, 4);

  await accessGuidanceMigration.down(queryInterface);
  assert.equal(historicalV2.is_active, true, 'down restaura la última versión previa a la primera canónica');
  assert.equal(publishedV3.is_active, false);
  assert.equal(draftV4.is_active, false, 'down desactiva también clones publicados de la versión canónica');
  assert.equal(automationCatalog.template_version, 2);

  const publishedV5 = {
    ...draftV4,
    id: nextFlowId++,
    version: 5,
    name: 'Versión posterior sin la rama de la migración',
    nodes: originalNodesJson,
    is_active: true,
    published_at: new Date('2026-07-05T08:00:00Z'),
  };
  historicalV2.is_active = false;
  automationCatalog.template_version = 5;
  flowRows.push(publishedV5);
  await accessGuidanceMigration.up(queryInterface);
  assert.equal(publishedV5.is_active, true, 'un re-up respeta una publicación posterior no canónica');
  assert.equal(publishedV3.is_active, false);
  assert.equal(automationCatalog.template_version, 5, 'un re-up no repinea el catálogo a una versión antigua');
});
