'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE AutomationFlowTemplatesV2
         SET name = 'Reseñas automáticas',
             updated_at = NOW()
       WHERE (
              template_key = 'review_request_after_completed'
              OR template_key = 'system_review_request_after_appointment_completed'
              OR public_id = 'flw_review_request_system'
            )
         AND name LIKE 'Plantilla base de sistema%Reseñas automáticas%'
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE AutomationFlowTemplatesV2
         SET name = 'Plantilla base de sistema · Reseñas automáticas',
             updated_at = NOW()
       WHERE (
              template_key = 'review_request_after_completed'
              OR template_key = 'system_review_request_after_appointment_completed'
              OR public_id = 'flw_review_request_system'
            )
         AND name = 'Reseñas automáticas'
    `);
  },
};
