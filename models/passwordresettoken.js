'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class PasswordResetToken extends Model {
    static associate(models) {
      if (models.Usuario) {
        PasswordResetToken.belongsTo(models.Usuario, { foreignKey: 'user_id', as: 'usuario' });
      }
      if (models.EmailMessage) {
        PasswordResetToken.belongsTo(models.EmailMessage, { foreignKey: 'email_message_id', as: 'emailMessage' });
      }
    }
  }

  PasswordResetToken.init({
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    token_hash: { type: DataTypes.CHAR(64), allowNull: false, unique: true },
    token_prefix: { type: DataTypes.STRING(16), allowNull: false },
    email_hash: { type: DataTypes.CHAR(64), allowNull: false },
    email_message_id: DataTypes.INTEGER.UNSIGNED,
    status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'pending' },
    expires_at: { type: DataTypes.DATE, allowNull: false },
    used_at: DataTypes.DATE,
    requested_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    request_ip_hash: DataTypes.CHAR(64),
    user_agent_hash: DataTypes.CHAR(64),
  }, {
    sequelize,
    modelName: 'PasswordResetToken',
    tableName: 'PasswordResetTokens',
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });

  return PasswordResetToken;
};
