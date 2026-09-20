'use strict';
module.exports = (sequelize, D) => sequelize.define('GoogleCloudCostCache', {
  cache_key: { type: D.STRING(96), primaryKey: true },
  snapshot: { type: D.JSON, allowNull: false },
  collected_at: { type: D.DATE, allowNull: false },
}, { tableName: 'GoogleCloudCostCaches', createdAt: 'created_at', updatedAt: 'updated_at' });
