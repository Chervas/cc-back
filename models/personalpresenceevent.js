'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class PersonalPresenceEvent extends Model {
    static associate(models) {
      PersonalPresenceEvent.belongsTo(models.Clinica, {
        foreignKey: 'clinic_id',
        targetKey: 'id_clinica',
        as: 'clinic',
      });
      PersonalPresenceEvent.belongsTo(models.Usuario, {
        foreignKey: 'user_id',
        targetKey: 'id_usuario',
        as: 'user',
      });
      PersonalPresenceEvent.belongsTo(models.Usuario, {
        foreignKey: 'created_by',
        targetKey: 'id_usuario',
        as: 'creator',
      });
    }
  }

  PersonalPresenceEvent.init({
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    public_id: { type: DataTypes.STRING(36), allowNull: false, unique: true },
    clinic_id: { type: DataTypes.INTEGER, allowNull: false },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    business_date: { type: DataTypes.DATEONLY, allowNull: false },
    event_type: { type: DataTypes.STRING(32), allowNull: false },
    occurred_at: { type: DataTypes.DATE, allowNull: false },
    source: { type: DataTypes.STRING(64), allowNull: false, defaultValue: 'web' },
    note: { type: DataTypes.TEXT, allowNull: true },
    created_by: { type: DataTypes.INTEGER, allowNull: true },
  }, {
    sequelize,
    modelName: 'PersonalPresenceEvent',
    tableName: 'PersonalPresenceEvents',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });

  return PersonalPresenceEvent;
};
