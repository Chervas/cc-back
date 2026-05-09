'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class ConsentSignaturePackage extends Model {
    static associate(models) {
      ConsentSignaturePackage.belongsTo(models.Paciente, {
        foreignKey: 'paciente_id',
        targetKey: 'id_paciente',
        as: 'paciente',
      });
      ConsentSignaturePackage.belongsTo(models.Clinica, {
        foreignKey: 'clinica_id',
        targetKey: 'id_clinica',
        as: 'clinica',
      });
      ConsentSignaturePackage.belongsTo(models.CitaPaciente, {
        foreignKey: 'cita_id',
        targetKey: 'id_cita',
        as: 'cita',
      });
      ConsentSignaturePackage.belongsTo(models.Tratamiento, {
        foreignKey: 'tratamiento_id',
        targetKey: 'id_tratamiento',
        as: 'tratamiento',
      });
      ConsentSignaturePackage.hasMany(models.PatientConsentDocument, {
        foreignKey: 'package_id',
        as: 'documents',
      });
      ConsentSignaturePackage.hasMany(models.ConsentDeliveryEvent, {
        foreignKey: 'package_id',
        as: 'deliveryEvents',
      });
    }
  }

  ConsentSignaturePackage.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    public_id: { type: DataTypes.STRING(80), allowNull: false, unique: true },
    paciente_id: { type: DataTypes.INTEGER, allowNull: false },
    clinica_id: { type: DataTypes.INTEGER, allowNull: false },
    cita_id: { type: DataTypes.INTEGER, allowNull: true },
    tratamiento_id: { type: DataTypes.INTEGER, allowNull: true },
    status: {
      type: DataTypes.ENUM('draft', 'pending', 'sent', 'viewed', 'signed', 'expired', 'cancelled'),
      allowNull: false,
      defaultValue: 'pending',
    },
    required_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    signed_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    due_at: { type: DataTypes.DATE, allowNull: true },
    expires_at: { type: DataTypes.DATE, allowNull: true },
    trigger_source: { type: DataTypes.STRING(80), allowNull: true },
    created_by: { type: DataTypes.INTEGER, allowNull: true },
  }, {
    sequelize,
    modelName: 'ConsentSignaturePackage',
    tableName: 'ConsentSignaturePackages',
    timestamps: true,
  });

  return ConsentSignaturePackage;
};
