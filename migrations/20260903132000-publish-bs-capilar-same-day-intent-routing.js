'use strict';

const { Op } = require('sequelize');
const { cloneClassifyIntentPresetConfig } = require('../src/lib/automation-intent-contract');

const SNAPSHOT_TABLE = 'AutomationIntentMigrationSnapshots';
const SNAPSHOT_KEY = 'bs_capilar_same_day_intent_routing_v1';
const TARGET_PUBLIC_ID = 'flw_0b8af554f77d0f0f';
const TARGET_CLINIC_ID = 66;

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function parseJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function pickExistingColumns(payload, definition) {
  return Object.fromEntries(Object.entries(payload).filter(([key]) => definition[key]));
}

function aiRef(path, valueType, label) {
  return {
    source: 'node_output',
    node_id: 'N3',
    path,
    value_type: valueType,
    label,
  };
}

function comparison(id, connector, path, valueType, operator, rightValue, label) {
  return {
    id,
    connector,
    left_ref: aiRef(path, valueType, label),
    operator,
    right_value: rightValue,
  };
}

function branch(id, label, comparisonRules) {
  const first = comparisonRules[0];
  return {
    id,
    label,
    comparison_rules: comparisonRules,
    left_ref: first.left_ref,
    operator: first.operator,
    right_value: first.right_value,
  };
}

function node(id, type, config, outputs, x, y, outputSchema) {
  return {
    id,
    type,
    config: config || {},
    outputs: outputs || {},
    position: { x, y },
    ...(outputSchema ? { output_schema: outputSchema } : {}),
  };
}

function notificationConfig(title, message, options = {}) {
  return {
    title,
    message,
    assignee_type: 'role',
    assignee_id: options.adminOnly
      ? 'admin'
      : ['personaldeclinica', 'admin'],
    subrole: options.adminOnly ? null : 'Recepcion / Comercial ventas',
    display_mode: options.persistent ? 'persistent_alert' : 'inbox',
    alert_level: options.urgent ? 'error' : 'warning',
  };
}

function validateSource(source) {
  if (!source || source.public_id !== TARGET_PUBLIC_ID || Number(source.clinic_id) !== TARGET_CLINIC_ID) {
    throw new Error('bs_capilar_same_day_source_scope_mismatch');
  }
  if (source.trigger_type !== 'appointment_reminder_window') {
    throw new Error('bs_capilar_same_day_source_trigger_mismatch');
  }
  const nodes = parseJson(source.nodes, []);
  for (const requiredId of ['N1', 'N2', 'N3', 'N6', 'N7', 'N8', 'N9']) {
    if (!nodes.some((item) => item?.id === requiredId)) {
      throw new Error(`bs_capilar_same_day_source_node_missing:${requiredId}`);
    }
  }
  const wait = nodes.find((item) => item?.id === 'N9');
  if (
    wait?.type !== 'delay/wait_response'
    || wait?.config?.response_buffer_enabled !== true
    || Number(wait?.config?.response_buffer_delay_seconds) !== 90
  ) {
    throw new Error('bs_capilar_same_day_source_wait_contract_mismatch');
  }
  return true;
}

