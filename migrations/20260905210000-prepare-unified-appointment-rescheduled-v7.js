'use strict';

const {
  cloneConfirmAppointmentDecisionConfig,
  cloneConfirmAppointmentPresetConfig,
  CONFIRM_APPOINTMENT_DECISION_TEMPLATE,
} = require('../src/lib/automation-intent-contract');
const prepareAppointmentData = require('./20260904162000-prepare-appointment-data-confirmation-ai-v16');
const routeAppointmentData = require('./20260904170000-route-appointment-data-confirmation-v16');
const persistAppointmentDataAlerts = require('./20260904203000-persist-appointment-data-human-response-alerts-v16');
const suppressAppointmentDataReplies = require('./20260905082000-suppress-appointment-data-replies-after-human-intervention-v16');
const refineAppointmentDataAlerts = require('./20260905083000-refine-appointment-data-review-alerts-v16');

const SNAPSHOT_TABLE = 'AutomationIntentMigrationSnapshots';
const SNAPSHOT_KEY = 'unified_appointment_rescheduled_v7';
const TARGET_PUBLIC_ID = 'flw_e98572a766ab3ff3';
const PATIENT_SOURCE_PUBLIC_ID = 'flw_appointment_rescheduled_patient_request_system';
const SOURCE_VERSION = 1;
const ACTIVE_VERSION = 6;
const DRAFT_VERSION = 7;
const RESCHEDULE_REASONS = Object.freeze(['patient_request', 'clinic_schedule']);
const CATALOG_NAME = 'envio_de_datos_de_la_cita_tras_reprogramar';

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

function buildCatalogSteps(nodes) {
  return nodes.map((item, index) => ({
    id: item.id,
    name: item.id,
    type: item.type,
    order: index + 1,
    config: {},
  }));
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
  };
}

function buildOutputSchema() {
  return Object.fromEntries([
    ...CONFIRM_APPOINTMENT_DECISION_TEMPLATE.branches.map((branch) => [
      branch.id,
      { label: branch.label },
    ]),
    ['on_else', { label: CONFIRM_APPOINTMENT_DECISION_TEMPLATE.fallback_label }],
  ]);
}

function buildOriginRouter() {
  const field = {
    source: 'trigger_data',
    node_id: null,
    path: 'reschedule_reason',
    value_type: 'string',
    label: 'Quién solicitó el cambio',
  };
  const makeBranch = (id, label, value) => ({
    id,
    label,
    comparison_rules: [{
      id: 'rule_1',
      connector: null,
      left_ref: { ...field },
      operator: 'equals',
      right_value: value,
    }],
  });
  return node('N70', 'condition/field_check', {
    mode: 'multi_branch',
    display_label: '¿Quién solicitó el cambio?',
    branch_rules: [
      makeBranch('branch_patient_request', 'A petición del paciente', 'patient_request'),
      makeBranch('branch_clinic_schedule', 'Por necesidades de agenda', 'clinic_schedule'),
    ],
    migration_key: SNAPSHOT_KEY,
  }, {
    branch_patient_request: 'N72',
    branch_clinic_schedule: 'N2',
    on_else: 'N71',
  }, 100, 240, {
    branch_patient_request: { label: 'A petición del paciente' },
    branch_clinic_schedule: { label: 'Por necesidades de agenda' },
    on_else: { label: 'Motivo no reconocido' },
  });
}

