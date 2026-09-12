'use strict';
module.exports = {
  async up(qi, D) {
    await qi.createTable('AuthSessions', {
      session_id: { type: D.UUID, primaryKey: true, allowNull: false },
      user_id: { type: D.INTEGER, allowNull: false, references: { model: 'Usuarios', key: 'id_usuario' }, onDelete: 'RESTRICT', onUpdate: 'RESTRICT' },
      issued_at: { type: D.DATE(3), allowNull: false }, expires_at: { type: D.DATE(3), allowNull: false },
      absolute_expires_at: { type: D.DATE(3), allowNull: false }, credential_binding: { type: D.STRING(64), allowNull: false },
      state: { type: D.STRING(16), allowNull: false }, ended_at: { type: D.DATE(3), allowNull: true },
    });
    await qi.addIndex('AuthSessions', ['user_id', 'state'], { name: 'idx_auth_session_user' });
    await qi.addIndex('AuthSessions', ['state', 'expires_at'], { name: 'idx_auth_session_expiry' });
  },
  async down() { throw Error('auth_sessions_preserve_revocations_and_evidence'); },
};
