'use strict';
module.exports = (sequelize, D) => sequelize.define('BusinessProfileMutationLock', {
  resource_key: { type: D.CHAR(64), primaryKey: true, allowNull: false },
  operation_id: { type: D.UUID, allowNull: false },
}, { tableName: 'BusinessProfileMutationLocks', timestamps: false,
  indexes: [{ name: 'cc_gbp_mutation_lock_owner', fields: ['operation_id'] }] });