function buildTargetNodes(source) {
  validateSource(source);
  const sourceNodes = clone(parseJson(source.nodes, []));
  const keepIds = new Set(['N1', 'N2', 'N3', 'N6', 'N7', 'N8', 'N9']);
  const retained = sourceNodes.filter((item) => keepIds.has(item?.id));
  const byId = new Map(retained.map((item) => [item.id, item]));

  const aiNode = byId.get('N3');
  aiNode.config = cloneClassifyIntentPresetConfig({
    mode: 'auto',
    max_tokens: 700,
    migration_key: SNAPSHOT_KEY,
  });
  aiNode.outputs = { on_success: 'N10', on_fail: 'N70' };
  aiNode.position = { x: 100, y: 720 };

  const mainBranches = [
    branch('branch_urgent', 'Posible urgencia', [
      comparison('rule_1', null, 'posible_urgencia', 'boolean', 'equals', true, 'Posible urgencia'),
    ]),
    branch('branch_confirm_pending', 'Confirma y requiere respuesta', [
      comparison('rule_1', null, 'intencion_principal', 'string', 'equals', 'confirmar_cita', 'Intencion principal'),
      comparison('rule_2', 'and', 'confianza_intencion_principal', 'number', 'greater_than', 0.85, 'Confianza de la intencion principal'),
      comparison('rule_3', 'and', 'necesita_respuesta', 'boolean', 'equals', true, 'Necesita respuesta'),
    ]),
    branch('branch_confirm', 'Confirma la cita', [
      comparison('rule_1', null, 'intencion_principal', 'string', 'equals', 'confirmar_cita', 'Intencion principal'),
      comparison('rule_2', 'and', 'confianza_intencion_principal', 'number', 'greater_than', 0.85, 'Confianza de la intencion principal'),
      comparison('rule_3', 'and', 'necesita_respuesta', 'boolean', 'equals', false, 'Necesita respuesta'),
    ]),
    branch('branch_cancel', 'Cancela la cita', [
      comparison('rule_1', null, 'intencion_principal', 'string', 'equals', 'cancelar_cita', 'Intencion principal'),
      comparison('rule_2', 'and', 'confianza_intencion_principal', 'number', 'greater_than', 0.85, 'Confianza de la intencion principal'),
    ]),
    branch('branch_change', 'Solicita cambiar la cita', [
      comparison('rule_1', null, 'intencion_principal', 'string', 'equals', 'solicitar_cambio_cita', 'Intencion principal'),
      comparison('rule_2', 'and', 'confianza_intencion_principal', 'number', 'greater_than', 0.85, 'Confianza de la intencion principal'),
    ]),
    branch('branch_needs_reply', 'Requiere respuesta de la clinica', [
      comparison('rule_1', null, 'necesita_respuesta', 'boolean', 'equals', true, 'Necesita respuesta'),
    ]),
    branch('branch_ack', 'Agradecimiento sin accion pendiente', [
      comparison('rule_1', null, 'intencion_principal', 'string', 'equals', 'agradecimiento', 'Intencion principal'),
      comparison('rule_2', 'and', 'necesita_respuesta', 'boolean', 'equals', false, 'Necesita respuesta'),
    ]),
  ];

  const mainOutputs = {
    branch_urgent: 'N30',
    branch_confirm_pending: 'N31',
    branch_confirm: 'N32',
    branch_cancel: 'N40',
    branch_change: 'N50',
    branch_needs_reply: 'N60',
    branch_ack: 'N62',
    on_else: 'N61',
  };
  const mainOutputSchema = Object.fromEntries([
    ...mainBranches.map((item) => [item.id, { label: item.label }]),
    ['on_else', { label: 'Ninguna coincide' }],
  ]);

  const followupAiConfig = {
    preset_key: 'custom',
    mode: 'auto',
    max_tokens: 350,
    instruction: 'Analiza exclusivamente patient_message_batch como respuesta a la pregunta de si el paciente quiere concertar una nueva cita. Usa conversation_today solo para comprender esa pregunta. Devuelve quiere_nueva_cita=true si acepta una nueva fecha, false si la rechaza y una confianza individual. No cambies el estado de la cita cancelada.',
    context_sources: [
      { key: 'patient_message_batch', path: '{{last_response_context}}' },
      { key: 'conversation_today', path: '{{conversation_today}}' },
    ],
    output_fields: [
      {
        name: 'quiere_nueva_cita',
        type: 'boolean',
        description: 'Indica si el paciente acepta que recepcion le ayude a concertar una cita nueva',
        include_confidence: true,
      },
      {
        name: 'motivo',
        type: 'string',
        description: 'Razon breve de la clasificacion sin datos clinicos innecesarios',
      },
    ],
  };
  const followupRef = (path, valueType, label) => ({
    source: 'node_output', node_id: 'N44', path, value_type: valueType, label,
  });
  const followupBranches = [
    {
      id: 'branch_yes',
      label: 'Quiere una cita nueva',
      comparison_rules: [
        { id: 'rule_1', connector: null, left_ref: followupRef('quiere_nueva_cita', 'boolean', 'Quiere una cita nueva'), operator: 'equals', right_value: true },
        { id: 'rule_2', connector: 'and', left_ref: followupRef('confianza_quiere_nueva_cita', 'number', 'Confianza'), operator: 'greater_than', right_value: 0.85 },
      ],
    },
    {
      id: 'branch_no',
      label: 'No quiere una cita nueva',
      comparison_rules: [
        { id: 'rule_1', connector: null, left_ref: followupRef('quiere_nueva_cita', 'boolean', 'Quiere una cita nueva'), operator: 'equals', right_value: false },
        { id: 'rule_2', connector: 'and', left_ref: followupRef('confianza_quiere_nueva_cita', 'number', 'Confianza'), operator: 'greater_than', right_value: 0.85 },
      ],
    },
  ];

  return [
    ...retained,
    node('N10', 'condition/field_check', {
      mode: 'multi_branch',
      branch_rules: mainBranches,
      migration_key: SNAPSHOT_KEY,
    }, mainOutputs, 100, 840, mainOutputSchema),

    node('N30', 'action/send_system_notification', notificationConfig(
      'Posible urgencia en una conversación',
      '{{paciente.nombre}} ha enviado un mensaje que requiere revisión prioritaria. Abre la conversación y valora la situación.',
      { persistent: true, urgent: true },
    ), { on_success: null, on_fail: 'N71' }, -1180, 1080),

    node('N31', 'action/change_status', { target_entity: 'appointment', new_status: 'recordatorio_confirmado' }, { on_success: 'N33', on_fail: 'N71' }, -820, 1080),
    node('N33', 'action/send_system_notification', notificationConfig(
      'Cita confirmada con comentario pendiente',
      '{{paciente.nombre}} ha confirmado la cita y ha añadido otro comentario. La cita ya está confirmada; revisa la conversación para completar la atención.',
      { persistent: true },
    ), { on_success: null, on_fail: 'N71' }, -820, 1260),

    node('N32', 'action/change_status', { target_entity: 'appointment', new_status: 'recordatorio_confirmado' }, { on_success: 'N34', on_fail: 'N71' }, -460, 1080),
    node('N34', 'action/reply_message', {
      message_text: 'Gracias por confirmarlo. ¡Hasta ahora!',
      suppress_if_human_replied: true,
      suppress_if_response_needed: false,
    }, { on_success: null, on_fail: 'N71' }, -460, 1260),

    node('N40', 'action/change_status', { target_entity: 'appointment', new_status: 'cancelada' }, { on_success: 'N41', on_fail: 'N72' }, -100, 1080),
    node('N41', 'action/send_system_notification', notificationConfig(
      'Cita cancelada por el paciente',
      '{{paciente.nombre}} ha cancelado su cita. Revisa la conversación si necesitas completar alguna gestión.',
      { persistent: true },
    ), { on_success: 'N42', on_fail: 'N42' }, -100, 1260),
    node('N42', 'action/reply_message', {
      message_text: 'Gracias por avisarnos. Hemos cancelado tu cita. ¿Quieres que te ayudemos a concertar una nueva fecha?',
      suppress_if_human_replied: true,
      suppress_if_response_needed: false,
    }, { on_success: 'N43', on_fail: 'N72' }, -100, 1440),
    node('N43', 'delay/wait_response', {
      timeout_duration: 12,
      timeout_unit: 'hours',
      listens_to_node_id: 'N42',
      response_buffer_enabled: true,
      response_buffer_delay_seconds: 90,
    }, { on_response: 'N44', on_timeout: null }, -100, 1620),
    node('N44', 'condition/ai_analysis', followupAiConfig, { on_success: 'N45', on_fail: 'N73' }, -100, 1800),
    node('N45', 'condition/field_check', {
      mode: 'multi_branch',
      branch_rules: followupBranches,
    }, { branch_yes: 'N46', branch_no: null, on_else: 'N47' }, -100, 1980, {
      branch_yes: { label: 'Quiere una cita nueva' },
      branch_no: { label: 'No quiere una cita nueva' },
      on_else: { label: 'Ninguna coincide' },
    }),
    node('N46', 'action/send_system_notification', notificationConfig(
      'Paciente pendiente de nueva cita',
      '{{paciente.nombre}} ha cancelado su cita anterior y quiere concertar una fecha nueva. Abre la conversación para gestionarla.',
      { persistent: true },
    ), { on_success: null, on_fail: 'N72' }, -220, 2160),
    node('N47', 'action/send_system_notification', notificationConfig(
      'Revisar respuesta tras cancelar una cita',
      'No se ha podido determinar si {{paciente.nombre}} quiere concertar una cita nueva. Revisa la conversación.',
      { persistent: true },
    ), { on_success: null, on_fail: 'N72' }, 20, 2160),

    node('N50', 'action/change_status', { target_entity: 'appointment', new_status: 'cambio_solicitado' }, { on_success: 'N51', on_fail: 'N71' }, 260, 1080),
    node('N51', 'action/reply_message', {
      message_text: 'Gracias por avisarnos. Hemos anotado que quieres cambiar tu cita. No recibirás más recordatorios mientras recepción revisa tu solicitud. Te contactaremos para ofrecerte otra hora.',
      suppress_if_human_replied: true,
      suppress_if_response_needed: false,
    }, { on_success: 'N52', on_fail: 'N52' }, 260, 1260),
    node('N52', 'action/send_system_notification', notificationConfig(
      'Cambio de cita solicitado',
      '{{paciente.nombre}} quiere cambiar su cita actual. Abre la conversación y acuerda una nueva fecha.',
      { persistent: true },
    ), { on_success: null, on_fail: 'N71' }, 260, 1440),

    node('N60', 'action/send_system_notification', notificationConfig(
      'Respuesta pendiente de la clínica',
      '{{paciente.nombre}} ha enviado un mensaje que necesita atención del equipo. Revisa la conversación.',
      { persistent: true },
    ), { on_success: null, on_fail: 'N71' }, 620, 1080),
    node('N62', 'action/reply_message', {
      message_text: 'Perfecto ¡hasta ahora!',
      suppress_if_human_replied: true,
      suppress_if_response_needed: false,
    }, { on_success: null, on_fail: 'N71' }, 980, 1080),
    node('N61', 'action/send_system_notification', notificationConfig(
      'Respuesta no concluyente',
      'La automatización no ha aplicado cambios a la cita de {{paciente.nombre}} porque la respuesta no supera las condiciones configuradas. Revisa la conversación.',
      { persistent: false },
    ), { on_success: null, on_fail: 'N71' }, 1340, 1080),
    node('N70', 'action/send_system_notification', notificationConfig(
      'No se pudo completar el análisis automático',
      'Se ha producido un fallo técnico al analizar la respuesta de {{paciente.nombre}}. La cita no debe modificarse sin revisión.',
      { persistent: false, adminOnly: true },
    ), { on_success: null, on_fail: null }, 1700, 1080),
    node('N71', 'action/send_system_notification', notificationConfig(
      'No se pudo aplicar la respuesta del paciente',
      'Se ha producido un fallo técnico al aplicar la respuesta de {{paciente.nombre}}. Revisa la conversación y la cita.',
      { persistent: false, adminOnly: true },
    ), { on_success: null, on_fail: null }, 1460, 1260),
    node('N72', 'action/send_system_notification', notificationConfig(
      'No se pudo completar la cancelación',
      'Se ha producido un fallo técnico durante la cancelación o su seguimiento para {{paciente.nombre}}. Revisa la conversación y la cita.',
      { persistent: false, adminOnly: true },
    ), { on_success: null, on_fail: null }, -100, 2340),
    node('N73', 'action/send_system_notification', notificationConfig(
      'No se pudo analizar la respuesta tras cancelar',
      'Se ha producido un fallo técnico al analizar si {{paciente.nombre}} quiere una cita nueva. La cita original permanece cancelada.',
      { persistent: false, adminOnly: true },
    ), { on_success: null, on_fail: null }, 140, 1980),
  ];
}

