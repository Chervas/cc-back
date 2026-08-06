'use strict';

const CATALOG_NAME = 'auto_solicitar_resena';
const TRIGGER_TYPE = 'appointment_completed';
const ACTION_TYPE = 'action/request_review';
const MANAGED_FEATURE = 'review_request';
const CONFIGURATION_VERSION = 1;
const VALID_REVIEW_SOURCES = new Set([
  'completed_treatment',
  'first_completed_appointment',
  'first_completed_or_completed_treatment',
]);
const DELAY_BY_HOURS = new Map([
  [0, 'same_day'],
  [24, '24h'],
  [48, '48h'],
  [168, '7d'],
]);

function parseJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function cleanString(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function delayHoursFromNode(node) {
  const duration = Number(node?.config?.duration);
  const unit = cleanString(node?.config?.unit).toLowerCase();
  if (!Number.isFinite(duration) || duration < 0) return null;
  if (unit === 'minutes') return duration / 60;
  if (unit === 'days') return duration * 24;
  return unit === 'hours' ? duration : null;
}

module.exports = {
  async up(queryInterface) {
    const [rows] = await queryInterface.sequelize.query(
      `
      SELECT id, clinic_id, is_system, is_active, published_at, trigger_config, nodes
        FROM AutomationFlowTemplatesV2
       WHERE trigger_type = :triggerType
         AND CAST(nodes AS CHAR) LIKE '%action/request_review%'
      `,
      { replacements: { triggerType: TRIGGER_TYPE } }
    );

    const now = new Date();
    for (const row of rows || []) {
      const nodes = parseJson(row.nodes, []);
      const triggerConfig = parseJson(row.trigger_config, {});
      const actionNode = Array.isArray(nodes)
        ? nodes.find((node) => cleanString(node?.type) === ACTION_TYPE)
        : null;
      const delayNode = Array.isArray(nodes)
        ? nodes.find((node) => cleanString(node?.type) === 'delay/fixed')
        : null;
      const actionConfig = actionNode?.config && typeof actionNode.config === 'object'
        ? actionNode.config
        : {};
      const reviewSource = cleanString(actionConfig.review_source).toLowerCase();
      const initialDelayHours = delayHoursFromNode(delayNode);
      const reviewDelay = DELAY_BY_HOURS.get(initialDelayHours) || null;
      const hasExplicitConfiguration = Number(row.clinic_id || 0) > 0
        && Number(row.is_system || 0) === 0
        && !!row.published_at
        && VALID_REVIEW_SOURCES.has(reviewSource)
        && !!reviewDelay
        && Number(actionConfig.whatsapp_template_id || 0) > 0
        && !!cleanString(actionConfig.review_sender_name);

      const nextTriggerConfig = {
        ...triggerConfig,
        event_name: TRIGGER_TYPE,
        managed_feature: MANAGED_FEATURE,
        configured: hasExplicitConfiguration,
        configuration_version: CONFIGURATION_VERSION,
        ...(hasExplicitConfiguration ? {
          review_source: reviewSource,
          review_delay: reviewDelay,
          initial_delay_hours: initialDelayHours,
        } : {}),
      };

      await queryInterface.sequelize.query(
        `
        UPDATE AutomationFlowTemplatesV2
           SET trigger_config = :triggerConfig,
               is_active = :isActive,
               updated_at = :updatedAt
         WHERE id = :id
        `,
        {
          replacements: {
            id: row.id,
            triggerConfig: JSON.stringify(nextTriggerConfig),
            // A valid configuration is preserved, but rollout never opts a clinic in.
            // Each clinic must explicitly activate automatic review requests afterwards.
            isActive: 0,
            updatedAt: now,
          },
        }
      );
    }

    await queryInterface.bulkUpdate(
      'AutomationFlowCatalog',
      {
        is_default_for_trigger: false,
        updated_at: now,
      },
      { name: CATALOG_NAME }
    );
  },

  async down() {
    // No-op: reactivar configuraciones ambiguas podría volver a enviar mensajes sin permiso explícito.
  },
};
