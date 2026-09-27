'use strict';

module.exports = (sequelize, D) => sequelize.define('MedicalAreaAdoption', {
  id: { type: D.INTEGER, autoIncrement: true, primaryKey: true },
  clinic_id: { type: D.INTEGER, allowNull: false },
  code: { type: D.STRING(80), allowNull: false },
  previous_revision_id: { type: D.INTEGER, allowNull: true },
  revision_id: { type: D.INTEGER, allowNull: false },
  actor_id: { type: D.INTEGER, allowNull: false },
  review_hash: { type: D.STRING(64), allowNull: false },
  review_json: { type: D.JSON, allowNull: false },
  reason: { type: D.STRING(500), allowNull: false },
}, {
  tableName: 'MedicalAreaAdoptions', underscored: true, timestamps: true, updatedAt: false,
  indexes: [{ fields: ['clinic_id', 'code', 'id'] }],
  hooks: {
    beforeUpdate() { throw Error('medical_area_adoption_immutable'); },
    beforeBulkUpdate() { throw Error('medical_area_adoption_immutable'); },
    beforeDestroy() { throw Error('medical_area_adoption_immutable'); },
    beforeBulkDestroy() { throw Error('medical_area_adoption_immutable'); },
  },
});
