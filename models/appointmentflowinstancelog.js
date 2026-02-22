'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class AppointmentFlowInstanceLog extends Model {
    static associate(models) {
      if (models.AppointmentFlowInstance) {
        AppointmentFlowInstanceLog.belongsTo(models.AppointmentFlowInstance, {
          foreignKey: 'flow_instance_id',
          targetKey: 'id',
          as: 'flowInstance',
        });
      }
      if (models.CitaPaciente) {
        AppointmentFlowInstanceLog.belongsTo(models.CitaPaciente, {
          foreignKey: 'cita_id',
          targetKey: 'id_cita',
          as: 'cita',
        });
      }
    }
  }

  AppointmentFlowInstanceLog.init(
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      flow_instance_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      cita_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      step_index: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      step_type: {
        type: DataTypes.STRING(64),
        allowNull: true,
      },
      step_label: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      event_type: {
        type: DataTypes.STRING(64),
        allowNull: false,
      },
      status_before: {
        type: DataTypes.STRING(32),
        allowNull: true,
      },
      status_after: {
        type: DataTypes.STRING(32),
        allowNull: true,
      },
      payload: {
        type: DataTypes.JSON,
        allowNull: true,
      },
    },
    {
      sequelize,
      modelName: 'AppointmentFlowInstanceLog',
      tableName: 'AppointmentFlowInstanceLogs',
      timestamps: false,
      underscored: true,
    }
  );

  return AppointmentFlowInstanceLog;
};
