'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        `
          UPDATE Tratamientos
          SET appointment_automation_template_version = NULL
          WHERE appointment_automation_template_version IS NOT NULL
        `,
        { transaction }
      );

      await queryInterface.sequelize.query(
        `
          UPDATE AutomationFlowCatalog
          SET template_version = NULL
          WHERE template_version IS NOT NULL
        `,
        { transaction }
      );

      await queryInterface.sequelize.query(
        `
          UPDATE AutomationFlowTemplatesV2
          SET is_active = CASE
            WHEN published_at IS NULL THEN is_active
            ELSE 0
          END
        `,
        { transaction }
      );

      await queryInterface.sequelize.query(
        `
          UPDATE AutomationFlowTemplatesV2 t
          INNER JOIN (
            SELECT template_key, MAX(version) AS max_version
            FROM AutomationFlowTemplatesV2
            WHERE published_at IS NOT NULL
            GROUP BY template_key
          ) latest
            ON latest.template_key = t.template_key
           AND latest.max_version = t.version
          SET t.is_active = 1
        `,
        { transaction }
      );
    });
  },

  async down() {
    // No reversible: la migración limpia pins históricos y normaliza el estado activo.
  },
};
