'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `UPDATE AutomationFlowTemplatesV2
       SET is_active = 0, updated_at = NOW()
       WHERE trigger_type = 'appointment_completed'
         AND template_key LIKE 'review_request_after_completed__group_%'`
    );
  },

  async down() {
    // No se reactivan automáticamente: la activación de reseñas por grupo
    // ahora se materializa como automatizaciones individuales por clínica.
  },
};
