'use strict';
module.exports = {
  async up(qi, D) {
    await qi.addIndex('BusinessProfileBrokerBindings', ['google_connection_id', 'clinica_id', 'external_location_id'], { name: 'idx_gbp_binding_scope' });
    await qi.createTable('BusinessProfileBrokerRevocations', {
      external_location_id: { type: D.STRING(30), primaryKey: true, allowNull: false },
      connection_ref: { type: D.STRING(128), allowNull: false }, asset_ref: { type: D.STRING(128), allowNull: false },
      clinica_id: { type: D.INTEGER, allowNull: false }, google_connection_id: { type: D.INTEGER, allowNull: false },
      request_id: { type: D.UUID, allowNull: false, unique: true }, actor_user_id: { type: D.INTEGER, allowNull: false },
      requested_at: { type: D.DATE(3), allowNull: false }, confirmed_at: { type: D.DATE(3), allowNull: true },
      state: { type: D.STRING(16), allowNull: false, defaultValue: 'pending' },
      attempts: { type: D.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }, next_attempt_at: { type: D.DATE(3), allowNull: false },
      lease_token: { type: D.UUID, allowNull: true }, lease_until: { type: D.DATE(3), allowNull: true },
      last_error: { type: D.STRING(48), allowNull: true },
    });
    await qi.addIndex('BusinessProfileBrokerRevocations', ['state', 'next_attempt_at', 'lease_until'], { name: 'idx_gbp_revocation_delivery' });
    await qi.addIndex('BusinessProfileBrokerRevocations', ['clinica_id', 'google_connection_id', 'external_location_id'], { name: 'idx_gbp_revocation_scope' });
  },
  async down(qi) {
    const [rows] = await qi.sequelize.query('SELECT COUNT(*) AS count FROM BusinessProfileBrokerRevocations');
    if (Number(rows[0].count)) throw Error('gbp_revocation_preserve_tombstones');
    await qi.dropTable('BusinessProfileBrokerRevocations');
    await qi.removeIndex('BusinessProfileBrokerBindings', 'idx_gbp_binding_scope');
  },
};
