'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class PacienteConsentimiento extends Model {
    static associate(models) {
      PacienteConsentimiento.belongsTo(models.Paciente, {
        foreignKey: 'paciente_id',
        targetKey: 'id_paciente',
        as: 'paciente',
      });
    }
  }

  PacienteConsentimiento.init(
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      paciente_id: { type: DataTypes.INTEGER, allowNull: false },
      nombre: { type: DataTypes.STRING(255), allowNull: false },
      descripcion: { type: DataTypes.TEXT, allowNull: true },
      tipo: {
        type: DataTypes.ENUM('tratamiento', 'rgpd', 'imagen', 'comunicaciones', 'otro'),
        allowNull: false,
      },
      estado: {
        type: DataTypes.ENUM('pendiente', 'enviado', 'firmado', 'rechazado', 'caducado'),
        allowNull: false,
        defaultValue: 'pendiente',
      },
      fecha_envio: { type: DataTypes.DATE, allowNull: true },
      fecha_firma: { type: DataTypes.DATE, allowNull: true },
      fecha_caducidad: { type: DataTypes.DATE, allowNull: true },
      url_documento: { type: DataTypes.STRING(512), allowNull: true },
      obligatorio: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    },
    {
      sequelize,
      modelName: 'PacienteConsentimiento',
      tableName: 'PacienteConsentimientos',
      timestamps: true,
    }
  );

  return PacienteConsentimiento;
};
