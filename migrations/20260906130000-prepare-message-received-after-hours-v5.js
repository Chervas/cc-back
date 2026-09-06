'use strict';

const { cloneClassifyIntentPresetConfig } = require('../src/lib/automation-intent-contract');

const SNAPSHOT_TABLE = 'AutomationIntentMigrationSnapshots';
const SNAPSHOT_KEY = 'message_received_after_hours_v5';
const TARGET_PUBLIC_ID = 'flw_message_received_after_hours';
const SOURCE_VERSION = 1;
const ACTIVE_VERSION = 4;
const DRAFT_VERSION = 5;

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

function node(id, type, config, outputs, x, y, outputSchema = null) {
  return {
    id,
    type,
    config: config || {},
    outputs: outputs || {},
    position: { x, y },
    ...(outputSchema ? { output_schema: outputSchema } : {}),
  };
}

function ref(source, nodeId, path, valueType, label) {
  return {
    source,
    node_id: nodeId || null,
    path,
    value_type: valueType,
    label,
  };
}

function rule(id, connector, leftRef, operator, rightValue) {
  return { id, connector, left_ref: leftRef, operator, right_value: rightValue };
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

function aiRule(id, connector, path, valueType, operator, rightValue, label) {
  return rule(id, connector, ref('node_output', 'N2', path, valueType, label), operator, rightValue);
}

function notificationConfig(title, message, options = {}) {
  return {
    title,
    message,
    assignee_type: 'role',
    assignee_id: options.adminOnly ? 'admin' : ['personaldeclinica', 'admin'],
    subrole: options.adminOnly ? null : 'Recepcion / Comercial ventas',
    display_mode: options.persistent ? 'persistent_alert' : 'inbox',
    alert_level: options.alertLevel || 'warning',
    ...(options.preferenceKey ? { presentation_preference_key: options.preferenceKey } : {}),
    ...(options.replacePreviousPersistentAlerts ? { replace_previous_persistent_alerts: true } : {}),
    ...(options.conversationAction ? { conversation_action: options.conversationAction } : {}),
  };
}

const REPLY_TEXTS = Object.freeze({
  cancellation: {
    es: 'Gracias por avisarnos. Hemos cancelado tu cita. ¿Quieres que te ayudemos a concertar una nueva fecha?',
    ca: 'Gràcies per avisar-nos. Hem cancel·lat la teva cita. Vols que t\'ajudem a concertar una nova data?',
    en: 'Thanks for letting us know. We have cancelled your appointment. Would you like us to help you arrange a new date?',
  },
  rebookingDeclined: {
    es: 'De acuerdo. Si más adelante necesitas una nueva cita, estaremos encantados de ayudarte.',
    ca: 'D\'acord. Si més endavant necessites una nova cita, estarem encantats d\'ajudar-te.',
    en: 'Understood. If you need another appointment later, we will be happy to help.',
  },
  changeRequested: {
    es: 'Gracias por avisarnos. Revisamos agenda y te decimos disponibilidad cuanto antes.',
    ca: 'Gràcies per avisar-nos. Revisarem l\'agenda i et direm la disponibilitat tan aviat com sigui possible.',
    en: 'Thanks for letting us know. We will check the schedule and get back to you with availability as soon as possible.',
  },
  confirmationWithQuestion: {
    es: 'Gracias. Hemos registrado tu confirmación. La clínica está cerrada ahora y hemos dejado tu pregunta pendiente para recepción.',
    ca: 'Gràcies. Hem registrat la teva confirmació. La clínica està tancada ara i hem deixat la teva pregunta pendent perquè recepció la revisi.',
    en: 'Thank you. We have recorded your confirmation. The clinic is currently closed, and your question is pending review by reception.',
  },
  confirmation: {
    es: '¡Gracias! Te esperamos 😊',
    ca: 'Gràcies! T\'esperem 😊',
    en: 'Thank you! We look forward to seeing you 😊',
  },
  urgent: {
    es: '¡Hola! La clínica no está abierta ahora mismo. Hemos marcado tu mensaje para revisión prioritaria y te responderemos cuanto antes.',
    ca: 'Hola! La clínica no està oberta ara mateix. Hem marcat el teu missatge per a revisió prioritària i et respondrem tan aviat com sigui possible.',
    en: 'Hello! The clinic is currently closed. We have marked your message for priority review and will reply as soon as possible.',
  },
  general: {
    es: '¡Hola! La clínica no está abierta ahora mismo y no te puedo responder, pero te contestaremos cuanto antes.',
    ca: 'Hola! La clínica no està oberta ara mateix i no et puc respondre, però et contestarem tan aviat com sigui possible.',
    en: 'Hello! The clinic is not open right now and I cannot answer you, but we will reply as soon as possible.',
  },
});

function replyConfig(messages) {
  return {
    message_text: messages.es,
    suppress_if_human_replied: true,
    language_routing: {
      enabled: true,
      source: 'patient_preferred_language',
      variants: {
        ca: { message_text: messages.ca },
        en: { message_text: messages.en },
      },
    },
  };
}

function buildIntentConfig() {
  return cloneClassifyIntentPresetConfig({
    mode: 'auto',
    max_tokens: 700,
    migration_key: SNAPSHOT_KEY,
  });
}

function buildMainBranches() {
  const appointmentExists = (id, connector = 'and') => rule(
    id,
    connector,
    ref('context', null, 'appointment.id', 'number', 'Cita relacionada'),
    'exists',
    '',
  );
  return [
    branch('branch_cancel', 'Cancela una cita', [
      aiRule('rule_1', null, 'intencion_principal', 'string', 'equals', 'cancelar_cita', 'Intencion principal'),
      aiRule('rule_2', 'and', 'confianza_intencion_principal', 'number', 'greater_than', 0.85, 'Confianza de la intencion'),
      appointmentExists('rule_3'),
    ]),
    branch('branch_change', 'Solicita cambiar una cita', [
      aiRule('rule_1', null, 'intencion_principal', 'string', 'equals', 'solicitar_cambio_cita', 'Intencion principal'),
      aiRule('rule_2', 'and', 'confianza_intencion_principal', 'number', 'greater_than', 0.85, 'Confianza de la intencion'),
      appointmentExists('rule_3'),
    ]),
    branch('branch_confirm', 'Confirma una cita o sus datos', [
      aiRule('rule_1', null, 'intencion_principal', 'string', 'equals', 'confirmar_cita', 'Intencion principal'),
      aiRule('rule_2', 'and', 'confianza_intencion_principal', 'number', 'greater_than', 0.85, 'Confianza de la intencion'),
      appointmentExists('rule_3'),
    ]),
    branch('branch_urgent', 'Requiere respuesta urgente', [
      aiRule('rule_1', null, 'posible_urgencia', 'boolean', 'equals', true, 'Posible urgencia'),
      aiRule('rule_2', 'and', 'confianza_posible_urgencia', 'number', 'greater_than', 0.75, 'Confianza de posible urgencia'),
    ]),
    branch('branch_needs_reply', 'Requiere respuesta de la clinica', [
      aiRule('rule_1', null, 'necesita_respuesta', 'boolean', 'equals', true, 'Necesita respuesta'),
      aiRule('rule_2', 'and', 'confianza_necesita_respuesta', 'number', 'greater_than', 0.75, 'Confianza de necesita respuesta'),
    ]),
    branch('branch_ack', 'Agradecimiento sin accion pendiente', [
      aiRule('rule_1', null, 'intencion_principal', 'string', 'equals', 'agradecimiento', 'Intencion principal'),
      aiRule('rule_2', 'and', 'confianza_intencion_principal', 'number', 'greater_than', 0.85, 'Confianza de la intencion'),
      aiRule('rule_3', 'and', 'necesita_respuesta', 'boolean', 'equals', false, 'Necesita respuesta'),
      aiRule('rule_4', 'and', 'confianza_necesita_respuesta', 'number', 'greater_than', 0.75, 'Confianza de necesita respuesta'),
    ]),
  ];
}

function buildAppointmentStatusBranches() {
  const statusRef = () => ref('context', null, 'appointment.estado', 'string', 'Estado actual de la cita');
  return [
    branch('branch_info_sent', 'Datos de cita enviados', [
      rule('rule_1', null, statusRef(), 'equals', 'info_enviada'),
    ]),
    branch('branch_reminder_sent', 'Recordatorio enviado', [
      rule('rule_1', null, statusRef(), 'equals', 'recordatorio_enviado'),
    ]),
    branch('branch_already_confirmed', 'Ya estaba confirmada', [
      rule('rule_1', null, statusRef(), 'equals', 'info_confirmada'),
      rule('rule_2', 'or', statusRef(), 'equals', 'recordatorio_confirmado'),
    ]),
  ];
}

function buildConfirmationResponseBranches() {
  return [
    branch('branch_urgent', 'Confirmacion con respuesta urgente', [
      aiRule('rule_1', null, 'posible_urgencia', 'boolean', 'equals', true, 'Posible urgencia'),
      aiRule('rule_2', 'and', 'confianza_posible_urgencia', 'number', 'greater_than', 0.75, 'Confianza de posible urgencia'),
    ]),
    branch('branch_needs_reply', 'Confirmacion con respuesta pendiente', [
      aiRule('rule_1', null, 'necesita_respuesta', 'boolean', 'equals', true, 'Necesita respuesta'),
      aiRule('rule_2', 'and', 'confianza_necesita_respuesta', 'number', 'greater_than', 0.75, 'Confianza de necesita respuesta'),
    ]),
    branch('branch_complete', 'Confirmacion sin respuesta pendiente', [
      aiRule('rule_1', null, 'necesita_respuesta', 'boolean', 'equals', false, 'Necesita respuesta'),
      aiRule('rule_2', 'and', 'confianza_necesita_respuesta', 'number', 'greater_than', 0.75, 'Confianza de necesita respuesta'),
    ]),
  ];
}

function buildFollowupAiConfig() {
  return {
    preset_key: 'custom',
    mode: 'auto',
    max_tokens: 350,
    instruction: 'Analiza exclusivamente patient_message_batch como respuesta a la pregunta de si el paciente quiere que recepcion le ayude a concertar una nueva cita. Devuelve quiere_nueva_cita=true si acepta la ayuda y false si la rechaza. No cambies el estado de la cita cancelada. Devuelve la confianza individual y un motivo breve.',
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
        description: 'Razon breve de la clasificacion',
        include_confidence: true,
      },
    ],
  };
}

