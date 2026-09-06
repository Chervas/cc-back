'use strict';

const SNAPSHOT_TABLE = 'AutomationIntentMigrationSnapshots';
const SNAPSHOT_KEY = 'appointment_data_confirmation_ai_v16';
const TARGET_PUBLIC_ID = 'flw_fc01d1d9647df069';
const SOURCE_VERSION = 15;
const DRAFT_VERSION = 16;
const AI_NODE_IDS = new Set(['N18', 'N14', 'N28', 'N24', 'N40', 'N35']);

const CONFIRM_APPOINTMENT_CONFIG = Object.freeze({
  preset_key: 'confirm_appointment',
  preset_contract_version: 2,
  routing_pending_review: true,
  instruction: 'Analiza exclusivamente patient_message_batch como la respuesta nueva del paciente a la petición de confirmación del último mensaje de la clínica sobre una cita. El propio patient_message_batch incluye el mensaje concreto de la clínica al que responde el paciente; usa appointment y trigger únicamente como contexto de esa cita. No uses mensajes anteriores de la conversación ni atribuyas al lote preguntas o comentarios previos. Primero identifica qué pidió confirmar la clínica. Si preguntó si el paciente asistirá, confirma_asistencia=true significa que acepta asistir. Si preguntó si recibió el mensaje o los datos de la cita enviados al agendarla, confirma_asistencia=true significa que confirma esa recepción, sin afirmar por ello que asistirá. Evalúa confirma_asistencia y requiere_respuesta de forma independiente recorriendo todo el lote: una pregunta o petición posterior nunca borra una confirmación explícita anterior, salvo que exista una contradicción posterior. Ejemplos obligatorios: "sí, lo he recibido, ¿tengo que llevar algo?" devuelve confirma_asistencia=true y requiere_respuesta=true; "¿tengo que llevar algo?" sin afirmación previa en el lote devuelve confirma_asistencia=false y requiere_respuesta=true; "gracias", "ok", "vale" o "recibido" como respuesta directa a una petición clara de confirmar recepción devuelve confirma_asistencia=true y requiere_respuesta=false. Una respuesta breve afirmativa, un agradecimiento, un acuse o una reacción positiva como 👍, ❤️, ✅, ok, vale, gracias o recibido confirma únicamente si responde directamente a cualquiera de esas peticiones y no existe una contradicción. Si patient_message_batch indica response_message_type=reaction y contiene una reacción positiva vinculada al mensaje de confirmación, devuelve confirma_asistencia=true y requiere_respuesta=false: la reacción es el acuse, no una pregunta ni una petición. Devuelve confirma_asistencia=false cuando no confirma lo que la clínica preguntó, lo rechaza, solicita cambiar la cita, expresa dudas, todavía no puede confirmar, solo hace una pregunta o responde sobre otro asunto. Evalúa por separado requiere_respuesta: devuelve true únicamente si el lote contiene una pregunta, petición concreta o comentario que exige una actuación o contestación de la clínica. Si dudas de que no haga falta contestar, devuelve requiere_respuesta=true para conservar la revisión humana. Devuelve requiere_respuesta=false para agradecimientos, saludos, confirmaciones, acuses de recibo o comentarios de cortesía sin pregunta ni petición, aunque una persona pudiera responder por educación. Un mensaje compuesto como "confirmo, ¿tengo que llevar algo?" sí requiere respuesta; "gracias", "ok gracias", "recibido" o una reacción positiva aislada no. La confianza de cada campo mide la certeza de que el valor concreto devuelto es correcto: si un booleano es false y estás seguro de ese false, su confianza debe ser alta. No uses la confianza como probabilidad de que el booleano sea true. No clasifiques el tipo de cancelación o cambio ni ejecutes acciones. Devuelve exactamente los campos solicitados, la confianza individual de cada campo y un motivo breve.',
  context_sources: [
    { key: 'patient_message_batch', path: '{{last_response_context}}' },
    { key: 'appointment', path: '{{appointment}}' },
    { key: 'trigger', path: '{{trigger.data}}' },
  ],
  output_fields: [
    {
      name: 'confirma_asistencia',
      type: 'boolean',
      description: 'Indica si el paciente confirma de forma clara lo que preguntó la clínica: asistencia cuando se pidió confirmar que acudirá, o recepción cuando se pidió confirmar los datos enviados. Una pregunta aislada sin afirmación en el lote devuelve false; conserva un true explícito aunque después añada una pregunta, salvo contradicción',
      include_confidence: true,
    },
    {
      name: 'requiere_respuesta',
      type: 'boolean',
      description: 'Devuelve true si el paciente formula una pregunta, petición concreta o comentario que exige actuación o respuesta, y también si existe duda sobre si hace falta contestar; devuelve false solo para gracias, saludos, confirmaciones, acuses o reacciones positivas aisladas sin ninguna petición pendiente',
      include_confidence: true,
    },
    {
      name: 'motivo',
      type: 'string',
      description: 'Explica brevemente qué parte de la respuesta justifica ambos resultados, sin datos clínicos innecesarios',
      include_confidence: true,
    },
  ],
});

function parseJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function cloneConfig(config) {
  return {
    ...config,
    context_sources: CONFIRM_APPOINTMENT_CONFIG.context_sources.map((source) => ({ ...source })),
    output_fields: CONFIRM_APPOINTMENT_CONFIG.output_fields.map((field) => ({ ...field })),
  };
}

