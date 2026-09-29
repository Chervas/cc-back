'use strict';

// A reconnection is not a new enrollment. These nullable fields bind a new
// OAuth attempt to the existing local phone without rewriting historical rows.
module.exports = {
  async up(qi, D) {
    await qi.addColumn('WhatsappAuthorizationStates', 'replacement_asset_id', {
      type: D.INTEGER, allowNull: true,
    });
    await qi.addColumn('WhatsappAuthorizationStates', 'replacement_authorization_id', {
      type: D.UUID, allowNull: true,
    });
    await qi.addColumn('WhatsappAuthorizationStates', 'replacement_phone_digest', {
      type: D.STRING(64), allowNull: true,
    });
    await qi.addIndex('WhatsappAuthorizationStates', ['replacement_asset_id'], {
      name: 'idx_whatsapp_authorization_replacement_asset',
    });
  },
  async down(qi) {
    const [rows] = await qi.sequelize.query(
      'SELECT COUNT(*) AS n FROM WhatsappAuthorizationStates WHERE replacement_asset_id IS NOT NULL OR replacement_authorization_id IS NOT NULL OR replacement_phone_digest IS NOT NULL'
    );
    if (Number(rows[0].n)) throw Error('Preserve signed WhatsApp reconnection targets; rollback requires an approved cut');
    await qi.removeIndex('WhatsappAuthorizationStates', 'idx_whatsapp_authorization_replacement_asset');
    await qi.removeColumn('WhatsappAuthorizationStates', 'replacement_phone_digest');
    await qi.removeColumn('WhatsappAuthorizationStates', 'replacement_authorization_id');
    await qi.removeColumn('WhatsappAuthorizationStates', 'replacement_asset_id');
  },
};
