'use strict';

const OLD_TEMPLATE_MESSAGE = 'El paciente {{paciente.nombre}} tiene cita ahora, pero no queda claro que la haya confirmado';
const NEW_TEMPLATE_MESSAGE = 'El paciente {{paciente.nombre}} no ha confirmado claramente la cita o propone otra disponibilidad. Revisa la conversación y responde desde la clínica.';

const OLD_NOTIFICATION_REGEX = /^El paciente (.+) tiene cita ahora, pero no queda claro que la haya confirmado$/;

function parseNodes(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (_error) {
      return [];
    }
  }
  return [];
}

function replaceNodeMessage(nodes, fromMessage, toMessage) {
  let changed = false;
  const nextNodes = nodes.map((node) => {
    if (!node || typeof node !== 'object') return node;
    const currentMessage = node.config?.message;
    if (currentMessage !== fromMessage) return node;
    changed = true;
    return {
      ...node,
      config: {
        ...(node.config || {}),
        message: toMessage,
      },
    };
  });

  return { changed, nextNodes };
}

async function updateActiveTemplateMessages(queryInterface, fromMessage, toMessage) {
  const [rows] = await queryInterface.sequelize.query(`
    SELECT id, nodes
    FROM AutomationFlowTemplatesV2
    WHERE is_active = 1
      AND CAST(nodes AS CHAR) LIKE :needle
  `, {
    replacements: { needle: `%${fromMessage}%` },
  });

  for (const row of rows) {
    const nodes = parseNodes(row.nodes);
    const { changed, nextNodes } = replaceNodeMessage(nodes, fromMessage, toMessage);
    if (!changed) continue;

    await queryInterface.bulkUpdate(
      'AutomationFlowTemplatesV2',
      { nodes: JSON.stringify(nextNodes) },
      { id: row.id }
    );
  }
}

async function updateRenderedNotifications(queryInterface, toMessageFactory) {
  const [rows] = await queryInterface.sequelize.query(`
    SELECT id, message
    FROM Notifications
    WHERE message LIKE 'El paciente % tiene cita ahora, pero no queda claro que la haya confirmado'
  `);

  for (const row of rows) {
    const match = String(row.message || '').match(OLD_NOTIFICATION_REGEX);
    if (!match) continue;
    const patientName = match[1];
    await queryInterface.bulkUpdate(
      'Notifications',
      { message: toMessageFactory(patientName) },
      { id: row.id }
    );
  }
}

module.exports = {
  async up(queryInterface) {
    await updateActiveTemplateMessages(queryInterface, OLD_TEMPLATE_MESSAGE, NEW_TEMPLATE_MESSAGE);
    await updateRenderedNotifications(
      queryInterface,
      (patientName) => `El paciente ${patientName} no ha confirmado claramente la cita o propone otra disponibilidad. Revisa la conversación y responde desde la clínica.`
    );
  },

  async down(queryInterface) {
    await updateActiveTemplateMessages(queryInterface, NEW_TEMPLATE_MESSAGE, OLD_TEMPLATE_MESSAGE);
    await updateRenderedNotifications(
      queryInterface,
      (patientName) => `El paciente ${patientName} tiene cita ahora, pero no queda claro que la haya confirmado`
    );
  },
};
