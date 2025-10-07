'use strict';
module.exports = (sequelize, DataTypes) => {
  const Notification = sequelize.define('Notification', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    userId: { type: DataTypes.INTEGER, allowNull: false, field: 'user_id' },
    role: { type: DataTypes.STRING(64), allowNull: true },
    subrole: { type: DataTypes.STRING(128), allowNull: true },
    category: { type: DataTypes.STRING(64), allowNull: false },
    event: { type: DataTypes.STRING(128), allowNull: false },
    title: { type: DataTypes.STRING(255), allowNull: true },
    message: { type: DataTypes.TEXT, allowNull: true },
    icon: { type: DataTypes.STRING(128), allowNull: true },
    level: { type: DataTypes.STRING(32), allowNull: true },
    data: { type: DataTypes.JSON, allowNull: true },
    clinicaId: { type: DataTypes.INTEGER, allowNull: true, field: 'clinica_id' },
    isRead: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'is_read' },
    readAt: { type: DataTypes.DATE, allowNull: true, field: 'read_at' }
  }, {
    tableName: 'Notifications',
    underscored: true
  });

  Notification.associate = function(models) {
    Notification.belongsTo(models.Usuario, {
      foreignKey: 'userId',
      targetKey: 'id_usuario',
      as: 'usuario'
    });
    Notification.belongsTo(models.Clinica, {
      foreignKey: 'clinicaId',
      targetKey: 'id_clinica',
      as: 'clinica'
    });
  };

  return Notification;
};
