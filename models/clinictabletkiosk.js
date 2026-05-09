'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class ClinicTabletKiosk extends Model {
    static associate(models) {
      ClinicTabletKiosk.belongsTo(models.Clinica, {
        foreignKey: 'clinic_id',
        targetKey: 'id_clinica',
        as: 'clinic',
      });
    }
  }

  ClinicTabletKiosk.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    public_id: { type: DataTypes.STRING(80), allowNull: false, unique: true },
    clinic_id: { type: DataTypes.INTEGER, allowNull: false },
    username: { type: DataTypes.STRING(160), allowNull: false, unique: true },
    password_hash: { type: DataTypes.STRING(255), allowNull: false },
    display_name: { type: DataTypes.STRING(160), allowNull: true },
    status: {
      type: DataTypes.ENUM('active', 'disabled'),
      allowNull: false,
      defaultValue: 'active',
    },
    last_login_at: { type: DataTypes.DATE, allowNull: true },
    last_used_at: { type: DataTypes.DATE, allowNull: true },
    created_by: { type: DataTypes.INTEGER, allowNull: true },
  }, {
    sequelize,
    modelName: 'ClinicTabletKiosk',
    tableName: 'ClinicTabletKiosks',
    timestamps: true,
  });

  return ClinicTabletKiosk;
};
