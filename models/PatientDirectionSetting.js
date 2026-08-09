'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class PatientDirectionSetting extends Model {
    static associate(models) {
      PatientDirectionSetting.belongsTo(models.Clinica, { foreignKey: 'clinic_id', as: 'clinic' });
      PatientDirectionSetting.belongsTo(models.Usuario, { foreignKey: 'director_user_id', as: 'director' });
      PatientDirectionSetting.belongsTo(models.Usuario, { foreignKey: 'default_successor_user_id', as: 'defaultSuccessor' });
      PatientDirectionSetting.belongsTo(models.ClinicMetaAsset, { foreignKey: 'director_phone_asset_id', as: 'directorPhone' });
      PatientDirectionSetting.belongsTo(models.ClinicMetaAsset, { foreignKey: 'clinic_phone_asset_id', as: 'clinicPhone' });
    }
  }

  PatientDirectionSetting.init({
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    clinic_id: { type: DataTypes.INTEGER, allowNull: false, unique: true },
    is_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    director_user_id: { type: DataTypes.INTEGER, allowNull: true },
    director_phone_asset_id: { type: DataTypes.INTEGER, allowNull: true },
    clinic_phone_asset_id: { type: DataTypes.INTEGER, allowNull: true },
    default_successor_user_id: { type: DataTypes.INTEGER, allowNull: true },
    enabled_by: { type: DataTypes.INTEGER, allowNull: true },
    enabled_at: { type: DataTypes.DATE, allowNull: true },
    disabled_by: { type: DataTypes.INTEGER, allowNull: true },
    disabled_at: { type: DataTypes.DATE, allowNull: true },
    config: { type: DataTypes.JSON, allowNull: true },
  }, {
    sequelize,
    modelName: 'PatientDirectionSetting',
    tableName: 'PatientDirectionSettings',
    timestamps: true,
    underscored: true,
  });

  return PatientDirectionSetting;
};
