'use strict';
// Separate, approved cut only. No binding population, credential copying or
// deletion occurs here. MySQL DDL is not an atomic multi-statement transaction.
module.exports = {
  async up(qi, D) {
    await qi.createTable('GoogleOAuthBrokerBindings', {
      google_user_id: { type: D.STRING(128), primaryKey: true, allowNull: false },
      google_connection_id: { type: D.INTEGER, unique: true, allowNull: false },
      connection_ref: { type: D.STRING(128), unique: true, allowNull: false },
      asset_ref: { type: D.STRING(128), allowNull: false },
      clinica_id: { type: D.INTEGER, allowNull: false },
      scope_key: { type: D.STRING(64), allowNull: false },
      policy_version: { type: D.STRING(64), allowNull: false },
      secret_version: { type: D.STRING(64), allowNull: true },
      confirmed_at: { type: D.DATE(3), allowNull: true },
    });
    await qi.createTable('GoogleOAuthBrokerRequests', {
      flow_id: { type: D.UUID, primaryKey: true, allowNull: false },
      activation_id: { type: D.UUID, unique: true, allowNull: false },
      state_hash: { type: D.STRING(64), unique: true, allowNull: false },
      binding_digest: { type: D.STRING(64), allowNull: false },
      google_user_id: { type: D.STRING(128), allowNull: false },
      google_connection_id: { type: D.INTEGER, allowNull: false },
      connection_ref: { type: D.STRING(128), allowNull: false },
      asset_ref: { type: D.STRING(128), allowNull: false },
      clinica_id: { type: D.INTEGER, allowNull: false },
      scope_key: { type: D.STRING(64), allowNull: false },
      clinic_ids: { type: D.JSON, allowNull: false },
      actor_user_id: { type: D.INTEGER, allowNull: false },
      session_ref: { type: D.UUID, allowNull: false },
      return_to: { type: D.STRING(256), allowNull: false },
      requested_at: { type: D.DATE(3), allowNull: false },
      expires_at: { type: D.DATE(3), allowNull: false },
      state: { type: D.STRING(24), allowNull: false },
      next_attempt_at: { type: D.DATE(3), allowNull: false },
      attempts: { type: D.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      lease_token: { type: D.UUID, allowNull: true },
      lease_until: { type: D.DATE(3), allowNull: true },
      last_error: { type: D.STRING(48), allowNull: true },
      completed_at: { type: D.DATE(3), allowNull: true },
    });
    await qi.addIndex('GoogleOAuthBrokerRequests', ['state', 'next_attempt_at', 'lease_until'], { name: 'idx_google_oauth_delivery' });
    await qi.addIndex('GoogleOAuthBrokerRequests', ['google_connection_id', 'requested_at'], { name: 'idx_google_oauth_connection' });
    await qi.changeColumn('GoogleConnections', 'accessToken', { type: D.TEXT, allowNull: true });
  },
  async down(qi, D) {
    const [rows] = await qi.sequelize.query('SELECT (SELECT COUNT(*) FROM GoogleOAuthBrokerBindings) + '
      + '(SELECT COUNT(*) FROM GoogleOAuthBrokerRequests) + (SELECT COUNT(*) FROM GoogleConnections WHERE accessToken IS NULL) AS count');
    if (Number(rows[0].count)) throw Error('google_oauth_preserve_bindings');
    await qi.changeColumn('GoogleConnections', 'accessToken', { type: D.TEXT, allowNull: false });
    await qi.dropTable('GoogleOAuthBrokerRequests');
    await qi.dropTable('GoogleOAuthBrokerBindings');
  },
};
