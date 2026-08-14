'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class PatientDirectionProfile extends Model {
    static associate(models) {
      PatientDirectionProfile.belongsTo(models.Usuario, {
        foreignKey: 'user_id',
        as: 'user',
      });
      PatientDirectionProfile.belongsTo(models.ClinicMetaAsset, {
        foreignKey: 'whatsapp_phone_asset_id',
        as: 'whatsappPhone',
      });
      PatientDirectionProfile.hasMany(models.PatientDirectionSetting, {
        foreignKey: 'director_user_id',
        sourceKey: 'user_id',
        as: 'clinicSettings',
      });
    }
  }

  PatientDirectionProfile.init({
    user_id: { type: DataTypes.INTEGER, primaryKey: true, allowNull: false },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    whatsapp_phone_asset_id: { type: DataTypes.INTEGER, allowNull: true, unique: true },
    created_by: { type: DataTypes.INTEGER, allowNull: true },
    updated_by: { type: DataTypes.INTEGER, allowNull: true },
  }, {
    sequelize,
    modelName: 'PatientDirectionProfile',
    tableName: 'PatientDirectionProfiles',
    timestamps: true,
    underscored: true,
  });

  return PatientDirectionProfile;
};
