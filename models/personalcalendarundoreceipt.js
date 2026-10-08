'use strict';
module.exports = (sequelize, D) => sequelize.define('PersonalCalendarUndoReceipt', {
  id: { type: D.UUID, primaryKey: true, allowNull: false },
  token_hash: { type: D.STRING(64), allowNull: false, unique: true },
  actor_user_id: { type: D.INTEGER, allowNull: false },
  doctor_ids: { type: D.JSON, allowNull: false },
  revisions: { type: D.JSON, allowNull: false },
  before_state: { type: D.JSON, allowNull: false },
  after_state: { type: D.JSON, allowNull: false },
  post_sha256: { type: D.STRING(64), allowNull: false },
  expires_at: { type: D.DATE(3), allowNull: false },
  consumed_at: { type: D.DATE(3), allowNull: true },
}, { tableName: 'PersonalCalendarUndoReceipts', underscored: true,
  createdAt: 'created_at', updatedAt: 'updated_at',
  indexes: [{ fields: ['expires_at'] }, { fields: ['actor_user_id', 'created_at'] }] });
