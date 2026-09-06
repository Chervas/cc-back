'use strict';

const SNAPSHOT_TABLE = 'AutomationIntentMigrationSnapshots';
const SNAPSHOT_KEY = 'review_request_v4';
const TARGET_PUBLIC_ID = 'flw_review_request_system';
const SOURCE_VERSION = 2;
const DRAFT_VERSION = 4;

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

function ref(path, valueType, label) {
  return {
    source: 'node_output',
    node_id: 'N5',
    path,
    value_type: valueType,
    label,
  };
}

function rule(id, connector, path, valueType, operator, rightValue, label) {
  return {
    id,
    connector,
    left_ref: ref(path, valueType, label),
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

function buildReviewAnalysisConfig() {
  return {
    preset_key: 'review_response_classifier',
    preset_contract_version: 1,
    mode: 'quick_qa',
    max_tokens: 240,
    instruction: 'Interpreta exclusivamente patient_message_batch como respuesta a una solicitud de valoración de la clínica. Distingue una valoración de 1 a 5, una solicitud de baja comercial, un número equivocado, el rechazo a dejar una reseña o una respuesta no concluyente. No inventes una puntuación ni uses mensajes anteriores como si fueran la respuesta actual. Devuelve exactamente los campos solicitados y un motivo breve.',
    context_sources: [
      { key: 'patient_message_batch', path: '{{last_response_context}}' },
    ],
    output_fields: [
      {
        name: 'response_intent',
        type: 'string',
        description: 'Tipo de respuesta del paciente a la solicitud de valoración.',
        allowed_values: ['rating', 'marketing_opt_out', 'wrong_recipient', 'review_refusal', 'ambiguous'],
      },
      {
        name: 'response_rating',
        type: 'number',
        description: 'Valoración entera de 1 a 5; devuelve 0 cuando no exista una valoración clara.',
      },
      {
        name: 'confidence',
        type: 'number',
        description: 'Confianza de la clasificación entre 0 y 1.',
      },
      {
        name: 'reason',
        type: 'string',
        description: 'Motivo breve de la clasificación sin información clínica innecesaria.',
      },
    ],
  };
}

function buildReviewBranches(threshold) {
  return [
    branch('branch_public_review', 'Valoración 5/5', [
      rule('rule_1', null, 'response_intent', 'string', 'equals', 'rating', 'Tipo de respuesta'),
      rule('rule_2', 'and', 'response_rating', 'number', 'greater_than_or_equals', threshold, 'Valoración'),
      rule('rule_3', 'and', 'confidence', 'number', 'greater_than', 0.85, 'Confianza'),
    ]),
    branch('branch_private_feedback', 'Valoración de 1 a 4', [
      rule('rule_1', null, 'response_intent', 'string', 'equals', 'rating', 'Tipo de respuesta'),
      rule('rule_2', 'and', 'response_rating', 'number', 'greater_than_or_equals', 1, 'Valoración'),
      rule('rule_3', 'and', 'response_rating', 'number', 'less_than', threshold, 'Valoración'),
      rule('rule_4', 'and', 'confidence', 'number', 'greater_than', 0.85, 'Confianza'),
    ]),
    branch('branch_marketing_opt_out', 'Solicita no recibir más mensajes', [
      rule('rule_1', null, 'response_intent', 'string', 'equals', 'marketing_opt_out', 'Tipo de respuesta'),
      rule('rule_2', 'and', 'confidence', 'number', 'greater_than', 0.85, 'Confianza'),
    ]),
    branch('branch_wrong_recipient', 'Número equivocado', [
      rule('rule_1', null, 'response_intent', 'string', 'equals', 'wrong_recipient', 'Tipo de respuesta'),
      rule('rule_2', 'and', 'confidence', 'number', 'greater_than', 0.85, 'Confianza'),
    ]),
    branch('branch_review_refusal', 'No quiere dejar una reseña', [
      rule('rule_1', null, 'response_intent', 'string', 'equals', 'review_refusal', 'Tipo de respuesta'),
      rule('rule_2', 'and', 'confidence', 'number', 'greater_than', 0.85, 'Confianza'),
    ]),
    branch('branch_ambiguous', 'Respuesta no concluyente', [
      rule('rule_1', null, 'response_intent', 'string', 'equals', 'ambiguous', 'Tipo de respuesta'),
    ]),
  ];
}

function outputSchema(branches) {
  return Object.fromEntries([
    ...branches.map((item) => [item.id, { label: item.label }]),
    ['on_else', { label: 'Revisión necesaria' }],
  ]);
}

function notificationConfig(title, message, adminOnly = false) {
  return {
    title,
    message,
    assignee_type: 'role',
    assignee_id: adminOnly ? 'admin' : ['personaldeclinica', 'admin'],
    subrole: adminOnly ? null : 'Recepcion / Comercial ventas',
    display_mode: 'inbox',
    alert_level: 'warning',
  };
}

function validateSource(source) {
  if (
    !source
    || source.public_id !== TARGET_PUBLIC_ID
    || Number(source.version) !== SOURCE_VERSION
    || source.trigger_type !== 'appointment_completed'
    || source.clinic_id !== null
  ) {
    throw new Error('review_request_source_mismatch');
  }
  const nodes = parseJson(source.nodes, []);
  const byId = new Map(nodes.map((item) => [item?.id, item]));
  if (
    nodes.length !== 10
    || byId.get('N1')?.type !== 'trigger/appointment_completed'
    || byId.get('N3')?.type !== 'action/request_review'
    || byId.get('N5')?.type !== 'condition/field_check'
  ) {
    throw new Error('review_request_source_graph_mismatch');
  }
  return true;
}

function buildTargetNodes(source) {
  validateSource(source);
  const sourceNodes = clone(parseJson(source.nodes, []));
  const byId = new Map(sourceNodes.map((item) => [item.id, item]));
  const request = byId.get('N3');
  const threshold = Number(request?.config?.review_threshold || 5) || 5;
  const branches = buildReviewBranches(threshold);

  return [
    node('N1', 'trigger/appointment_completed', byId.get('N1').config, { on_success: 'N2' }, 100, 100),
    node('N2', 'delay/fixed', byId.get('N2').config, { on_complete: 'N3' }, 100, 260),
    node('N3', 'action/request_review', request.config, { on_success: 'N4', on_fail: 'N90' }, 100, 420),
    node('N4', 'delay/wait_response', byId.get('N4').config, { on_response: 'N5', on_timeout: 'N20' }, 100, 580),
    node('N5', 'condition/ai_analysis', buildReviewAnalysisConfig(), { on_success: 'N6', on_fail: 'N90' }, 100, 760),
    node('N6', 'condition/field_check', {
      mode: 'multi_branch',
      source_ai_node_id: 'N5',
      display_label: 'Comparar respuesta a la solicitud de reseña',
      fallback_label: 'Revisión necesaria',
      branch_rules: branches,
    }, {
      branch_public_review: 'N8',
      branch_private_feedback: 'N9',
      branch_marketing_opt_out: 'N10',
      branch_wrong_recipient: 'N11',
      branch_review_refusal: 'N12',
      branch_ambiguous: 'N13',
      on_else: 'N13',
    }, 100, 1080, outputSchema(branches)),

    node('N8', 'action/review_followup', { followup_kind: 'google_review', review_threshold: threshold }, { on_success: 'N15', on_fail: 'N90' }, -980, 1280),
    node('N9', 'action/review_followup', { followup_kind: 'private_feedback', review_threshold: threshold }, { on_success: 'N16', on_fail: 'N90' }, -620, 1280),
    node('N10', 'action/unsubscribe_communications', {
      communication_scope: 'marketing',
    }, { on_success: 'N14', on_fail: 'N90' }, -260, 1280),
    node('N11', 'action/process_review_response_classification', {
      source_node_id: 'N5', effect_intents: ['wrong_recipient'],
    }, { on_success: 'N18', on_fail: 'N90' }, 100, 1280),
    node('N12', 'action/process_review_response_classification', {
      source_node_id: 'N5', effect_intents: ['review_refusal'],
    }, { on_success: 'N19', on_fail: 'N90' }, 460, 1280),
    node('N13', 'action/send_system_notification', notificationConfig(
      'Revisar respuesta de {{paciente.nombre}} a la solicitud de reseña',
      'No se ha podido interpretar la respuesta con confianza suficiente. Revisa la conversación; no se ha enviado ningún seguimiento de reseña.',
    ), { on_success: 'N17' }, 820, 1280),
    node('N14', 'control/end', {}, {}, -260, 1440),
    node('N15', 'control/end', {}, {}, -980, 1440),
    node('N16', 'control/end', {}, {}, -620, 1440),
    node('N17', 'control/end', {}, {}, 820, 1440),
    node('N18', 'control/end', {}, {}, 100, 1440),
    node('N19', 'control/end', {}, {}, 460, 1440),

    node('N20', 'action/request_review_reminder', byId.get('N9').config, { on_success: 'N21', on_fail: 'N90' }, 620, 760),
    node('N21', 'delay/wait_response', byId.get('N10').config, { on_response: 'N5', on_timeout: 'N22' }, 620, 920),
    node('N22', 'action/review_no_response', byId.get('N12').config, { on_success: null }, 620, 1080),

    node('N90', 'action/send_system_notification', notificationConfig(
      'No se pudo completar la automatización de reseña',
      'Se ha producido un fallo técnico al solicitar, interpretar o responder la valoración del paciente. Revisa la ejecución y la conversación.',
      true,
    ), { on_success: null }, 1180, 920),
  ];
}

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const snapshots = await queryInterface.sequelize.query(
        `SELECT snapshot_key FROM ${SNAPSHOT_TABLE} WHERE snapshot_key = :snapshotKey LIMIT 1`,
        {
          replacements: { snapshotKey: SNAPSHOT_KEY },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      if (snapshots.length) return;

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
      const existingDraft = family.find((row) => Number(row.version) === DRAFT_VERSION);
      validateSource(source);
      if (existingDraft) throw new Error('review_request_v4_already_exists');

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
        throw new Error(`review_request_v4_invalid:${JSON.stringify(validation.errors)}`);
      }

      const definition = await queryInterface.describeTable('AutomationFlowTemplatesV2');
      const now = new Date();
      await queryInterface.bulkInsert('AutomationFlowTemplatesV2', [pickExistingColumns({
        public_id: source.public_id,
        template_key: source.template_key,
        version: DRAFT_VERSION,
        engine_version: source.engine_version || 'v2',
        name: 'Solicitar reseña tras cita completada',
        description: 'Espera tras completar la cita, solicita una valoración e interpreta cualquier respuesta con una salida modular antes de decidir el seguimiento.',
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

      const inserted = await queryInterface.sequelize.query(
        `SELECT id, is_active, published_at FROM AutomationFlowTemplatesV2
          WHERE public_id = :publicId AND version = :version LIMIT 1`,
        {
          replacements: { publicId: TARGET_PUBLIC_ID, version: DRAFT_VERSION },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      if (!inserted[0] || Number(inserted[0].is_active) !== 0 || inserted[0].published_at !== null) {
        throw new Error('review_request_v4_insert_failed');
      }

      await queryInterface.bulkInsert(SNAPSHOT_TABLE, [{
        snapshot_key: SNAPSHOT_KEY,
        payload: JSON.stringify({ inserted_template_id: Number(inserted[0].id), source_template_id: Number(source.id) }),
        created_at: now,
        updated_at: now,
      }], { transaction });
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const rows = await queryInterface.sequelize.query(
        `SELECT payload FROM ${SNAPSHOT_TABLE} WHERE snapshot_key = :snapshotKey LIMIT 1`,
        {
          replacements: { snapshotKey: SNAPSHOT_KEY },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      const snapshot = parseJson(rows[0]?.payload, null);
      if (!snapshot?.inserted_template_id) return;
      const templates = await queryInterface.sequelize.query(
        `SELECT template.id, template.is_active, template.published_at,
                (SELECT COUNT(*) FROM FlowExecutionsV2 execution WHERE execution.template_version_id = template.id) AS execution_count
           FROM AutomationFlowTemplatesV2 template WHERE template.id = :id FOR UPDATE`,
        {
          replacements: { id: Number(snapshot.inserted_template_id) },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      const target = templates[0];
      if (target && (Number(target.is_active) !== 0 || target.published_at !== null || Number(target.execution_count) !== 0)) {
        throw new Error('review_request_v4_no_longer_reversible');
      }
      await queryInterface.bulkDelete('AutomationFlowTemplatesV2', { id: Number(snapshot.inserted_template_id) }, { transaction });
      await queryInterface.bulkDelete(SNAPSHOT_TABLE, { snapshot_key: SNAPSHOT_KEY }, { transaction });
    });
  },

  _test: {
    DRAFT_VERSION,
    SNAPSHOT_KEY,
    SOURCE_VERSION,
    TARGET_PUBLIC_ID,
    buildReviewAnalysisConfig,
    buildReviewBranches,
    buildTargetNodes,
    validateSource,
  },
};
