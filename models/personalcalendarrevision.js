'use strict';
module.exports = (sequelize, D) => sequelize.define('PersonalCalendarRevision', {
  doctor_id: { type: D.INTEGER, primaryKey: true, allowNull: false },
  revision: { type: D.BIGINT.UNSIGNED, allowNull: false, defaultValue: 0 },
}, { tableName: 'PersonalCalendarRevisions', underscored: true,
  createdAt: 'created_at', updatedAt: 'updated_at' });
