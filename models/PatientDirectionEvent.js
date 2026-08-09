'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class PatientDirectionEvent extends Model {
    static associate(models) {
      PatientDirectionEvent.belongsTo(models.PatientDirectionAssignment, { foreignKey: 'assignment_id', as: 'assignment' });
    }
  }

  PatientDirectionEvent.init({
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    assignment_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    clinic_id: { type: DataTypes.INTEGER, allowNull: true },
    event_type: { type: DataTypes.STRING(64), allowNull: false },
    actor_user_id: { type: DataTypes.INTEGER, allowNull: true },
    payload: { type: DataTypes.JSON, allowNull: true },
  }, {
    sequelize,
    modelName: 'PatientDirectionEvent',
    tableName: 'PatientDirectionEvents',
    timestamps: true,
    updatedAt: false,
    underscored: true,
  });

  return PatientDirectionEvent;
};
