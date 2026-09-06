'use strict';

const SNAPSHOT_TABLE = 'AutomationIntentMigrationSnapshots';
const SNAPSHOT_KEY = 'appointment_data_confirmation_v16_review_alert_copy';
const TARGET_PUBLIC_ID = 'flw_fc01d1d9647df069';
const TARGET_VERSION = 16;
const REVIEW_NODE_IDS = Object.freeze(['N21', 'N16', 'N31', 'N32', 'N43', 'N38']);
const OLD_TITLE = 'Confirmación inconclusa';
const OLD_MESSAGE = 'El paciente {{paciente.nombre}} no ha confirmado claramente la cita o propone otra disponibilidad. Revisa la conversación y responde desde la clínica.';
const NEW_TITLE = '{{paciente.nombre}} necesita respuesta';
const NEW_MESSAGE = 'Ha planteado una pregunta o petición, pero todavía no ha confirmado que recibió los datos de la cita. Revisa la conversación y respóndele desde la clínica.';
const RENDERED_OLD_MESSAGE = /^El paciente (.+) no ha confirmado claramente la cita o propone otra disponibilidad\. Revisa la conversación y responde desde la clínica\.$/;

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

function applyReviewAlertCopy(inputNodes) {
  const nodes = clone(inputNodes);
  if (!Array.isArray(nodes)) {
    throw new Error('appointment_data_confirmation_v16_review_copy_nodes_invalid');
  }
  const byId = new Map(nodes.map((node) => [node?.id, node]));
  for (const id of REVIEW_NODE_IDS) {
    const node = byId.get(id);
    if (
      node?.type !== 'action/send_system_notification'
      || node?.config?.title !== OLD_TITLE
      || node?.config?.message !== OLD_MESSAGE
      || node?.config?.display_mode !== 'persistent_alert'
    ) {
      throw new Error(`appointment_data_confirmation_v16_review_copy_node_mismatch:${id}`);
    }
    node.config = {
      ...(node.config || {}),
      title: NEW_TITLE,
      message: NEW_MESSAGE,
    };
  }
  return nodes;
}

function renderExistingAlert(title, message) {
  const match = String(message || '').match(RENDERED_OLD_MESSAGE);
  if (String(title || '') !== OLD_TITLE || !match) return null;
  return {
    title: `${match[1]} necesita respuesta`,
    message: NEW_MESSAGE,
  };
}

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const existing = await queryInterface.sequelize.query(
        `SELECT snapshot_key FROM ${SNAPSHOT_TABLE} WHERE snapshot_key = :snapshotKey LIMIT 1`,
        {
          replacements: { snapshotKey: SNAPSHOT_KEY },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      if (existing.length) return;

      const rows = await queryInterface.sequelize.query(
        `SELECT id, nodes, is_active, published_at
           FROM AutomationFlowTemplatesV2
          WHERE public_id = :publicId AND version = :version
          FOR UPDATE`,
        {
          replacements: { publicId: TARGET_PUBLIC_ID, version: TARGET_VERSION },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      const target = rows[0];
      if (!target || Number(target.is_active) !== 0 || target.published_at !== null) {
        throw new Error('appointment_data_confirmation_v16_review_copy_requires_draft');
      }

      const originalNodes = parseJson(target.nodes, []);
      const updatedNodes = applyReviewAlertCopy(originalNodes);
      const renderedNotifications = await queryInterface.sequelize.query(
        `SELECT notification.id, notification.title, notification.message
           FROM Notifications notification
           JOIN FlowExecutionsV2 execution
             ON execution.id = CAST(JSON_UNQUOTE(JSON_EXTRACT(notification.data, '$.execution_id')) AS UNSIGNED)
          WHERE execution.template_version_id = :templateId
            AND notification.is_read = 0
            AND JSON_UNQUOTE(JSON_EXTRACT(notification.data, '$.node_id')) IN (:nodeIds)
          FOR UPDATE`,
        {
          replacements: { templateId: Number(target.id), nodeIds: REVIEW_NODE_IDS },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      const notificationSnapshots = [];
      for (const notification of renderedNotifications) {
        const replacement = renderExistingAlert(notification.title, notification.message);
        if (!replacement) continue;
        notificationSnapshots.push({
          id: Number(notification.id),
          title: notification.title,
          message: notification.message,
        });
        await queryInterface.bulkUpdate(
          'Notifications',
          replacement,
          { id: Number(notification.id), is_read: false },
          { transaction },
        );
      }

      const now = new Date();
      await queryInterface.bulkInsert(SNAPSHOT_TABLE, [{
        snapshot_key: SNAPSHOT_KEY,
        payload: JSON.stringify({
          target_template_id: Number(target.id),
          original_nodes: originalNodes,
          notifications: notificationSnapshots,
        }),
        created_at: now,
        updated_at: now,
      }], { transaction });
      await queryInterface.bulkUpdate(
        'AutomationFlowTemplatesV2',
        { nodes: JSON.stringify(updatedNodes), updated_at: now },
        { id: Number(target.id), is_active: false, published_at: null },
        { transaction },
      );
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
      if (!snapshot?.target_template_id || !Array.isArray(snapshot.original_nodes)) return;

      const targets = await queryInterface.sequelize.query(
        `SELECT id, is_active, published_at
           FROM AutomationFlowTemplatesV2
          WHERE id = :id
          FOR UPDATE`,
        {
          replacements: { id: Number(snapshot.target_template_id) },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      const target = targets[0];
      if (target && (Number(target.is_active) !== 0 || target.published_at !== null)) {
        throw new Error('appointment_data_confirmation_v16_review_copy_no_longer_reversible');
      }

      await queryInterface.bulkUpdate(
        'AutomationFlowTemplatesV2',
        { nodes: JSON.stringify(snapshot.original_nodes), updated_at: new Date() },
        { id: Number(snapshot.target_template_id), is_active: false, published_at: null },
        { transaction },
      );
      for (const notification of snapshot.notifications || []) {
        await queryInterface.bulkUpdate(
          'Notifications',
          { title: notification.title, message: notification.message },
          { id: Number(notification.id), is_read: false },
          { transaction },
        );
      }
      await queryInterface.bulkDelete(SNAPSHOT_TABLE, { snapshot_key: SNAPSHOT_KEY }, { transaction });
    });
  },

  _test: {
    NEW_MESSAGE,
    NEW_TITLE,
    REVIEW_NODE_IDS,
    applyReviewAlertCopy,
    renderExistingAlert,
  },
};
