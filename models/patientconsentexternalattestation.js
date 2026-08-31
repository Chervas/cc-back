'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class PatientConsentExternalAttestation extends Model {
    static associate(models) {
      PatientConsentExternalAttestation.belongsTo(models.Paciente, {
        foreignKey: 'paciente_id',
        targetKey: 'id_paciente',
        as: 'paciente',
      });
      PatientConsentExternalAttestation.belongsTo(models.Clinica, {
        foreignKey: 'clinica_id',
        targetKey: 'id_clinica',
        as: 'clinica',
      });
      PatientConsentExternalAttestation.belongsTo(models.Tratamiento, {
        foreignKey: 'tratamiento_id',
        targetKey: 'id_tratamiento',
        as: 'tratamiento',
      });
      PatientConsentExternalAttestation.belongsTo(models.Usuario, {
        foreignKey: 'attested_by',
        targetKey: 'id_usuario',
        as: 'attestedByUser',
      });
      PatientConsentExternalAttestation.belongsTo(models.Usuario, {
        foreignKey: 'revoked_by',
        targetKey: 'id_usuario',
        as: 'revokedByUser',
      });
    }
  }

  PatientConsentExternalAttestation.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    public_id: { type: DataTypes.STRING(80), allowNull: false, unique: true },
    paciente_id: { type: DataTypes.INTEGER, allowNull: false },
    clinica_id: { type: DataTypes.INTEGER, allowNull: false },
    tratamiento_id: { type: DataTypes.INTEGER, allowNull: true },
    purpose: { type: DataTypes.STRING(80), allowNull: false, defaultValue: 'clinical' },
    title: { type: DataTypes.STRING(255), allowNull: false },
    note: { type: DataTypes.TEXT, allowNull: true },
    source: { type: DataTypes.STRING(80), allowNull: false, defaultValue: 'external_written' },
    status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'active' },
    attested_by: { type: DataTypes.INTEGER, allowNull: true },
    attested_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    revoked_by: { type: DataTypes.INTEGER, allowNull: true },
    revoked_at: { type: DataTypes.DATE, allowNull: true },
  }, {
    sequelize,
    modelName: 'PatientConsentExternalAttestation',
    tableName: 'PatientConsentExternalAttestations',
    timestamps: true,
  });

  return PatientConsentExternalAttestation;
};