function buildDecisionBranch({
  aiId,
  decisionId,
  successId,
  statusId,
  mixedStatusId,
  mixedNoticeId,
  reviewId,
  fallbackId,
  sourceStatusConfig,
  sourceReplyConfig,
  x,
  y,
}) {
  const ai = node(aiId, 'condition/ai_analysis', cloneConfirmAppointmentPresetConfig({
    mode: 'auto',
    max_tokens: 700,
    decision_template_key: CONFIRM_APPOINTMENT_DECISION_TEMPLATE.key,
    migration_key: SNAPSHOT_KEY,
  }), { on_success: decisionId, on_fail: 'N93' }, x, y);
  const decision = node(decisionId, 'condition/field_check',
    cloneConfirmAppointmentDecisionConfig(aiId, { migration_key: SNAPSHOT_KEY }),
    {
      branch_confirm_without_reply: successId,
      branch_confirm_needs_reply: mixedStatusId,
      branch_not_confirmed: reviewId,
      on_else: fallbackId,
    },
    x,
    y + 160,
    buildOutputSchema());
  const reply = node(successId, 'action/send_whatsapp', {
    ...clone(sourceReplyConfig || {}),
    suppress_if_human_replied: true,
  }, { on_success: statusId, on_fail: null }, x - 360, y + 340);
  const status = node(statusId, 'action/change_status', clone(sourceStatusConfig || {}), {
    on_success: null,
    on_fail: null,
  }, x - 360, y + 500);
  const mixedStatus = node(mixedStatusId, 'action/change_status', clone(sourceStatusConfig || {}), {
    on_success: mixedNoticeId,
    on_fail: null,
  }, x, y + 340);
  const mixedNotice = node(mixedNoticeId, 'action/send_system_notification', notificationConfig(
    '{{paciente.nombre}} ha confirmado y necesita respuesta',
    'El paciente ha confirmado los datos de la cita y también ha planteado una pregunta o petición. Revisa la conversación y respóndele desde la clínica.',
    {
      persistent: true,
      preferenceKey: 'automation.appointment_data.confirmed_with_reply',
    },
  ), { on_success: null }, x, y + 500);
  const review = node(reviewId, 'action/send_system_notification', notificationConfig(
    '{{paciente.nombre}} necesita respuesta',
    'Ha planteado una pregunta o petición, pero todavía no ha confirmado que recibió los datos de la cita. Revisa la conversación y respóndele desde la clínica.',
    {
      persistent: true,
      preferenceKey: 'automation.appointment_data.response_needs_human',
    },
  ), { on_success: null }, x + 360, y + 340);
  const fallback = node(fallbackId, 'action/send_system_notification', notificationConfig(
    'Revisión necesaria',
    'No hay confianza suficiente para aplicar automáticamente la respuesta de {{paciente.nombre}}. Revisa la conversación y la cita.',
  ), { on_success: null }, x + 720, y + 340);
  return [ai, decision, reply, status, mixedStatus, mixedNotice, review, fallback];
}

function validateSources(genericSource, patientSource) {
  if (
    !genericSource
    || genericSource.public_id !== TARGET_PUBLIC_ID
    || Number(genericSource.version) !== SOURCE_VERSION
    || genericSource.trigger_type !== 'appointment_rescheduled'
  ) {
    throw new Error('unified_appointment_rescheduled_generic_source_mismatch');
  }
  if (
    !patientSource
    || patientSource.public_id !== PATIENT_SOURCE_PUBLIC_ID
    || Number(patientSource.version) !== SOURCE_VERSION
    || patientSource.trigger_type !== 'appointment_rescheduled'
  ) {
    throw new Error('unified_appointment_rescheduled_patient_source_mismatch');
  }
  const genericNodes = parseJson(genericSource.nodes, []);
  const patientNodes = parseJson(patientSource.nodes, []);
  if (genericNodes.length !== 41 || patientNodes.length !== 14) {
    throw new Error('unified_appointment_rescheduled_source_node_count_mismatch');
  }
  const genericById = new Map(genericNodes.map((item) => [item?.id, item]));
  const patientById = new Map(patientNodes.map((item) => [item?.id, item]));
  if (
    genericById.get('N2')?.type !== 'condition/field_check'
    || genericById.get('N3')?.config?.template_name !== 'clinicaclick_confirmacion_datos_cita_reprogramada_hoy'
    || genericById.get('N4')?.config?.template_name !== 'clinicaclick_confirmacion_datos_cita_reprogramada_24'
    || genericById.get('N5')?.config?.template_name !== 'clinicaclick_confirmacion_datos_cita_reprogramada_48'
    || patientById.get('N5')?.config?.template_name !== 'clinicaclick_cita_reprogramada_peticion_paciente'
  ) {
    throw new Error('unified_appointment_rescheduled_source_graph_mismatch');
  }
  return { genericNodes, patientNodes, genericById, patientById };
}

function mergeCurrentRuntimeConfig(nodes, configSource) {
  const currentById = new Map(
    parseJson(configSource?.nodes, []).map((item) => [String(item?.id || ''), item]),
  );
  return nodes.map((item) => {
    const current = currentById.get(String(item?.id || ''));
    if (!current || current.type !== item.type) return item;
    if (item.type === 'action/send_whatsapp') {
      return {
        ...item,
        config: clone(current.config || item.config || {}),
      };
    }
    if (item.type === 'delay/wait_response') {
      return {
        ...item,
        config: {
          ...(item.config || {}),
          timeout_duration: current.config?.timeout_duration ?? item.config?.timeout_duration,
          timeout_unit: current.config?.timeout_unit || item.config?.timeout_unit,
        },
      };
    }
    return item;
  });
}