function buildFollowupBranches() {
  const followupRef = (path, valueType, label) => ref('node_output', 'N24', path, valueType, label);
  return [
    branch('branch_yes', 'Quiere una cita nueva', [
      rule('rule_1', null, followupRef('quiere_nueva_cita', 'boolean', 'Quiere una cita nueva'), 'equals', true),
      rule('rule_2', 'and', followupRef('confianza_quiere_nueva_cita', 'number', 'Confianza'), 'greater_than', 0.85),
    ]),
    branch('branch_no', 'No quiere una cita nueva', [
      rule('rule_1', null, followupRef('quiere_nueva_cita', 'boolean', 'Quiere una cita nueva'), 'equals', false),
      rule('rule_2', 'and', followupRef('confianza_quiere_nueva_cita', 'number', 'Confianza'), 'greater_than', 0.85),
    ]),
  ];
}

function outputSchema(branches, fallbackLabel = 'Ninguna coincide') {
  return Object.fromEntries([
    ...branches.map((item) => [item.id, { label: item.label }]),
    ['on_else', { label: fallbackLabel }],
  ]);
}

function validateSource(source) {
  if (
    !source
    || source.public_id !== TARGET_PUBLIC_ID
    || Number(source.version) !== SOURCE_VERSION
    || source.trigger_type !== 'message_received'
    || source.clinic_id !== null
  ) {
    throw new Error('message_received_after_hours_source_mismatch');
  }
  const nodes = parseJson(source.nodes, []);
  const byId = new Map(nodes.map((item) => [item?.id, item]));
  if (
    nodes.length !== 23
    || byId.get('N1')?.type !== 'trigger/message_received'
    || byId.get('N2')?.config?.preset_key !== 'classify_intent'
  ) {
    throw new Error('message_received_after_hours_source_graph_mismatch');
  }
  return true;
}

