'use strict';
module.exports = (sequelize, D) => sequelize.define('ClinicSupplyCommand', {
  id: { type: D.STRING(36), primaryKey: true }, clinic_id: { type: D.INTEGER, allowNull: false }, command_key: D.STRING(120),
  command_hash: D.STRING(64), command_type: D.STRING(60), actor_id: D.INTEGER, result: D.JSON,
}, { tableName: 'ClinicSupplyCommands', underscored: true, createdAt: 'created_at', updatedAt: 'updated_at', hooks: {
  beforeUpdate() { throw Error('clinic_supply_command_immutable'); }, beforeDestroy() { throw Error('clinic_supply_command_immutable'); },
  beforeBulkUpdate() { throw Error('clinic_supply_command_immutable'); }, beforeBulkDestroy() { throw Error('clinic_supply_command_immutable'); },
} });
