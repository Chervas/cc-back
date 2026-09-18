'use strict';
module.exports = (sequelize, D) => sequelize.define('GoogleAdsActionPlan', {
  plan_id: { type: D.UUID, primaryKey: true, allowNull: false },
  owner_digest: { type: D.CHAR(64), allowNull: false },
  actor_user_id: { type: D.INTEGER, allowNull: false },
  session_ref: { type: D.UUID, allowNull: false },
  mapping_id: { type: D.INTEGER, allowNull: false },
  customer_id: { type: D.CHAR(10), allowNull: false },
  input: { type: D.JSON, allowNull: false },
  receipt: { type: D.JSON, allowNull: true },
  apply_command_id: { type: D.UUID, allowNull: true, unique: true },
  created_at: { type: D.DATE(3), allowNull: false },
  updated_at: { type: D.DATE(3), allowNull: false },
}, { tableName: 'GoogleAdsActionPlans', timestamps: false });