function buildTargetNodes(source) {
  validateSource(source);
  const sourceNodes = clone(parseJson(source.nodes, []));
  const trigger = sourceNodes.find((item) => item.id === 'N1');
  trigger.position = { x: 100, y: 100 };
  trigger.outputs = { on_success: 'N2' };

  const mainBranches = buildMainBranches();
  const statusBranches = buildAppointmentStatusBranches();
  const confirmationBranches = buildConfirmationResponseBranches();
  const followupBranches = buildFollowupBranches();

  return [
    trigger,
    node('N2', 'condition/ai_analysis', buildIntentConfig(), { on_success: 'N3', on_fail: 'N90' }, 100, 280),
    node('N3', 'condition/field_check', {
      mode: 'multi_branch',
      source_ai_node_id: 'N2',
      display_label: 'Comparar resultado de N2',
      branch_rules: mainBranches,
      migration_key: SNAPSHOT_KEY,
    }, {
      branch_cancel: 'N20',
      branch_change: 'N30',
      branch_confirm: 'N40',
      branch_urgent: 'N50',
      branch_needs_reply: 'N60',
      branch_ack: null,
      on_else: 'N70',
    }, 100, 460, outputSchema(mainBranches)),

    node('N20', 'action/change_status', {
      target_entity: 'appointment',
      new_status: 'cancelada',
    }, { on_success: 'N21', on_fail: 'N91' }, -1000, 680),
    node('N21', 'action/send_system_notification', notificationConfig(
      '{{paciente.nombre}} ha cancelado su cita',
      'La cita se ha cancelado. Clinicaclick preguntará al paciente si quiere que recepción le ayude a buscar una nueva fecha.',
      { persistent: true },
    ), { on_success: 'N22' }, -1000, 840),
    node('N22', 'action/reply_message', replyConfig(REPLY_TEXTS.cancellation), { on_success: 'N23', on_fail: 'N23' }, -1000, 1000),
    node('N23', 'delay/wait_response', {
      timeout_duration: 12,
      timeout_unit: 'hours',
      listens_to_node_id: 'N22',
      response_buffer_enabled: true,
      response_buffer_delay_seconds: 90,
    }, { on_response: 'N24', on_timeout: null }, -1000, 1160),
    node('N24', 'condition/ai_analysis', buildFollowupAiConfig(), { on_success: 'N25', on_fail: 'N93' }, -1000, 1320),
    node('N25', 'condition/field_check', {
      mode: 'multi_branch',
      source_ai_node_id: 'N24',
      display_label: 'Comparar resultado de N24',
      branch_rules: followupBranches,
    }, { branch_yes: 'N26', branch_no: 'N27', on_else: 'N28' }, -1000, 1480, outputSchema(followupBranches)),
    node('N26', 'action/send_system_notification', notificationConfig(
      '{{paciente.nombre}} quiere una nueva cita',
      'Ha cancelado su cita anterior y quiere que recepción le ayude a concertar una nueva fecha. Abre la conversación para gestionarla.',
      { persistent: true, replacePreviousPersistentAlerts: true, conversationAction: 'schedule_new_appointment' },
    ), { on_success: null }, -1280, 1660),
    node('N27', 'action/reply_message', replyConfig(REPLY_TEXTS.rebookingDeclined), { on_success: null, on_fail: 'N92' }, -1000, 1660),
    node('N28', 'action/send_system_notification', notificationConfig(
      '{{paciente.nombre}} necesita respuesta',
      'No se ha podido determinar si quiere concertar una nueva cita. Revisa la conversación y responde desde la clínica.',
      { persistent: true, preferenceKey: 'automation.appointment_data.response_needs_human', replacePreviousPersistentAlerts: true },
    ), { on_success: null }, -720, 1660),

    node('N30', 'action/change_status', {
      target_entity: 'appointment',
      new_status: 'cambio_solicitado',
    }, { on_success: 'N31', on_fail: 'N91' }, -620, 680),
    node('N31', 'action/reply_message', replyConfig(REPLY_TEXTS.changeRequested), { on_success: 'N32', on_fail: 'N32' }, -620, 840),
    node('N32', 'action/send_system_notification', notificationConfig(
      '{{paciente.nombre}} quiere cambiar su cita',
      'La cita está marcada como cambio solicitado. Abre la conversación y acuerda una nueva fecha con el paciente.',
      { persistent: true },
    ), { on_success: null }, -620, 1000),

    node('N40', 'condition/field_check', {
      mode: 'multi_branch',
      display_label: '¿Que esta confirmando?',
      branch_rules: statusBranches,
    }, {
      branch_info_sent: 'N41',
      branch_reminder_sent: 'N42',
      branch_already_confirmed: 'N43',
      on_else: 'N71',
    }, -240, 680, outputSchema(statusBranches, 'Estado no compatible')),
    node('N41', 'action/change_status', {
      target_entity: 'appointment',
      new_status: 'info_confirmada',
    }, { on_success: 'N43', on_fail: 'N91' }, -380, 860),
    node('N42', 'action/change_status', {
      target_entity: 'appointment',
      new_status: 'recordatorio_confirmado',
    }, { on_success: 'N43', on_fail: 'N91' }, -100, 860),
    node('N43', 'condition/field_check', {
      mode: 'multi_branch',
      source_ai_node_id: 'N2',
      display_label: '¿Queda algo por responder?',
      branch_rules: confirmationBranches,
    }, {
      branch_urgent: 'N50',
      branch_needs_reply: 'N44',
      branch_complete: 'N46',
      on_else: 'N71',
    }, -240, 1040, outputSchema(confirmationBranches, 'Revisar confirmación')),
    node('N44', 'action/reply_message', replyConfig(REPLY_TEXTS.confirmationWithQuestion), { on_success: 'N45', on_fail: 'N45' }, -240, 1220),
    node('N45', 'action/send_system_notification', notificationConfig(
      '{{paciente.nombre}} ha confirmado y necesita respuesta',
      'La confirmación ya está registrada. El paciente también ha planteado una pregunta o petición; revisa la conversación y responde desde la clínica.',
      { persistent: true, preferenceKey: 'automation.appointment_data.confirmed_with_reply' },
    ), { on_success: null }, -240, 1380),
    node('N46', 'action/reply_message', replyConfig(REPLY_TEXTS.confirmation), { on_success: null, on_fail: 'N92' }, 40, 1220),

    node('N50', 'action/reply_message', replyConfig(REPLY_TEXTS.urgent), { on_success: 'N51', on_fail: 'N51' }, 180, 680),
    node('N51', 'action/send_system_notification', notificationConfig(
      '{{paciente.nombre}} necesita respuesta urgente',
      'Ha enviado un mensaje relacionado con una situación que está ocurriendo ahora. Abre la conversación y respóndele cuanto antes.',
      { persistent: true, alertLevel: 'error' },
    ), { on_success: null }, 180, 840),

    node('N60', 'action/reply_message', replyConfig(REPLY_TEXTS.general), { on_success: 'N61', on_fail: 'N61' }, 540, 680),
    node('N61', 'action/send_system_notification', notificationConfig(
      '{{paciente.nombre}} necesita respuesta',
      'Ha escrito fuera de horario y ha planteado una pregunta o petición. Revisa la conversación y responde desde la clínica.',
      { persistent: true, preferenceKey: 'automation.appointment_data.response_needs_human' },
    ), { on_success: null }, 540, 840),

    node('N70', 'action/reply_message', replyConfig(REPLY_TEXTS.general), { on_success: 'N71', on_fail: 'N71' }, 980, 680),
    node('N71', 'action/send_system_notification', notificationConfig(
      'Revisar mensaje de {{paciente.nombre}}',
      'No hay confianza suficiente para aplicar una acción automática. Revisa la conversación antes de modificar una cita o responder al paciente.',
      { persistent: true, preferenceKey: 'automation.appointment_data.response_needs_human' },
    ), { on_success: null }, 980, 840),

    node('N90', 'action/send_system_notification', notificationConfig(
      'No se pudo analizar un mensaje',
      'Se ha producido un fallo técnico al analizar un mensaje recibido fuera de horario. Revisa la conversación manualmente.',
      { adminOnly: true },
    ), { on_success: null }, 1360, 460),
    node('N91', 'action/send_system_notification', notificationConfig(
      'No se pudo actualizar la cita',
      'Se ha producido un fallo técnico al aplicar la respuesta del paciente. Revisa la conversación y el estado de la cita.',
      { adminOnly: true },
    ), { on_success: null }, 1360, 680),
    node('N92', 'action/send_system_notification', notificationConfig(
      'No se pudo enviar una respuesta automática',
      'La respuesta preparada fuera de horario no se ha podido enviar. Revisa la conversación.',
      { adminOnly: true },
    ), { on_success: null }, 1360, 900),
    node('N93', 'action/send_system_notification', notificationConfig(
      'No se pudo analizar la respuesta sobre una nueva cita',
      'La cita permanece cancelada. Revisa manualmente si el paciente quiere concertar otra fecha.',
      { adminOnly: true },
    ), { on_success: null }, -720, 1480),
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
        throw new Error('message_received_after_hours_active_v4_mismatch');
      }
      if (existingDraft) {
        throw new Error('message_received_after_hours_v5_already_exists');
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
        throw new Error(`message_received_after_hours_v5_invalid:${JSON.stringify(validation.errors)}`);
      }

      const definition = await queryInterface.describeTable('AutomationFlowTemplatesV2');
      const now = new Date();
      await queryInterface.bulkInsert('AutomationFlowTemplatesV2', [pickExistingColumns({
        public_id: source.public_id,
        template_key: source.template_key,
        version: DRAFT_VERSION,
        engine_version: source.engine_version || 'v2',
        name: source.name,
        description: 'Agrupa los mensajes recibidos fuera de horario, clasifica su intencion y aplica solo acciones seguras sobre una unica cita.',
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
        throw new Error('message_received_after_hours_v5_insert_failed');
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
        throw new Error('message_received_after_hours_v5_no_longer_reversible');
      }
      await queryInterface.bulkDelete('AutomationFlowTemplatesV2', { id: Number(snapshot.inserted_template_id) }, { transaction });
      await queryInterface.bulkDelete(SNAPSHOT_TABLE, { snapshot_key: SNAPSHOT_KEY }, { transaction });
    });
  },

  _test: {
    ACTIVE_VERSION,
    DRAFT_VERSION,
    SNAPSHOT_KEY,
    SOURCE_VERSION,
    TARGET_PUBLIC_ID,
    buildAppointmentStatusBranches,
    buildConfirmationResponseBranches,
    buildFollowupBranches,
    buildIntentConfig,
    buildMainBranches,
    buildTargetNodes,
    validateSource,
  },
};