function prepareNodes(rawNodes) {
  const nodes = parseJson(rawNodes, []);
  if (!Array.isArray(nodes) || nodes.length !== 41) {
    throw new Error('appointment_data_confirmation_source_node_count_mismatch');
  }

  let changed = 0;
  const prepared = nodes.map((node) => {
    if (!AI_NODE_IDS.has(node?.id)) return node;
    if (
      node?.type !== 'condition/ai_analysis'
      || node?.config?.preset_key !== 'confirm_appointment'
    ) {
      throw new Error(`appointment_data_confirmation_ai_node_mismatch:${node?.id || 'missing'}`);
    }
    changed += 1;
    return {
      ...node,
      config: cloneConfig({
        ...(node.config || {}),
        ...CONFIRM_APPOINTMENT_CONFIG,
      }),
    };
  });

  if (changed !== AI_NODE_IDS.size) {
    throw new Error('appointment_data_confirmation_ai_node_count_mismatch');
  }
  return prepared;
}

function validateSource(source) {
  if (
    !source
    || source.public_id !== TARGET_PUBLIC_ID
    || Number(source.version) !== SOURCE_VERSION
    || Number(source.is_active) !== 0
    || !source.published_at
    || source.template_key !== 'env_o_de_datos_de_la_cita_tras_agendar'
    || source.trigger_type !== 'appointment_created'
  ) {
    throw new Error('appointment_data_confirmation_source_mismatch');
  }
  prepareNodes(source.nodes);
}

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const snapshots = await queryInterface.sequelize.query(
        `SELECT payload FROM ${SNAPSHOT_TABLE} WHERE snapshot_key = :snapshotKey LIMIT 1`,
        {
          replacements: { snapshotKey: SNAPSHOT_KEY },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      if (snapshots.length) return;

      const rows = await queryInterface.sequelize.query(
        `SELECT *
           FROM AutomationFlowTemplatesV2
          WHERE public_id = :publicId
            AND version IN (:activeVersion, :sourceVersion, :draftVersion)
          FOR UPDATE`,
        {
          replacements: {
            publicId: TARGET_PUBLIC_ID,
            activeVersion: 14,
            sourceVersion: SOURCE_VERSION,
            draftVersion: DRAFT_VERSION,
          },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      const active = rows.find((row) => Number(row.version) === 14);
      const source = rows.find((row) => Number(row.version) === SOURCE_VERSION);
      const existingDraft = rows.find((row) => Number(row.version) === DRAFT_VERSION);
      if (!active || Number(active.is_active) !== 1) {
        throw new Error('appointment_data_confirmation_active_v14_mismatch');
      }
      validateSource(source);
      if (existingDraft) {
        throw new Error('appointment_data_confirmation_v16_already_exists');
      }

      const now = new Date();
      const preparedNodes = prepareNodes(source.nodes);
      await queryInterface.bulkInsert('AutomationFlowTemplatesV2', [{
        public_id: source.public_id,
        template_key: source.template_key,
        version: DRAFT_VERSION,
        engine_version: source.engine_version,
        name: source.name,
        description: source.description,
        trigger_type: source.trigger_type,
        trigger_config: source.trigger_config == null
          ? null
          : JSON.stringify(parseJson(source.trigger_config, {})),
        is_active: false,
        is_system: source.is_system,
        clinic_id: source.clinic_id,
        group_id: source.group_id,
        entry_node_id: source.entry_node_id,
        nodes: JSON.stringify(preparedNodes),
        published_at: null,
        published_by: null,
        created_by: source.created_by,
        created_at: now,
        updated_at: now,
      }], { transaction });

      const insertedRows = await queryInterface.sequelize.query(
        `SELECT id, version, is_active, published_at
           FROM AutomationFlowTemplatesV2
          WHERE public_id = :publicId AND version = :draftVersion
          LIMIT 1`,
        {
          replacements: { publicId: TARGET_PUBLIC_ID, draftVersion: DRAFT_VERSION },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      const inserted = insertedRows[0];
      if (
        !inserted
        || Number(inserted.is_active) !== 0
        || inserted.published_at !== null
      ) {
        throw new Error('appointment_data_confirmation_v16_insert_failed');
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
        `SELECT t.id, t.is_active, t.published_at,
                COUNT(e.id) AS execution_count
           FROM AutomationFlowTemplatesV2 t
           LEFT JOIN FlowExecutionsV2 e ON e.template_version_id = t.id
          WHERE t.id = :id
          GROUP BY t.id, t.is_active, t.published_at
          FOR UPDATE`,
        {
          replacements: { id: Number(snapshot.inserted_template_id) },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      const row = rows[0];
      if (
        row
        && (
          Number(row.is_active) !== 0
          || row.published_at !== null
          || Number(row.execution_count) !== 0
        )
      ) {
        throw new Error('appointment_data_confirmation_v16_no_longer_disposable');
      }
      await queryInterface.bulkDelete(
        'AutomationFlowTemplatesV2',
        { id: Number(snapshot.inserted_template_id) },
        { transaction },
      );
      await queryInterface.bulkDelete(
        SNAPSHOT_TABLE,
        { snapshot_key: SNAPSHOT_KEY },
        { transaction },
      );
    });
  },

  _test: {
    AI_NODE_IDS,
    CONFIRM_APPOINTMENT_CONFIG,
    DRAFT_VERSION,
    SNAPSHOT_KEY,
    SOURCE_VERSION,
    TARGET_PUBLIC_ID,
    prepareNodes,
    validateSource,
  },
};
