'use strict';
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`CREATE TABLE WhatsappAuthorizationStates (
      request_id CHAR(36) NOT NULL PRIMARY KEY,
      user_id INT NOT NULL, session_ref CHAR(36) NOT NULL,
      session_expires_at DATETIME(3) NOT NULL,
      scope_type ENUM('clinic','group') NOT NULL, scope_id INT NOT NULL,
      original_clinic_ids JSON NOT NULL, scope_digest CHAR(64) NOT NULL,
      state_hash CHAR(64) NOT NULL, context_digest CHAR(64) NOT NULL,
      state ENUM('awaiting','claimed','cancelled') NOT NULL,
      code_hash CHAR(64) NULL,
      created_at DATETIME(3) NOT NULL, expires_at DATETIME(3) NOT NULL,
      claimed_at DATETIME(3) NULL, cancelled_at DATETIME(3) NULL,
      UNIQUE KEY uq_whatsapp_authorization_state_hash (state_hash),
      UNIQUE KEY uq_whatsapp_authorization_code_hash (code_hash),
      KEY idx_whatsapp_authorization_user_time (user_id,created_at),
      KEY idx_whatsapp_authorization_user_active (user_id,state,expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=ascii COLLATE=ascii_bin`);
    // No FK/cascade: deleting a user, session, clinic or legacy Meta connection
    // cannot erase a consumed/cancelled state or make its request ID reusable.
  },
  async down(qi) {
    const [rows] = await qi.sequelize.query('SELECT COUNT(*) AS n FROM WhatsappAuthorizationStates');
    if (Number(rows[0].n)) throw Error('Preserve WhatsApp authorization states; rollback requires an approved cut');
    await qi.dropTable('WhatsappAuthorizationStates');
  },
};
