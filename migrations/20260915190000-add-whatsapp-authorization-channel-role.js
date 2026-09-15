'use strict';
// NULL is the original v1 signed context; no backfill or credential activation.
module.exports = {
  async up(qi, D) {
    await qi.addColumn('WhatsappAuthorizationStates', 'channel_role', {
      type: D.ENUM('primary', 'secondary'), allowNull: true, defaultValue: null,
    });
  },
  async down(qi) {
    const [rows] = await qi.sequelize.query('SELECT COUNT(*) AS n FROM WhatsappAuthorizationStates WHERE channel_role IS NOT NULL');
    if (Number(rows[0].n)) throw Error('Preserve signed WhatsApp channel intents; rollback must retain channel_role');
    await qi.removeColumn('WhatsappAuthorizationStates', 'channel_role');
  },
};
