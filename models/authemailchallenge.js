'use strict';
module.exports = (sequelize, D) => sequelize.define('AuthEmailChallenge', {
  challenge_id: { type: D.UUID, primaryKey: true, allowNull: false },
  user_id: { type: D.INTEGER, allowNull: false },
  challenge_hash: { type: D.CHAR(64), allowNull: false, unique: true },
  code_hash: { type: D.CHAR(64), allowNull: false },
  credential_binding: { type: D.CHAR(64), allowNull: false },
  email_hash: { type: D.CHAR(64), allowNull: false },
  state: { type: D.ENUM('pending', 'verified', 'used', 'revoked', 'locked', 'expired'), allowNull: false, defaultValue: 'pending' },
  created_at: { type: D.DATE(3), allowNull: false },
  expires_at: { type: D.DATE(3), allowNull: false },
  absolute_expires_at: { type: D.DATE(3), allowNull: false },
  last_sent_at: { type: D.DATE(3), allowNull: false },
  attempts: { type: D.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
  sends: { type: D.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
  verified_at: { type: D.DATE(3), allowNull: true },
  consumed_session_id: { type: D.UUID, allowNull: true, unique: true },
  email_message_id: { type: D.INTEGER, allowNull: true },
}, { tableName: 'AuthEmailChallenges', timestamps: false });
