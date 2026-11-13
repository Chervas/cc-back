'use strict';

// NULL preserves the exact v1/v2/v3 signed context. No backfill or grants.
module.exports = {
  async up(qi, D) {
    await qi.addColumn('WhatsappAuthorizationStates', 'onboarding_mode', {
      type: D.ENUM('cloud_api', 'coexistence'), allowNull: true, defaultValue: null,
    });
  },
  async down(qi) {
    const [rows] = await qi.sequelize.query(
      'SELECT COUNT(*) AS n FROM WhatsappAuthorizationStates WHERE onboarding_mode IS NOT NULL'
    );
    if (Number(rows[0].n)) throw Error('Preserve signed WhatsApp onboarding modes; rollback must retain onboarding_mode');
    await qi.removeColumn('WhatsappAuthorizationStates', 'onboarding_mode');
  },
};
