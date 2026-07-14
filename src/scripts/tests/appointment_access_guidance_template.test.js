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

test('migración atómica añade la variante y revierte bindings versionados sin tocar reglas', async () => {
  const catalogs = new Map([
    ['clinicaclick_recordatorio_mismo_dia_primera_visita', { id: 4, name: 'clinicaclick_recordatorio_mismo_dia_primera_visita' }],
  ]);
  let nextCatalogId = 9;
  const effectiveTemplates = [{
    id: 700,
    name: 'clinicaclick_recordatorio_mismo_dia_primera_visita_acceso_dificil_v1',
    is_active: true,
  }];
  const flowRows = [{
    id: 300,
    nodes: JSON.stringify([
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
      },
      {
        id: 'N2',
        type: 'action/send_whatsapp',
        config: {
          message_mode: 'template',
          template_name: 'clinicaclick_recordatorio_mismo_dia_primera_visita',
          catalog_template_id: 4,
          quiet_hours_enabled: true,
        },
      },
    ]),
  }];

  const queryInterface = {
    sequelize: {
      QueryTypes: { SELECT: 'SELECT' },
      async transaction(callback) {
        return callback({ id: 'tx' });
      },
      async query(sql, options = {}) {
        if (sql.includes('FROM WhatsappTemplateCatalog')) {
          const row = catalogs.get(options.replacements?.name);
          return row ? [{ id: row.id }] : [];
        }
        if (sql.includes('FROM AutomationFlowTemplatesV2')) {
          return flowRows.map((row) => ({ ...row }));
        }
        if (sql.includes('FROM WhatsappTemplates')) {
          return effectiveTemplates.map((row) => ({ ...row }));
        }
        throw new Error(`unexpected_query:${sql}`);
      },
    },
    async describeTable(table) {
      assert.equal(table, 'WhatsappTemplateCatalog');
      return {
        display_name: {},
        category: {},
        body_text: {},
        variables: {},
        components: {},
        is_generic: {},
        is_active: {},
        propagation_state: {},
        updated_at: {},
      };
    },
    async bulkInsert(table, rows) {
      assert.equal(table, 'WhatsappTemplateCatalog');
      for (const row of rows) {
        const stored = { id: nextCatalogId++, ...row };
        catalogs.set(row.name, stored);
      }
    },
    async bulkUpdate(table, patch, where) {
      if (table === 'WhatsappTemplates') {
        for (const template of effectiveTemplates) {
          if (where.id.includes(template.id)) Object.assign(template, patch);
        }
        return;
      }
      assert.equal(table, 'AutomationFlowTemplatesV2');
      const row = flowRows.find((candidate) => Number(candidate.id) === Number(where.id));
      assert.ok(row);
      Object.assign(row, patch);
    },
    async bulkDelete(table, where) {
      assert.equal(table, 'WhatsappTemplateCatalog');
      const entry = Array.from(catalogs.entries()).find(([, row]) => Number(row.id) === Number(where.id));
      assert.ok(entry);
      catalogs.delete(entry[0]);
    },
  };

  await accessGuidanceMigration.up(queryInterface);
  const firstResult = JSON.parse(flowRows[0].nodes);
  await assert.rejects(
    () => accessGuidanceMigration.up(queryInterface),
    /access_guidance_catalog_template_already_exists/
  );
  const secondResult = JSON.parse(flowRows[0].nodes);

  assert.equal(catalogs.size, 2);
  assert.deepEqual(secondResult, firstResult);
  assert.deepEqual(secondResult[0].config, {
    schedule_moment: 'same_day',
    schedule_time_mode: 'custom',
    custom_time: '08:00',
    exclude_if_not_confirmed: true,
    exclude_if_booked_same_day: true,
  });
  assert.equal(secondResult[1].config.quiet_hours_enabled, true);
  assert.deepEqual(
    secondResult[1].config.access_guidance_variant.appointment_types,
    ['primera_sin_trat', 'primera_con_trat']
  );
  assert.equal(secondResult[1].config.access_guidance_variant.catalog_template_id, 9);

  const variant = catalogs.get('clinicaclick_recordatorio_mismo_dia_primera_visita_acceso_dificil');
  assert.equal(
    variant.display_name,
    'Recordatorio mismo día 8:00 (primera visita - clínica con difícil acceso)'
  );
  assert.match(variant.components, /team-example\.jpg/);
  assert.match(variant.body_text, /Si necesitas ayuda, respóndenos por aquí\.$/);
  assert.doesNotMatch(variant.body_text, /\{\{5\}\}$/);
  assert.deepEqual(
    JSON.parse(variant.variables).map((variable) => variable.name),
    [
      'nombre_paciente',
      'hora_cita',
      'direccion_clinica',
      'url_como_llegar_clinica',
      'indicaciones_acceso_clinica',
    ]
  );

  secondResult[1].config.access_guidance_variant.template_name = effectiveTemplates[0].name;
  secondResult[1].config.access_guidance_variant.template_id = effectiveTemplates[0].id;
  flowRows[0].nodes = JSON.stringify(secondResult);
  await accessGuidanceMigration.down(queryInterface);

  const reverted = JSON.parse(flowRows[0].nodes);
  assert.equal(reverted[1].config.access_guidance_variant, undefined);
  assert.deepEqual(reverted[0].config, firstResult[0].config);
  assert.equal(catalogs.has('clinicaclick_recordatorio_mismo_dia_primera_visita_acceso_dificil'), false);
  assert.equal(effectiveTemplates[0].is_active, false);
});
