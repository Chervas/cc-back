'use strict';
module.exports = (sequelize, D) => sequelize.define('ClinicalPhotoPairRevision', {
  id: { type: D.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true }, pair_id: { type: D.BIGINT.UNSIGNED, allowNull: false },
  version_number: { type: D.INTEGER.UNSIGNED, allowNull: false }, snapshot: { type: D.JSON, allowNull: false },
  actor_id: { type: D.INTEGER, allowNull: false }, change_type: { type: D.STRING(20), allowNull: false },
  command_key: D.STRING(120), command_hash: D.STRING(64),
  before_asset_id: { type: D.INTEGER, allowNull: false }, after_asset_id: { type: D.INTEGER, allowNull: false },
}, { tableName: 'ClinicalPhotoPairRevisions', underscored: true, createdAt: 'created_at', updatedAt: false,
  hooks: { beforeUpdate() { throw Error('clinical_photo_pair_revision_immutable'); }, beforeDestroy() { throw Error('clinical_photo_pair_revision_immutable'); },
    beforeBulkUpdate() { throw Error('clinical_photo_pair_revision_immutable'); }, beforeBulkDestroy() { throw Error('clinical_photo_pair_revision_immutable'); } } });
