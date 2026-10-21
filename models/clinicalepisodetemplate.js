'use strict';
module.exports = (sequelize, D) => sequelize.define('ClinicalEpisodeTemplate', {
  id: { type: D.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
  public_id: { type: D.STRING(36), allowNull: false, unique: true }, clinic_id: { type: D.INTEGER, allowNull: false },
  current_version: { type: D.INTEGER.UNSIGNED, allowNull: false }, creation_key: { type: D.STRING(64), unique: true, allowNull: false },
  creation_hash: { type: D.STRING(64), allowNull: false }, created_by: { type: D.INTEGER, allowNull: false }, updated_by: { type: D.INTEGER, allowNull: false },
}, { tableName: 'ClinicalEpisodeTemplates', underscored: true, createdAt: 'created_at', updatedAt: 'updated_at' });
