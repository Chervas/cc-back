'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class CitaPaciente extends Model {
    static associate(models) {
      CitaPaciente.belongsTo(models.Clinica, { foreignKey: 'clinica_id', targetKey: 'id_clinica', as: 'clinica' });
      CitaPaciente.belongsTo(models.Paciente, { foreignKey: 'paciente_id', targetKey: 'id_paciente', as: 'paciente' });
      if (models.LeadIntake) {
        CitaPaciente.belongsTo(models.LeadIntake, { foreignKey: 'lead_intake_id', as: 'lead' });
      }
      if (models.Usuario) {
        CitaPaciente.belongsTo(models.Usuario, { foreignKey: 'doctor_id', targetKey: 'id_usuario', as: 'doctor' });
      }
      if (models.Campana) {
        CitaPaciente.belongsTo(models.Campana, { foreignKey: 'campana_id', as: 'campana' });
      }
    }
  }

  CitaPaciente.init({
    id_cita: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    clinica_id: { type: DataTypes.INTEGER, allowNull: false },
    paciente_id: { type: DataTypes.INTEGER, allowNull: false },
    lead_intake_id: { type: DataTypes.INTEGER, allowNull: true },
    doctor_id: { type: DataTypes.INTEGER, allowNull: true },
    instalacion_id: { type: DataTypes.INTEGER, allowNull: true },
    tratamiento_id: { type: DataTypes.INTEGER, allowNull: true },
    campana_id: { type: DataTypes.INTEGER, allowNull: true },
    titulo: { type: DataTypes.STRING(255), allowNull: true },
    nota: { type: DataTypes.TEXT, allowNull: true },
    motivo: { type: DataTypes.STRING(255), allowNull: true },
    tipo_cita: {
      type: DataTypes.ENUM('primera_sin_trat', 'primera_con_trat', 'continuacion', 'urgencia', 'revision'),
      allowNull: false,
      defaultValue: 'continuacion'
    },
    estado: {
      type: DataTypes.ENUM('pendiente', 'confirmada', 'cancelada', 'completada', 'no_asistio'),
      allowNull: false,
      defaultValue: 'pendiente'
    },
    inicio: { type: DataTypes.DATE, allowNull: false },
    fin: { type: DataTypes.DATE, allowNull: false },
    es_provisional: { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: false },
    hold_expires_at: { type: DataTypes.DATE, allowNull: true }
  }, {
    sequelize,
    modelName: 'CitaPaciente',
    tableName: 'CitasPacientes',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  return CitaPaciente;
};