async function readSnapshot(queryInterface, transaction) {
  const rows = await queryInterface.sequelize.query(
    `SELECT payload FROM ${SNAPSHOT_TABLE} WHERE snapshot_key = :snapshotKey LIMIT 1`,
    {
      replacements: { snapshotKey: SNAPSHOT_KEY },
      type: queryInterface.sequelize.QueryTypes.SELECT,
      transaction,
    },
  );
  return parseJson(rows[0]?.payload, null);
}

async function loadFamily(queryInterface, transaction) {
  return queryInterface.sequelize.query(
    `
      SELECT id, public_id, template_key, version, engine_version, name, description,
             trigger_type, trigger_config, is_active, is_system, clinic_id, group_id,
             entry_node_id, nodes, published_at, published_by, created_by
      FROM AutomationFlowTemplatesV2
      WHERE public_id = :publicId
      ORDER BY version ASC, id ASC
      FOR UPDATE
    `,
    {
      replacements: { publicId: TARGET_PUBLIC_ID },
      type: queryInterface.sequelize.QueryTypes.SELECT,
      transaction,
    },
  );
}

function shouldRestorePreviousVersion(family, snapshot) {
  const insertedId = Number(snapshot?.inserted_template_id);
  const inserted = family.find((row) => Number(row.id) === insertedId);
  const otherActive = family.some(
    (row) => Number(row.id) !== insertedId && Number(row.is_active) === 1,
  );
  return Number(inserted?.is_active) === 1 && !otherActive;
}

