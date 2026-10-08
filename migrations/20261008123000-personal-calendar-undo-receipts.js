'use strict';
module.exports = {
  async up(q, D) {
    await q.createTable('PersonalCalendarRevisions', {
      doctor_id: { type: D.INTEGER, primaryKey: true, allowNull: false },
      revision: { type: D.BIGINT.UNSIGNED, allowNull: false, defaultValue: 0 },
      created_at: { type: D.DATE, allowNull: false }, updated_at: { type: D.DATE, allowNull: false },
    });
    await q.createTable('PersonalCalendarUndoReceipts', {
      id: { type: D.UUID, primaryKey: true, allowNull: false },
      token_hash: { type: D.STRING(64), allowNull: false, unique: true },
      actor_user_id: { type: D.INTEGER, allowNull: false }, doctor_ids: { type: D.JSON, allowNull: false },
      revisions: { type: D.JSON, allowNull: false }, before_state: { type: D.JSON, allowNull: false },
      after_state: { type: D.JSON, allowNull: false }, post_sha256: { type: D.STRING(64), allowNull: false },
      expires_at: { type: D.DATE(3), allowNull: false }, consumed_at: { type: D.DATE(3), allowNull: true },
      created_at: { type: D.DATE, allowNull: false }, updated_at: { type: D.DATE, allowNull: false },
    });
    await q.addIndex('PersonalCalendarUndoReceipts', ['expires_at']);
    await q.addIndex('PersonalCalendarUndoReceipts', ['actor_user_id', 'created_at']);
  },
  async down(q) {
    // Never discard a still-live receipt or monotonic revision during rollback.
    const [rows] = await q.sequelize.query('SELECT COUNT(*) AS n FROM PersonalCalendarUndoReceipts');
    if (Number(rows[0]?.n)) throw Error('personal_calendar_undo_rollback_requires_empty_receipts');
    await q.dropTable('PersonalCalendarUndoReceipts');
    await q.dropTable('PersonalCalendarRevisions');
  },
};