function prepareClinicBranch(genericSource, activeSource = null) {
  let nodes = prepareAppointmentData._test.prepareNodes(genericSource.nodes);
  nodes = routeAppointmentData._test.applyDecisionRouting(nodes);
  nodes = persistAppointmentDataAlerts._test.applyPersistentHumanResponseAlerts(nodes);
  nodes = suppressAppointmentDataReplies._test.enableHumanReplySuppression(nodes);
  nodes = refineAppointmentDataAlerts._test.applyReviewAlertCopy(nodes);
  if (activeSource) {
    nodes = mergeCurrentRuntimeConfig(nodes, activeSource);
  }

  const byId = new Map(nodes.map((item) => [item.id, item]));
  byId.get('N1').outputs = { on_success: 'N70' };
  byId.get('N1').position = { x: 100, y: 120 };
  byId.get('N2').outputs.on_else = 'N94';
  byId.get('N2').output_schema = {
    branch_1: { label: 'Mismo día' },
    branch_2: { label: 'Día anterior' },
    branch_3: { label: 'Con más antelación' },
    on_else: { label: 'Momento no reconocido' },
  };
  for (const id of ['N18', 'N14', 'N28', 'N24', 'N40', 'N35']) {
    byId.get(id).outputs.on_fail = 'N93';
  }
  for (const current of nodes) {
    if (current.type === 'delay/wait_response') {
      current.config = {
        ...(current.config || {}),
        response_buffer_enabled: true,
        response_buffer_delay_seconds: 90,
      };
    }
  }
  for (const id of ['N48', 'N52', 'N56', 'N60', 'N64', 'N68']) {
    const notice = byId.get(id);
    notice.config.title = '{{paciente.nombre}} ha confirmado y necesita respuesta';
    notice.config.message = 'El paciente ha confirmado los datos de la cita y también ha planteado una pregunta o petición. Revisa la conversación y respóndele desde la clínica.';
  }
  return nodes;
}

function buildPatientBranch(patientSource) {
  const sourceNodes = parseJson(patientSource.nodes, []);
  const byId = new Map(sourceNodes.map((item) => [item.id, item]));
  const firstDecision = buildDecisionBranch({
    aiId: 'N77',
    decisionId: 'N78',
    successId: 'N79',
    statusId: 'N80',
    mixedStatusId: 'N81',
    mixedNoticeId: 'N82',
    reviewId: 'N83',
    fallbackId: 'N84',
    sourceStatusConfig: byId.get('N37').config,
    sourceReplyConfig: byId.get('N36').config,
    x: -620,
    y: 980,
  });
  const secondDecision = buildDecisionBranch({
    aiId: 'N85',
    decisionId: 'N86',
    successId: 'N87',
    statusId: 'N88',
    mixedStatusId: 'N89',
    mixedNoticeId: 'N90',
    reviewId: 'N91',
    fallbackId: 'N92',
    sourceStatusConfig: byId.get('N42').config,
    sourceReplyConfig: byId.get('N41').config,
    x: -620,
    y: 1780,
  });

  return [
    node('N72', 'action/send_whatsapp', clone(byId.get('N5').config), {
      on_success: 'N73',
      on_fail: null,
    }, -620, 420),
    node('N73', 'action/change_status', clone(byId.get('N33').config), {
      on_success: 'N74',
      on_fail: null,
    }, -620, 580),
    node('N74', 'delay/wait_response', {
      ...clone(byId.get('N34').config),
      listens_to_node_id: 'N72',
      response_buffer_enabled: true,
      response_buffer_delay_seconds: 90,
    }, { on_response: 'N77', on_timeout: 'N75' }, -620, 740),
    node('N75', 'action/send_whatsapp', clone(byId.get('N39').config), {
      on_success: 'N76',
      on_fail: null,
    }, -980, 980),
    node('N76', 'delay/wait_response', {
      ...clone(byId.get('N44').config),
      listens_to_node_id: 'N75',
      response_buffer_enabled: true,
      response_buffer_delay_seconds: 90,
    }, { on_response: 'N85', on_timeout: null }, -980, 1140),
    ...firstDecision,
    ...secondDecision,
    node('N93', 'action/send_system_notification', notificationConfig(
      'No se pudo analizar la respuesta',
      'Se ha producido un fallo técnico al analizar la respuesta de {{paciente.nombre}}. La cita no se ha modificado.',
      { adminOnly: true },
    ), { on_success: null }, 520, 1780),
  ];
}

