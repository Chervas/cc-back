'use strict';

const REMINDER_TEMPLATE_NAME = 'clinicaclick_recordatorio_resena_sin_respuesta';

module.exports = {
  async up(queryInterface) {
    const now = new Date();

    await queryInterface.sequelize.query(
      `
      UPDATE WhatsappTemplateCatalog
         SET is_active = 0,
             updated_at = :now
       WHERE name = :name
      `,
      { replacements: { name: REMINDER_TEMPLATE_NAME, now } }
    );

    await queryInterface.sequelize.query(
      `
      UPDATE WhatsappTemplates wt
      LEFT JOIN WhatsappTemplateCatalog c ON c.id = wt.catalog_template_id
         SET wt.is_active = 0,
             wt.updatedAt = :now
       WHERE wt.name = :name
          OR wt.name LIKE :familyName
          OR c.name = :name
      `,
      {
        replacements: {
          name: REMINDER_TEMPLATE_NAME,
          familyName: `${REMINDER_TEMPLATE_NAME}_v%`,
          now,
        },
      }
    );

    await queryInterface.sequelize.query(
      `
      UPDATE FlowExecutionsV2 e
      JOIN AutomationFlowTemplatesV2 t ON t.id = e.template_version_id
         SET e.status = 'completed',
             e.current_node_id = NULL,
             e.wait_until = NULL,
             e.waiting_meta = NULL,
             e.context = JSON_SET(
               CASE
                 WHEN JSON_VALID(e.context) THEN e.context
                 ELSE JSON_OBJECT()
               END,
               '$.review_no_response_policy',
               'closed_without_reminder',
               '$.legacy_review_reminder_cancelled_at',
               :nowIso
             ),
             e.updated_at = :now
       WHERE e.status = 'waiting'
         AND t.trigger_type = 'appointment_completed'
         AND (
           CAST(e.context AS CHAR) LIKE '%review_request_reminder%'
           OR CAST(e.waiting_meta AS CHAR) LIKE '%review_request_reminder%'
           OR (
             e.current_node_id IN ('N4', 'N5')
             AND CAST(e.waiting_meta AS CHAR) LIKE '%"listens_to_node_id": "N4"%'
             AND CAST(e.context AS CHAR) LIKE '%"outputs"%'
           )
         )
      `,
      { replacements: { now, nowIso: now.toISOString() } }
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `
      UPDATE WhatsappTemplateCatalog
         SET is_active = 1,
             updated_at = NOW()
       WHERE name = :name
      `,
      { replacements: { name: REMINDER_TEMPLATE_NAME } }
    );

    await queryInterface.sequelize.query(
      `
      UPDATE WhatsappTemplates wt
      LEFT JOIN WhatsappTemplateCatalog c ON c.id = wt.catalog_template_id
         SET wt.is_active = 1,
             wt.updatedAt = NOW()
       WHERE wt.name = :name
          OR wt.name LIKE :familyName
          OR c.name = :name
      `,
      {
        replacements: {
          name: REMINDER_TEMPLATE_NAME,
          familyName: `${REMINDER_TEMPLATE_NAME}_v%`,
        },
      }
    );
  },
};