function findPreparedVersion(family) {
  return family.find((row) => parseJson(row.nodes, []).some(
    (item) => item?.config?.migration_key === SNAPSHOT_KEY,
  )) || null;
}

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      if (await readSnapshot(queryInterface, transaction)) return;
      const family = await loadFamily(queryInterface, transaction);
      const activeRows = family.filter((row) => Number(row.is_active) === 1);
      if (activeRows.length !== 1) throw new Error('bs_capilar_same_day_active_version_invalid');
      const source = activeRows[0];
      const prepared = findPreparedVersion(family);
      const nodes = prepared
        ? parseJson(prepared.nodes, [])
        : buildTargetNodes(source);

      const previousJobsAutoStart = process.env.JOBS_AUTO_START;
      process.env.JOBS_AUTO_START = 'false';
      let validateFlowPayloadForInternalUse;
      try {
        ({ validateFlowPayloadForInternalUse } = require('../src/controllers/automationsV2.controller'));
      } finally {
        if (previousJobsAutoStart === undefined) delete process.env.JOBS_AUTO_START;
        else process.env.JOBS_AUTO_START = previousJobsAutoStart;
      }
      const validation = await validateFlowPayloadForInternalUse({
        entry_node_id: source.entry_node_id,
        trigger_type: source.trigger_type,
        trigger_config: parseJson(source.trigger_config, {}),
        nodes,
      });
      if (!validation.ok) {
        throw new Error(`bs_capilar_same_day_validation_failed:${JSON.stringify(validation.errors)}`);
      }

      const now = new Date();
      if (prepared) {
        await queryInterface.bulkInsert(SNAPSHOT_TABLE, [{
          snapshot_key: SNAPSHOT_KEY,
          payload: JSON.stringify({
            target_public_id: TARGET_PUBLIC_ID,
            source_template_id: Number(source.id),
            inserted_template_id: Number(prepared.id),
            inserted_version: Number(prepared.version),
            prepared_only: true,
          }),
          created_at: now,
          updated_at: now,
        }], { transaction });
        return;
      }

      const version = Math.max(...family.map((row) => Number(row.version) || 0)) + 1;
      const definition = await queryInterface.describeTable('AutomationFlowTemplatesV2');
      await queryInterface.bulkInsert('AutomationFlowTemplatesV2', [pickExistingColumns({
        public_id: source.public_id,
        template_key: source.template_key,
        version,
        engine_version: source.engine_version || 'v2',
        name: source.name,
        description: source.description,
        trigger_type: source.trigger_type,
        trigger_config: JSON.stringify(parseJson(source.trigger_config, null)),
        is_active: false,
        is_system: Number(source.is_system) === 1,
        clinic_id: source.clinic_id,
        group_id: source.group_id,
        entry_node_id: source.entry_node_id,
        nodes: JSON.stringify(nodes),
        published_at: now,
        published_by: source.published_by || source.created_by,
        created_by: source.created_by,
        created_at: now,
        updated_at: now,
      }, definition)], { transaction });

      const inserted = await queryInterface.sequelize.query(
        `SELECT id FROM AutomationFlowTemplatesV2 WHERE public_id = :publicId AND version = :version ORDER BY id DESC LIMIT 1`,
        {
          replacements: { publicId: TARGET_PUBLIC_ID, version },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      if (!inserted[0]?.id) throw new Error('bs_capilar_same_day_insert_readback_failed');
      await queryInterface.bulkInsert(SNAPSHOT_TABLE, [{
        snapshot_key: SNAPSHOT_KEY,
        payload: JSON.stringify({
          target_public_id: TARGET_PUBLIC_ID,
          source_template_id: Number(source.id),
          inserted_template_id: Number(inserted[0].id),
          inserted_version: version,
          prepared_only: true,
        }),
        created_at: now,
        updated_at: now,
      }], { transaction });
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const snapshot = await readSnapshot(queryInterface, transaction);
      if (!snapshot?.inserted_template_id) return;
      const family = await loadFamily(queryInterface, transaction);
      const inserted = family.find((row) => Number(row.id) === Number(snapshot.inserted_template_id));
      const restorePrevious = shouldRestorePreviousVersion(family, snapshot);
      const now = new Date();
      if (Number(inserted?.is_active) === 1) {
        await queryInterface.bulkUpdate(
          'AutomationFlowTemplatesV2',
          { is_active: false, updated_at: now },
          { id: Number(snapshot.inserted_template_id) },
          { transaction },
        );
        if (restorePrevious) {
          await queryInterface.bulkUpdate(
            'AutomationFlowTemplatesV2',
            { is_active: true, updated_at: now },
            { id: Number(snapshot.source_template_id) },
            { transaction },
          );
        }
      }
      await queryInterface.bulkDelete(SNAPSHOT_TABLE, { snapshot_key: SNAPSHOT_KEY }, { transaction });
    });
  },

  _test: {
    SNAPSHOT_KEY,
    TARGET_CLINIC_ID,
    TARGET_PUBLIC_ID,
    buildTargetNodes,
    findPreparedVersion,
    shouldRestorePreviousVersion,
    validateSource,
  },
};
