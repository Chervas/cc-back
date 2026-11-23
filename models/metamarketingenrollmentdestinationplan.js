'use strict';

module.exports = (sequelize, DataTypes) => sequelize.define('MetaMarketingEnrollmentDestinationPlan', {
  enrollment_id: { type: DataTypes.CHAR(36), allowNull: false, primaryKey: true },
  plan: { type: DataTypes.TEXT('medium'), allowNull: false },
  digest: { type: DataTypes.CHAR(64), allowNull: false },
  asset_labels: { type: DataTypes.JSON, allowNull: true },
}, { tableName: 'MetaMarketingEnrollmentDestinationPlans', timestamps: false, charset: 'ascii', collate: 'ascii_bin' });
