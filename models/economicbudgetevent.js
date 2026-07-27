'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class EconomicBudgetEvent extends Model {}
  EconomicBudgetEvent.init({
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    budget_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    version_number: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    event_type: { type: DataTypes.STRING(30), allowNull: false },
    from_status: DataTypes.STRING(30),
    to_status: { type: DataTypes.STRING(30), allowNull: false },
    metadata: DataTypes.JSON,
    actor_id: DataTypes.INTEGER,
    created_at: DataTypes.DATE,
  }, {
    sequelize,
    modelName: 'EconomicBudgetEvent',
    tableName: 'EconomicBudgetEvents',
    timestamps: false,
  });
  return EconomicBudgetEvent;
};
