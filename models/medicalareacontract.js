'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class MedicalAreaContract extends Model {}

  MedicalAreaContract.init(
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      code: {
        type: DataTypes.STRING(80),
        allowNull: false,
      },
      contract_json: {
        type: DataTypes.JSON,
        allowNull: false,
      },
      version: {
        type: DataTypes.STRING(80),
        allowNull: false,
        defaultValue: 'custom-v1',
      },
      active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      updated_by: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
    },
    {
      sequelize,
      modelName: 'MedicalAreaContract',
      tableName: 'MedicalAreaContracts',
      underscored: true,
      timestamps: true,
    },
  );

  return MedicalAreaContract;
};
