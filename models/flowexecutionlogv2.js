'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class FlowExecutionLogV2 extends Model {
    static associate(models) {
      if (models.FlowExecutionV2) {
        FlowExecutionLogV2.belongsTo(models.FlowExecutionV2, {
          foreignKey: 'flow_execution_id',
          targetKey: 'id',
          as: 'execution',
        });
      }
    }
  }

  FlowExecutionLogV2.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    flow_execution_id: { type: DataTypes.INTEGER, allowNull: false },
    node_id: { type: DataTypes.STRING(32), allowNull: false },
    node_type: { type: DataTypes.STRING(120), allowNull: true },
    status: { type: DataTypes.ENUM('running', 'success', 'error'), allowNull: false },
    started_at: { type: DataTypes.DATE, allowNull: false },
    finished_at: { type: DataTypes.DATE, allowNull: true },
    error_message: { type: DataTypes.TEXT, allowNull: true },
    audit_snapshot: { type: DataTypes.JSON, allowNull: true },
    encrypted_context_diff: { type: DataTypes.TEXT('long'), allowNull: true },
  }, {
    sequelize,
    modelName: 'FlowExecutionLogV2',
    tableName: 'FlowExecutionLogsV2',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: false,
  });

  return FlowExecutionLogV2;
};
