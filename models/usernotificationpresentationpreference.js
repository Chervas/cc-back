'use strict';

module.exports = (sequelize, DataTypes) => {
  const UserNotificationPresentationPreference = sequelize.define('UserNotificationPresentationPreference', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    userId: { type: DataTypes.INTEGER, allowNull: false, field: 'user_id' },
    preferenceKey: { type: DataTypes.STRING(160), allowNull: false, field: 'preference_key' },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  }, {
    tableName: 'UserNotificationPresentationPreferences',
    underscored: true,
  });

  UserNotificationPresentationPreference.associate = function associate(models) {
    UserNotificationPresentationPreference.belongsTo(models.Usuario, {
      foreignKey: 'userId',
      targetKey: 'id_usuario',
      as: 'usuario',
    });
  };

  return UserNotificationPresentationPreference;
};
