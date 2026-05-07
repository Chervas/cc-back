'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class PatientCustomField extends Model {
    static associate(models) {
      PatientCustomField.belongsTo(models.Paciente, { foreignKey: 'paciente_id', targetKey: 'id_paciente', as: 'paciente' });
      PatientCustomField.belongsTo(models.Clinica, { foreignKey: 'clinica_id', targetKey: 'id_clinica', as: 'clinica' });
    }
  }

  PatientCustomField.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    paciente_id: { type: DataTypes.INTEGER, allowNull: false },
    clinica_id: { type: DataTypes.INTEGER, allowNull: false },
    field_key: { type: DataTypes.STRING(120), allowNull: false },
    label: { type: DataTypes.STRING(255), allowNull: true },
    value: { type: DataTypes.TEXT, allowNull: true },
    value_type: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'text' },
    source: { type: DataTypes.STRING(64), allowNull: false, defaultValue: 'import' },
    source_column: { type: DataTypes.STRING(255), allowNull: true },
    last_imported_at: { type: DataTypes.DATE, allowNull: true },
  }, {
    sequelize,
    modelName: 'PatientCustomField',
    tableName: 'PatientCustomFields',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });

  return PatientCustomField;
};
