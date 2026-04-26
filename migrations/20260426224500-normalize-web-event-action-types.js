'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE WebEvents
      SET event_type = 'whatsapp_click', updated_at = CURRENT_TIMESTAMP
      WHERE event_type IN ('whatsappclick', 'openwhatsapp', 'whatsappstarted', 'click_whatsapp')
    `);

    await queryInterface.sequelize.query(`
      UPDATE WebEvents
      SET event_type = 'form_submit', updated_at = CURRENT_TIMESTAMP
      WHERE event_type IN ('formsubmit', 'formsubmitted', 'submitform')
    `);

    await queryInterface.sequelize.query(`
      UPDATE WebClickDaily
      SET click_type = 'whatsapp_click', updated_at = CURRENT_TIMESTAMP
      WHERE click_type IN ('whatsappclick', 'openwhatsapp', 'whatsappstarted', 'click_whatsapp')
    `);

    await queryInterface.sequelize.query(`
      UPDATE WebClickDaily
      SET click_type = 'form_submit', updated_at = CURRENT_TIMESTAMP
      WHERE click_type IN ('formsubmit', 'formsubmitted', 'submitform')
    `);
  },

  async down() {
    // No-op: reverting would make already normalized analytics ambiguous.
  },
};
