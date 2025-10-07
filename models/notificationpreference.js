'use strict';
module.exports = (sequelize, DataTypes) => {
  const NotificationPreference = sequelize.define('NotificationPreference', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    role: { type: DataTypes.STRING(64), allowNull: false },
    subrole: { type: DataTypes.STRING(128), allowNull: false, defaultValue: '' },
    category: { type: DataTypes.STRING(64), allowNull: false },
    event: { type: DataTypes.STRING(128), allowNull: false },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }
  }, {
    tableName: 'NotificationPreferences',
    underscored: true
  });

  return NotificationPreference;
};
