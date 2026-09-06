'use strict';

const { cloneClassifyIntentPresetConfig } = require('../src/lib/automation-intent-contract');

const SNAPSHOT_TABLE = 'AutomationIntentMigrationSnapshots';
const SNAPSHOT_KEY = 'cancel_unconfirmed_night_before_v7';
const TARGET_PUBLIC_ID = 'flw_cancel_unconfirmed_appt_night_before';
const SOURCE_VERSION = 2;
const ACTIVE_VERSION = 6;
const DRAFT_VERSION = 7;

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

function aiRef(nodeId, path, valueType, label) {
  return {
    source: 'node_output',
    node_id: nodeId,
    path,
    value_type: valueType,
    label,
  };
}

function comparison(nodeId, id, connector, path, valueType, operator, rightValue, label) {
  return {
    id,
    connector,
    left_ref: aiRef(nodeId, path, valueType, label),
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

function notificationConfig(title, message, options = {}) {
  return {
    title,
    message,
    assignee_type: 'role',
    assignee_id: options.adminOnly ? 'admin' : ['personaldeclinica', 'admin'],
    subrole: options.adminOnly ? null : 'Recepción / Comercial ventas',
    display_mode: options.persistent ? 'persistent_alert' : 'inbox',
    alert_level: 'warning',
    ...(options.preferenceKey
      ? { presentation_preference_key: options.preferenceKey }
      : {}),
    ...(options.replacePreviousPersistentAlerts
      ? { replace_previous_persistent_alerts: true }
      : {}),
    ...(options.conversationAction
      ? { conversation_action: options.conversationAction }
      : {}),
  };
}

function manualWhatsappConfig(es, ca, en) {
  return {
    variables: {},
    sender_mode: 'clinic_default',
    template_id: '',
    message_mode: 'manual',
    recipient_to: '',
    language_code: 'es_ES',
    recipient_mode: 'context_patient',
    language_routing: {
      source: 'patient_preferred_language',
      enabled: true,
      variants: {
        ca: { language_code: 'ca', manual_message_text: ca },
        en: { language_code: 'en_US', manual_message_text: en },
      },
    },
    sender_origin_id: null,
    fallback_variables: {},
    manual_message_text: es,
    quiet_hours_enabled: false,
    fallback_template_id: '',
    fallback_template_name: '',
    fallback_variables_named: {},
    suppress_if_human_replied: true,
    suppress_if_response_needed: false,
  };
}

function buildIntentConfig() {
  return cloneClassifyIntentPresetConfig({
    mode: 'auto',
    max_tokens: 700,
    migration_key: SNAPSHOT_KEY,
  });
}

function buildMainBranches(sourceNodeId) {
  const c = (id, connector, path, type, operator, value, label) => comparison(
    sourceNodeId,
    id,
    connector,
    path,
    type,
    operator,
    value,
    label,
  );
  return [
    branch('branch_confirm_pending', 'Confirma y necesita respuesta', [
      c('rule_1', null, 'intencion_principal', 'string', 'equals', 'confirmar_cita', 'Intención principal'),
      c('rule_2', 'and', 'confianza_intencion_principal', 'number', 'greater_than', 0.85, 'Confianza de la intención principal'),
      c('rule_3', 'and', 'necesita_respuesta', 'boolean', 'equals', true, 'Necesita respuesta'),
      c('rule_4', 'and', 'confianza_necesita_respuesta', 'number', 'greater_than', 0.85, 'Confianza de necesita respuesta'),
    ]),
    branch('branch_confirm', 'Confirma la cita', [
      c('rule_1', null, 'intencion_principal', 'string', 'equals', 'confirmar_cita', 'Intención principal'),
      c('rule_2', 'and', 'confianza_intencion_principal', 'number', 'greater_than', 0.85, 'Confianza de la intención principal'),
      c('rule_3', 'and', 'necesita_respuesta', 'boolean', 'equals', false, 'Necesita respuesta'),
      c('rule_4', 'and', 'confianza_necesita_respuesta', 'number', 'greater_than', 0.85, 'Confianza de necesita respuesta'),
    ]),
    branch('branch_cancel', 'Cancela la cita', [
      c('rule_1', null, 'intencion_principal', 'string', 'equals', 'cancelar_cita', 'Intención principal'),
      c('rule_2', 'and', 'confianza_intencion_principal', 'number', 'greater_than', 0.85, 'Confianza de la intención principal'),
    ]),
    branch('branch_change', 'Solicita cambiar la cita', [
      c('rule_1', null, 'intencion_principal', 'string', 'equals', 'solicitar_cambio_cita', 'Intención principal'),
      c('rule_2', 'and', 'confianza_intencion_principal', 'number', 'greater_than', 0.85, 'Confianza de la intención principal'),
    ]),
    branch('branch_needs_reply', 'Requiere respuesta de la clínica', [
      c('rule_1', null, 'necesita_respuesta', 'boolean', 'equals', true, 'Necesita respuesta'),
      c('rule_2', 'and', 'confianza_necesita_respuesta', 'number', 'greater_than', 0.85, 'Confianza de necesita respuesta'),
    ]),
  ];
}

function buildFollowupAiConfig() {
  return {
    preset_key: 'custom',
    mode: 'auto',
    max_tokens: 350,
    instruction: 'Analiza exclusivamente patient_message_batch como respuesta a la pregunta de si el paciente quiere concertar una nueva cita. Usa conversation_today solo para comprender esa pregunta. Devuelve quiere_nueva_cita=true si acepta que recepción le ayude a buscar una nueva fecha y false si lo rechaza. No cambies el estado de la cita cancelada. Devuelve la confianza individual y un motivo breve.',
    context_sources: [
      { key: 'patient_message_batch', path: '{{last_response_context}}' },
      { key: 'conversation_today', path: '{{conversation_today}}' },
    ],
    output_fields: [
      {
        name: 'quiere_nueva_cita',
        type: 'boolean',
        description: 'Indica si el paciente acepta que recepción le ayude a concertar una cita nueva',
        include_confidence: true,
      },
      {
        name: 'motivo',
        type: 'string',
        description: 'Razón breve de la clasificación sin datos clínicos innecesarios',
      },
    ],
  };
}

function buildFollowupBranches(sourceNodeId) {
  const ref = (path, type, label) => aiRef(sourceNodeId, path, type, label);
  return [
    branch('branch_yes', 'Quiere una cita nueva', [
      { id: 'rule_1', connector: null, left_ref: ref('quiere_nueva_cita', 'boolean', 'Quiere una cita nueva'), operator: 'equals', right_value: true },
      { id: 'rule_2', connector: 'and', left_ref: ref('confianza_quiere_nueva_cita', 'number', 'Confianza'), operator: 'greater_than', right_value: 0.85 },
    ]),
    branch('branch_no', 'No quiere una cita nueva', [
      { id: 'rule_1', connector: null, left_ref: ref('quiere_nueva_cita', 'boolean', 'Quiere una cita nueva'), operator: 'equals', right_value: false },
      { id: 'rule_2', connector: 'and', left_ref: ref('confianza_quiere_nueva_cita', 'number', 'Confianza'), operator: 'greater_than', right_value: 0.85 },
    ]),
  ];
}

function validateSource(source) {
  if (
    !source
    || source.public_id !== TARGET_PUBLIC_ID
    || Number(source.version) !== SOURCE_VERSION
    || source.trigger_type !== 'appointment_reminder_window'
    || source.clinic_id !== null
  ) {
    throw new Error('cancel_unconfirmed_night_before_source_mismatch');
  }
  const nodes = parseJson(source.nodes, []);
  const byId = new Map(nodes.map((item) => [item?.id, item]));
  if (
    nodes.length !== 13
    || byId.get('N1')?.type !== 'trigger/appointment_reminder_window'
    || byId.get('N3')?.type !== 'delay/wait_response'
    || byId.get('N4')?.config?.preset_key !== 'appointment_unconfirmed_reply'
  ) {
    throw new Error('cancel_unconfirmed_night_before_source_graph_mismatch');
  }
  return true;
}

function buildTargetNodes(source) {
  validateSource(source);
  const sourceNodes = clone(parseJson(source.nodes, []));
  const retainedIds = new Set(['N1', 'N2', 'N3', 'N10']);
  const retained = sourceNodes.filter((item) => retainedIds.has(item?.id));
  const byId = new Map(retained.map((item) => [item.id, item]));

  byId.get('N1').position = { x: 100, y: 100 };
  byId.get('N1').outputs = { on_success: 'N2' };

  byId.get('N2').position = { x: 100, y: 260 };
  byId.get('N2').outputs = { on_success: 'N3', on_fail: 'N40' };

  byId.get('N3').position = { x: 100, y: 440 };
  byId.get('N3').config = {
    ...(byId.get('N3').config || {}),
    response_buffer_enabled: true,
    response_buffer_delay_seconds: 90,
  };
  byId.get('N3').outputs = { on_response: 'N4', on_timeout: 'N10' };

  byId.get('N10').position = { x: 980, y: 620 };
  byId.get('N10').config = { target_entity: 'appointment', new_status: 'cancelada' };
  byId.get('N10').outputs = { on_success: null, on_fail: 'N37' };

  const mainBranches = buildMainBranches('N4');
  const mainOutputs = {
    branch_confirm_pending: 'N15',
    branch_confirm: 'N6',
    branch_cancel: 'N21',
    branch_change: 'N30',
    branch_needs_reply: 'N33',
    on_else: 'N13',
  };
  const mainOutputSchema = Object.fromEntries([
    ...mainBranches.map((item) => [item.id, { label: item.label }]),
    ['on_else', { label: 'Ninguna coincide' }],
  ]);
  const followupBranches = buildFollowupBranches('N25');

  return [
    ...retained,
    node('N4', 'condition/ai_analysis', buildIntentConfig(), {
      on_success: 'N14',
      on_fail: 'N35',
    }, 100, 620),
    node('N14', 'condition/field_check', {
      mode: 'multi_branch',
      source_ai_node_id: 'N4',
      display_label: 'Comparar resultado de N4',
      branch_rules: mainBranches,
      migration_key: SNAPSHOT_KEY,
    }, mainOutputs, 100, 800, mainOutputSchema),

    node('N15', 'action/change_status', {
      target_entity: 'appointment',
      new_status: 'recordatorio_confirmado',
    }, { on_success: 'N16', on_fail: 'N37' }, -900, 1000),
    node('N16', 'action/send_system_notification', notificationConfig(
      '{{paciente.nombre}} ha confirmado y necesita respuesta',
      'La cita ya está confirmada. El paciente también ha planteado una pregunta o petición; revisa la conversación y respóndele desde la clínica.',
      {
        persistent: true,
        preferenceKey: 'automation.appointment_data.confirmed_with_reply',
      },
    ), { on_success: null }, -900, 1180),

    node('N6', 'action/change_status', {
      target_entity: 'appointment',
      new_status: 'recordatorio_confirmado',
    }, { on_success: 'N12', on_fail: 'N37' }, -540, 1000),
    node('N12', 'action/send_whatsapp', manualWhatsappConfig(
      'Gracias, queda confirmada. Te esperamos mañana a la hora prevista.',
      'Gràcies, queda confirmada. T’esperem demà a l’hora prevista.',
      'Thank you, it is confirmed. We look forward to seeing you tomorrow at the scheduled time.',
    ), { on_success: null, on_fail: null }, -540, 1180),

    node('N21', 'action/change_status', {
      target_entity: 'appointment',
      new_status: 'cancelada',
    }, { on_success: 'N22', on_fail: 'N37' }, -180, 1000),
    node('N22', 'action/send_system_notification', notificationConfig(
      '{{paciente.nombre}} ha cancelado su cita',
      'La cita se ha cancelado. Clinicaclick preguntará al paciente si quiere que recepción le ayude a buscar una nueva fecha.',
      { persistent: true },
    ), { on_success: 'N23' }, -180, 1180),
    node('N23', 'action/send_whatsapp', manualWhatsappConfig(
      'Gracias por avisarnos. Hemos cancelado tu cita. ¿Quieres que te ayudemos a concertar una nueva fecha?',
      'Gràcies per avisar-nos. Hem cancel·lat la teva cita. Vols que t’ajudem a concertar una nova data?',
      'Thank you for letting us know. We have cancelled your appointment. Would you like us to help you arrange a new date?',
    ), { on_success: 'N24', on_fail: null }, -180, 1360),
    node('N24', 'delay/wait_response', {
      timeout_duration: 12,
      timeout_unit: 'hours',
      listens_to_node_id: 'N23',
      response_buffer_enabled: true,
      response_buffer_delay_seconds: 90,
    }, { on_response: 'N25', on_timeout: null }, -180, 1540),
    node('N25', 'condition/ai_analysis', buildFollowupAiConfig(), {
      on_success: 'N26',
      on_fail: 'N36',
    }, -180, 1720),
    node('N26', 'condition/field_check', {
      mode: 'multi_branch',
      source_ai_node_id: 'N25',
      display_label: 'Comparar resultado de N25',
      branch_rules: followupBranches,
    }, { branch_yes: 'N27', branch_no: 'N28', on_else: 'N29' }, -180, 1900, {
      branch_yes: { label: 'Quiere una cita nueva' },
      branch_no: { label: 'No quiere una cita nueva' },
      on_else: { label: 'Ninguna coincide' },
    }),
    node('N27', 'action/send_system_notification', notificationConfig(
      '{{paciente.nombre}} quiere una nueva cita',
      'Ha cancelado su cita anterior y quiere que recepción le ayude a concertar una nueva fecha. Abre la conversación para gestionarla.',
      {
        persistent: true,
        replacePreviousPersistentAlerts: true,
        conversationAction: 'schedule_new_appointment',
      },
    ), { on_success: null }, -420, 2080),
    node('N28', 'action/send_whatsapp', manualWhatsappConfig(
      'De acuerdo. Si más adelante necesitas una nueva cita, estaremos encantados de ayudarte.',
      'D’acord. Si més endavant necessites una nova cita, estarem encantats d’ajudar-te.',
      'Understood. If you need a new appointment later, we will be happy to help.',
    ), { on_success: null, on_fail: null }, -180, 2080),
    node('N29', 'action/send_system_notification', notificationConfig(
      '{{paciente.nombre}} necesita respuesta',
      'No se ha podido determinar si quiere concertar una nueva cita. Revisa la conversación y respóndele desde la clínica.',
      {
        persistent: true,
        preferenceKey: 'automation.appointment_data.response_needs_human',
        replacePreviousPersistentAlerts: true,
      },
    ), { on_success: null }, 60, 2080),

    node('N30', 'action/change_status', {
      target_entity: 'appointment',
      new_status: 'cambio_solicitado',
    }, { on_success: 'N31', on_fail: 'N37' }, 180, 1000),
    node('N31', 'action/send_whatsapp', manualWhatsappConfig(
      'Gracias por avisarnos. Revisamos agenda y te decimos disponibilidad cuanto antes.',
      'Gràcies per avisar-nos. Revisem l’agenda i et diem disponibilitat al més aviat possible.',
      'Thank you for letting us know. We will check the diary and send you our availability as soon as possible.',
    ), { on_success: 'N32', on_fail: null }, 180, 1180),
    node('N32', 'action/send_system_notification', notificationConfig(
      '{{paciente.nombre}} quiere cambiar su cita',
      'La cita está marcada como cambio solicitado. Abre la conversación y acuerda una nueva fecha con el paciente.',
      { persistent: true },
    ), { on_success: null }, 180, 1360),

    node('N33', 'action/send_system_notification', notificationConfig(
      '{{paciente.nombre}} necesita respuesta',
      'Ha planteado una pregunta o petición sin confirmar claramente la cita. Revisa la conversación y respóndele desde la clínica.',
      {
        persistent: true,
        preferenceKey: 'automation.appointment_data.response_needs_human',
      },
    ), { on_success: null }, 540, 1000),
    node('N13', 'action/send_system_notification', notificationConfig(
      'Revisar respuesta de {{paciente.nombre}}',
      'La respuesta no supera las condiciones configuradas y no se ha modificado la cita. Revisa la conversación antes de realizar una acción.',
    ), { on_success: null }, 900, 1000),

    node('N35', 'action/send_system_notification', notificationConfig(
      'No se pudo analizar la respuesta',
      'Se ha producido un fallo técnico al analizar la respuesta de {{paciente.nombre}}. La cita no se ha modificado.',
      { adminOnly: true },
    ), { on_success: null }, 1260, 800),
    node('N36', 'action/send_system_notification', notificationConfig(
      'No se pudo analizar la respuesta sobre una nueva cita',
      'Se ha producido un fallo técnico al analizar la respuesta de {{paciente.nombre}}. La cita original permanece cancelada.',
      { adminOnly: true },
    ), { on_success: null }, 180, 1900),
    node('N37', 'action/send_system_notification', notificationConfig(
      'No se pudo actualizar la cita',
      'Se ha producido un fallo técnico al aplicar la respuesta de {{paciente.nombre}}. Revisa la conversación y el estado de la cita.',
      { adminOnly: true },
    ), { on_success: null }, 1260, 1000),
    node('N40', 'action/send_system_notification', notificationConfig(
      'No se pudo enviar el aviso de cita sin confirmar',
      'El aviso nocturno no se ha podido enviar a {{paciente.nombre}}. La cita no se cancelará automáticamente desde esta ejecución.',
      { adminOnly: true },
    ), { on_success: null }, 1260, 260),
  ];
}

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const existingSnapshot = await queryInterface.sequelize.query(
        `SELECT snapshot_key FROM ${SNAPSHOT_TABLE} WHERE snapshot_key = :snapshotKey LIMIT 1`,
        {
          replacements: { snapshotKey: SNAPSHOT_KEY },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      if (existingSnapshot.length) return;

      const family = await queryInterface.sequelize.query(
        `SELECT *,
                (SELECT COUNT(*) FROM FlowExecutionsV2 execution WHERE execution.template_version_id = template.id) AS execution_count
           FROM AutomationFlowTemplatesV2 template
          WHERE public_id = :publicId
          ORDER BY version ASC
          FOR UPDATE`,
        {
          replacements: { publicId: TARGET_PUBLIC_ID },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      const source = family.find((row) => Number(row.version) === SOURCE_VERSION);
      const active = family.find((row) => Number(row.version) === ACTIVE_VERSION);
      const existingDraft = family.find((row) => Number(row.version) === DRAFT_VERSION);
      validateSource(source);
      if (!active || Number(active.is_active) !== 1) {
        throw new Error('cancel_unconfirmed_night_before_active_v6_mismatch');
      }
      if (existingDraft) {
        throw new Error('cancel_unconfirmed_night_before_v7_already_exists');
      }

      const nodes = buildTargetNodes(source);
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
        throw new Error(`cancel_unconfirmed_night_before_v7_invalid:${JSON.stringify(validation.errors)}`);
      }

      const definition = await queryInterface.describeTable('AutomationFlowTemplatesV2');
      const now = new Date();
      await queryInterface.bulkInsert('AutomationFlowTemplatesV2', [pickExistingColumns({
        public_id: source.public_id,
        template_key: source.template_key,
        version: DRAFT_VERSION,
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
        published_at: null,
        published_by: source.published_by || source.created_by,
        created_by: source.created_by,
        created_at: now,
        updated_at: now,
      }, definition)], { transaction });

      const insertedRows = await queryInterface.sequelize.query(
        `SELECT id, is_active, published_at
           FROM AutomationFlowTemplatesV2
          WHERE public_id = :publicId AND version = :version
          LIMIT 1`,
        {
          replacements: { publicId: TARGET_PUBLIC_ID, version: DRAFT_VERSION },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      const inserted = insertedRows[0];
      if (!inserted || Number(inserted.is_active) !== 0 || inserted.published_at !== null) {
        throw new Error('cancel_unconfirmed_night_before_v7_insert_failed');
      }

      await queryInterface.bulkInsert(SNAPSHOT_TABLE, [{
        snapshot_key: SNAPSHOT_KEY,
        payload: JSON.stringify({
          inserted_template_id: Number(inserted.id),
          source_template_id: Number(source.id),
          active_template_id: Number(active.id),
        }),
        created_at: now,
        updated_at: now,
      }], { transaction });
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const snapshots = await queryInterface.sequelize.query(
        `SELECT payload FROM ${SNAPSHOT_TABLE} WHERE snapshot_key = :snapshotKey LIMIT 1`,
        {
          replacements: { snapshotKey: SNAPSHOT_KEY },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      const snapshot = parseJson(snapshots[0]?.payload, null);
      if (!snapshot?.inserted_template_id) return;

      const rows = await queryInterface.sequelize.query(
        `SELECT template.id, template.is_active, template.published_at,
                (SELECT COUNT(*) FROM FlowExecutionsV2 execution WHERE execution.template_version_id = template.id) AS execution_count
           FROM AutomationFlowTemplatesV2 template
          WHERE template.id = :id
          FOR UPDATE`,
        {
          replacements: { id: Number(snapshot.inserted_template_id) },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      const target = rows[0];
      if (
        target
        && (
          Number(target.is_active) !== 0
          || target.published_at !== null
          || Number(target.execution_count) !== 0
        )
      ) {
        throw new Error('cancel_unconfirmed_night_before_v7_no_longer_reversible');
      }
      await queryInterface.bulkDelete(
        'AutomationFlowTemplatesV2',
        { id: Number(snapshot.inserted_template_id) },
        { transaction },
      );
      await queryInterface.bulkDelete(SNAPSHOT_TABLE, { snapshot_key: SNAPSHOT_KEY }, { transaction });
    });
  },

  _test: {
    ACTIVE_VERSION,
    DRAFT_VERSION,
    SNAPSHOT_KEY,
    SOURCE_VERSION,
    TARGET_PUBLIC_ID,
    buildIntentConfig,
    buildMainBranches,
    buildTargetNodes,
    validateSource,
  },
};
