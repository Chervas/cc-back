'use strict';
module.exports = {
  async up(qi, D) {
    const user = () => ({ type: D.INTEGER, allowNull: false,
      references: { model: 'Usuarios', key: 'id_usuario' }, onDelete: 'RESTRICT', onUpdate: 'RESTRICT' });
    await qi.createTable('DelegatedSessions', {
      delegation_id: { type: D.UUID, primaryKey: true, allowNull: false },
      admin_user_id: user(), effective_user_id: user(),
      parent_session_id: { type: D.UUID, allowNull: false, references: { model: 'AuthSessions', key: 'session_id' },
        onDelete: 'RESTRICT', onUpdate: 'RESTRICT' },
      parent_expires_at: { type: D.DATE(3), allowNull: false },
      actor_credential_binding: { type: D.STRING(64), allowNull: false },
      target_credential_binding: { type: D.STRING(64), allowNull: false },
      handoff_digest: { type: D.STRING(64), allowNull: false, unique: true },
      pkce_challenge: { type: D.STRING(43), allowNull: false }, tab_nonce_digest: { type: D.STRING(64), allowNull: false },
      handoff_expires_at: { type: D.DATE(3), allowNull: false }, handoff_consumed_at: { type: D.DATE(3), allowNull: true },
      state: { type: D.STRING(16), allowNull: false }, created_at: { type: D.DATE(3), allowNull: false },
      activated_at: { type: D.DATE(3), allowNull: true }, expires_at: { type: D.DATE(3), allowNull: false },
      ended_at: { type: D.DATE(3), allowNull: true }, end_reason: { type: D.STRING(32), allowNull: true },
      runtime_namespace: { type: D.STRING(80), allowNull: false }, frontend_origin: { type: D.STRING(255), allowNull: false },
    });
    await qi.addIndex('DelegatedSessions', ['parent_session_id', 'state'], { name: 'idx_delegated_parent_state' });
    await qi.addIndex('DelegatedSessions', ['effective_user_id', 'state'], { name: 'idx_delegated_target_state' });
    await qi.addIndex('DelegatedSessions', ['state', 'expires_at'], { name: 'idx_delegated_state_expiry' });
  },
  async down() { throw Error('delegated_sessions_preserve_revocations_and_audit_evidence'); },
};
