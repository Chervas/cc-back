'use strict';

module.exports = (sequelize, D) => sequelize.define('MedicalAreaContractRevision', {
  id: { type: D.INTEGER, autoIncrement: true, primaryKey: true },
  code: { type: D.STRING(80), allowNull: false },
  revision_number: { type: D.INTEGER, allowNull: false },
  contract_json: { type: D.JSON, allowNull: false },
  content_hash: { type: D.STRING(64), allowNull: false },
  created_by: { type: D.INTEGER, allowNull: true },
}, {
  tableName: 'MedicalAreaContractRevisions', underscored: true,
  timestamps: true, updatedAt: false,
  indexes: [{ unique: true, fields: ['code', 'revision_number'] }],
  hooks: {
    beforeUpdate() { throw new Error('medical_area_revision_immutable'); },
    beforeBulkUpdate() { throw new Error('medical_area_revision_immutable'); },
    beforeDestroy() { throw new Error('medical_area_revision_immutable'); },
    beforeBulkDestroy() { throw new Error('medical_area_revision_immutable'); },
  },
});
