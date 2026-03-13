'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class AppointmentFlowInstance extends Model {
    static associate(models) {
      if (models.CitaPaciente) {
        AppointmentFlowInstance.belongsTo(models.CitaPaciente, {
          foreignKey: 'cita_id',
          targetKey: 'id_cita',
          as: 'cita',
        });
      }
      if (models.AppointmentFlowTemplate) {
        AppointmentFlowInstance.belongsTo(models.AppointmentFlowTemplate, {
          foreignKey: 'template_id',
          targetKey: 'id',
          as: 'template',
        });
      }
      if (models.Clinica) {
        AppointmentFlowInstance.belongsTo(models.Clinica, {
          foreignKey: 'clinica_id',
          targetKey: 'id_clinica',
          as: 'clinica',
        });
      }
      if (models.Paciente) {
        AppointmentFlowInstance.belongsTo(models.Paciente, {
          foreignKey: 'paciente_id',
          targetKey: 'id_paciente',
          as: 'paciente',
        });
      }
      if (models.AppointmentFlowInstanceLog) {
        AppointmentFlowInstance.hasMany(models.AppointmentFlowInstanceLog, {
          foreignKey: 'flow_instance_id',
          sourceKey: 'id',
          as: 'logs',
        });
      }
    }
  }

  AppointmentFlowInstance.init(
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      cita_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        unique: true,
      },
      clinica_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      paciente_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      tratamiento_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      template_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      template_version: {
        type: DataTypes.STRING(20),
        allowNull: true,
      },
      status: {
        type: DataTypes.ENUM('running', 'waiting', 'completed', 'failed', 'cancelled'),
        allowNull: false,
        defaultValue: 'running',
      },
      current_step_index: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      current_step_type: {
        type: DataTypes.STRING(64),
        allowNull: true,
      },
      current_step_label: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      current_state: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      agenda_icon: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      next_action_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      last_transition_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      last_error: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      context_json: {
        type: DataTypes.JSON,
        allowNull: true,
      },
      started_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      completed_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      created_by: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
    },
    {
      sequelize,
      modelName: 'AppointmentFlowInstance',
      tableName: 'AppointmentFlowInstances',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    }
  );

  return AppointmentFlowInstance;
};
