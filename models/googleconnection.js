'use strict';

// GoogleConnection model
module.exports = (sequelize, DataTypes) => {
  const GoogleConnection = sequelize.define('GoogleConnection', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      unique: true,
      field: 'userId', // la columna existe en camelCase por migración
      references: { model: 'Usuarios', key: 'id_usuario' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE'
    },
    googleUserId: { type: DataTypes.STRING(128), allowNull: false, field: 'googleUserId' },
    userEmail: { type: DataTypes.STRING(256), allowNull: true, field: 'userEmail' },
    userName: { type: DataTypes.STRING(256), allowNull: true, field: 'userName' },
    accessToken: { type: DataTypes.TEXT, allowNull: false, field: 'accessToken' },
    refreshToken: { type: DataTypes.TEXT, allowNull: true, field: 'refreshToken' },
    scopes: { type: DataTypes.TEXT, allowNull: true, field: 'scopes' },
    expiresAt: { type: DataTypes.DATE, allowNull: true, field: 'expiresAt' }
  }, {
    tableName: 'GoogleConnections',
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  GoogleConnection.associate = function(models) {
    GoogleConnection.belongsTo(models.Usuario, { foreignKey: 'userId', targetKey: 'id_usuario', as: 'usuario' });
  };

  return GoogleConnection;
};
