'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class AppointmentFlowTemplate extends Model {
    static associate(models) {
      if (models.Clinica) {
        AppointmentFlowTemplate.belongsTo(models.Clinica, {
          foreignKey: 'clinic_id',
          targetKey: 'id_clinica',
          as: 'clinic',
        });
      }
      if (models.GrupoClinica) {
        AppointmentFlowTemplate.belongsTo(models.GrupoClinica, {
          foreignKey: 'group_id',
          targetKey: 'id_grupo',
          as: 'group',
        });
      }
      if (models.Tratamiento) {
        AppointmentFlowTemplate.hasMany(models.Tratamiento, {
          foreignKey: 'appointment_flow_template_id',
          sourceKey: 'id',
          as: 'treatments',
        });
      }
    }
  }

  AppointmentFlowTemplate.init(
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      name: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      discipline: {
        type: DataTypes.STRING(80),
        allowNull: false,
      },
      version: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: '1.0',
      },
      steps: {
        type: DataTypes.JSON,
        allowNull: false,
      },
      is_system: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      clinic_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      group_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      is_active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
    },
    {
      sequelize,
      modelName: 'AppointmentFlowTemplate',
      tableName: 'AppointmentFlowTemplates',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    }
  );

  return AppointmentFlowTemplate;
};