function buildTargetNodes(genericSource, patientSource, activeSource = null) {
  validateSources(genericSource, patientSource);
  return [
    ...prepareClinicBranch(genericSource, activeSource),
    buildOriginRouter(),
    node('N71', 'action/send_system_notification', notificationConfig(
      'Reprogramación pendiente de revisar',
      'No se ha reconocido quién solicitó el cambio de la cita de {{paciente.nombre}}. No se ha enviado ningún mensaje; revisa la cita y la configuración.',
      { adminOnly: true },
    ), { on_success: null }, 820, 420),
    ...buildPatientBranch(patientSource),
    node('N94', 'action/send_system_notification', notificationConfig(
      'Momento de reprogramación no reconocido',
      'No se ha podido determinar con cuánta antelación se reprogramó la cita de {{paciente.nombre}}. No se ha enviado ningún mensaje; revisa la cita.',
      { adminOnly: true },
    ), { on_success: null }, 820, 740),
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

      const genericFamily = await queryInterface.sequelize.query(
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
      const patientFamily = await queryInterface.sequelize.query(
        `SELECT * FROM AutomationFlowTemplatesV2
          WHERE public_id = :publicId
          ORDER BY version ASC
          FOR UPDATE`,
        {
          replacements: { publicId: PATIENT_SOURCE_PUBLIC_ID },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      const catalogRows = await queryInterface.sequelize.query(
        `SELECT * FROM AutomationFlowCatalog
          WHERE name = :name
          LIMIT 1
          FOR UPDATE`,
        {
          replacements: { name: CATALOG_NAME },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      const catalog = catalogRows[0] || null;
      const genericSource = genericFamily.find((row) => Number(row.version) === SOURCE_VERSION);
      const patientSource = patientFamily.find((row) => Number(row.version) === SOURCE_VERSION);
      const active = genericFamily.find((row) => Number(row.version) === ACTIVE_VERSION);
      const patientActive = patientFamily.find((row) => Number(row.is_active) === 1);
      const existingDraft = genericFamily.find((row) => Number(row.version) === DRAFT_VERSION);
      validateSources(genericSource, patientSource);
      if (!active || Number(active.is_active) !== 1) {
        throw new Error('unified_appointment_rescheduled_active_v6_mismatch');
      }
      if (!patientActive) {
        throw new Error('unified_appointment_rescheduled_patient_active_missing');
      }
      if (existingDraft) {
        throw new Error('unified_appointment_rescheduled_v7_already_exists');
      }

      const nodes = buildTargetNodes(genericSource, patientSource, active);
      const previousJobsAutoStart = process.env.JOBS_AUTO_START;
      process.env.JOBS_AUTO_START = 'false';
      let validateFlowPayloadForInternalUse;
      try {
        ({ validateFlowPayloadForInternalUse } = require('../src/controllers/automationsV2.controller'));
      } finally {
        if (previousJobsAutoStart === undefined) delete process.env.JOBS_AUTO_START;
        else process.env.JOBS_AUTO_START = previousJobsAutoStart;
      }
      const triggerConfig = { reschedule_reasons: [...RESCHEDULE_REASONS] };
      const validation = await validateFlowPayloadForInternalUse({
        entry_node_id: genericSource.entry_node_id,
        trigger_type: genericSource.trigger_type,
        trigger_config: triggerConfig,
        nodes,
      });
      if (!validation.ok) {
        throw new Error(`unified_appointment_rescheduled_v7_invalid:${JSON.stringify(validation.errors)}`);
      }

      const definition = await queryInterface.describeTable('AutomationFlowTemplatesV2');
      const now = new Date();
      await queryInterface.bulkInsert('AutomationFlowTemplatesV2', [pickExistingColumns({
        public_id: genericSource.public_id,
        template_key: genericSource.template_key,
        version: DRAFT_VERSION,
        engine_version: genericSource.engine_version || 'v2',
        name: genericSource.name,
        description: 'Envía los datos de una cita reprogramada con un mensaje distinto según quién solicitó el cambio y confirma su recepción.',
        trigger_type: genericSource.trigger_type,
        trigger_config: JSON.stringify(triggerConfig),
        is_active: false,
        is_system: true,
        clinic_id: genericSource.clinic_id,
        group_id: genericSource.group_id,
        entry_node_id: genericSource.entry_node_id,
        nodes: JSON.stringify(nodes),
        published_at: null,
        published_by: genericSource.published_by || genericSource.created_by,
        created_by: genericSource.created_by,
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
        throw new Error('unified_appointment_rescheduled_v7_insert_failed');
      }

      await queryInterface.sequelize.query(
        `UPDATE AutomationFlowTemplatesV2
            SET is_active = 0, updated_at = :now
          WHERE public_id IN (:targetPublicId, :patientPublicId)`,
        {
          replacements: {
            now,
            targetPublicId: TARGET_PUBLIC_ID,
            patientPublicId: PATIENT_SOURCE_PUBLIC_ID,
          },
          transaction,
        },
      );
      await queryInterface.sequelize.query(
        `UPDATE AutomationFlowTemplatesV2
            SET is_active = 1, published_at = :now, updated_at = :now
          WHERE id = :id`,
        {
          replacements: { id: Number(inserted.id), now },
          transaction,
        },
      );
      if (catalog) {
        await queryInterface.sequelize.query(
          `UPDATE AutomationFlowCatalog
              SET template_key = :templateKey,
                  template_version = :templateVersion,
                  steps = :steps,
                  description = :description,
                  updated_at = :now
            WHERE id = :id`,
          {
            replacements: {
              id: Number(catalog.id),
              templateKey: TARGET_PUBLIC_ID,
              templateVersion: DRAFT_VERSION,
              steps: JSON.stringify(buildCatalogSteps(nodes)),
              description: 'Envía los datos de una cita reprogramada con un mensaje distinto según quién solicitó el cambio y confirma su recepción.',
              now,
            },
            transaction,
          },
        );
      }

      await queryInterface.bulkInsert(SNAPSHOT_TABLE, [{
        snapshot_key: SNAPSHOT_KEY,
        payload: JSON.stringify({
          inserted_template_id: Number(inserted.id),
          generic_source_template_id: Number(genericSource.id),
          patient_source_template_id: Number(patientSource.id),
          active_template_id: Number(active.id),
          patient_active_template_id: Number(patientActive.id),
          catalog: catalog ? {
            id: Number(catalog.id),
            template_key: catalog.template_key,
            template_version: catalog.template_version,
            steps: parseJson(catalog.steps, []),
            description: catalog.description,
          } : null,
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
          Number(target.execution_count) !== 0
        )
      ) {
        throw new Error('unified_appointment_rescheduled_v7_no_longer_reversible');
      }
      await queryInterface.sequelize.query(
        `UPDATE AutomationFlowTemplatesV2
            SET is_active = 0, published_at = NULL, updated_at = :now
          WHERE id = :id`,
        {
          replacements: { id: Number(snapshot.inserted_template_id), now: new Date() },
          transaction,
        },
      );
      await queryInterface.sequelize.query(
        `UPDATE AutomationFlowTemplatesV2
            SET is_active = CASE
                  WHEN id IN (:genericActiveId, :patientActiveId) THEN 1
                  ELSE 0
                END,
                updated_at = :now
          WHERE public_id IN (:targetPublicId, :patientPublicId)`,
        {
          replacements: {
            genericActiveId: Number(snapshot.active_template_id),
            patientActiveId: Number(snapshot.patient_active_template_id),
            targetPublicId: TARGET_PUBLIC_ID,
            patientPublicId: PATIENT_SOURCE_PUBLIC_ID,
            now: new Date(),
          },
          transaction,
        },
      );
      if (snapshot.catalog?.id) {
        await queryInterface.sequelize.query(
          `UPDATE AutomationFlowCatalog
              SET template_key = :templateKey,
                  template_version = :templateVersion,
                  steps = :steps,
                  description = :description,
                  updated_at = :now
            WHERE id = :id`,
          {
            replacements: {
              id: Number(snapshot.catalog.id),
              templateKey: snapshot.catalog.template_key,
              templateVersion: snapshot.catalog.template_version,
              steps: JSON.stringify(snapshot.catalog.steps || []),
              description: snapshot.catalog.description,
              now: new Date(),
            },
            transaction,
          },
        );
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
    CATALOG_NAME,
    DRAFT_VERSION,
    PATIENT_SOURCE_PUBLIC_ID,
    RESCHEDULE_REASONS,
    SNAPSHOT_KEY,
    SOURCE_VERSION,
    TARGET_PUBLIC_ID,
    buildOriginRouter,
    buildCatalogSteps,
    buildPatientBranch,
    buildTargetNodes,
    mergeCurrentRuntimeConfig,
    prepareClinicBranch,
    validateSources,
  },
};
